/**
 * dsh-human-alert 的类型声明。
 *
 * 刻意只用 `any` 而不从 `@deepseek-ai/cordis` 引入 Context：
 * 引入会在消费方的编译期制造 peer 依赖，而本插件的宿主侧代码对 ctx 的
 * 使用面很窄（on / effect / inject / logger / get），用结构化描述即可。
 */

/** 插件名，与 package.json 的 name 一致。宿主用它把 bundle 行与模块对上。 */
export declare const name: 'dsh-human-alert'

/**
 * 插件入口。
 *
 * 只做三件事：订阅会话事件（审批 / 提问 / 一轮正常完成）、折叠成一份快照、
 * 用一条 HTTP 路由把快照交给浏览器端。不修改事件、不调用 approval / userQuestions 的写方法。
 *
 * 宿主侧启动开销是 O(1) 且无 I/O；客户端半侧（./client）的存储读取、轮询与音频
 * 都在浏览器空闲时惰性初始化。
 */
export declare function apply(ctx: any): void
