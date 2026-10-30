# dsh-human-alert v0.3.0 改动说明

需求：把提醒从「DSH 页面内弹窗」改成**右下角独立系统弹窗（脱离 DSH 主窗口）**，
DSH 最小化 / 切到别的窗口也要能看见；区分【人工审批】/【任务完成】；不抢焦点、置顶；
保留侧边栏全部配置、独立开关、声音、本地存储与启动懒加载，尽量少改原有代码。

版本：`0.2.0` → `0.3.0`；客户端产物 `client.js` 已重新构建入库。

---

## 1. 方案选择：系统通知，而不是"再开一个 Electron 窗口"

| 方案 | 问题 | 结论 |
|---|---|---|
| 宿主侧 `new BrowserWindow({ alwaysOnTop: true })` | 要调 Electron 主进程 API、自己画 UI 与管理生命周期；窗口抢注意力、`alwaysOnTop` 会压住用户正在看的别的窗口；插件契约里没有这条缝 | 不做 |
| **系统通知（`window.Notification`）** | 由操作系统渲染（Windows toast / macOS 通知中心），插件只调标准 Web API | 采用 |

系统通知天然满足需求：右下角、置顶于所有窗口、**不激活 DSH 窗口**、最小化/被遮挡仍显示、点击才回到 DSH。
同类通知用 `tag` 去重，只保留最新一条，不会堆成一串。

**边界（如实说明）**：DSH 进程完全退出后没有进程能提醒——通知由页面发起。要"关掉 DSH 也能提醒"
需要宿主侧常驻服务，超出本插件范围，已写进 README 与帮助区。

---

## 2. 通道优先级与兜底

```
桌面通知开？──是──▶ 弹系统通知 ──成功──▶ 应用内弹窗开？──是──▶ 再弹一个（系统通知静音）
    │                    │
    否                   └──失败（无权限 / 不支持 / 抛错）──▶ 应用内弹窗兜底
    │
    └──▶ 应用内弹窗开？──是──▶ 直接弹
```

- 默认：**只弹系统通知**（`popupEnabled` 默认关）；
- 只开桌面通知时，声音交给系统提示音（页面隐藏时 Web Audio 可能被挂起）；
- 两个都开：系统通知 `silent: true`，由插件自己响铃（避免两声）；
- 系统通知失败：**一定**回退应用内弹窗——"什么都没出现"比"多一个窗"糟得多。

---

## 3. 最小化也能提醒：长轮询代替定时轮询

浏览器会把后台页面的定时器节流（隐藏约 5 分钟后，链式 `setTimeout` 可低到**每分钟一次**）。
v0.2 的 1 秒轮询在 DSH 最小化时会把提醒推迟一分钟，正好违背这个功能的目的。

所以宿主新增一条端点：

```
GET /dsh-human-alert/wait?since=<客户端已见版本>&timeout=20000
  → 版本比 since 新：立刻回 200 { revision, pending, completions, completionSeq }
  → 否则挂起，直到状态变化或超时（20s）
```

- 客户端每收到一次就立刻续下一个请求，**不依赖定时器**；
- 页面隐藏时只挂着一条连接，没有每秒定时器，比轮询更省；
- 宿主侧每个挂起响应都带超时与 `req.on('close')` 清理，客户端断开不会泄漏；
- 老宿主没有 `/wait`（404/405）→ 立刻退化为 `/state` 轮询（可见 1s / 隐藏 5s）；
- `/state` 保留，作为手工排查与降级通道。

---

## 4. 代码改动清单（尽量小）

| 文件 | 改动 |
|---|---|
| `index.js` | 状态加 `revision` 与订阅；新增 `GET /wait`（长轮询，超时/断开清理）；`/state` 返回 `revision` |
| `lib/shared/defaults.mjs` | 新增 `desktopNotifyEnabled`（默认开）；`popupEnabled` 默认改关；`SETTINGS_VERSION = 3`；v2→v3 一次性迁移（关掉应用内弹窗） |
| `src/client.template.js` | 新增 `createDesktopNotifier()`（权限申请 / tag 去重 / 失败返回 false）；`fire()` 改为"桌面通知优先 + 应用内兜底"；`startPolling` → `startSubscription`（长轮询 + 退化）；面板新增「桌面通知」分组与权限行；测试按钮先申请权限 |
| `client.js` | 重新构建 |
| `tests/*` | 124 个用例：新增桌面通知通道/兜底/权限、onerror 二次兜底、长轮询唤醒、老宿主退化、v2→v3 迁移、`tool/result` 真实形状 |
| `package.json` / `locale/*` | 版本 0.3.0、展示名与简介 |
| `README.md` / `doc/*` | 行为、配置、原理、边界、验收清单同步 |

未动的部分：三类 slot 注册形状、侧边栏面板骨架与懒加载、日志三层上限、音频引擎、只读会话事件折叠、
通知/设置/日志的存储键名。

### 顺手修掉的一个真 bug：提问项永远清不掉

真实验证时发现 `/state` 里挂着一个 16 分钟前的提问待确认项。查宿主 `SessionEventMap`：

```
'tool/result': { turn, step, message: ToolResultMessage, error?, meta? }
```

`callId` 在 `message` 里，**不在 `data` 顶层**；而 `fold.mjs` 只读了 `data.callId`，于是
`ask_user_question` 结束后那条 pending 永远不消失（面板一直显示"当前有 N 项待确认"）。
现在依次读 `data.callId` → `data.message.callId` → `data.message.toolCallId`，并补了两条回归用例。

---

## 5. 配置与迁移

| 项 | 变化 |
|---|---|
| `desktopNotifyEnabled` | 新增，默认 **开** |
| `popupEnabled` | 默认 **关**（兜底通道） |
| v2 设置（无 `desktopNotifyEnabled`） | 升级时一次性把 `popupEnabled` 置为关，避免同一件事弹两个窗；文案与其它开关原样保留 |
| 之后用户手动打开应用内弹窗 | 写入 `desktopNotifyEnabled` 后不再触发迁移，保持用户选择 |
| `dsh-human-alert:settings:v1` / `dsh-human-alert:log:v1` | 键名不变（改键等于清零老设置），版本字段分别为 3 / 2 |

---

## 6. 验证

```text
$ node --test tests/
ℹ tests 124
ℹ pass 124
ℹ fail 0
```

覆盖到的关键回归：

- 两类提醒都走系统通知，标题分别带 `【人工审批】`/`【任务完成】`，tag 不同；
- 系统通知弹不出来（`show` 返回 false / 无权限 / 抛错）→ 自动回退应用内弹窗；
- 系统"接受但丢弃"（`onerror`）→ 通过失败回调补上应用内弹窗（Windows 无 AUMID / 勿扰模式的情形）；
- 两个通道都开时系统通知静音、插件自己响铃，且不再注册失败兜底（避免弹两次）；
- 首帧不补弹历史、宿主重启序号回退不误报；
- 长轮询：`/wait` 在状态变化时立刻回包、超时回包、断开清理、跨站/非 GET 被拒；
- 老宿主 404 → 立刻退化为 `/state` 轮询（不打 404 风暴）；
- `tool/result` 宿主真实形状（callId 在 message 里）能清掉提问待确认项；
- 真实宿主 JSON 喂给真实客户端产物的跨两半契约（含"审批一发生就唤醒客户端"）。

`plugin_check` → pass；`dsh-plugin-dev check` → OK。

### 需要你做的一步

**重启 DSH + 刷新页面**（宿主新增了 `/wait`，客户端也换了通道逻辑）。
生效判断：

```bash
curl -s http://127.0.0.1:19387/dsh-human-alert/state
# 返回里应出现 "revision": 0
curl -s "http://127.0.0.1:19387/dsh-human-alert/wait?since=-1&timeout=100"
# 应立刻返回一份快照
```

然后在面板里点「测试审批」/「测试完成」：右下角应出现系统通知；把 DSH 最小化再点一次，通知仍应出现。
