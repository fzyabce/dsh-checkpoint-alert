/**
 * 宿主插件的集成测试。
 *
 * 用一个假的 Cordis ctx 驱动 apply()，验证：
 *  - 插件契约（导出 name / apply）
 *  - 订阅的是只读的 session/event，且没有 inject approval 之类的写服务
 *  - 事件折叠结果能通过路由读到
 *  - 卸载时把监听和路由都解绑（不残留）
 *
 * 这些断言的价值：安装到真实宿主之前，就能证明"事件→状态→HTTP"这条链是通的。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, name } from '../index.js'

/** 造一个最小可用的假 ctx。 */
function makeCtx() {
  const handlers = new Map()
  const disposed = []
  const routes = []
  let routeDisposed = 0
  let injectCalls = 0

  const scope = {
    webServer: {
      register(route) {
        routes.push(route)
        return () => {
          routeDisposed += 1
        }
      },
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposed.push(dispose)
    },
  }

  const ctx = {
    logger: { warn() {} },
    // 宿主服务查询：这里一律返回 undefined，走"无 connection 服务"的分支
    get() {
      return undefined
    },
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(fn)
      return () => {
        const list = handlers.get(event)
        const index = list.indexOf(fn)
        if (index >= 0) list.splice(index, 1)
      }
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposed.push(dispose)
    },
    inject(services, cb) {
      injectCalls += 1
      assert.deepEqual(services, ['webServer'], '应当只等 webServer 这一个服务')
      cb(scope)
    },
  }

  return {
    ctx,
    routes,
    handlers,
    get routeDisposed() {
      return routeDisposed
    },
    get injectCalls() {
      return injectCalls
    },
    emit(event, ...args) {
      for (const fn of handlers.get(event) ?? []) fn(...args)
    },
    disposeAll() {
      for (const dispose of disposed) dispose()
    },
  }
}

/** 打开一个路由调用但不要求立刻回包（长轮询用）。 */
function openRoute(route, { method = 'GET', url, headers = {} } = {}) {
  let status = 0
  let body = ''
  const res = {
    writeHead(code) {
      status = code
    },
    end(chunk) {
      if (typeof chunk === 'string') body += chunk
      else if (chunk) body += Buffer.from(chunk).toString('utf8')
    },
  }
  const req = { method, url, headers, socket: { remoteAddress: '127.0.0.1' }, on() {} }
  route.handler(req, res)
  return {
    get status() {
      return status
    },
    get body() {
      return body
    },
    get json() {
      return body === '' ? null : JSON.parse(body)
    },
  }
}

/** 造一对假 req/res，并跑 route handler，返回解析后的 JSON。 */
function callRoute(route, { method = 'GET', url = '/dsh-human-alert/state', headers = {} } = {}) {
  let status = 0
  let body = ''
  const res = {
    writeHead(code) {
      status = code
    },
    end(chunk) {
      if (typeof chunk === 'string') body += chunk
      else if (chunk) body += Buffer.from(chunk).toString('utf8')
    },
  }
  const req = { method, url, headers, socket: { remoteAddress: '127.0.0.1' } }
  route.handler(req, res)
  let json = null
  try {
    json = body === '' ? null : JSON.parse(body)
  } catch {
    json = null
  }
  return { status, json, raw: body }
}

const session = id => ({ id })

test('导出契约：name 与 apply', () => {
  assert.equal(name, 'dsh-human-alert')
  assert.equal(typeof apply, 'function')
})

test('只订阅 session/event 与 session/disposed', () => {
  const fake = makeCtx()
  apply(fake.ctx)
  const subscribed = [...fake.handlers.keys()].sort()
  assert.deepEqual(subscribed, ['session/disposed', 'session/event'])
  for (const event of subscribed) {
    assert.ok(fake.handlers.get(event).length >= 1)
  }
})

test('只等 webServer 服务，不碰 approval / userQuestions 这类写服务', () => {
  const fake = makeCtx()
  apply(fake.ctx)
  assert.equal(fake.injectCalls, 1)
})

test('审批生命周期：asked 出现 → decided 消失', () => {
  const fake = makeCtx()
  apply(fake.ctx)
  const route = fake.routes.find(r => r.path === '/dsh-human-alert')

  let payload = callRoute(route).json
  assert.equal(payload.ok, true)
  assert.deepEqual(payload.pending, [])

  fake.emit('session/event', session('S1'), { type: 'approval/asked', data: { id: 'A1', toolName: 'edit_file' } })
  payload = callRoute(route).json
  assert.equal(payload.pending.length, 1)
  assert.equal(payload.pending[0].kind, 'approval')
  assert.equal(payload.pending[0].toolName, 'edit_file')
  assert.equal(payload.pending[0].sessionId, 'S1')

  fake.emit('session/event', session('S1'), { type: 'approval/decided', data: { id: 'A1', outcome: 'allowed-once' } })
  payload = callRoute(route).json
  assert.deepEqual(payload.pending, [])
})

test('提问生命周期：ask_user_question → tool/result', () => {
  const fake = makeCtx()
  apply(fake.ctx)
  const route = fake.routes.find(r => r.path === '/dsh-human-alert')

  fake.emit('session/event', session('S2'), { type: 'tool/call', data: { name: 'ask_user_question', callId: 'C1' } })
  let payload = callRoute(route).json
  assert.equal(payload.pending.length, 1)
  assert.equal(payload.pending[0].kind, 'question')

  fake.emit('session/event', session('S2'), { type: 'tool/result', data: { callId: 'C1' } })
  payload = callRoute(route).json
  assert.deepEqual(payload.pending, [])
})

test('提问生命周期（宿主真实 payload 形状）不会留下永久待确认', () => {
  const fake = makeCtx()
  apply(fake.ctx)
  const route = fake.routes.find(r => r.path === '/dsh-human-alert')

  fake.emit('session/event', session('S3'), {
    type: 'tool/call',
    data: { turn: 1, step: 1, callId: 'call-real', name: 'ask_user_question', arguments: '{}' },
  })
  assert.equal(callRoute(route).json.pending.length, 1)

  // 真实事件的 callId 在 message 里
  fake.emit('session/event', session('S3'), {
    type: 'tool/result',
    data: { turn: 1, step: 1, message: { role: 'tool', callId: 'call-real', content: [] } },
  })
  assert.deepEqual(callRoute(route).json.pending, [], '提问结果到达后待确认必须消失')
})

test('普通工具调用不产生待确认项', () => {
  const fake = makeCtx()
  apply(fake.ctx)
  const route = fake.routes.find(r => r.path === '/dsh-human-alert')
  fake.emit('session/event', session('S3'), { type: 'tool/call', data: { name: 'read_file', callId: 'C9' } })
  assert.deepEqual(callRoute(route).json.pending, [])
})

test('会话销毁后状态被清理', () => {
  const fake = makeCtx()
  apply(fake.ctx)
  const route = fake.routes.find(r => r.path === '/dsh-human-alert')
  fake.emit('session/event', session('S4'), { type: 'approval/asked', data: { id: 'A4' } })
  assert.equal(callRoute(route).json.pending.length, 1)
  fake.emit('session/disposed', session('S4'))
  assert.deepEqual(callRoute(route).json.pending, [])
})

test('状态接口只允许 GET/HEAD', () => {
  const fake = makeCtx()
  apply(fake.ctx)
  const route = fake.routes.find(r => r.path === '/dsh-human-alert')
  const result = callRoute(route, { method: 'POST' })
  assert.equal(result.status, 405)
})

test('未知子路径返回 404，健康检查返回 ok', () => {
  const fake = makeCtx()
  apply(fake.ctx)
  const route = fake.routes.find(r => r.path === '/dsh-human-alert')
  assert.equal(callRoute(route, { url: '/dsh-human-alert/nope' }).status, 404)
  const health = callRoute(route, { url: '/dsh-human-alert/health' }).json
  assert.equal(health.ok, true)
  assert.equal(health.plugin, 'dsh-human-alert')
})

test('非本机 Host 头被拒绝', () => {
  const fake = makeCtx()
  apply(fake.ctx)
  const route = fake.routes.find(r => r.path === '/dsh-human-alert')
  const result = callRoute(route, { headers: { host: 'evil.example.com' } })
  assert.equal(result.status, 403)
})

test('非回环对端被拒绝', () => {
  const fake = makeCtx()
  apply(fake.ctx)
  const route = fake.routes.find(r => r.path === '/dsh-human-alert')
  let status = 0
  const res = { writeHead(code) { status = code }, end() {} }
  // 直接用 route.handler 才能控制 socket.remoteAddress
  route.handler({ method: 'GET', url: '/dsh-human-alert/state', headers: {}, socket: { remoteAddress: '192.168.1.7' } }, res)
  assert.equal(status, 403)
})

test('本机 Host + 同源 Origin 放行', () => {
  const fake = makeCtx()
  apply(fake.ctx)
  const route = fake.routes.find(r => r.path === '/dsh-human-alert')
  const result = callRoute(route, {
    headers: { host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387', 'sec-fetch-site': 'same-origin' },
  })
  assert.equal(result.status, 200)
})

test('跨站 Origin 被拒绝', () => {
  const fake = makeCtx()
  apply(fake.ctx)
  const route = fake.routes.find(r => r.path === '/dsh-human-alert')
  const result = callRoute(route, {
    headers: { host: '127.0.0.1:19387', origin: 'http://evil.example.com' },
  })
  assert.equal(result.status, 403)
})

test('sec-fetch-site 为 cross-site 时被拒绝', () => {
  const fake = makeCtx()
  apply(fake.ctx)
  const route = fake.routes.find(r => r.path === '/dsh-human-alert')
  const result = callRoute(route, {
    headers: { host: 'localhost:19387', 'sec-fetch-site': 'cross-site' },
  })
  assert.equal(result.status, 403)
})

test('畸形事件不会让插件抛错', () => {
  const fake = makeCtx()
  apply(fake.ctx)
  assert.doesNotThrow(() => {
    fake.emit('session/event', null, null)
    fake.emit('session/event', session('S5'), { type: 42 })
    fake.emit('session/event', session('S5'), { type: 'approval/asked', data: null })
  })
})

test('卸载时路由被解绑', () => {
  const fake = makeCtx()
  apply(fake.ctx)
  assert.equal(fake.routes.length, 1)
  const before = fake.routeDisposed
  fake.disposeAll()
  assert.equal(fake.routeDisposed, before + 1, 'disposer 应当调用 route 的注销函数')
  assert.equal((fake.handlers.get('session/event') ?? []).length, 0, '事件监听应被解绑')
})

// ───────────────────────── 任务完成（turn/end） ─────────────────────────

/** 带 header 的会话对象（DSH 真实形状：session.header.id）。 */
const headerSession = (id, header = {}) => ({ id, header: { id, ...header } })

test('turn/end completed 被折成完成记录，并通过 /state 交给客户端', () => {
  const fake = makeCtx()
  apply(fake.ctx)
  const route = fake.routes.find(r => r.path === '/dsh-human-alert')

  fake.emit('session/event', headerSession('S9'), { type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } })
  const payload = callRoute(route).json
  assert.equal(payload.completionSeq, 1)
  assert.equal(payload.completions.length, 1)
  assert.equal(payload.completions[0].turn, 4)
  assert.equal(payload.completions[0].sessionId, 'S9')
})

test('取消/报错的 turn/end 不产生完成记录', () => {
  const fake = makeCtx()
  apply(fake.ctx)
  const route = fake.routes.find(r => r.path === '/dsh-human-alert')

  for (const kind of ['aborted', 'error', 'blocked', 'max-tokens', 'interrupted']) {
    fake.emit('session/event', headerSession('S9'), { type: 'turn/end', data: { turn: 1, reason: { kind } } })
  }
  const payload = callRoute(route).json
  assert.deepEqual(payload.completions, [])
  assert.equal(payload.completionSeq, 0)
})

test('子 agent 的轮次结束不提醒，但它的审批仍然提醒', () => {
  const fake = makeCtx()
  apply(fake.ctx)
  const route = fake.routes.find(r => r.path === '/dsh-human-alert')
  const child = headerSession('CHILD1', { origin: 'subagent', parentSession: 'ROOT' })

  fake.emit('session/event', child, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.deepEqual(callRoute(route).json.completions, [])

  fake.emit('session/event', child, { type: 'approval/asked', data: { id: 'A1', toolName: 'bash' } })
  const pending = callRoute(route).json.pending
  assert.equal(pending.length, 1)
  assert.equal(pending[0].sessionId, 'CHILD1')
})

test('会话 id 优先取 header.id（真实宿主形状），不再全部折进 default', () => {
  const fake = makeCtx()
  apply(fake.ctx)
  const route = fake.routes.find(r => r.path === '/dsh-human-alert')

  fake.emit('session/event', headerSession('S-REAL-1'), { type: 'approval/asked', data: { id: 'A1' } })
  fake.emit('session/event', headerSession('S-REAL-2'), { type: 'approval/asked', data: { id: 'A2' } })
  const pending = callRoute(route).json.pending
  assert.deepEqual(pending.map(item => item.sessionId).sort(), ['S-REAL-1', 'S-REAL-2'])
})

test('健康检查与状态接口不互相干扰', () => {
  const fake = makeCtx()
  apply(fake.ctx)
  const route = fake.routes.find(r => r.path === '/dsh-human-alert')
  fake.emit('session/event', session('S1'), { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(callRoute(route, { url: '/dsh-human-alert/health' }).json.ok, true)
  assert.equal(callRoute(route).json.completions.length, 1, '健康检查不应清空状态')
})

// ─────────────────────── 长轮询（最小化也能被唤醒） ───────────────────────

test('/state 带版本号 revision', () => {
  const fake = makeCtx()
  apply(fake.ctx)
  const route = fake.routes.find(r => r.path === '/dsh-human-alert')
  assert.equal(callRoute(route).json.revision, 0)

  fake.emit('session/event', session('S1'), { type: 'approval/asked', data: { id: 'A1' } })
  assert.equal(callRoute(route).json.revision, 1, '每次状态变化 revision +1')
})

test('/wait 在版本更新时才回包', () => {
  const fake = makeCtx()
  apply(fake.ctx)
  const route = fake.routes.find(r => r.path === '/dsh-human-alert')

  // 客户端已有版本 -1：立刻拿到当前快照
  const first = openRoute(route, { url: '/dsh-human-alert/wait?since=-1' })
  assert.equal(first.status, 200)
  assert.equal(first.json.revision, 0)

  // 客户端已是最新版：挂起
  const pending = openRoute(route, { url: '/dsh-human-alert/wait?since=0&timeout=5000' })
  assert.equal(pending.body, '', '版本没变时不应立刻回包')

  // 状态变化 → 挂起的请求被唤醒
  fake.emit('session/event', session('S1'), { type: 'approval/asked', data: { id: 'A1' } })
  assert.equal(pending.status, 200)
  assert.equal(pending.json.revision, 1)
  assert.equal(pending.json.pending.length, 1)
})

test('/wait 超时也会回包（连接不会一直吊着）', async () => {
  const fake = makeCtx()
  apply(fake.ctx)
  const route = fake.routes.find(r => r.path === '/dsh-human-alert')

  const held = openRoute(route, { url: '/dsh-human-alert/wait?since=0&timeout=100' })
  assert.equal(held.body, '', '先挂起')
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.equal(held.status, 200)
  assert.equal(held.json.revision, 0, '超时回当前快照，客户端会立刻续下一个')
})

test('/wait 走同一套访问校验（跨站被拒、非 GET 被拒）', () => {
  const fake = makeCtx()
  apply(fake.ctx)
  const route = fake.routes.find(r => r.path === '/dsh-human-alert')

  assert.equal(callRoute(route, { url: '/dsh-human-alert/wait?since=-1', headers: { host: 'evil.example.com' } }).status, 403)
  assert.equal(callRoute(route, { method: 'POST', url: '/dsh-human-alert/wait?since=-1' }).status, 405)
})
