// vlln/task-status Node half：自造数据通道——注册一个只读 JSON 路由，
// 轮询时返回宿主 `ctx.tasks` 的当前任务快照。不依赖官方推送帧（useTasks /
// task/snapshot）：客户端每 1s fetch 本路由刷新，官方树零改动。
//
// 任务可见性：`tasks.list(caller)` 的 owner fence 让无 agent 身份的调用方
// 只看到 unowned 任务，所以这里遍历 `ctx.agents.list()` 逐个取 owned 任务
// 再并上 unowned（按 id 去重）——这是示例演示的"自造缝"替代 `listOwned`。
//
// 输出 tail 的现实约束（0809 官方 tasks API）：
// - `tasks.get(id)` 是非消耗快照，但 TaskSnapshot **不含输出文本**（仅元数据）；
// - 唯一输出通道是 `tasks.read(id)`：stream 任务返回"上次读取以来的增量"并
//   推进**每任务唯一共享游标**（官方 `task_output` 工具走同一游标）。
// 因此"非消耗式 peek 全文"在 0809 上**不存在**。
//
// 竞争解法（镜像补丁）：给 `ctx.tasks.read` 打**镜像优先补丁**——
// - 官方 read：缓冲里有"官方尚未消费"的增量 → **从缓冲切片返回**（不推进
//   producer 游标，零消耗）；无货 → **回退直读**（原语义，消耗 + 累积 +
//   推进官方镜像游标）。官方看到的增量序列与无插件时**逐字节一致**。
// - 本插件自读：直接调底层 rawRead（绕过补丁，producer 游标唯一推进者）
//   + 累积进缓冲；tail 路由返回累积全文（full: true 契约）。
// 效果：官方零干扰（折叠时恒直读、展开时镜像=直读视图）、插件 tail 完整
// 实时（≤1s 滞后）、无重复（官方镜像游标只前移）、无丢失（缓冲 = 全部已读
// 增量顺序累积）。唯一残留：producer 游标仍被插件推进（消耗的唯一性），
// 但官方感知无差异。镜像分支用 get 取快照（不置 reported），终态通知仍由
// 官方 onTaskDone/wait 交付。

/** 只读任务列表路由（与 client bundle 轮询地址一致）。 */
export const TASKS_PATH = '/plugins/dsh-task-status/tasks'

/** 任务输出读取路由（tail：返回 shadow 缓冲累积全文，full: true 契约）。 */
export const OUTPUT_PATH = '/plugins/dsh-task-status/output'

/** shadow 缓冲上限：超限丢最旧（tail 保尾），防长任务无界增长。 */
const OUTPUT_BUF_MAX = 64 * 1024

/** taskId -> 累积输出（全部已读增量的顺序累积：插件自读 + 官方直读）。 */
const outputBuffers = new Map()

/** taskId -> 官方 read 已消费的缓冲长度（镜像游标，仅补丁维护、只前移）。 */
const officialConsumed = new Map()

/** 底层原始 tasks.read（apply 时绑定）；插件自读直接调它绕过补丁。 */
let rawRead = undefined

/** 把一段增量追加进 shadow 缓冲（保尾截断）。 */
function accumulate(id, text) {
  if (typeof text !== 'string' || text.length === 0) return
  const prev = outputBuffers.get(id) ?? ''
  outputBuffers.set(id, (prev + text).slice(-OUTPUT_BUF_MAX))
}

/** Cordis 插件名。 */
export const name = 'task-status'

/** 所需服务：web 形状的 HTTP 载体 + 任务注册表 + agent 注册表。 */
export const inject = ['httpServer', 'tasks', 'agents']

/** 裁剪任务快照到 wire 视图（内部记账不跨线；owner 只投影 session id）。 */
function toWire(snapshot) {
  return {
    id: snapshot.id,
    kind: snapshot.kind,
    label: snapshot.label,
    status: snapshot.status,
    ...(snapshot.detail !== undefined ? { detail: snapshot.detail } : {}),
    startedAt: snapshot.startedAt,
    ...(snapshot.finishedAt !== undefined ? { finishedAt: snapshot.finishedAt } : {}),
    ...(snapshot.ownerSession !== undefined ? { ownerSession: snapshot.ownerSession } : {}),
  }
}

/** 收集宿主全部任务：owned（按 agent 遍历，绕过 owner fence）+ unowned，按 id 去重。 */
function collectTasks(ctx) {
  const tasks = ctx.tasks
  const seen = new Set()
  const out = []
  for (const agent of ctx.agents.list()) {
    for (const snapshot of tasks.list(agent)) {
      if (snapshot.ownerSession === undefined || seen.has(snapshot.id)) continue
      seen.add(snapshot.id)
      out.push(toWire(snapshot))
    }
  }
  for (const snapshot of tasks.list()) {
    if (seen.has(snapshot.id)) continue
    seen.add(snapshot.id)
    out.push(toWire(snapshot))
  }
  return out
}

/**
 * 读取一个任务的输出 tail（镜像版）：先按 agent 遍历找到任务的 owner（其
 * `list(agent)` 含该 id），用该 agent 身份**直接调底层 rawRead**（绕过镜像
 * 补丁——本插件是 producer 游标的唯一主动推进者），增量累积进 shadow 缓冲；
 * unowned 任务直接 rawRead。返回**累积全文**（客户端整段替换）。
 *
 * 自读仅发生在用户展开任务时；展开期间任务终态会使 read 置 `reported`
 * （官方"首次消耗式 read 交付终态通知"语义被提前触发）——窗口有限、可接受。
 * @param ctx - host cordis context。
 * @param id - 任务 id。
 * @returns 累积 text 与读后快照；任务不存在返回 null。
 */
function readTaskOutput(ctx, id) {
  // 先确认任务存在（列表视图非消耗式），未知 id 直接 404，避免消耗式 read 抛错。
  if (!collectTasks(ctx).some(snapshot => snapshot.id === id)) return null
  const tasks = ctx.tasks
  let caller
  for (const agent of ctx.agents.list()) {
    if (tasks.list(agent).some(snapshot => snapshot.id === id)) {
      caller = agent
      break
    }
  }
  const read = caller === undefined ? rawRead(id) : rawRead(id, caller)
  accumulate(id, read?.text)
  return { text: outputBuffers.get(id) ?? '', snapshot: read.snapshot }
}

/**
 * 插件主体：打 read 镜像补丁 + 注册任务列表与输出读取路由。镜像补丁让官方
 * read 优先从缓冲切片（零消耗），无货回退直读（原语义）；dispose 时恢复
 * 原方法。路由 handler 异常以 500 返回，客户端轮询吞掉瞬态错误。
 * @param ctx - host cordis context。
 */
export function apply(ctx) {
  ctx.effect(() => {
    // 绑定底层原始 read（插件自读经 rawRead 绕过补丁）。
    rawRead = ctx.tasks.read.bind(ctx.tasks)
    // 镜像补丁（镜像 + 直读补最新）：官方 read = 缓冲中"官方未消费"的增量
    // （别人已读的，镜像返回，不重复消耗 producer 游标）+ 直读"producer 未读"
    // 的最新增量（正常消耗）。官方视图完整无滞后、无重复；每个增量恰好被
    // 消耗一次（插件自读或官方直读），双方都能看到全量。
    ctx.tasks.read = (id, caller) => {
      const buf = outputBuffers.get(id)
      const consumed = officialConsumed.get(id) ?? 0
      const mirror = buf !== undefined && buf.length > consumed ? buf.slice(consumed) : ''
      // 直读补最新：消耗 producer 游标（拿自官方上次 read 以来新产出的增量），
      // 同时累积进缓冲（插件视图也完整）。
      const result = rawRead(id, caller)
      accumulate(id, result?.text)
      const text = mirror + (result?.text ?? '')
      officialConsumed.set(id, (buf?.length ?? 0) + (typeof result?.text === 'string' ? result.text.length : 0))
      return { text, snapshot: result.snapshot }
    }
    const disposeTasks = ctx.httpServer.register({
      kind: 'exact',
      path: TASKS_PATH,
      handler: async (_req, res) => {
        try {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ tasks: collectTasks(ctx) }))
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: message }))
        }
      },
    })
    const disposeOutput = ctx.httpServer.register({
      kind: 'exact',
      path: OUTPUT_PATH,
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://dsh.internal')
          const id = url.searchParams.get('id') ?? ''
          if (id === '') {
            res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: 'missing task id' }))
            return
          }
          const read = readTaskOutput(ctx, id)
          if (read === null || read.snapshot === undefined) {
            res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: `task ${id} not found` }))
            return
          }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          // full: true = peek 全文契约（客户端整段替换）；缺省视为旧增量契约。
          res.end(JSON.stringify({ text: read.text, full: true, snapshot: read.snapshot }))
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: message }))
        }
      },
    })
    return () => {
      ctx.tasks.read = rawRead
      rawRead = undefined
      disposeTasks()
      disposeOutput()
    }
  }, 'task-status: mirror tasks.read + tasks/output routes')
}
