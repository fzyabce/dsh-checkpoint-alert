# Spec — settings-and-log（设置面板与日志）

## ADDED Requirements

### Requirement: 侧边栏入口与面板

客户端 SHALL 在侧边栏挂一个图标入口，点击后在主区域渲染插件页面。
面板 SHALL 分区展示：总开关、提醒类型、弹窗、声音、文案（两类各一块）、日志、帮助。
面板 SHALL 可收起（折叠分组）。
面板正文 SHALL 懒加载：首帧只渲染骨架，正文在浏览器空闲后挂载。

#### Scenario: 入口可见
- **GIVEN** 插件已激活
- **WHEN** 用户查看侧边栏面板列表
- **THEN** 能看到"人工确认提醒"入口及图标

#### Scenario: 面板懒加载
- **GIVEN** 用户点击入口
- **WHEN** 首帧渲染
- **THEN** 先出现标题与"正在加载设置面板…"
- **AND** 空闲时再渲染完整设置树，不阻塞首屏

### Requirement: 分组配置项

面板 SHALL 提供以下配置项，且每项改动即时生效：

| 分组 | 配置项 | 类型 | 默认值 |
|---|---|---|---|
| 总开关 | `enabled` | 开关 | 开 |
| 提醒类型 | `approvalEnabled` | 开关 | 开 |
| 提醒类型 | `taskDoneEnabled` | 开关 | 开 |
| 桌面通知 | `desktopNotifyEnabled` | 开关 | 开 |
| 桌面通知 | 通知权限 | 只读状态 + 申请按钮 | 跟随系统 |
| 应用内弹窗 | `popupEnabled` | 开关 | 关（兜底） |
| 应用内弹窗 | `popupPinned` | 开关（置顶） | 开 |
| 应用内弹窗 | `autoCloseSeconds` | 数字 0–600 | 20 |
| 声音 | `soundEnabled` | 开关 | 开 |
| 声音 | `soundPreset` | 枚举 `synth` / `custom` | `synth` |
| 声音 | `customSoundUrl` | 文本 | 空 |
| 声音 | `volume` | 滑块 0–100 | 60 |
| 声音 | `loopUntilAck` | 开关 | 开 |
| 文案·审批 | `approvalTitle` / `approvalMessage` / `approvalConfirmLabel` | 文本 | 见默认设置 |
| 文案·完成 | `taskDoneTitle` / `taskDoneMessage` / `taskDoneConfirmLabel` | 文本 | 见默认设置 |

#### Scenario: 两类开关独立
- **GIVEN** 用户关闭 `taskDoneEnabled`
- **WHEN** 设置被保存
- **THEN** `approvalEnabled` 仍为开

#### Scenario: 非法数值被钳制
- **GIVEN** 存储里 `autoCloseSeconds` 为 `-5` 或 `99999`
- **WHEN** 设置被加载
- **THEN** 生效值落在 `[0, 600]` 区间
- **AND** 不抛异常

#### Scenario: 未知枚举回退默认
- **GIVEN** 存储里 `soundPreset` 为 `"weird"`
- **WHEN** 设置被加载
- **THEN** 生效值为 `synth`

### Requirement: 配置持久化与迁移

设置 SHALL 持久化到 `localStorage`，键 `dsh-human-alert:settings:v1`，值里带 `version` 字段（当前为 3）。
页面刷新后 SHALL 恢复上次设置。

读到 v1 形状（只有 `popupTitle` / `popupMessage` / `confirmLabel`）时，SHALL 把它们静默迁移成
「人工审批」文案，且 SHALL NOT 触发"已回退默认值"提示。

读到 v2 形状（没有 `desktopNotifyEnabled`）时，SHALL 一次性把 `popupEnabled` 置为关闭：
v3 起桌面通知是主通道，保留应用内弹窗会让同一件事弹两个窗。文案与其它开关 SHALL 原样保留。

#### Scenario: 从 v2 升级
- **GIVEN** 本地存的是 v2 设置，`popupEnabled: true`、审批标题为「我的标题」
- **WHEN** 插件加载设置
- **THEN** `desktopNotifyEnabled` 为开、`popupEnabled` 变为关
- **AND** 审批标题仍是「我的标题」
- **AND** 不显示"数据损坏"提示

#### Scenario: 用户重新打开应用内弹窗
- **GIVEN** 用户手动打开「应用内弹窗」
- **WHEN** 刷新页面
- **THEN** 该开关保持为开（写了 `desktopNotifyEnabled` 后不再触发迁移）

#### Scenario: 刷新后保留
- **GIVEN** 用户把音量改为 80 并关闭弹窗
- **WHEN** 刷新页面
- **THEN** 音量仍为 80、弹窗仍为关闭

#### Scenario: 从 v1 升级
- **GIVEN** 本地存的是 v1 设置，标题为"我的标题"
- **WHEN** 插件加载设置
- **THEN** `approvalTitle` 为"我的标题"
- **AND** 不显示"数据损坏"提示

#### Scenario: 存储损坏时回退
- **GIVEN** localStorage 中的值不是合法 JSON
- **WHEN** 插件加载设置
- **THEN** 使用默认设置，不抛异常
- **AND** 面板显示一条"设置已重置"提示

#### Scenario: 存储不可用
- **GIVEN** 浏览器禁用 localStorage
- **WHEN** 用户修改设置
- **THEN** 设置在当前页面会话内生效
- **AND** 面板提示"本次不保存"

### Requirement: 提醒日志

客户端 SHALL 记录每次提醒触发：时间、类型（`approval` / `taskDone`）、来源（工具审批 / 提问 / 轮次结束）、
工具名、会话 id、是否测试。SHALL NOT 记录提问正文或任何对话内容。
日志 SHALL 以环形缓冲保存，上限 200 条，超出丢弃最旧的；界面 SHALL 只渲染最近 50 条。
日志 SHALL 持久化到 `localStorage`，键 `dsh-human-alert:log:v1`。

#### Scenario: 记录一次审批提醒
- **GIVEN** 一次审批触发了提醒
- **WHEN** 用户打开日志区
- **THEN** 出现一条记录，含本地时间、标记"【人工审批】"、来源与工具名

#### Scenario: 记录一次任务完成
- **GIVEN** 一轮任务正常跑完
- **WHEN** 用户打开日志区
- **THEN** 出现一条记录，标记"【任务完成】"，颜色与审批不同

#### Scenario: 两类标记可区分
- **GIVEN** 日志里同时有审批与完成记录
- **WHEN** 用户浏览列表
- **THEN** 两条的类型标记文案与配色都不同

#### Scenario: 超出上限裁剪
- **GIVEN** 日志已有 200 条
- **WHEN** 新增第 201 条
- **THEN** 保留最新 200 条，最旧一条被丢弃
- **AND** 界面最多渲染 50 条

#### Scenario: 清空日志
- **GIVEN** 日志有多条记录
- **WHEN** 用户点击"清空日志"
- **THEN** 日志清空且持久化状态同步清空

### Requirement: 启动性能

`apply()` SHALL NOT 在同步路径上读 `localStorage`、发网络请求或创建 `AudioContext`（也不得创建通知对象）。
初始化 SHALL 推迟到浏览器空闲（`requestIdleCallback`，兜底 `setTimeout`）。
状态同步 SHALL 用长轮询（见 alerting spec）：页面隐藏时连接挂着、不产生定时器工作；
退化轮询模式下失败 SHALL 指数退避到 10 秒。

#### Scenario: 启动不阻塞
- **GIVEN** 页面刚加载
- **WHEN** 插件被激活
- **THEN** 同步阶段没有存储读取与状态请求
- **AND** 空闲后才 hydrate 并建立第一个长轮询

#### Scenario: 后台不产生定时器工作
- **GIVEN** 页面切到后台
- **WHEN** 状态没有变化
- **THEN** 只有一条挂起的长轮询连接，没有每秒触发的定时器

### Requirement: 帮助说明区

面板 SHALL 包含帮助区，说明：两类提醒何时触发、子 agent 与取消/报错为何不提醒、两类如何区分、
通知长什么样/为什么最小化也能提醒、插件是否替人做决定、数据存在哪里、如何完全关闭。

#### Scenario: 帮助可读
- **GIVEN** 用户首次使用
- **WHEN** 展开帮助区
- **THEN** 能看到上述说明

### Requirement: 视觉与可访问性

样式 SHALL 只使用宿主主题 token（`--dsw-alias-*`、`--dsw-elevation-*`、`--dsw-radius-*`），不写死颜色（图标 artwork 除外）。
开关 SHALL 带 `role="switch"` 与 `aria-checked`。
弹窗 SHALL 支持 Escape 关闭并把焦点移到确认按钮，SHALL 带 `role="alertdialog"` 与 `aria-modal`。
所有交互控件 SHALL 有可读标签。

#### Scenario: 深色主题
- **GIVEN** 宿主切到深色主题
- **WHEN** 面板与弹窗渲染
- **THEN** 文字与背景对比正常，无写死颜色造成的突兀色块

#### Scenario: 键盘关闭弹窗
- **GIVEN** 弹窗展示中
- **WHEN** 用户按 Escape
- **THEN** 弹窗关闭、声音停止
