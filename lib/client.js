window.__ModuleLoader__.load({
	id: "@vlln/dsh-task-status",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/task-status.tsx
		/** Node half 只读任务路由（与 examples/task-status/index.mjs 的 TASKS_PATH 一致）。 */
		const TASKS_PATH = "/plugins/dsh-task-status/tasks";
		/** Node half 任务输出读取路由（与 src/index.mjs 的 OUTPUT_PATH 一致）。 */
		const OUTPUT_PATH = "/plugins/dsh-task-status/output";
		/** 轮询间隔：活跃任务状态条不需要亚秒刷新。 */
		const POLL_MS = 1e3;
		const NS = "task-status";
		const zh = {
			"status.running": "{count} 个后台任务运行中",
			"status.finished": "{count} 已完成",
			"status.open": "展开",
			"status.close": "收起",
			"task.running": "运行中",
			"task.stopping": "停止中",
			"task.completed": "已完成",
			"task.killed": "已终止",
			"task.failed": "失败"
		};
		const en = {
			"status.running": "{count} background task(s) running",
			"status.finished": "{count} finished",
			"status.open": "Expand",
			"status.close": "Collapse",
			"task.running": "Running",
			"task.stopping": "Stopping",
			"task.completed": "Completed",
			"task.killed": "Killed",
			"task.failed": "Failed"
		};
		/** 布局变量对齐官方 dock 家族（ConversationRoot.module.css）。 */
		const SIDE_CLEARANCE = "var(--dsh-composer-side-clearance, 16px)";
		const DOCK_INSET = "var(--dsh-composer-dock-inset, 8px)";
		const CARD_MAX = "var(--dsh-composer-card-max-width, 780px)";
		/** 每状态视觉：token + glyph 字符（14px outline 家族近似）。 */
		const STATUS_META = {
			running: {
				state: "ongoing",
				label: "task.running"
			},
			stopping: {
				state: "warning",
				label: "task.stopping"
			},
			completed: {
				state: "done",
				label: "task.completed"
			},
			killed: {
				state: "warning",
				label: "task.killed"
			},
			failed: {
				state: "error",
				label: "task.failed"
			}
		};
		/** 会话级轮询 hook：每 POLL_MS 拉取 Node half 路由，返回该会话的活跃任务。 */
		function useSessionTasks(sessionId) {
			const [tasks, setTasks] = (0, react.useState)([]);
			(0, react.useEffect)(() => {
				let alive = true;
				const poll = async () => {
					try {
						const res = await fetch(TASKS_PATH, { headers: { accept: "application/json" } });
						if (!res.ok) return;
						const data = await res.json();
						if (alive && Array.isArray(data.tasks)) setTasks(data.tasks);
					} catch {}
				};
				poll();
				const timer = setInterval(() => {
					poll();
				}, POLL_MS);
				return () => {
					alive = false;
					clearInterval(timer);
				};
			}, [sessionId]);
			return tasks.filter((task) => task.ownerSession === sessionId);
		}
		/**
		* 任务输出 tail：展开任务时**自动轮询** Node half 输出路由。Node half 给
		* `ctx.tasks.read` 打了**镜像补丁**（见 src/index.mjs）——官方 read = 缓冲
		* 镜像（他人已读增量，不重复消耗）+ 直读补最新（正常消耗），官方视图与
		* 无插件时逐字节一致；本插件自读直接走底层 rawRead 并累积。路由带
		* `full: true` 返回累积全文——客户端**整段替换**渲染（tail -f 效果，无需
		* 按钮）。双方视图 = 全量（无重复无丢失无滞后）。兼容旧路由（无 `full`
		* 标志 = 增量契约）：此时**追加**。
		* @param taskId - 当前展开的任务 id；null 时不轮询。
		* @returns 当前输出文本（整段替换或增量追加后）。
		*/
		function useTaskOutput(taskId) {
			const [output, setOutput] = (0, react.useState)("");
			(0, react.useEffect)(() => {
				if (taskId === null) {
					setOutput("");
					return;
				}
				let alive = true;
				const poll = async () => {
					try {
						const res = await fetch(`${OUTPUT_PATH}?id=${encodeURIComponent(taskId)}`, { headers: { accept: "application/json" } });
						if (!res.ok) return;
						const data = await res.json();
						if (!alive || typeof data.text !== "string") return;
						setOutput((prev) => data.full === true ? data.text : prev + data.text);
					} catch {}
				};
				poll();
				const timer = setInterval(() => {
					poll();
				}, POLL_MS);
				return () => {
					alive = false;
					clearInterval(timer);
				};
			}, [taskId]);
			return output;
		}
		/**
		* 对话页对话框上方的后台任务状态条：仅 Chat 视图显示（`[data-chat-flow=""]`
		* 探针），轮询该会话任务（running 高亮 + 展开逐条）。
		*/
		function TaskStatusBar(props) {
			const { t, session } = props;
			const tasks = useSessionTasks(session.sessionId);
			const [inChat, setInChat] = (0, react.useState)(false);
			const [open, setOpen] = (0, react.useState)(false);
			const [expandedTask, setExpandedTask] = (0, react.useState)(null);
			const taskOutput = useTaskOutput(expandedTask);
			(0, react.useEffect)(() => {
				const check = () => {
					setInChat(document.querySelector("[data-chat-flow=\"\"]") !== null);
				};
				check();
				const observer = new MutationObserver(check);
				observer.observe(document.body, {
					childList: true,
					subtree: true
				});
				return () => {
					observer.disconnect();
				};
			}, []);
			if (!inChat) return null;
			const active = tasks.filter((task) => task.status === "running" || task.status === "stopping");
			const running = active.filter((task) => task.status === "running").length;
			if (active.length === 0) return null;
			const statusOf = (status) => STATUS_META[status] ?? {
				state: "warning",
				label: status
			};
			const header = /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					alignItems: "center",
					gap: 6,
					padding: "6px 12px",
					cursor: active.length > 1 ? "pointer" : "default"
				},
				onClick: active.length > 1 ? () => setOpen((v) => !v) : void 0,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: {
							width: 16,
							fontSize: 14,
							lineHeight: "16px",
							textAlign: "center",
							color: "var(--dsw-alias-label-tertiary)"
						},
						children: "⚙"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: {
							flex: 1,
							fontSize: 13,
							lineHeight: "24px",
							fontWeight: 500,
							color: "var(--dsw-alias-label-primary)"
						},
						children: t("status.running", { count: running })
					}),
					active.length > 1 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: {
							padding: "0 8px",
							fontSize: 12,
							color: "var(--dsw-alias-label-caption)"
						},
						children: open ? t("status.close") : t("status.open")
					})
				]
			});
			const timeText = (task) => {
				const start = new Date(task.startedAt);
				const pad = (n) => String(n).padStart(2, "0");
				const time = `${pad(start.getHours())}:${pad(start.getMinutes())}:${pad(start.getSeconds())}`;
				return task.finishedAt === void 0 ? `${time} 起` : `${time} → ${pad(new Date(task.finishedAt).getHours())}:${pad(new Date(task.finishedAt).getMinutes())}`;
			};
			const row = (task) => {
				const meta = statusOf(task.status);
				const expanded = expandedTask === task.id;
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						display: "flex",
						alignItems: "center",
						gap: 6,
						height: 36,
						padding: "0 12px",
						borderRadius: 8,
						cursor: "pointer",
						background: expanded ? "var(--dsw-alias-interactive-bg-hover)" : void 0
					},
					onClick: () => setExpandedTask(expanded ? null : task.id),
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, {
							state: meta.state,
							size: 10
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								flex: 1,
								fontSize: 13,
								lineHeight: "20px",
								color: "var(--dsw-alias-label-secondary)",
								overflow: "hidden",
								textOverflow: "ellipsis",
								whiteSpace: "nowrap"
							},
							children: task.label
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								fontSize: 12,
								color: "var(--dsw-alias-label-caption)",
								whiteSpace: "nowrap"
							},
							children: timeText(task)
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								fontSize: 12,
								color: meta.color,
								whiteSpace: "nowrap"
							},
							children: t(meta.label)
						})
					]
				}), expanded && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						padding: "0 12px 8px 34px",
						fontSize: 12,
						lineHeight: "18px",
						color: "var(--dsw-alias-label-tertiary)",
						display: "flex",
						flexDirection: "column",
						gap: 2
					},
					children: [task.detail !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["详情：", task.detail] }), taskOutput !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							margin: "2px 0 0",
							fontSize: 11,
							lineHeight: "16px",
							fontFamily: "var(--dsh-code-font-family, ui-monospace, monospace)",
							whiteSpace: "pre-wrap",
							wordBreak: "break-word",
							maxHeight: 160,
							overflowY: "auto"
						},
						children: taskOutput
					})]
				})] }, task.id);
			};
			const card = (body) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				"data-task-status-bar": "",
				style: {
					width: `calc(100% - 2 * ${SIDE_CLEARANCE} - 4 * ${DOCK_INSET})`,
					maxWidth: `calc(${CARD_MAX} - 4 * ${DOCK_INSET})`,
					margin: "0 auto",
					border: "1px solid var(--dsw-alias-border-l1)",
					borderRadius: 12,
					background: "var(--dsw-specific-tip)",
					overflow: "hidden",
					fontSize: 13,
					fontFamily: "system-ui"
				},
				children: body
			});
			if (active.length === 1) {
				const single = active[0];
				if (single !== void 0) return card(row(single));
				return null;
			}
			return card(/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [header, open && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: {
					maxHeight: 180,
					overflowY: "auto",
					borderTop: "1px solid var(--dsw-alias-border-l1)"
				},
				children: active.map(row)
			})] }));
		}
		/** 需要此插件声明的服务：slots + locale。 */
		const inject = ["slots", "locale"];
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "task-status: dictionaries");
			ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
				name: "conversation.input.dock",
				id: "task-status",
				order: 10,
				locale: NS
			}, TaskStatusBar));
		}
		//#endregion
		exports.TaskStatusBar = TaskStatusBar;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
