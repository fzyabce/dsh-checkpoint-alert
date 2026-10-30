# Spec — human-confirm-detection（人工确认节点检测）

## ADDED Requirements

### Requirement: 检测审批请求

宿主 SHALL 通过只读监听 `session/event`，在 `event.type === 'approval/asked'` 时记录一条待确认项。

待确认项 SHALL 包含：唯一 id、类型 `approval`、触发时间戳、会话 id、工具名（若 payload 提供）、原因文案（若 payload 提供）。

#### Scenario: 审批事件产生待确认项
- **GIVEN** 插件已激活，某会话正在运行工具调用
- **WHEN** 宿主追加 `approval/asked` 事件，payload 含 `id` 与 `toolName`
- **THEN** 该会话的 pending 列表新增一条 `{ kind: 'approval' }` 记录
- **AND** 记录里的 `toolName` 与 payload 一致

#### Scenario: payload 字段缺失时不崩溃
- **GIVEN** 插件已激活
- **WHEN** 收到 `approval/asked` 但 payload 缺少 `id`
- **THEN** 插件使用回退 id（按会话+时间戳生成）
- **AND** 不抛异常、不影响其它会话状态

### Requirement: 检测用户提问

宿主 SHALL 在 `event.type === 'tool/call'` 且工具名为 `ask_user_question` 时记录一条待确认项，类型为 `question`。

#### Scenario: 提问工具被调用
- **GIVEN** 插件已激活
- **WHEN** 收到 `tool/call`，`data.name === 'ask_user_question'`
- **THEN** pending 列表新增一条 `{ kind: 'question' }` 记录

#### Scenario: 其它工具调用不触发
- **GIVEN** 插件已激活
- **WHEN** 收到 `tool/call`，`data.name === 'read_file'`
- **THEN** 不新增任何待确认项

### Requirement: 检测任务完成

宿主 SHALL 在 `event.type === 'turn/end'` 且 `event.data.reason.kind === 'completed'` 时追加一条完成记录，
记录 SHALL 包含单调递增的 `seq`、时间戳、会话 id、轮次号。

宿主 SHALL NOT 把取消、报错、被拦截、超出 token 上限、被中断的 turn 算作任务完成。
宿主 SHALL 通过 `/state` 返回 `completions`（最近 20 条）与 `completionSeq`。

#### Scenario: 一轮正常跑完
- **GIVEN** 插件已激活，某根会话正在跑任务
- **WHEN** 宿主追加 `turn/end`，`reason.kind === 'completed'`
- **THEN** 完成记录里新增一条，`seq` 比上一条大 1
- **AND** `/state` 的 `completions` 能看到它

#### Scenario: 取消或报错不算完成
- **GIVEN** 插件已激活
- **WHEN** `turn/end` 的 `reason.kind` 为 `aborted` / `error` / `blocked` / `max-tokens` / `interrupted`
- **THEN** 不新增完成记录

#### Scenario: 子 agent 的轮次结束不提醒
- **GIVEN** 某子 agent 会话（`session.header.origin === 'subagent'`）正在跑
- **WHEN** 它追加 `turn/end` 且原因为 `completed`
- **THEN** 不新增完成记录（内部实现细节，不该打断用户）
- **AND** 该子 agent 的 `approval/asked` 仍然产生待确认项

### Requirement: 会话 id 解析

宿主 SHALL 优先使用 `session.header.id` 作为会话 id，其次 `session.id`、`session.sessionId`，都取不到才回落到 `default`。

#### Scenario: 两个真实会话不互相覆盖
- **GIVEN** 两个会话的 id 都只在 `header.id` 上
- **WHEN** 各自产生一条审批
- **THEN** 待确认列表里出现两条，`sessionId` 各不相同

### Requirement: 清除已解决的待确认项

宿主 SHALL 在 `approval/decided`（对应审批）或 `tool/result`（对应提问）到达时移除相应待确认项。

#### Scenario: 审批有了结果
- **GIVEN** pending 中有一条 id 为 `A1` 的审批项
- **WHEN** 收到 `approval/decided`，payload `id === 'A1'`
- **THEN** 该条被移除
- **AND** 其它待确认项不受影响

#### Scenario: 提问有了结果
- **GIVEN** pending 中有一条 callId 为 `C1` 的提问项
- **WHEN** 收到 `tool/result`，callId 为 `C1`
- **THEN** 该条被移除

#### Scenario: 无法匹配的结果事件
- **GIVEN** pending 为空
- **WHEN** 收到任意 `approval/decided`
- **THEN** 状态保持不变，不报错

### Requirement: 不干扰自动任务流

插件 SHALL NOT 修改任何事件、SHALL NOT 在 `approval/request` 等 waterfall 事件中短路、SHALL NOT 调用 `next()` 之外的分支。

#### Scenario: 只读监听
- **GIVEN** 插件已激活且某个工具调用需要审批
- **WHEN** 审批流程走完
- **THEN** 审批结果与未安装插件时完全相同
- **AND** 插件未调用任何 `approval` 服务方法

### Requirement: 会话隔离与清理

pending 状态 SHALL 按会话 id 分桶；会话销毁时 SHALL 清除该会话全部状态，包括完成记录里该会话的行。
完成序号 SHALL NOT 回收（避免客户端把旧边沿当成新边沿）。

#### Scenario: 两个会话互不干扰
- **GIVEN** 会话 S1 有 1 条待确认项
- **WHEN** 会话 S2 产生一条待确认项
- **THEN** 两个会话各自持有自己的列表

#### Scenario: 会话销毁清理
- **GIVEN** 会话 S3 有 2 条待确认项
- **WHEN** 收到 `session/disposed`
- **THEN** S3 的状态被删除
- **AND** 内存不残留该会话引用
