import type { Context } from '@deepseek-ai/cordis'

/** 只读任务列表路由（与 client bundle 轮询地址一致）。 */
export const TASKS_PATH: string

/** 任务输出读取路由（tail：返回 shadow 缓冲累积全文，full: true 契约）。 */
export const OUTPUT_PATH: string

/** Cordis 插件名。 */
export const name: string

/** 所需服务：web 形状的 HTTP 载体 + 任务注册表 + agent 注册表。 */
export const inject: string[]

/**
 * 插件主体：打 jobs.read 镜像补丁 + 注册任务列表与输出读取路由。
 * 镜像补丁让官方 read 优先从缓冲切片（零消耗），无货回退直读（原语义）。
 */
export function apply(ctx: Context): void
