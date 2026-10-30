# dsh-human-alert v0.2.0 改动说明

对应本轮三点迭代需求：**两类提醒区分 / 审批弹窗 bug / 启动性能**。
版本：`0.1.0` → `0.2.0`，客户端产物 `client.js` 已重新构建入库。

---

## 1. 两类提醒：【人工审批】与【任务完成】

### 1.1 触发面（宿主侧）

| 类型 | 事件 | 判定 | 语义 |
|---|---|---|---|
| `approval` | `approval/asked` | 直接命中 | 工具调用等人审批 |
| `approval`（来源 `question`） | `tool/call` + `name === 'ask_user_question'` | 直接命中 | agent 向你提问，同样是人卡住了 |
| `taskDone` | `turn/end` | `reason.kind === 'completed'` | 一轮任务正常跑完 |

刻意排除的：

- `turn/end` 的 `aborted` / `error` / `blocked` / `max-tokens` / `interrupted` —— 这些不是「完成」；
- 子 agent 会话（`session.header.origin === 'subagent'` 或带 `parentSession`）的 `turn/end`
  —— 内部轮次结束不该打断用户。但**子 agent 的审批仍然提醒**（人还是得拍板）。

### 1.2 三条独立通道

| 通道 | 实现 |
|---|---|
| 独立开关 | `settings.approvalEnabled` / `settings.taskDoneEnabled`，各自都不影响对方；总开关 `enabled` 仍然在最上层 |
| 独立文案 | `approvalTitle/approvalMessage/approvalConfirmLabel` 与 `taskDoneTitle/taskDoneMessage/taskDoneConfirmLabel`，面板里两块编辑区 |
| 日志标记 | 日志条目 `kind: 'approval' 或 'taskDone'`，界面用 `kindTag()` 输出 `【人工审批】/【任务完成】`，并用警示色 / 成功色区分 |

### 1.3 「任务完成」为什么不用 pending 列表

pending 表达的是**持续状态**（"现在还有人要处理"），完成是**一次性边沿**（"刚刚这一轮结束了"）。
用状态表达边沿，1 秒一次的轮询会漏（连续两轮之间状态又变回去了）。

所以宿主给每条完成记录分配单调递增的 `seq`，并保留最近 `COMPLETION_KEEP = 20` 条：

```
GET /dsh-human-alert/state
{ ok, updatedAt, pending: [...], completions: [{ seq, at, sessionId, turn }], completionSeq: 12 }
```

客户端规则：

- 首帧只把 `max(seq)` 记成基线，**不补弹历史**（打开页面不该被旧完成刷屏）；
- 之后只处理 `seq > 上次基线` 的记录；
- 宿主重启导致 `seq` 回退时重建基线，不把旧记录当新边沿。

---

## 2. 修复「审批只有声音、不弹出弹窗」

### 2.1 根因（已用宿主真实代码证实）

`shell.overlay` 在宿主里是 **list** 类型的 slot，标识符是 `id`；`main` 是 keyed，用 `key`。
v0.1 把 `shell.overlay` 也写成了 `key`：

```js
// v0.1（错误）
ctx.slots.register({ name: 'shell.overlay', key: PLUGIN_NAME, order: 100 }, AlertPopup)
```

宿主 slot 实现的校验（`@deepseek-ai/dsh-client-ui-slots`）：

```js
case 'list': {
  if (options.id === void 0) throw new Error(`list slot "${options.name}" requires options.id`)
  ...
}
```

于是注册直接抛错、组件从未挂载 —— 没有任何弹窗；而声音走的是 `store.fire()` 里的另一条路径，
所以用户听到的只有声音。测试按钮其实也一样（同一个 `fire`），这也解释了为什么"测试也没窗"。

**验证证据**（用宿主 asar 里抽出的真实 `SlotCore` 跑）：

```
id registration: OK
key registration throws: list slot "shell.overlay" requires options.id
entries: 1 [ 'dsh-human-alert' ]
```

### 2.2 修复

```js
// v0.2
const SLOT_CONTRACT = { 'sidebar.panellist': 'id', main: 'key', 'shell.overlay': 'id' }
registerSlot(ctx, store, 'shell.overlay', { id: PLUGIN_NAME, order: 100 }, Popup)
```

配套三件事：

1. **注册失败可见**：`registerSlot()` 把异常写进 store，面板顶部直接显示
   `shell.overlay 注册失败：…`，不再静默消失（这次 bug 之所以难查，就是因为被吞了）。
2. **弹窗优先于声音**：`fire()` 先把提醒放进弹窗队列，再 `try { audio.start() } catch {}`。
   音频子系统抛错（无设备、自动播放被拦、AudioContext 数量超限）再也无法吞掉弹窗。
3. **弹窗队列**：审批与完成同一批到达时，审批先弹、完成排队；关掉当前弹窗后队长顶上，
   两类提醒都不会被后来的覆盖掉（队列上限 5）。

回归用例：

- `覆盖层用 list slot 的 id 注册（v1 "只有声音没弹窗"的回归用例）`
- `声音报错不影响弹窗（"只有声音没弹窗"的反向回归）`
- `同一批里两类提醒都会弹：审批在前，完成排队等待`

---

## 3. 启动性能

### 3.1 之前慢在哪

| 位置 | 问题 |
|---|---|
| `apply()` | 同步 `store.hydrate()`：读 + `JSON.parse` 两块 localStorage |
| `apply()` | 同步 `startPolling()`：首轮 `fetch` 立刻发出，和宿主引导抢主线程 |
| 音频 | 每次 `apply` 都构造引擎对象（AudioContext 虽惰性，但监听/闭包在启动路径上） |
| 面板 | 一打开就把 8 个分组 + 日志列表全部算完 |
| 轮询 | 页面在后台也每秒一次；失败也每秒重试 |
| 日志 | 上限只在写入时裁剪，渲染没有上限 |

### 3.2 现在

| 项 | 做法 |
|---|---|
| 初始化 | `apply()` 只做「建 store + 注册 3 个薄组件 + 挂 2 个监听」；`hydrate()` 与轮询启动包进 `requestIdleCallback(…, {timeout:1200})`（不支持则 `setTimeout 0`） |
| 音频 | `createAudioEngine()` 不建 AudioContext；首次真正要响、或用户首次 pointerdown/keydown 时才创建，且全部包 `try/catch` |
| 侧边栏渲染 | 面板先渲染骨架（标题 + 状态条 + "正在加载设置面板…"），正文 idle 后再挂载；日志只渲染最近 `LOG_RENDER_LIMIT = 50` 条 |
| 轮询 | 首次请求延后 1s；`document.visibilityState === 'hidden'` 时**完全停轮询**，切回可见立刻补一次；失败按 1s→2s→4s→8s→10s 退避 |
| 轮询开销 | `pending` 用签名比对，内容没变不 `set()`，不会每秒让面板整体重渲染 |
| 日志上限 | 存储/内存 `LOG_LIMIT = 200`；界面 `LOG_RENDER_LIMIT = 50`；"已提醒"集合 `ALERTED_MAX = 200`（FIFO 淘汰） |
| 宿主侧 | 启动只建空对象 + 两个只读监听 + 一条路由，无 I/O；折叠是纯函数 |

数字上的直观结论：启动路径上的同步工作从「2 次 localStorage 读写 + 1 次 fetch + 音频初始化 + 整页设置树」
降到「几个对象与函数注册」；其余都在首帧之后的空闲时间片里完成。

---

## 4. 顺手修掉的两处问题

1. **会话 id**：v0.1 只读 `session.id`，而宿主真实形状是 `session.header.id`，
   导致所有会话折叠进 `'default'` 一个桶（多会话并行会互相覆盖）。
   现在依次尝试 `header.id` → `id` → `sessionId`。
2. **日志隐私**：v0.1 把 `item.reason` 写进日志，而提问类型的 `reason` 是**提问正文**。
   现在 pending 日志不写 reason（只留类型、来源、工具名、会话），读回旧日志时也会把 `reason` 清空。

---

## 5. 兼容与迁移

| 数据 | 处理 |
|---|---|
| `dsh-human-alert:settings:v1` | 键名不变（改键等于清零老用户设置），值里 `version` 升到 2。读到 v1 形状时把 `popupTitle/popupMessage/confirmLabel` **静默迁移**成「人工审批」文案，且**不**触发"数据损坏"提示 |
| `dsh-human-alert:log:v1` | `version` 升到 2。v1 的 `question` 条目迁移成 `approval` + `via: 'question'`，同样不报"已回退默认值" |
| 旧客户端 / 旧宿主混跑 | 新版客户端读不到 `completions` 字段时按空处理（任务完成不提醒，审批照旧）；新版宿主多给的字段旧客户端会忽略 |

---

## 6. 文件改动清单

| 文件 | 改动 |
|---|---|
| `lib/shared/defaults.mjs` | v2 设置：两类开关 + 两套文案；`alertCopy()`；v1→v2 文案迁移；`SETTINGS_VERSION = 2` |
| `lib/shared/logbuf.mjs` | `taskDone` 类型；`kindTag()` / `describeVia()`；`LOG_RENDER_LIMIT`；v1 `question` 迁移；迁移不算"损坏"；读回时清空 `reason` |
| `lib/shared/fold.mjs` | 新增 `completions` / `completionSeq` 边沿；`turn/end` 只认 `completed`；子 agent 过滤；完成记录上限与会话销毁清理 |
| `index.js` | `sessionIdOf` 读 `header.id`；`isSubagentSession`；`/state` 增加 `completions` / `completionSeq` |
| `src/client.template.js` | 两类提醒与独立文案；**弹窗注册改用 `id`**（+ 注册失败可见）；弹窗队列；弹窗先于声音；启动懒加载；轮询可见性/退避；日志三层上限；`__internals` 测试句柄 |
| `client.js` | 重新构建（v2 产物） |
| `package.json` / `locale/*.json` | 版本、展示名与简介 |
| `tests/*.test.mjs` | 107 个用例（新增两类提醒、边沿基线、队列、slot 契约、懒加载、日志上限、迁移、跨两半契约等） |
| `README.md`、`doc/*` | 行为、配置、原理、边界、验收清单同步 |

---

## 7. 验证

```text
$ node --test tests/
ℹ tests 107
ℹ pass 107
ℹ fail 0
```

- 客户端用例**加载的是真实的 `client.js` 产物**（不是模板），用假 `__ModuleLoader__` / 假 React / 假
  `localStorage` 驱动，覆盖：外壳格式、只 require react、三个 slot 的标识符契约、启动零 I/O、
  idle 后才初始化、隐藏页不轮询、卸载停止轮询、两类提醒弹窗与日志、首帧基线、宿主重启、队列、音频报错、
  分类开关、日志上限、持久化、存储不可用降级。
- 跨两半契约用例（`tests/integration.test.mjs`）把宿主 `index.js` 折叠出的 JSON 直接喂给客户端
  `client.js`，验证字段名没有漂移、两类提醒端到端都弹得出来。
- slot 契约用宿主 asar 里的真实 `SlotCore` 单独验证过（见 §2.1）。
- 宿主状态接口在本机真实进程上探测过：
  `/dsh-human-alert/health` → `{"ok":true,"plugin":"dsh-human-alert"}`。
- 客户端产物已被运行中的宿主按需提供：`/plugins/??dsh-human-alert/client.js&rev=…` 返回 200、约 74 KB，
  内容是 v0.2（含 `【任务完成】` 与 `shell.overlay` 的 `id` 注册）——**刷新页面即可加载新客户端**，
  但宿主半侧（`completions` 字段）仍需重启 DSH。
- `plugin_check` → pass（20 项：19 通过 / 0 失败 / 1 跳过）；`dsh-plugin-dev check` → OK。

### 还需要你做的（自动化覆盖不到）

1. **重启 DSH**：宿主侧 `index.js` 是进程内缓存的，新代码要重启才载入
   （当前运行中的进程仍在跑旧版：`/state` 里还没有 `completions` 字段）。
2. **刷新页面**：浏览器端 `client.js` 随页面启动加载。
3. 按 `doc/usage.md` §6 的清单肉眼验收，重点两条：
   - 点「测试审批」/「测试完成」，**两种都能弹出弹窗** + 听到声音；
   - 触发一次真实操作审批，看到 `【人工审批】` 弹窗；等一轮任务跑完，看到 `【任务完成】` 弹窗。
