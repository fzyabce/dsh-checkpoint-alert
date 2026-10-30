/**
 * 跨两半的契约测试：宿主 `index.js` 产出的 JSON，客户端 `client.js` 真的能消费。
 *
 * 为什么需要它：宿主和客户端各自有单测，但字段名（`completions` / `completionSeq` /
 * `sessionId` / `turn`）只在一处写错，两边单测都不会红 —— 只有把它们接起来跑才知道。
 * 这里不启动真实 DSH，用假 ctx 驱动宿主、用假浏览器驱动客户端，中间只走真实 JSON。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { apply } from '../index.js'

/** 最小假 ctx（与 tests/host.test.mjs 同构，只留跨端契约用到的部分）。 */
function makeHostCtx() {
  const handlers = new Map()
  const routes = []

  const scope = {
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : undefined
    },
  }

  const ctx = {
    logger: { warn() {} },
    get() {
      return undefined
    },
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(fn)
      return () => {}
    },
    effect(fn) {
      fn()
    },
    inject(_services, callback) {
      callback(scope)
    },
  }

  return {
    ctx,
    routes,
    emit(event, ...args) {
      for (const fn of handlers.get(event) ?? []) fn(...args)
    },
  }
}

/** 调用路由，返回真实 JSON（走一遍 JSON.parse，模拟浏览器）。 */
function readState(route) {
  let body = ''
  route.handler(
    { method: 'GET', url: '/dsh-human-alert/state', headers: {}, socket: { remoteAddress: '127.0.0.1' } },
    { writeHead() {}, end(chunk) { if (chunk) body += Buffer.from(chunk).toString('utf8') } },
  )
  return JSON.parse(body)
}

/** 打开一个长轮询但不等待（模拟客户端挂在 /wait 上）。 */
function openWait(route, since) {
  let body = ''
  route.handler(
    {
      method: 'GET',
      url: `/dsh-human-alert/wait?since=${encodeURIComponent(String(since))}&timeout=5000`,
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
      on() {},
    },
    { writeHead() {}, end(chunk) { if (chunk) body += Buffer.from(chunk).toString('utf8') } },
  )
  return {
    get body() {
      return body
    },
    get json() {
      return body === '' ? null : JSON.parse(body)
    },
  }
}

/** 用假浏览器环境加载客户端产物，返回 module.exports。 */
async function loadClient() {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  let captured = null

  const fakeReact = {
    createElement: () => ({}),
    useState: initial => [initial, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
    useCallback: fn => fn,
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  }

  const windowStub = {
    __ModuleLoader__: {
      load(definition) {
        captured = definition
      },
    },
    addEventListener() {},
    removeEventListener() {},
    setTimeout: (...args) => setTimeout(...args),
    clearTimeout: (...args) => clearTimeout(...args),
    setInterval: (...args) => setInterval(...args),
    clearInterval: (...args) => clearInterval(...args),
    localStorage: { getItem: () => null, setItem() {} },
  }

  // eslint-disable-next-line no-new-func
  const run = new Function('window', 'document', 'fetch', 'Audio', source)
  run(windowStub, undefined, async () => ({ ok: true, json: async () => ({}) }), undefined)

  if (captured === null) throw new Error('客户端产物没有调用 __ModuleLoader__.load')
  return captured.factory(id => {
    if (id === 'react') return fakeReact
    throw new Error(`客户端产物 require 了非基线模块：${id}`)
  })
}

const silentAudio = () => ({
  start() {},
  stop() {},
  unlock() {},
  dispose() {},
  isPlaying: () => false,
})

const session = id => ({ header: { id } })

test('宿主 → 客户端：审批与完成两类提醒端到端可用', async () => {
  const host = makeHostCtx()
  apply(host.ctx)
  const route = host.routes.find(item => item.path === '/dsh-human-alert')
  assert.ok(route !== undefined, '宿主应注册状态路由')

  const exported = await loadClient()
  const store = exported.__internals.createStore({ audio: silentAudio() })
  store.hydrate()

  // 1) 一次真实审批：宿主折叠 → JSON → 客户端弹「人工审批」
  host.emit('session/event', session('S1'), {
    type: 'approval/asked',
    data: { id: 'A1', toolName: 'bash', reason: 'needs approval' },
  })
  const firstSnapshot = readState(route)
  assert.equal(firstSnapshot.pending.length, 1)
  assert.equal(firstSnapshot.pending[0].sessionId, 'S1')

  store.ingest(firstSnapshot)
  assert.equal(store.getState().popup.kind, 'approval')
  assert.equal(store.getState().popup.toolName, 'bash')
  assert.equal(store.getState().log[0].kind, 'approval')
  store.dismissPopup()

  // 2) 审批被处理 + 一轮正常完成
  host.emit('session/event', session('S1'), {
    type: 'approval/decided',
    data: { id: 'A1', outcome: 'allowed-once' },
  })
  host.emit('session/event', session('S1'), {
    type: 'turn/end',
    data: { turn: 2, reason: { kind: 'completed' } },
  })

  const secondSnapshot = readState(route)
  assert.deepEqual(secondSnapshot.pending, [])
  assert.equal(secondSnapshot.completionSeq, 1)
  assert.equal(secondSnapshot.completions.length, 1)

  store.ingest(secondSnapshot)
  assert.equal(store.getState().popup.kind, 'taskDone')
  assert.equal(store.getState().popup.turn, 2)
  assert.equal(store.getState().log[0].kind, 'taskDone')
  store.dismissPopup()

  // 3) 再来一轮完成：seq 前进，客户端仍能识别为新边沿
  host.emit('session/event', session('S1'), {
    type: 'turn/end',
    data: { turn: 3, reason: { kind: 'completed' } },
  })
  const thirdSnapshot = readState(route)
  assert.equal(thirdSnapshot.completionSeq, 2)

  store.ingest(thirdSnapshot)
  assert.equal(store.getState().popup.kind, 'taskDone')
  assert.equal(store.getState().popup.turn, 3)
  assert.deepEqual(
    store.getState().log.map(entry => entry.kind),
    ['taskDone', 'taskDone', 'approval'],
    '日志按时间倒序，三类事件各一条',
  )
})

test('旧宿主（没有 completions 字段）不会让新客户端报错', async () => {
  const exported = await loadClient()
  const store = exported.__internals.createStore({ audio: silentAudio() })
  store.hydrate()

  assert.doesNotThrow(() => {
    store.ingest({ ok: true, updatedAt: Date.now(), pending: [] })
  })
  assert.equal(store.getState().popup, null)
})

test('长轮询：审批一发生就唤醒客户端（模拟 DSH 最小化时的通知路径）', async () => {
  const host = makeHostCtx()
  apply(host.ctx)
  const route = host.routes.find(item => item.path === '/dsh-human-alert')
  const exported = await loadClient()
  const store = exported.__internals.createStore({ audio: silentAudio() })
  store.hydrate()

  // 客户端已同步到当前版本
  const snapshot = readState(route)
  store.ingest(snapshot)

  // 挂一个长轮询（这正是最小化时浏览器里唯一还在等的东西）
  const held = openWait(route, snapshot.revision)
  assert.equal(held.body, '', '没有变化时应挂起')

  // 宿主产生审批 -> 长轮询立刻回包 -> 客户端立即消费
  host.emit('session/event', session('S1'), {
    type: 'approval/asked',
    data: { id: 'A-WAKE', toolName: 'bash' },
  })
  assert.notEqual(held.body, '', '状态变化必须唤醒长轮询')
  assert.ok(held.json.revision > snapshot.revision)

  store.ingest(held.json)
  assert.equal(store.getState().popup.kind, 'approval', '唤醒后客户端要立刻弹提醒（默认兜底到应用内）')
  assert.equal(store.getState().popup.toolName, 'bash')
})
