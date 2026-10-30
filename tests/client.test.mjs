/**
 * 客户端产物（client.js）的加载与行为测试。
 *
 * 目的：在装进真实宿主之前，先用一个假的浏览器环境把产物**真的加载一遍**，
 * 验证最脆的几件事：
 *  1. lazy-CJS factory 外壳格式能被 __ModuleLoader__ 正确消费；
 *  2. factory 只 require 了 'react'（不碰任何 Harness Client 包）；
 *  3. 三个 slot 都注册上了，且**用对了标识符**（main=key，两个 list slot=id）；
 *     v1 的弹窗 bug 就是 `shell.overlay` 误用了 `key`；
 *  4. 提醒逻辑：系统桌面通知为主、应用内弹窗兜底、两类都能弹、声音不被音频错误吞掉；
 *  5. 状态订阅：长轮询为主（最小化也能唤醒），老宿主退化为轮询。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const SOURCE_URL = new URL('../client.js', import.meta.url)

/** 极简 React 替身：只需要导出被解构的那几个函数。 */
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: initial => [initial, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useCallback: fn => fn,
  useMemo: fn => fn(),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}

/** 记录调用的假音频引擎。 */
function makeAudio(overrides = {}) {
  const calls = []
  return {
    calls,
    start(options) {
      calls.push(['start', options])
      if (overrides.throwOnStart === true) throw new Error('audio context limited')
    },
    stop() {
      calls.push(['stop'])
    },
    unlock() {
      calls.push(['unlock'])
    },
    dispose() {
      calls.push(['dispose'])
    },
    isPlaying: () => true,
  }
}

/**
 * 假的系统通知引擎。
 * `showResult` 控制"通知弹出来了没有"，用来验证兜底逻辑。
 */
function makeNotifier(overrides = {}) {
  const shown = []
  const closed = []
  let permission = overrides.permission ?? 'granted'
  return {
    shown,
    closed,
    get calls() {
      return shown
    },
    supported: overrides.supported ?? true,
    readPermission: () => permission,
    requestPermission: () => {
      permission = overrides.grantOnRequest ?? 'granted'
      return Promise.resolve(permission)
    },
    show(options) {
      // 与真实实现一致：没有 granted 权限时根本弹不出来，也不该被记为"弹过"
      if (permission !== 'granted') return false
      shown.push(options)
      if (overrides.throwOnShow === true) throw new Error('notification failed')
      return overrides.showResult ?? true
    },
    closeAll() {
      closed.push(true)
    },
  }
}

/** 造一个假的 document，用来驱动 visibilitychange。 */
function makeDocument(visibilityState = 'visible') {
  const listeners = new Map()
  return {
    visibilityState,
    addEventListener(type, fn) {
      listeners.set(type, fn)
    },
    removeEventListener(type) {
      listeners.delete(type)
    },
    __emit(type) {
      const fn = listeners.get(type)
      if (typeof fn === 'function') fn()
    },
    __listeners: listeners,
  }
}

/** 读源码并在受控作用域里执行，返回 factory 产出的 module.exports。 */
async function loadClientModule(overrides = {}) {
  const source = await readFile(SOURCE_URL, 'utf8')
  const required = []
  let captured = null

  const storage = overrides.storage ?? { reads: 0, writes: 0, data: new Map() }
  const idleQueue = []
  const documentStub = overrides.document ?? makeDocument()
  const fetchCalls = []

  const baseFetch = overrides.fetch
  const fetchStub = async (url, init) => {
    fetchCalls.push({ url, init })
    if (baseFetch !== undefined) return baseFetch(url, init)
    return {
      ok: true,
      json: async () => ({ ok: true, revision: 0, pending: [], completions: [], completionSeq: 0 }),
    }
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
    localStorage: {
      getItem(key) {
        storage.reads += 1
        return storage.data.has(key) ? storage.data.get(key) : null
      },
      setItem(key, value) {
        storage.writes += 1
        storage.data.set(key, value)
      },
    },
    AudioContext: undefined,
    webkitAudioContext: undefined,
    Notification: undefined,
  }

  // 需要观察"空闲时才初始化"的用例：把 idle 回调攒起来手动 flush
  if (overrides.deferIdle === true) {
    windowStub.requestIdleCallback = callback => {
      idleQueue.push(callback)
      return idleQueue.length
    }
    windowStub.cancelIdleCallback = id => {
      idleQueue[id - 1] = null
    }
  }
  windowStub.__flushIdle = () => {
    while (idleQueue.length > 0) {
      const callback = idleQueue.shift()
      if (typeof callback === 'function') callback({ didTimeout: true })
    }
  }
  windowStub.__idleQueue = idleQueue

  const requireStub = id => {
    required.push(id)
    if (id === 'react') return fakeReact
    throw new Error(`客户端产物 require 了非基线模块：${id}`)
  }

  // eslint-disable-next-line no-new-func
  const run = new Function('window', 'document', 'fetch', 'Audio', source)
  run(windowStub, documentStub, fetchStub, undefined)

  if (captured === null) throw new Error('产物没有调用 window.__ModuleLoader__.load')
  const exported = captured.factory(requireStub)

  return { exported, captured, required, windowStub, storage, fetchCalls, documentStub }
}

/** 假 ctx：记录 slot 注册与 effect 清理函数。 */
function makeSlotCtx() {
  const injected = []
  const registrations = []
  const disposers = []
  const errors = []

  const ctx = {
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    slots: {
      inject(slotId, factory) {
        injected.push(slotId)
        try {
          factory()
        } catch (error) {
          errors.push({ slotId, error })
        }
      },
      register(descriptor, component) {
        registrations.push({ descriptor, component })
        return () => {}
      },
    },
  }

  return {
    ctx,
    injected,
    registrations,
    disposers,
    errors,
    disposeAll() {
      for (const dispose of disposers) dispose()
    },
  }
}

/** 起一个客户端实例，并保证用例结束时一定 dispose。 */
async function withClient(t, overrides) {
  const loaded = await loadClientModule(overrides)
  const fake = makeSlotCtx()
  loaded.exported.apply(fake.ctx)
  t.after(() => fake.disposeAll())
  return { ...loaded, fake }
}

/** 让 microtask / 定时器跑一轮。 */
const settle = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms))

// ───────────────────────────── 外壳与契约 ─────────────────────────────

test('产物外壳是 lazy-CJS factory，id 为包名', async () => {
  const { captured } = await loadClientModule()
  assert.equal(captured.id, 'dsh-human-alert')
  assert.equal(typeof captured.factory, 'function')
})

test('factory 只 require 了 react', async () => {
  const { required } = await loadClientModule()
  assert.deepEqual([...new Set(required)], ['react'])
})

test('导出契约：inject 是静态数组（含 slots）', async () => {
  const { exported } = await loadClientModule()
  assert.ok(Array.isArray(exported.inject), 'dsh.client 的 inject 若为函数会让整个 bundle 被禁用')
  assert.deepEqual(exported.inject, ['slots'])
  assert.equal(typeof exported.apply, 'function')
})

test('apply 注册三个 slot 且没有抛错', async t => {
  const { fake } = await withClient(t)

  assert.deepEqual(fake.errors, [], 'slot 注入不应抛错')
  assert.deepEqual([...fake.injected].sort(), ['main', 'shell.overlay', 'sidebar.panellist'])

  const bySlot = new Map(fake.registrations.map(r => [r.descriptor.name, r.descriptor]))
  assert.equal(bySlot.get('sidebar.panellist').id, 'dsh-human-alert')
  assert.equal(bySlot.get('main').key, 'dsh-human-alert')
  assert.equal(bySlot.get('main').id, undefined)
  for (const registration of fake.registrations) {
    assert.equal(typeof registration.component, 'function', '每个 slot 都要给出组件')
  }
})

test('覆盖层用 list slot 的 id 注册（v1 "只有声音没弹窗"的回归用例）', async t => {
  const { fake, exported } = await withClient(t)
  const overlay = fake.registrations.find(r => r.descriptor.name === 'shell.overlay')

  assert.ok(overlay !== undefined, '覆盖层必须注册上')
  // 宿主实现：list slot 没有 options.id 会直接抛 `list slot "…" requires options.id`
  assert.equal(overlay.descriptor.id, 'dsh-human-alert', 'shell.overlay 是 list slot，必须给 id')
  assert.equal(overlay.descriptor.key, undefined, '给 key 会被忽略并导致组件永不挂载')

  const contract = exported.__internals.SLOT_CONTRACT
  for (const [slot, identifier] of Object.entries(contract)) {
    const registration = fake.registrations.find(r => r.descriptor.name === slot)
    assert.ok(registration !== undefined, `缺少 ${slot} 注册`)
    assert.ok(registration.descriptor[identifier] !== undefined, `${slot} 应使用 ${identifier}`)
  }
})

// ───────────────────────── 启动性能（懒加载） ─────────────────────────

test('apply 同步阶段不读 localStorage、不发请求（重活都推到 idle）', async t => {
  const loaded = await loadClientModule({ deferIdle: true })
  const fake = makeSlotCtx()
  loaded.exported.apply(fake.ctx)
  t.after(() => fake.disposeAll())

  assert.equal(loaded.storage.reads, 0, '启动瞬间不应读存储')
  assert.equal(loaded.fetchCalls.length, 0, '启动瞬间不应发状态请求')
  assert.deepEqual(fake.errors, [])

  // idle 时间片到了才初始化
  loaded.windowStub.__flushIdle()
  assert.ok(loaded.storage.reads >= 1, 'idle 之后才 hydrate')
})

test('idle 之后建立长轮询（最小化也能被唤醒，不依赖定时器）', async t => {
  const loaded = await loadClientModule({ deferIdle: true })
  const fake = makeSlotCtx()
  loaded.exported.apply(fake.ctx)
  t.after(() => fake.disposeAll())

  assert.equal(loaded.fetchCalls.length, 0, 'idle 前零请求')
  loaded.windowStub.__flushIdle()
  await settle()

  assert.ok(loaded.fetchCalls.length >= 1)
  assert.equal(
    loaded.fetchCalls[0].url,
    '/dsh-human-alert/wait?since=-1',
    '首个请求必须走长轮询并带上客户端已有版本',
  )
  assert.equal(loaded.fetchCalls[0].init.method, 'GET')
  assert.equal(loaded.fetchCalls[0].init.cache, 'no-store')
})

test('老宿主没有 /wait 时退化为 /state 轮询', async t => {
  const loaded = await loadClientModule({
    deferIdle: true,
    fetch: async url => {
      if (url.startsWith('/dsh-human-alert/wait')) return { ok: false, status: 404, json: async () => ({}) }
      return { ok: true, json: async () => ({ ok: true, pending: [], completions: [], completionSeq: 0 }) }
    },
  })
  const fake = makeSlotCtx()
  loaded.exported.apply(fake.ctx)
  t.after(() => fake.disposeAll())

  loaded.windowStub.__flushIdle()
  await settle(30)

  const stateCalls = loaded.fetchCalls.filter(call => call.url === '/dsh-human-alert/state')
  assert.ok(stateCalls.length >= 1, '连续失败后应退回 /state 轮询')
  assert.equal(fake.errors.length, 0)
})

test('状态接口失败时不抛未捕获异常', async t => {
  const loaded = await loadClientModule({
    deferIdle: true,
    fetch: async () => {
      throw new Error('offline')
    },
  })
  const fake = makeSlotCtx()
  assert.doesNotThrow(() => loaded.exported.apply(fake.ctx))
  loaded.windowStub.__flushIdle()
  await settle()
  fake.disposeAll()
})

test('卸载后不再继续请求', async t => {
  const loaded = await loadClientModule({ deferIdle: true })
  const fake = makeSlotCtx()
  loaded.exported.apply(fake.ctx)
  loaded.windowStub.__flushIdle()
  await settle()

  const before = loaded.fetchCalls.length
  assert.ok(before >= 1)
  fake.disposeAll()
  await settle(30)
  assert.equal(loaded.fetchCalls.length, before, '卸载后不应再有新的请求')
})

// ─────────────────────────── 提醒逻辑（store） ───────────────────────────

/** 起一个只有 store 的环境（不注册 slot / 不起订阅）。 */
async function makeStore(overrides = {}) {
  const loaded = await loadClientModule({ deferIdle: true, storage: overrides.storage })
  const audio = overrides.audio ?? makeAudio()
  const notifier = overrides.notifier ?? makeNotifier()
  const store = loaded.exported.__internals.createStore({ audio, notifier })
  if (overrides.hydrate !== false) store.hydrate()
  return { store, audio, notifier, loaded }
}

const approvalItem = (id = 'A1', sessionId = 'S1') => ({ id, kind: 'approval', sessionId, toolName: 'edit_file' })
const completionItem = (seq, sessionId = 'S1', turn = 1) => ({ seq, sessionId, turn, at: 1700000000000 })

test('桌面通知：人工审批走系统通知，标题带类型标记', async () => {
  const { store, notifier, audio } = await makeStore()

  store.ingest({ pending: [approvalItem()], completions: [], completionSeq: 0 })
  const state = store.getState()

  assert.equal(notifier.shown.length, 1)
  assert.ok(notifier.shown[0].title.includes('【人工审批】'))
  assert.equal(notifier.shown[0].tag, 'dsh-human-alert:approval')
  assert.ok(notifier.shown[0].body.includes('edit_file'), '正文里应带触发工具')
  assert.equal(notifier.shown[0].silent, false, '纯系统通知时由系统发声')
  assert.equal(state.popup, null, '默认不弹应用内窗口')
  assert.equal(state.log.length, 1)
  assert.equal(state.log[0].kind, 'approval')
  assert.equal(audio.calls.filter(call => call[0] === 'start').length, 0, '声音交给系统通知')
})

test('桌面通知：任务完成走系统通知，与审批用不同 tag', async () => {
  const { store, notifier } = await makeStore()
  store.ingest({ pending: [], completions: [], completionSeq: 0 })
  store.ingest({ pending: [], completions: [completionItem(1, 'S2', 3)], completionSeq: 1 })

  assert.equal(notifier.shown.length, 1)
  assert.ok(notifier.shown[0].title.includes('【任务完成】'))
  assert.equal(notifier.shown[0].tag, 'dsh-human-alert:taskDone')
  assert.ok(notifier.shown[0].body.includes('第 3 轮'))
  assert.equal(store.getState().log[0].kind, 'taskDone')
})

test('两类文案独立作用到系统通知标题', async () => {
  const { store, notifier } = await makeStore()
  store.updateSettings({ approvalTitle: '审批标题', taskDoneTitle: '完成标题' })

  store.ingest({ pending: [approvalItem()], completions: [], completionSeq: 0 })
  assert.equal(notifier.shown[0].title, '【人工审批】审批标题')

  store.ingest({ pending: [], completions: [completionItem(1, 'S1', 2)], completionSeq: 1 })
  assert.equal(notifier.shown[1].title, '【任务完成】完成标题')
})

test('系统通知弹不出来时自动回退应用内弹窗（不会什么都不出现）', async () => {
  const { store } = await makeStore({ notifier: makeNotifier({ showResult: false }) })
  store.ingest({ pending: [approvalItem()], completions: [], completionSeq: 0 })

  assert.equal(store.getState().popup.kind, 'approval', '系统通知失败必须兜底到应用内')
  assert.equal(store.getState().popup.title, store.getState().settings.approvalTitle)
})

test('没有通知权限时也回退应用内弹窗', async () => {
  const { store, notifier } = await makeStore({ notifier: makeNotifier({ permission: 'denied' }) })
  store.ingest({ pending: [approvalItem()], completions: [], completionSeq: 0 })

  assert.equal(notifier.shown.length, 0, '没有权限时不调用 show')
  assert.equal(store.getState().popup.kind, 'approval')
})

test('系统"接受但丢弃"通知（onerror）时补上应用内弹窗', async () => {
  const { store, notifier } = await makeStore()
  store.ingest({ pending: [approvalItem()], completions: [], completionSeq: 0 })

  assert.equal(store.getState().popup, null, '通知看起来发出去了')
  const options = notifier.shown[0]
  assert.equal(typeof options.onFailure, 'function', '要给出失败兜底回调')

  options.onFailure()
  assert.equal(store.getState().popup.kind, 'approval', '系统丢弃通知时不能什么都不出现')
})

test('应用内弹窗已打开时不再注册失败兜底（避免弹两次）', async () => {
  const { store, notifier } = await makeStore()
  store.updateSettings({ popupEnabled: true })
  store.ingest({ pending: [approvalItem()], completions: [], completionSeq: 0 })

  assert.equal(notifier.shown[0].onFailure, undefined)
  assert.equal(store.getState().popup.kind, 'approval')
})

test('应用内弹窗打开时两个通道都弹：系统通知静音 + 插件自己响铃', async () => {
  const { store, notifier, audio } = await makeStore()
  store.updateSettings({ popupEnabled: true })

  store.ingest({ pending: [approvalItem()], completions: [], completionSeq: 0 })

  assert.equal(notifier.shown.length, 1)
  assert.equal(notifier.shown[0].silent, true, '避免系统音 + 合成音两声')
  assert.equal(store.getState().popup.kind, 'approval')
  assert.ok(audio.calls.some(call => call[0] === 'start'), '应用内弹窗由插件自己响铃')
})

test('声音报错不影响桌面通知与应用内兜底', async () => {
  const audio = makeAudio({ throwOnStart: true })
  const { store, notifier } = await makeStore({ audio })

  assert.doesNotThrow(() => {
    store.updateSettings({ popupEnabled: true })
    store.ingest({ pending: [approvalItem()], completions: [], completionSeq: 0 })
  })
  assert.equal(notifier.shown.length, 1)
  assert.equal(store.getState().popup.kind, 'approval')
})

test('首帧只建基线：加载页面前已有的完成记录不补弹', async () => {
  const { store, notifier } = await makeStore()
  store.ingest({ pending: [], completions: [completionItem(7), completionItem(8)], completionSeq: 8 })
  assert.equal(notifier.shown.length, 0)
  assert.equal(store.getState().log.length, 0)
})

test('宿主重启（序号回退）不会把旧完成记录当成新提醒', async () => {
  const { store, notifier } = await makeStore()
  store.ingest({ pending: [], completions: [completionItem(10)], completionSeq: 10 })
  assert.equal(notifier.shown.length, 0)

  store.ingest({ pending: [], completions: [], completionSeq: 0 })
  assert.equal(notifier.shown.length, 0)

  store.ingest({ pending: [], completions: [completionItem(1)], completionSeq: 1 })
  assert.equal(notifier.shown.length, 1)
})

test('同一批里两类提醒都会弹：审批先显示，完成排队等待', async () => {
  const { store, notifier } = await makeStore()
  store.updateSettings({ popupEnabled: true })

  store.ingest({ pending: [], completions: [], completionSeq: 0 })
  store.ingest({ pending: [approvalItem()], completions: [completionItem(1)], completionSeq: 1 })

  assert.equal(notifier.shown.length, 2, '两条系统通知都要弹')
  const state = store.getState()
  assert.equal(state.popup.kind, 'approval', '人正卡在审批上，应用内先显示审批')
  assert.equal(state.queue.length, 1)
  assert.equal(state.queue[0].kind, 'taskDone')

  store.dismissPopup()
  assert.equal(store.getState().popup.kind, 'taskDone')
})

test('分类开关独立：关掉任务完成不影响人工审批', async () => {
  const { store, notifier } = await makeStore()
  store.updateSettings({ taskDoneEnabled: false })

  store.ingest({ pending: [], completions: [], completionSeq: 0 })
  store.ingest({ pending: [], completions: [completionItem(1)], completionSeq: 1 })
  assert.equal(notifier.shown.length, 0, '完成提醒已关，不应弹系统通知')
  assert.equal(store.getState().log.length, 1, '日志仍记录发生过的事')

  store.ingest({ pending: [approvalItem()], completions: [], completionSeq: 1 })
  assert.equal(notifier.shown.length, 1, '审批提醒不受影响')
})

test('总开关关掉时既不弹窗也不响铃，但日志照样记', async () => {
  const { store, notifier, audio } = await makeStore()
  store.updateSettings({ enabled: false })

  store.ingest({ pending: [approvalItem()], completions: [], completionSeq: 0 })
  assert.equal(notifier.shown.length, 0)
  assert.equal(store.getState().popup, null)
  assert.equal(audio.calls.filter(call => call[0] === 'start').length, 0)
  assert.equal(store.getState().log.length, 1)
})

test('两个通道都关掉时什么都不弹', async () => {
  const { store, notifier } = await makeStore()
  store.updateSettings({ desktopNotifyEnabled: false, popupEnabled: false })

  store.ingest({ pending: [approvalItem()], completions: [], completionSeq: 0 })
  assert.equal(notifier.shown.length, 0)
  assert.equal(store.getState().popup, null)
})

test('同一项不会重复提醒', async () => {
  const { store, notifier } = await makeStore()
  store.ingest({ pending: [approvalItem()], completions: [], completionSeq: 0 })
  assert.equal(notifier.shown.length, 1)

  store.ingest({ pending: [approvalItem()], completions: [], completionSeq: 0 })
  assert.equal(notifier.shown.length, 1, '同一 pending 不重复弹')
  assert.equal(store.getState().log.length, 1)
})

test('日志有上限，超出丢最旧的', async () => {
  const { store } = await makeStore()
  for (let i = 0; i < 205; i += 1) {
    store.ingest({ pending: [approvalItem(`A${i}`, 'S1')], completions: [], completionSeq: 0 })
  }
  const state = store.getState()
  assert.equal(state.log.length, 200)
  assert.equal(state.log[0].sessionId, 'S1')
})

test('测试按钮：弹对应类型，不写日志；桌面通知会先申请权限', async () => {
  const notifier = makeNotifier({ permission: 'default', grantOnRequest: 'granted' })
  const { store } = await makeStore({ notifier })

  store.runTest('approval')
  await settle()
  assert.equal(notifier.shown.length, 1)
  assert.ok(notifier.shown[0].title.includes('【人工审批】'))
  assert.equal(store.getState().log.length, 0)
  assert.equal(store.getState().notifyPermission, 'granted')

  store.runTest('taskDone')
  await settle()
  assert.equal(notifier.shown.length, 2)
  assert.ok(notifier.shown[1].title.includes('【任务完成】'))
})

test('申请权限：granted / denied / 不支持三种状态都能落进面板状态', async () => {
  const denied = await makeStore({ notifier: makeNotifier({ permission: 'denied' }) })
  await denied.store.requestNotifyPermission()
  assert.equal(denied.store.getState().notifyPermission, 'denied')
  assert.equal(denied.store.getState().notifySupported, true)

  const unsupported = await makeStore({ notifier: makeNotifier({ supported: false }) })
  await unsupported.store.requestNotifyPermission()
  assert.equal(unsupported.store.getState().notifySupported, false)
  assert.equal(unsupported.store.getState().notifyPermission, 'unsupported')
})

test('设置持久化：hydrate 读回上次的开关与文案', async () => {
  const storage = { reads: 0, writes: 0, data: new Map() }
  const first = await makeStore({ storage })
  first.store.updateSettings({ approvalEnabled: false, taskDoneTitle: '自定义完成' })

  const second = await makeStore({ storage })
  assert.equal(second.store.getState().settings.approvalEnabled, false)
  assert.equal(second.store.getState().settings.taskDoneTitle, '自定义完成')
})

test('本地存储不可用时不抛错，设置仍在内存里生效', async () => {
  const storage = { reads: 0, writes: 0, data: new Map() }
  const loaded = await loadClientModule({ deferIdle: true, storage })
  // 覆盖成会抛错的实现，模拟隐私模式
  loaded.windowStub.localStorage.setItem = () => {
    throw new Error('quota exceeded')
  }
  const store = loaded.exported.__internals.createStore({ audio: makeAudio(), notifier: makeNotifier() })
  store.hydrate()
  store.updateSettings({ volume: 30 })

  assert.equal(store.getState().settings.volume, 30)
  assert.equal(store.getState().storageOk, false)
})
