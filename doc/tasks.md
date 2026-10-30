# Tasks — dsh-human-alert

状态标记：`[ ]` 未开始 · `[~]` 进行中 · `[x]` 完成

## 阶段 0：调研与事实核验（完成）

- [x] 0.1 确认触发事件面：`session/event` + `approval/asked` + `ask_user_question`
- [x] 0.2 确认宿主 slot 真实存在：`shell.overlay`(46) / `sidebar.panellist`(13) / `main`(549)
- [x] 0.3 确认客户端产物格式：`window.__ModuleLoader__.load({id, factory})`（以 940 字节的现成产物为样板）
- [x] 0.4 确认主题 token：从宿主产物抽出 132 个 `--dsw-*`，其中 120 个 alias
- [x] 0.5 确认无官方音频 seam → 用浏览器 Web Audio

## 阶段 1：OpenSpec 文档

- [x] 1.1 `doc/proposal.md`
- [x] 1.2 `doc/design.md`（含 §2.6 访问校验取舍）
- [x] 1.3 `doc/tasks.md`（本文件）
- [x] 1.4 `doc/specs/{detection,alerting,settings-and-log}/spec.md`

## 阶段 2：纯逻辑层（TDD）

- [x] 2.1 `tests/defaults.test.mjs`
- [x] 2.2 `tests/fold.test.mjs`
- [x] 2.3 `tests/logbuf.test.mjs`
- [x] 2.4 `lib/shared/defaults.mjs`
- [x] 2.5 `lib/shared/fold.mjs`
- [x] 2.6 `lib/shared/logbuf.mjs`
- 备注：先跑出红灯（`ERR_MODULE_NOT_FOUND`），再实现到绿；期间发现一处**测试自身**的算错（`at` 边界写成 203，实际 204），修的是测试不是实现。

## 阶段 3：宿主插件

- [x] 3.1 `index.js`：`name` + `apply`，订阅 `session/event`
- [x] 3.2 per-session pending + `session/disposed` 清理
- [x] 3.3 `webServer.register` 暴露 `GET /dsh-human-alert/{state,health}`
- [x] 3.4 全部注册包在 `ctx.effect` 里
- [x] 3.5 `tests/host.test.mjs`：假 ctx 端到端（事件→状态→HTTP→卸载）

## 阶段 4：客户端

- [x] 4.1 `scripts/build-client.mjs`（内联共享逻辑 + 语法自检 + 残留标记守卫）
- [x] 4.2 `src/client.template.js`：poller / settings store / audio engine / logger
- [x] 4.3 `<AlertPanel/>`：六分区 + 测试按钮 + 状态兜底条
- [x] 4.4 `<AlertPopup/>`：覆盖层、倒计时、Escape、焦点管理
- [x] 4.5 声音引擎：合成提示音 + 自定义 URL + 音量 + 循环到确认
- [x] 4.6 生成 `client.js`（45795 字节）并入库
- [x] 4.7 `tests/client.test.mjs`：真加载产物，验证外壳/单依赖/三 slot/轮询/卸载

## 阶段 5：打包元数据

- [x] 5.1 `package.json`：`dsh.bundle.patch` + `dsh.client`（静态数组）+ exports/files/types/peer
- [x] 5.2 `cordis.patch.yml`
- [x] 5.3 `locale/en.json` + `locale/zh.json`
- [x] 5.4 `icon.svg`

## 阶段 6：验证

- [x] 6.1 `node --test` 65/65 全绿
- [x] 6.2 `plugin_check` → **pass**（19 通过 / 0 失败 / 0 警告 / 1 跳过）
- [x] 6.3 `dsh-plugin-dev check` → **OK**（10 通过 / 0 失败 / 2 警告：五语 README、packageManager）
- [x] 6.4 `pnpm pack` 成功（`dsh-plugin-dev verify` 的 pack 阶段），产物可发布
- [x] 6.5 装进 desktop profile：依赖与 bundles 均已登记，`node_modules/dsh-human-alert` 指向本目录
- [x] 6.6 宿主侧路由已被调用：`POST` → `405 allow: GET, HEAD`（本插件 handler 的响应特征），随机路径 → 宿主 404
- [x] 6.7 宿主已在 `/plugins/??dsh-human-alert/client.js` 提供客户端产物（200，含 `__ModuleLoader__`）
- [~] 6.8 浏览器界面（侧边栏入口、弹窗、声音、日志）尚未肉眼验收
- [ ] 6.9 触发真实审批，确认端到端
- [x] 6.10 `dsh-plugin-dev verify` 的 install 阶段：**工具自身**版本线不匹配（它要装 `@deepseek-ai/dsh-headless@0.2.1-rc.2`，宿主是 `0.2.0-rc.2`），与本插件无关

> 6.8–6.9 需要**重启 DSH** 才能生效：宿主插件模块是进程内缓存的，安装后新版 `index.js`
> 不会自动载入（旧版仍在内存里，表现为 `GET /state` 返回 403 而 `POST` 返回 405；
> 客户端产物则已被扫描注册、可直接提供）。重启会中断当前会话，因此交由用户执行。

## 阶段 7：文档交付

- [x] 7.1 `README.md`（安装/配置/原理/边界/卸载/开发）
- [x] 7.2 `doc/usage.md`（详细配置说明 + 排障表 + 手工验收清单）
- [x] 7.3 卸载步骤与残留说明

## 剩余工作（交给用户）

1. 重启 DSH（加载新版宿主模块）+ 刷新页面（加载客户端半侧）
2. 执行 `doc/usage.md` §6 的手工验收清单
3. 若「侧边栏没有入口」，查 `dsh plugin --profile desktop list` 与页面 DevTools 的 Network
4. `plugin_check` 提示的五语 README 与 hub 登记属于发布阶段的事，交付运行不需要

---

## 阶段 8：v0.2.0 迭代（两类提醒 / 弹窗 bug / 启动性能）

- [x] 8.1 事实核验：`shell.overlay` 是 list slot，必须 `id`；`{key}` 会抛
      `list slot "shell.overlay" requires options.id`（用宿主 asar 里的真实 `SlotCore` 复现）
- [x] 8.2 事实核验：`turn/end` 的 `reason` 是 `{ kind: 'completed' | 'aborted' | … }`；
      子 agent 会话带 `header.origin === 'subagent'`
- [x] 8.3 `fold.mjs`：完成边沿（`completions` / `completionSeq` / 上限 20 / 会话销毁清理 / 子 agent 过滤）
- [x] 8.4 `defaults.mjs`：两类开关 + 两套文案 + v1→v2 静默迁移（迁移不算"数据损坏"）
- [x] 8.5 `logbuf.mjs`：`taskDone` 类型、`kindTag`、`describeVia`、渲染上限、v1 `question` 迁移
- [x] 8.6 `index.js`：`session.header.id` 优先、子 agent 判定、`/state` 返回完成边沿
- [x] 8.7 客户端：覆盖层改用 `id` 注册；注册失败可见；弹窗队列；弹窗先于声音
- [x] 8.8 客户端启动性能：hydrate/轮询 idle 化、音频全惰性、面板骨架 + 懒加载、
      页面隐藏停轮询、失败退避、日志三层上限
- [x] 8.9 客户端顺手修：日志不写提问正文；轮询无变化不触发重渲染
- [x] 8.10 单测扩到 107 个（新增 slot 契约、懒加载、两类提醒、边沿基线、队列、音频报错、跨两半契约等回归用例）
- [x] 8.11 重新构建 `client.js` 并入库
- [x] 8.12 文档同步：README、三份 spec、design、usage、`doc/changelog-0.2.0.md`
- [~] 8.13 真实界面验收：需**重启 DSH + 刷新页面**后由用户完成（宿主模块进程内缓存）

---

## 阶段 9：v0.3.0 迭代（桌面系统通知 / 最小化可见 / 长轮询）

- [x] 9.1 方案取舍：系统通知 vs 另开 Electron 窗口（选前者；理由与边界写进 design §2.10）
- [x] 9.2 `index.js`：状态加 `revision` + 订阅；新增 `GET /wait?since=&timeout=` 长轮询（超时/断开清理）
- [x] 9.3 `defaults.mjs`：新增 `desktopNotifyEnabled`；`popupEnabled` 默认关；v2→v3 一次性迁移；版本 3
- [x] 9.4 客户端 `createDesktopNotifier()`：权限申请、tag 去重、失败返回 false 触发兜底
- [x] 9.5 客户端 `fire()`：桌面通知优先 → 应用内兜底 → 声音；两通道都开时系统通知静音
- [x] 9.6 客户端订阅：`startPolling` → `startSubscription`（长轮询 + 404/失败退化 + AbortController）
- [x] 9.7 面板：「桌面通知」分组 + 权限状态/申请按钮；「应用内弹窗（兜底）」分组；帮助补充通知说明
- [x] 9.8 单测扩到 124 个（通知通道/兜底/权限、onerror 二次兜底、长轮询唤醒/超时/校验、老宿主退化、
      v2→v3 迁移、跨两半唤醒、`tool/result` 真实 payload 清理提问项）
- [x] 9.9 重新构建 `client.js` 并入库
- [x] 9.10 文档同步：README、alerting/settings spec、design、usage、`doc/changelog-0.3.0.md`
- [~] 9.11 真实系统通知验收：需**重启 DSH + 刷新页面**后由用户完成
      （重点：右下角 toast 是否出现、最小化后是否仍出现、通知是否不抢焦点）
