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
// 竞争解法（tee 补丁）：apply 时给 `ctx.tasks.read` 打**观察补丁**——任何
// 调用（官方 task_output 工具 / 本插件自读 / 其他消费者）拿到的增量都即时
// 累积进本插件的 shadow 缓冲。效果：
// - 官方工具每次 read 拿到它该拿的增量，**零干扰**（补丁原样透传结果）；
// - 本插件 tail 路由返回**累积全文**（已读全历史的并集），full: true 契约。
// 无重复（每次 read 都是自上次以来新增）、无丢失（每个增量恰好进缓冲一次）。
// 唯一取舍：被本插件抢先读走的增量，官方工具不再能单独重放——但官方语义
// 本就是增量读取（模型每次拿"新增"），感知无影响。终态 read 会置 reported：
// 自读仅发生在用户展开活跃任务时，窗口有限（见 readTaskOutput 注释）。

/** 只读任务列表路由（与 client bundle 轮询地址一致）。 */
export const TASKS_PATH = '/plugins/dsh-task-status/tasks'

/** 任务输出读取路由（tail：返回 shadow 缓冲累积全文，full: true 契约）。 */
export const OUTPUT_PATH = '/plugins/dsh-task-status/output'

/** shadow 缓冲上限：超限丢最旧（tail 保尾），防长任务无界增长。 */
const OUTPUT_BUF_MAX = 64 * 1024

/** taskId -> 累积输出（本插件 read 到的增量影子，与官方游标同步推进）。 */
const outputBuffers = new Map()

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
 * 读取一个任务的输出 tail（tee 版）：先按 agent 遍历找到任务的 owner（其
 * `list(agent)` 含该 id），用该 agent 身份 `read` 拿增量——read 已被 tee
 * 补丁观察，增量自动累积进 shadow 缓冲；unowned 任务直接 read。返回**累积
 * 全文**（客户端整段替换）。
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
  const read = caller === undefined ? tasks.read(id) : tasks.read(id, caller)
  return { text: outputBuffers.get(id) ?? '', snapshot: read.snapshot }
}

/**
 * 插件主体：打 read tee 补丁 + 注册任务列表与输出读取路由。tee 补丁观察
 * 所有 `tasks.read` 调用（原样透传结果，零干扰），增量累积进 shadow 缓冲；
 * dispose 时恢复原方法。路由 handler 异常以 500 返回，客户端轮询吞掉瞬态错误。
 * @param ctx - host cordis context。
 */
export function apply(ctx) {
  ctx.effect(() => {
    // tee 补丁：观察 read（调用方无关），增量即时累积；结果原样透传。
    const originalRead = ctx.tasks.read.bind(ctx.tasks)
    ctx.tasks.read = (...args) => {
      const result = originalRead(...args)
      const text = result?.text
      if (typeof text === 'string' && text.length > 0) {
        const prev = outputBuffers.get(args[0]) ?? ''
        outputBuffers.set(args[0], (prev + text).slice(-OUTPUT_BUF_MAX))
      }
      return result
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
      ctx.tasks.read = originalRead
      disposeTasks()
      disposeOutput()
    }
  }, 'task-status: tee tasks.read + tasks/output routes')
}
