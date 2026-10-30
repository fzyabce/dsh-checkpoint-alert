# Design — dsh-human-alert

## 1. 架构总览

```
┌─────────────────────── Host（Node / Cordis）───────────────────────┐
│                                                                    │
│  index.js  (name + apply)                                          │
│    ├── ctx.on('session/event')  ──►  lib/shared/fold.mjs (纯函数)   │
│    │        折叠 approval/asked / ask_user_question / 清除事件       │
│    │        + turn/end(completed) 完成边沿（seq 单调）               │
│    │        得到 per-session 的 pending 与 completions              │
│    │                                                               │
│    └── ctx.effect → webServer.register( GET /dsh-human-alert/{state,wait} ) │
│         /state        一次性快照（手工排查）                        │
│         /wait?since=N 长轮询：状态一变立刻回包（含 revision）       │
│                        返回 { ok, revision, updatedAt, pending[],   │
│                               completions[], completionSeq }        │
└────────────────────────────────┬───────────────────────────────────┘
                                 │ HTTP GET（同源，Connection 校验）
┌────────────────────────────────▼───────────────────────────────────┐
│                   Client（浏览器 / Cordis）                         │
│                                                                    │
│  client.js  (lazy-CJS factory)                                     │
│    ├── slots: main ─────────────► <AlertPanel/>   设置 + 日志       │
│    ├── slots: shell.overlay ────► <AlertPopup/>   应用内兜底弹窗     │
│    ├── 系统通知（Notification）──► 右下角独立通知（主通道）          │
│    └── 长轮询订阅 ──► 新 pending / 新完成 seq?                       │
│                     ──► 系统通知 + 声音 + 日志                       │
│                                                                    │
│  持久化：localStorage（设置 + 日志环）                              │
└────────────────────────────────────────────────────────────────────┘
```

**为什么"宿主算、客户端渲染"**：官方防御性模式要求客户端不要自己 fold 会话事件。本设计里折叠在宿主完成（`fold.mjs`），客户端只拿"算好的结果"，符合该约束的意图。客户端也不是直接拉会话日志，而是拉一个专为本插件计算的提醒快照。

## 2. 关键取舍

### 2.1 数据通道：自建 exact route + 轮询，而不是 session projection

| 方案 | 结论 |
|---|---|
| `sessionProjections` + `wire.view` | 文档推荐路径，但 `wire.view` 的具体用法只有片段，且 projection 是**会话作用域**；`shell.overlay` 未必带 session 标准 prop，`useProjection` 在弹窗里可能拿不到。 |
| `@Remote({mode:'stream'})` | 需要 Typert 代码生成 + 客户端装配侧主动选择命名空间，**第三方插件无法自行完成**，排除。 |
| **exact route + 长轮询（选用）** | `ctx.webServer.register` 是已安装插件在用的真实 API；长轮询在本机回环上几乎零成本，且不依赖定时器（见 §2.11）；失败可降级、易观测。 |

代价：浏览器里长期挂一条 HTTP 连接（宿主 20 秒回一次空包刷新）。用 `ctx.effect` 包住，插件卸载即 abort。

### 2.2 侧边栏：`sidebar.panellist` + `main`，不用 `sidebarRightTabs`

`sidebarRightTabs.register` 是为"文件/地址查看器"设计的：必须给 `kind`、`patterns`、`canOpen(address)`，而我们的设置页没有"地址"概念，硬套需要伪造一个伪地址，脆且无意义。

`sidebar.panellist`（在侧边栏挂一个图标入口）+ `main`（渲染整页）是已安装插件 `@furongjun1999/dsh-memory` 在同版本宿主上跑通的路径，注册形状最小：

```js
ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'human-alert' }, Panel))
ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
  { name: 'sidebar.panellist', id: 'human-alert', order: 20, label: '人工确认提醒' }, Icon))
```

用户需求原文允许"嵌入 / 独立悬浮侧边栏均可"，此为"嵌入"形态。

### 2.3 弹窗：`shell.overlay` + 面板内兜底

`shell.overlay` 是覆盖层 slot（宿主产物计数 46 证实存在），组件内用 `position: fixed` + 高 z-index + 半透明遮罩实现"置顶弹窗"。

**风险与兜底**：`shell.overlay` 的注册形状（是否需要 `order`/`key`）文档未给出确切签名。因此 `main` 面板内**同时**渲染一条紧凑提醒条（inline banner），即使 overlay 注册未生效，用户仍能在面板里看到待确认项。两者不重复打扰：overlay 正常时，面板条只是常驻状态显示。

### 2.4 声音：Web Audio 合成音 + 可选自定义音频

官方**没有**音频 seam（查遍文档只有语音输入的采集，没有播放）。因此用浏览器 API：

- 内置提示音用 `OscillatorNode` 合成三音上行（零资源、零版权风险、可无限循环）
- 自定义：填音频 URL，用 `Audio` 元素循环播放
- 音量 0–100 → 合成音走 `GainNode`，音频元素走 `.volume`
- 浏览器自动播放策略：首次交互前 `AudioContext` 可能是 `suspended`，代码里在首次点击时 `resume()`

### 2.5 持久化：localStorage

用户明确要求"本地存储"。无官方客户端存储 seam（文档明确 `ctx.storage` 是宿主侧服务），localStorage 是浏览器原生能力，不受插件红线约束（红线管的是 DOM 与模块依赖）。

键：`dsh-human-alert:settings:v1`、`dsh-human-alert:log:v1`。带版本号，便于将来迁移。写入做防御：`JSON.parse` 失败回落默认值，读到脏数据不抛错。

### 2.6 状态接口的访问校验：不用宿主的特权路由 fence

`GET /dsh-human-alert/state` 是只读状态源，只喂给同源 Web 客户端。校验规则自己实现：

1. 对端必须是回环地址（`127.0.0.0/8` / `::1`）——别的机器读不到；
2. `Host` 头必须是本机名——防 DNS rebinding；
3. `sec-fetch-site` 明确跨站、或 `Origin` 与 `Host` 不一致 → 拒绝。

**为什么不用 `ctx.get('connection').requestRejection(req)`**：那是给带浏览器认证凭据的特权路由
设计的 fence。用在只读轮询接口上，实测结果是**任何浏览器之外的请求一律 403**（含自动化测试），
于是"到底通不通"无法在安装后从外部证明，功能坏了也只会表现为界面静默不提醒。
换成自洽的几何校验后，`curl`/`fetch` 就能验证整条链路，同时安全性仍限定在回环 + 同源。

代价：本机上的其它进程可以读到待确认列表（工具名 + 会话 id）。这与宿主自身在缺少
`connection` 服务时采用的规则同一量级，且本插件不记录对话内容，可接受。

### 2.7 slot 标识符契约（v0.2 修复的弹窗 bug）

宿主 slot 有三种需要标识符的形态，**用错就是注册抛错、组件永不挂载**：

| slot | kind | 标识符 | 说明 |
|---|---|---|---|
| `main` | keyed | `key` | 一个 key 一个主面板 |
| `sidebar.panellist` | list | `id` | 一个 id 一个入口 |
| `shell.overlay` | list | `id` | 一个 id 一个覆盖层条目 |

v0.1 把 `shell.overlay` 写成了 `key`，宿主 slot 实现直接抛
`list slot "shell.overlay" requires options.id`。这个异常被 slot 框架吞掉，
最终表现是"有声音、没有弹窗"（声音走 store 的另一条路径）。

v0.2 的做法：

1. 用常量 `SLOT_CONTRACT` 把三类 slot 的标识符写死在一处，单测逐个核对；
2. `registerSlot()` 包住注册，异常写进 store，面板顶部显示具体原因 —— **失败必须可见**；
3. 弹窗先入队再放声音，音频异常不许吞掉弹窗。

### 2.8 启动性能：把重活挪出启动路径

| 工作 | v0.1 | v0.2 |
|---|---|---|
| 读 localStorage | `apply()` 内同步 | `requestIdleCallback`（timeout 1200ms） |
| 首轮轮询 | `apply()` 内立即 fetch | idle 后启动，首轮再延后 1s |
| AudioContext | 引擎对象随 apply 创建 | 首次真要响 / 首次用户手势才创建 |
| 侧边栏面板 | 打开即渲染全部 | 先骨架，正文 idle 后挂载；日志只渲染 50 条 |
| 后台标签页 | 照常每秒轮询 | 完全暂停，恢复可见立刻补一次 |
| 轮询失败 | 每秒重试 | 1s→2s→4s→8s→10s 退避 |
| 日志上限 | 仅写入时裁剪 | 存储 200 / 内存 200 / 渲染 50；"已提醒"集合 200 封顶 |

取舍：首次轮询最多晚约 2.2 秒（idle + 1s）。插件是"人来处理时提醒"，这点延迟换来的是
启动阶段零 I/O，值得。页面从后台切回时会立刻补一次，补上这段时间。

### 2.9 两类提醒的数据模型

`approval` 是**持续状态**（pending 列表，决定"人欠我多少个处理"）；
`taskDone` 是**一次性边沿**（`completions` + 单调 `completionSeq`，决定"刚刚发生了什么"）。

用状态表达边沿会漏：两轮连续完成之间 pending 没有变化，1 秒轮询只看到最终状态。
所以完成记录带 `seq`，客户端只消费比自己基线大的序号；首帧只建基线不补弹，
宿主重启导致序号回退时重建基线。

### 2.10 桌面系统通知：为什么不是"再开一个窗口"

需求是"右下角独立弹窗、脱离 DSH 主窗口、不抢焦点、最小化也可见"。两条路：

| 方案 | 代价 | 结论 |
|---|---|---|
| 宿主侧 `new BrowserWindow({ alwaysOnTop: true })` | 需要在插件里调 Electron 主进程 API、自己画 UI、自己管生命周期；窗口会抢注意力，`alwaysOnTop` 还会盖住用户正在看的其它窗口；插件契约里也没有这条缝 | 不做 |
| **系统通知（`window.Notification`）** | 由操作系统渲染；DSH 侧只调一个标准 Web API | 采用 |

系统通知天然满足：右下角（Windows toast / macOS 通知中心）、置顶于所有窗口、**不激活窗口**、
DSH 最小化/被遮挡仍显示、点击才回到 DSH。同类用 `tag` 去重，避免堆成一串。

代价（写进边界）：**DSH 进程完全退出后没有进程能提醒**；系统"专注助手/勿扰"会压掉 toast。

权限：Electron 渲染进程默认 granted；普通浏览器需要用户手势里 `requestPermission()`，
所以申请只发生在点击（面板按钮 / 测试按钮 / 页面首次点击）。拿不到权限不是错误——
按 §2.10.1 回退。

### 2.10.1 通道优先级与兜底

```
桌面通知开? ──是──► 弹系统通知 ──成功──► 应用内弹窗开? ──是──► 再弹一个（系统通知静音）
   │                    │                                                │
   否                   └──失败（无权限/不支持/抛错）──► 应用内弹窗兜底
   │                                                                    │
   └──────────────► 应用内弹窗开? ──是──► 直接弹 ◄──────────────────────┘
```

- 两个通道都开：系统通知 `silent: true`，由插件自己响铃（否则两声）。
- 只开桌面通知：声音交给系统提示音（页面隐藏时 Web Audio 可能被挂起）。
- 系统通知失败：**一定**回退应用内弹窗 —— "什么都没出现"比"多一个窗"糟得多。

### 2.11 最小化也能唤醒：长轮询而不是定时轮询

浏览器对后台页面的定时器有节流：隐藏约 5 分钟后，链式 `setTimeout` 可被压到**每分钟一次**。
如果靠轮询，DSH 最小化时提醒会迟到一分钟 —— 正好违背这个功能的用途。

所以宿主加了一条 `GET /wait?since=<revision>`：

```
客户端 ── since=7 ──► 宿主：revision 还是 7？挂起这条响应（最多 20s）
                          │
                       状态变化 → revision=8 → 立刻回包（带完整快照）
                          │
客户端 ◄── 200 {revision:8,...} ─┘ 立刻续下一个 /wait?since=8
```

- 网络回调不受定时器节流影响 → 最小化时也是秒级；
- 页面隐藏时只有一条挂起连接，**没有每秒定时器**，比轮询更省；
- 宿主用 `revision` 保证不重不漏：客户端带着"我看到的版本"来，变化了才回；
- 20 秒空包只是为了刷新连接并探测宿主存活；
- 老宿主没有 `/wait`（404/405）→ 立刻退化为 `/state` 轮询（可见 1s / 隐藏 5s）；
- 宿主侧每个挂起响应都有超时与 `req.close` 清理，不会泄漏。

## 3. 模块划分

| 文件 | 职责 | 可测性 |
|---|---|---|
| `lib/shared/defaults.mjs` | 默认设置（两类开关+两套文案）、逐字段钳制、合并、v1→v2 迁移、脏数据回退 | 纯函数，全量单测 |
| `lib/shared/fold.mjs` | 会话事件 → pending 快照 + 完成边沿（`completions`/`completionSeq`） | 纯函数，全量单测 |
| `lib/shared/logbuf.mjs` | 日志环形缓冲：两类标记、追加、裁剪、格式化时间 | 纯函数，全量单测 |
| `index.js` | 宿主插件：订阅事件、维护状态、注册 route | 薄壳，逻辑全在 shared |
| `src/client.template.js` | 客户端源码（含 shared 注入标记） | — |
| `scripts/build-client.mjs` | 把 shared 纯函数内联进模板，产出 `client.js` | 构建脚本，产物入库 |
| `client.js` | 构建产物（lazy-CJS factory），**提交进仓库** | 装上去实测 |

**为什么要构建脚本**：客户端是单文件、不能用相对 `require`，但设置校验/日志裁剪/折叠展示逻辑必须与宿主**同一份源码**，否则两边规则漂移。脚本只做"把 shared 模块文本内联到标记处"，不是打包器，无依赖。

## 4. 错误处理

| 场景 | 处理 |
|---|---|
| `webServer` 服务不存在 | 记 warn，插件其余部分照常；客户端长轮询失败后退化为轮询 |
| route 注册冲突（路径被占） | `try/catch` 后 warn，不抛，避免整个插件 activation 失败 |
| long-poll 挂起期间客户端断开 | `req.on('close')` 清理定时器与订阅，不留悬挂引用 |
| slot 注册抛错（标识符用错等） | `registerSlot` 捕获并写进面板错误区，其余 slot 继续注册 |
| 事件 payload 异常（缺 id/字段类型错） | 折叠函数做类型守卫，忽略该事件而不是抛错 |
| `turn/end` 的 reason 畸形 | 只有 `kind === 'completed'` 才记完成，其余一律忽略 |
| localStorage 不可用（隐私模式/配额满） | 读写都 `try/catch`，降级为内存态，界面提示"本次不持久化" |
| 音频被自动播放策略拦截 / 音频子系统报错 | 全部 `try/catch`；通知/弹窗先出，声音失败不影响它们 |
| 系统通知无权限 / 不支持 / 抛错 | `show()` 返回 false → 自动回退应用内弹窗，并把人引到权限行 |
| 老宿主没有 `/wait` | 404/405 立刻退化为 `/state` 轮询，不反复打 404 |
| 注册失败/无提醒通道时点测试 | 面板错误区给出可读原因，按钮不会"看起来是坏的" |

## 5. 测试策略

- **单元测试**（`node --test`，零依赖）：折叠逻辑的事件矩阵、两类边沿与基线、设置钳制与 v1→v2→v3 迁移、
  日志裁剪与两类标记、slot 标识符契约、启动懒加载、桌面通知通道选择与兜底、长轮询/退化轮询。
- **客户端产物测试**：用假 `__ModuleLoader__` / 假 React / 假 `localStorage` / 假通知引擎
  **真加载 `client.js`**，而不是只测模板 —— 保证入库产物本身能跑。
- **跨两半契约测试**：宿主 `index.js` 折叠出的 JSON 直接喂给客户端 `client.js`，
  再用宿主 `/wait` 验证"状态一变就唤醒"。
- **手工验收**：装上 profile → 重启 DSH → 打开面板 → 分别点「测试审批」「测试完成」→
  两种系统通知都能弹出 + 听到声音 → 最小化 DSH 后触发一次真实审批 → 仍能看到通知。
- **静态检查**：`plugin_check` + `dsh-plugin-dev check`。

不做 DOM 快照测试：项目没有引入 jsdom，加它会把依赖变重；UI 部分用"手工验收清单"覆盖，并在 `doc/usage.md` 里列明。
