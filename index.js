/**
 * dsh-human-alert —— 宿主侧插件。
 *
 * 职责非常克制：
 *  1. 只读订阅 `session/event`，把「需要人工处理」与「一轮任务跑完」折叠成一份快照；
 *  2. 通过 webServer 的一条 prefix route 把这份快照交给浏览器端；
 *  3. 其余一切（弹窗、声音、设置、日志）都在客户端完成。
 *
 * 刻意不做的事：
 *  - 不碰 `approval/request` 这类 waterfall 事件（短路就等于替用户做决定）；
 *  - 不调用 approval / userQuestions 服务的任何写方法；
 *  - 不写会话事件、不改 agent 行为。
 *  也就是说：**没有本插件，DSH 的行为一模一样。**
 *
 * 启动开销：本模块在宿主启动时只做「建一个空对象 + 挂两个只读监听 + 注册一条
 * 路由」，全部是 O(1) 且无 I/O；折叠本身是纯函数，单次事件几十微秒。
 *
 * @see doc/design.md
 */

import {
  emptyState,
  applySessionEvent,
  dropSession,
  listPending,
  listCompletions,
} from './lib/shared/fold.mjs'

/** 插件名（必须与 package.json 的 name 一致，方便宿主对号入座）。 */
export const name = 'dsh-human-alert'

/** 状态接口的挂载前缀。客户端按 `${PREFIX}/state` 拉取。 */
const ROUTE_PREFIX = '/dsh-human-alert'

/**
 * 待确认状态的持有者。
 *
 * 单独抽出来的原因：route handler 需要读它，事件监听需要写它，
 * 而两者在 apply 里是两块责任。用一个小对象代替散落的闭包变量，
 * 顺便让"全部清空"这类操作只有一个入口。
 */
function createStore() {
  let state = emptyState()
  /** 每次状态变化 +1。客户端拿它做"我看到的版本"，也是长轮询的唤醒条件。 */
  let revision = 0
  /** 长轮询挂起者：状态一变就把它们全部唤醒。 */
  const listeners = new Set()

  function notify() {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch {
        // 单个挂起的响应出错不能影响其它等待者
      }
    }
  }

  return {
    /** 把事件折进去；无变化时不产生新对象、不通知等待者。 */
    apply(sessionId, event, meta) {
      const next = applySessionEvent(state, sessionId, event, meta)
      if (next === state) return false
      state = next
      revision += 1
      notify()
      return true
    },
    /** 会话销毁时整桶丢弃，避免长会话把内存撑涨。 */
    drop(sessionId) {
      const next = dropSession(state, sessionId)
      if (next === state) return false
      state = next
      revision += 1
      notify()
      return true
    },
    /** 当前所有待确认项（含 sessionId）。 */
    list() {
      return listPending(state)
    },
    /** 最近的「任务完成」记录（seq 单调递增，客户端据此判断新边沿）。 */
    completions() {
      return listCompletions(state)
    },
    /** 已分配到的最大完成序号；客户端首帧用它做基线。 */
    completionSeq() {
      return typeof state.completionSeq === 'number' ? state.completionSeq : 0
    },
    /** 当前版本号。 */
    revision() {
      return revision
    },
    /** 订阅"状态有变化"（长轮询用）。返回解绑函数。 */
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    /** 一次性打包好要发给浏览器的快照。 */
    snapshot() {
      return {
        ok: true,
        updatedAt: Date.now(),
        revision,
        pending: listPending(state),
        // 「任务完成」是一次性边沿，用 seq 让客户端不重不漏地消费
        completions: listCompletions(state),
        completionSeq: typeof state.completionSeq === 'number' ? state.completionSeq : 0,
      }
    },
  }
}

/**
 * 从会话对象上稳妥地取 id。
 *
 * DSH 的 Session 同时提供 `session.id` 与 `session.header.id`；不同版本/不同
 * 调用点可能只有其中一个。早期版本只读了 `.id`，于是所有会话都被折进
 * `'default'` 一个桶里 —— 多会话并行时会互相覆盖，这里一并修掉。
 */
function sessionIdOf(session) {
  if (!session || typeof session !== 'object') return 'default'
  if (session.header && typeof session.header.id === 'string' && session.header.id !== '') {
    return session.header.id
  }
  if (typeof session.id === 'string' && session.id !== '') return session.id
  if (typeof session.sessionId === 'string' && session.sessionId !== '') return session.sessionId
  return 'default'
}

/**
 * 这个会话是不是子 agent。
 *
 * 子 agent 的 `turn/end` 属于内部实现细节，不该弹「任务完成」打断用户；
 * 但子 agent 卡在审批上时**必须**提醒（那时人也得拍板），所以只对完成事件过滤。
 * 依据：`childSessionMeta()` 在会话 meta 里写 `origin: 'subagent'` 与 `parentSession`。
 */
function isSubagentSession(session) {
  const header = session && typeof session === 'object' ? session.header : undefined
  if (!header || typeof header !== 'object') return false
  if (header.origin === 'subagent') return true
  return typeof header.parentSession === 'string' && header.parentSession !== ''
}

/**
 * 发出 JSON 响应。
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 */
function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    // 提醒状态是实时的，任何缓存都会让用户看到过期的"需要确认"
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** 对端是不是回环地址。 */
function isLoopbackPeer(address) {
  if (typeof address !== 'string' || address === '') return false
  const plain = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  return plain === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(plain)
}

/**
 * 访问校验。
 *
 * 这个接口是**只读**的状态源，只喂给同源的 Web 客户端。所以这里用的是一套
 * 自洽的几何校验（与宿主在拿不到 connection 服务时用的那套同构）：
 *
 *   1. 对端必须是回环地址 —— 别的机器读不到；
 *   2. Host 头必须是本机名 —— 防 DNS rebinding；
 *   3. 浏览器明确表示跨站（sec-fetch-site）或 Origin 与 Host 不一致 —— 挡掉。
 *
 * 刻意**不**转调 `connection.requestRejection`：那是给带浏览器认证凭据的
 * 特权路由用的，用在只读的轮询接口上会让真实浏览器之外的任何验证手段
 * （包括自动化测试）一律 403，功能静默失效且极难排查。
 * 这条取舍记录在 doc/design.md §2.6。
 */
function requestRejected(ctx, req) {
  if (!isLoopbackPeer(req?.socket?.remoteAddress)) return true

  const headers = req.headers ?? {}
  const host = headers.host
  if (host === undefined) return false

  let hostname
  try {
    hostname = new URL(`http://${host}`).hostname
  } catch {
    return true
  }
  // 只接受本机来源
  if (!(hostname === 'localhost' || hostname === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname))) {
    return true
  }

  const site = headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return true

  const origin = headers.origin
  if (origin === undefined) return false
  try {
    return new URL(origin).host !== host
  } catch {
    return true
  }
}

/**
 * 长轮询的默认挂起时长与上下界。
 *
 * 为什么需要长轮询：浏览器把**后台页面的定时器**节流（隐藏 5 分钟后可低到
 * 每分钟一次），纯轮询在 DSH 最小化时会严重延迟。长轮询由宿主在状态变化时
 * 立刻回包，网络回调不受定时器节流影响，所以最小化/切走也能秒级提醒。
 * 20 秒回一次空包只是为了让连接定期刷新、顺便探测宿主存活。
 */
const WAIT_DEFAULT_MS = 20000
const WAIT_MIN_MS = 100
const WAIT_MAX_MS = 25000

/** 从查询串里取一个整数（越界收敛、非数字回落）。 */
function readInt(searchParams, key, fallback, min, max) {
  const raw = searchParams.get(key)
  if (raw === null || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/**
 * 注册状态接口。
 *
 * 用 `kind: 'prefix'` 而不是精确路径：宿主的路由表按 (kind, path) 查重，
 * 前缀注册让我们可以在同一个前缀下继续加接口而不占用额外路径。
 */
function registerRoutes(ctx, scope, store) {
  const server = scope && scope.webServer
  if (!server || typeof server.register !== 'function') {
    ctx.logger?.warn?.('[dsh-human-alert] webServer 不可用，浏览器端拿不到提醒状态')
    return undefined
  }

  return server.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: (req, res) => {
      // 只读接口：只允许 GET/HEAD
      if (req.method !== undefined && !['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(405, { allow: 'GET, HEAD' })
        res.end()
        return
      }
      if (requestRejected(ctx, req)) {
        sendJson(res, 403, { ok: false, error: 'forbidden' })
        return
      }

      const url = new URL(req.url ?? '/', 'http://local')
      const sub = url.pathname.slice(ROUTE_PREFIX.length) || '/'

      if (sub === '/state') {
        sendJson(res, 200, store.snapshot())
        return
      }

      // 长轮询：版本比客户端看到的新就立刻回；否则挂起直到变化或超时
      if (sub === '/wait') {
        const since = readInt(url.searchParams, 'since', -1, -1, Number.MAX_SAFE_INTEGER)
        const timeout = readInt(url.searchParams, 'timeout', WAIT_DEFAULT_MS, WAIT_MIN_MS, WAIT_MAX_MS)

        let done = false
        let timer = null
        let unsubscribe = null

        const finish = () => {
          if (done) return
          done = true
          if (timer !== null) clearTimeout(timer)
          if (typeof unsubscribe === 'function') unsubscribe()
          try {
            sendJson(res, 200, store.snapshot())
          } catch {
            // 客户端已断开（翻页/关窗），忽略
          }
        }

        // 已经有了客户端没见过的版本：不必挂起
        if (store.revision() > since) {
          finish()
          return
        }

        unsubscribe = store.subscribe(finish)
        timer = setTimeout(finish, timeout)
        // 客户端提前断开（关窗、切页、刷新）时及时释放
        if (req && typeof req.on === 'function') {
          req.on('close', () => {
            if (done) return
            done = true
            if (timer !== null) clearTimeout(timer)
            if (typeof unsubscribe === 'function') unsubscribe()
          })
        }
        return
      }

      // 健康探测：便于用户/脚本确认插件真的挂上了
      if (sub === '/health') {
        sendJson(res, 200, { ok: true, plugin: name })
        return
      }

      sendJson(res, 404, { ok: false, error: 'not-found' })
    },
  })
}

/**
 * 插件入口。
 * @param {any} ctx Cordis 上下文
 */
export function apply(ctx) {
  const store = createStore()

  // ── 1. 只读监听会话事件 ────────────────────────────────────────────────
  // 用 ctx.effect 包住返回的 disposer：插件被禁用/热重载时自动解绑，
  // 不需要任何手动 removeListener。
  ctx.effect(() => {
    const off = ctx.on('session/event', (session, event) => {
      try {
        store.apply(sessionIdOf(session), event, { subagent: isSubagentSession(session) })
      } catch (error) {
        // 提醒插件绝不该因为一个畸形事件把宿主搞崩
        ctx.logger?.warn?.(`[${name}] 处理会话事件失败：${error?.message ?? error}`)
      }
    })
    return () => {
      if (typeof off === 'function') off()
    }
  })

  ctx.effect(() => {
    const off = ctx.on('session/disposed', (session) => {
      try {
        store.drop(sessionIdOf(session))
      } catch (error) {
        ctx.logger?.warn?.(`[${name}] 清理会话状态失败：${error?.message ?? error}`)
      }
    })
    return () => {
      if (typeof off === 'function') off()
    }
  })

  // ── 2. 注册状态接口 ────────────────────────────────────────────────────
  // webServer 是可选服务：用 ctx.inject 等它就绪，拿不到就降级（插件其余部分照常）。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scope) => {
      scope.effect(() => {
        const dispose = registerRoutes(ctx, scope, store)
        return () => {
          if (typeof dispose === 'function') dispose()
        }
      })
    })
  } else {
    ctx.effect(() => {
      const dispose = registerRoutes(ctx, ctx, store)
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    })
  }
}
