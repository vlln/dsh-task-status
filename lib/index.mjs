//#region src/index.mjs
/** 只读任务列表路由（与 client bundle 轮询地址一致）。 */
const TASKS_PATH = "/plugins/dsh-task-status/tasks";
/** 任务输出读取路由（tail：返回 shadow 缓冲累积全文，full: true 契约）。 */
const OUTPUT_PATH = "/plugins/dsh-task-status/output";
/** taskId -> 累积输出（全部已读增量的顺序累积：插件自读 + 官方直读）。 */
const outputBuffers = /* @__PURE__ */ new Map();
/** taskId -> 官方 read 已消费的缓冲长度（镜像游标，仅补丁维护、只前移）。 */
const officialConsumed = /* @__PURE__ */ new Map();
/** 底层原始 jobs.read（apply 时绑定）；插件自读直接调它绕过补丁。 */
let rawRead = void 0;
/** 把一段增量追加进 shadow 缓冲（保尾截断）。 */
function accumulate(id, text) {
	if (typeof text !== "string" || text.length === 0) return;
	const prev = outputBuffers.get(id) ?? "";
	outputBuffers.set(id, (prev + text).slice(-65536));
}
/** Cordis 插件名。 */
const name = "task-status";
/** 所需服务：web 形状的 HTTP 载体 + 任务注册表 + agent 注册表。 */
const inject = [
	"webServer",
	"jobs",
	"agents"
];
/** 裁剪任务快照到 wire 视图（内部记账不跨线；owner 只投影 session id）。 */
function toWire(snapshot) {
	return {
		id: snapshot.id,
		kind: snapshot.kind,
		label: snapshot.label,
		status: snapshot.status,
		...snapshot.detail !== void 0 ? { detail: snapshot.detail } : {},
		startedAt: snapshot.startedAt,
		...snapshot.finishedAt !== void 0 ? { finishedAt: snapshot.finishedAt } : {},
		...snapshot.ownerSession !== void 0 ? { ownerSession: snapshot.ownerSession } : {}
	};
}
/** 收集宿主全部任务：owned（按 agent 遍历，绕过 owner fence）+ unowned，按 id 去重。 */
function collectTasks(ctx) {
	const jobs = ctx.jobs;
	const seen = /* @__PURE__ */ new Set();
	const out = [];
	for (const agent of ctx.agents.list()) for (const snapshot of jobs.list(agent)) {
		if (snapshot.ownerSession === void 0 || seen.has(snapshot.id)) continue;
		seen.add(snapshot.id);
		out.push(toWire(snapshot));
	}
	for (const snapshot of jobs.list()) {
		if (seen.has(snapshot.id)) continue;
		seen.add(snapshot.id);
		out.push(toWire(snapshot));
	}
	return out;
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
	if (!collectTasks(ctx).some((snapshot) => snapshot.id === id)) return null;
	const jobs = ctx.jobs;
	let caller;
	for (const agent of ctx.agents.list()) if (jobs.list(agent).some((snapshot) => snapshot.id === id)) {
		caller = agent;
		break;
	}
	const read = caller === void 0 ? rawRead(id) : rawRead(id, caller);
	accumulate(id, read?.text);
	return {
		text: outputBuffers.get(id) ?? "",
		snapshot: read.snapshot
	};
}
/**
* 插件主体：打 read 镜像补丁 + 注册任务列表与输出读取路由。镜像补丁让官方
* read 优先从缓冲切片（零消耗），无货回退直读（原语义）；dispose 时恢复
* 原方法。路由 handler 异常以 500 返回，客户端轮询吞掉瞬态错误。
* @param ctx - host cordis context。
*/
function apply(ctx) {
	ctx.effect(() => {
		rawRead = ctx.jobs.read.bind(ctx.jobs);
		ctx.jobs.read = (id, caller) => {
			const buf = outputBuffers.get(id);
			const consumed = officialConsumed.get(id) ?? 0;
			const mirror = buf !== void 0 && buf.length > consumed ? buf.slice(consumed) : "";
			const result = rawRead(id, caller);
			accumulate(id, result?.text);
			const text = mirror + (result?.text ?? "");
			officialConsumed.set(id, (buf?.length ?? 0) + (typeof result?.text === "string" ? result.text.length : 0));
			return {
				text,
				snapshot: result.snapshot
			};
		};
		const disposeTasks = ctx.webServer.register({
			kind: "exact",
			path: TASKS_PATH,
			handler: async (_req, res) => {
				try {
					res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
					res.end(JSON.stringify({ tasks: collectTasks(ctx) }));
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
					res.end(JSON.stringify({ error: message }));
				}
			}
		});
		const disposeOutput = ctx.webServer.register({
			kind: "exact",
			path: OUTPUT_PATH,
			handler: async (req, res) => {
				try {
					const id = new URL(req.url ?? "/", "http://dsh.internal").searchParams.get("id") ?? "";
					if (id === "") {
						res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
						res.end(JSON.stringify({ error: "missing task id" }));
						return;
					}
					const read = readTaskOutput(ctx, id);
					if (read === null || read.snapshot === void 0) {
						res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
						res.end(JSON.stringify({ error: `task ${id} not found` }));
						return;
					}
					res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
					res.end(JSON.stringify({
						text: read.text,
						full: true,
						snapshot: read.snapshot
					}));
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
					res.end(JSON.stringify({ error: message }));
				}
			}
		});
		return () => {
			ctx.jobs.read = rawRead;
			rawRead = void 0;
			disposeTasks();
			disposeOutput();
		};
	}, "task-status: mirror jobs.read + jobs/output routes");
}
//#endregion
export { OUTPUT_PATH, TASKS_PATH, apply, inject, name };
