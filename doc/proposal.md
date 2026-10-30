# Proposal — dsh-human-alert（人工确认提醒插件）

## 1. 动机

DSH 的自动化任务流在多数时候不需要人盯着。但当 agent 走到**需要人拍板**的节点时，它会停下来等人：

- 工具调用需要审批（`approval/asked`）
- agent 调用 `ask_user_question` 提问（`tool/call` + 工具名 `ask_user_question`）

实际使用中，这两个时刻恰恰是最容易错过的：用户切到别的窗口干活，回来才发现任务已经空等了几十分钟。DSH 自带的界面提示只在当前页面可见，没有声音、没有持续提醒，也没有"我等了多久"的记录。

本插件补的就是这一段：**需要人工确认时主动叫人**，且不改变 DSH 任何自动流程。

## 2. 目标

| 编号 | 目标 |
|---|---|
| G1 | 在"需要人工确认/人为判定"的节点触发提醒，且**不干扰**自动任务流 |
| G2 | 双通道提醒：**系统桌面通知**（右下角、不抢焦点、DSH 最小化也可见）+ 可循环的声音 |
| G3 | 侧边栏设置面板：两类独立开关、提示音、音量、倒计时、文案自定义 |
| G4 | 提醒日志：记录历次触发时间与对应任务信息 |
| G5 | 配置持久化到本地存储 |
| G6 | 一键测试按钮，验证通知+声音效果 |
| G7 | 解耦、不侵入 DSH 核心，代码结构规范、注释清晰 |

## 3. 非目标（本期明确不做）

- **不做** 另开一个原生置顶窗口。v0.3 起提醒改为**操作系统通知**（`window.Notification`）——
  它由系统渲染、天然置顶且不抢焦点，但插件不会自己创建/管理原生窗口，也不会调用 Electron 主进程 API。
  代价：DSH 进程完全退出后没有进程能提醒。
- **不做** 远程推送（邮件/IM/手机）。需要额外凭据与服务端，超出本期范围。
- **不做** 替用户回答审批或问题。插件只提醒，绝不代替人做决定。
- **不做** 历史日志的跨设备同步。日志存浏览器本地存储，换浏览器即清空。

## 4. 约束（来自 DSH 官方插件契约）

这些是硬约束，设计必须满足，否则插件装不上或会被宿主自动禁用：

- C1 插件 = 模块导出 `name` + `apply(ctx)`；一切注册走 `ctx.effect()`/disposer。
- C2 UI 只能在 **slot** 里渲染 React 组件；禁止 iframe 托管页面、禁止 `require` Harness 客户端包、禁止在组件外写 DOM、禁止向 `document.body` 追加。
- C3 样式只用主题 token（`--dsw-alias-*` / `--dsw-elevation-*`），不写死颜色。
- C4 `dsh.client.inject` 必须是**静态数组**（写成函数会让整个 bundle 被自愈机制禁用）。
- C5 客户端产物必须是 lazy-CJS factory 格式（`window.__ModuleLoader__.load({id, factory})`）。
- C6 共享实例的 `@deepseek-ai/*` 包只能进 peerDependencies，不能进 dependencies。
- C7 监听 `session/event` 是只读通道；**不得**在 `approval/request` 里短路（不调 `next()` 等于抢走决策权）。

## 5. 触发面的事实依据（已验证）

不是照文档猜的，是对已安装插件 `dsh-whale-widget` 宿主产物与宿主 `app.asar` 做字符串普查得到的：

| 事实 | 证据 |
|---|---|
| `session/event` 携带 `event.type` | whale-widget `lib/index.js` 内 `ctx.on('session/event', (session, event) => …)` |
| `approval/asked` 是审批事件 | 同上，`if (type === 'approval/asked')` |
| `ask_user_question` 是提问工具名 | 同上，`WAIT_QUESTION_TOOL = 'ask_user_question'` |
| `shell.overlay` / `sidebar.panellist` / `main` slot 存在 | 对 `app.asar` 计数：46 / 13 / 549 |
| `__ModuleLoader__` 客户端加载器存在 | 89 处 |
| 主题 token 存在 | `dsw-alias-` 3056 处、`dsw-elevation-` 98 处 |

## 6. 验收标准

1. 装上 profile 后，`main` 面板里能看到插件页面，设置项可改并**刷新后仍保留**。
2. 触发一次真实审批/提问，弹窗与声音出现；点击"我知道了"后停止。
3. 日志区出现对应记录（时间、类型、工具名、会话）。
4. 关闭总开关后不再提醒；关闭弹窗只留声音、关闭声音只留弹窗，均符合预期。
5. 纯逻辑单元测试全绿；`plugin_check` 与 `dsh-plugin-dev check` 无 error。
6. 全程不改 DSH 任何核心文件，卸载后零残留。
