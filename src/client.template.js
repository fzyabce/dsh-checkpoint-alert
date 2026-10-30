/**
 * dsh-human-alert 客户端模板。
 *
 * 注意：最终产物是 `client.js`，由 `scripts/build-client.mjs` 生成。
 * 这个文件里带 inline 标记的位置会被替换成 `lib/shared/*.mjs` 的源码，
 * 保证「设置校验 / 日志裁剪」在宿主侧与浏览器侧是**同一份逻辑**，不会规则漂移。
 *
 * 约束（见 doc/proposal.md §4）：
 *  - 只渲染 slot 里的 React 组件，不写 document.body、不托管 iframe；
 *  - 只 require('react')（宿主浏览器模块表提供），不 require 任何 Harness Client 包；
 *  - 样式只用真实存在的 --dsw-* 主题 token（见 .plugin-src/tokens.txt 的普查结果）。
 *
 * v2 的三处重点（对应本轮迭代需求）：
 *  1. 两类提醒：`approval`（【人工审批】）与 `taskDone`（【任务完成】），
 *     各有独立开关、独立文案、独立日志标记。
 *  2. 弹窗注册修正：`shell.overlay` 是 **list** slot，必须用 `id` 而不是 `key`；
 *     用 `key` 会抛 `list slot ... requires options.id`，表现正是"只有声音、
 *     没有弹窗"。现在注册走 {@link registerSlot}，失败会被记进面板而不是静默消失。
 *  3. 启动性能：`apply()` 里不做任何重活 —— 读存储、起轮询、建 AudioContext
 *     全部推迟到 requestIdleCallback；侧边栏面板先渲染骨架、正文再懒加载；
 *     页面隐藏时停止轮询；日志三层上限（存储 200 / 内存 200 / 渲染 50）。
 */

const React = require('react')
const { useCallback, useEffect, useRef, useState, useSyncExternalStore } = React
/* @@INLINE:defaults@@ */

/* @@INLINE:logbuf@@ */

// ─────────────────────────────── 常量 ────────────────────────────────

const PLUGIN_NAME = 'dsh-human-alert'
const PANEL_TITLE = '人工确认提醒'
const STATE_URL = '/dsh-human-alert/state'
/**
 * 长轮询端点。宿主在状态变化时立刻回包，网络回调不受浏览器"后台定时器节流"
 * 影响 —— 这是 DSH 最小化时仍能秒级弹桌面通知的关键。
 */
const WAIT_URL = '/dsh-human-alert/wait'

/** 退化轮询（老宿主没有 /wait，或长轮询连续失败）时的间隔与退避上限。 */
const POLL_MS = 1000
const POLL_MAX_MS = 10000

/** 长轮询连续失败几次后永久退化为轮询。 */
const WAIT_FAILURES_BEFORE_FALLBACK = 2

/**
 * localStorage 的键名保持 v1 不变（改键名等于把老用户的设置清零），
 * 版本号写在值的 `version` 字段里，由 normalizeSettings / normalizeLog 迁移。
 */
const STORAGE_SETTINGS = 'dsh-human-alert:settings:v1'
const STORAGE_LOG = 'dsh-human-alert:log:v1'

/** "已提醒"集合的上限，防止超长会话把内存越攒越大。 */
const ALERTED_MAX = 200

/** 弹窗排队的上限：同时来很多提醒时只保留最新的几条，不堆出几十个窗口。 */
const POPUP_QUEUE_MAX = 5

/** 启动空转的兜底时长：requestIdleCallback 有 timeout，忙时也不会无限期不初始化。 */
const BOOT_TIMEOUT_MS = 1200

/** 侧边栏面板正文的懒加载兜底时长。 */
const PANEL_DEFER_MS = 120

// ─────────────────────────── 通用小工具 ──────────────────────────────

/** 读 localStorage 并 JSON 解析；任何异常都当"没有"。 */
function readStored(key) {
  try {
    const raw = window.localStorage.getItem(key)
    if (raw === null || raw === '') return undefined
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** 写 localStorage；返回是否成功（隐私模式/配额满会失败）。 */
function writeStored(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

/** 会话 id 太长，界面上只显示前 8 位。 */
function shortId(value) {
  const text = typeof value === 'string' ? value : ''
  if (text === '') return ''
  return text.length > 8 ? text.slice(0, 8) : text
}

/**
 * 把一段工作推到浏览器空闲时执行（不阻塞首屏）。
 *
 * 优先 `requestIdleCallback`（带 timeout，忙时也会执行），
 * 不支持时退化成 `setTimeout(…, 0)` —— 仍然晚于当前脚本求值，不会卡住启动。
 * @param {() => void} fn
 * @param {number} [timeout]
 * @returns {() => void} 取消函数
 */
function scheduleIdle(fn, timeout) {
  const win = typeof window !== 'undefined' ? window : undefined
  const limit = typeof timeout === 'number' && timeout > 0 ? timeout : BOOT_TIMEOUT_MS

  if (win !== undefined && typeof win.requestIdleCallback === 'function') {
    let cancelled = false
    const handle = win.requestIdleCallback(
      () => {
        if (!cancelled) fn()
      },
      { timeout: limit },
    )
    return () => {
      cancelled = true
      if (typeof win.cancelIdleCallback === 'function') win.cancelIdleCallback(handle)
    }
  }

  let cancelled = false
  const run = () => {
    if (!cancelled) fn()
  }
  const handle = win !== undefined ? win.setTimeout(run, 0) : setTimeout(run, 0)
  return () => {
    cancelled = true
    if (win !== undefined) win.clearTimeout(handle)
    else clearTimeout(handle)
  }
}

/**
 * 页面是否在后台。
 *
 * 只用来决定**声音与通知形态**（后台时交给系统发提示音），不再用来停轮询：
 * 现在靠长轮询唤醒，后台也必须保持连接，否则最小化就收不到提醒。
 */
function documentHidden() {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

/** 等待若干毫秒（只在退化轮询/退避时用；长轮询路径不依赖定时器）。 */
function delay(ms) {
  const win = typeof window !== 'undefined' ? window : undefined
  return new Promise(resolve => {
    if (win !== undefined) win.setTimeout(resolve, ms)
    else setTimeout(resolve, ms)
  })
}

// ────────────────────────────── 音频引擎 ───────────────────────────────

/**
 * 声音提醒引擎（**完全惰性**）。
 *
 * `createAudioEngine()` 本身不建 AudioContext、不 new Audio，只有真正要响
 * （或有用户手势来解锁）时才触碰浏览器音频 API。这样插件加载时不会因为
 * 初始化音频子系统而拖慢页面。
 *
 * 内置提示音用 Web Audio 振荡器合成（零资源、无版权问题），自定义提示音用
 * <audio> 元素。两者都受浏览器"自动播放策略"约束：首次用户交互前
 * AudioContext 可能是 suspended，此时静默失败不算错误。
 */
function createAudioEngine() {
  let audioContext = null
  let loopTimer = null
  let htmlAudio = null
  let playing = false

  /** 惰性创建并尝试恢复 AudioContext。 */
  function context() {
    const Ctor = window.AudioContext || window.webkitAudioContext
    if (!Ctor) return null
    if (audioContext === null) audioContext = new Ctor()
    if (audioContext.state === 'suspended') audioContext.resume().catch(() => {})
    return audioContext
  }

  /** 三音上行的短提示音，音量按 0–100 折算成增益。 */
  function synthOnce(volume) {
    const ac = context()
    if (ac === null) return
    const gain = ac.createGain()
    const normalized = Math.max(0, Math.min(100, volume)) / 100
    // 0.22 是让"满音量"也不至于刺耳的经验系数
    gain.gain.value = normalized * 0.22
    gain.connect(ac.destination)
    const notes = [659.25, 880, 1174.66]
    const start = ac.currentTime
    notes.forEach((freq, index) => {
      const osc = ac.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = freq
      osc.connect(gain)
      const at = start + index * 0.13
      osc.start(at)
      osc.stop(at + 0.16)
    })
    // 增益节点用完即弃，避免长期驻留
    window.setTimeout(() => {
      try {
        gain.disconnect()
      } catch {}
    }, 1200)
  }

  /** 播放自定义音频。 */
  function customOnce(url, volume, loop) {
    if (typeof url !== 'string' || url.trim() === '') return
    try {
      htmlAudio = new Audio(url)
      htmlAudio.volume = Math.max(0, Math.min(100, volume)) / 100
      htmlAudio.loop = loop === true
      htmlAudio.play().catch(() => {})
    } catch {
      htmlAudio = null
    }
  }

  function stop() {
    if (loopTimer !== null) {
      window.clearInterval(loopTimer)
      loopTimer = null
    }
    if (htmlAudio !== null) {
      try {
        htmlAudio.pause()
        htmlAudio.currentTime = 0
      } catch {}
      htmlAudio = null
    }
    playing = false
  }

  return {
    /**
     * 开始提醒。
     * 任何音频异常都在这里被吞掉：**声音失败绝不允许影响弹窗**。
     * @param {{preset: string, customUrl: string, volume: number, loop: boolean}} options
     */
    start(options) {
      try {
        stop()
        playing = true
        if (options.preset === 'custom') {
          customOnce(options.customUrl, options.volume, options.loop)
          return
        }
        synthOnce(options.volume)
        if (options.loop) {
          loopTimer = window.setInterval(() => {
            if (!playing) return
            try {
              synthOnce(options.volume)
            } catch {}
          }, 1600)
        }
      } catch {
        // 音频子系统不可用（无设备、被策略拦截、上下文数量超限）时静默降级
      }
    },
    stop,
    isPlaying: () => playing,
    /** 用户首次交互时调用，解锁自动播放限制。 */
    unlock() {
      try {
        const ac = context()
        if (ac !== null && ac.state === 'suspended') ac.resume().catch(() => {})
      } catch {}
    },
    /** 插件卸载/热重载时彻底释放。 */
    dispose() {
      stop()
      if (audioContext !== null) {
        try {
          audioContext.close().catch(() => {})
        } catch {}
        audioContext = null
      }
    },
  }
}

// ───────────────────────────── 桌面系统通知 ─────────────────────────────

/**
 * 桌面通知引擎（**完全惰性**，默认只在真的要弹提醒时才碰 Notification）。
 *
 * 用浏览器/Electron 的通知能力（`window.Notification`），通知由**操作系统**
 * 渲染在右下角，因此：
 *  - 脱离 DSH 主窗口，DSH 最小化、被别的窗口盖住、切到其它页面都看得见；
 *  - 不抢焦点（系统 toast 本身不激活窗口）；
 *  - 天然置顶（由系统通知中心叠加在所有窗口之上）。
 *
 * 边界：DSH 进程完全退出后没有进程能提醒（这是"浏览器内插件"的硬边界）。
 *
 * 权限：Electron 渲染进程通常直接是 granted；普通浏览器里需要在**用户手势**
 * 内调用 requestPermission()，所以申请只会发生在点击（面板按钮/首次交互）时。
 */
function createDesktopNotifier() {
  const supported = typeof window !== 'undefined' && typeof window.Notification === 'function'
  let permission = supported ? window.Notification.permission || 'default' : 'unsupported'
  /** tag → Notification，同类只保留最新一条，避免堆成一串。 */
  const active = new Map()

  function readPermission() {
    if (!supported) return 'unsupported'
    try {
      permission = window.Notification.permission || permission
    } catch {}
    return permission
  }

  /**
   * 申请通知权限。必须在用户手势里调用（浏览器要求），Electron 里通常秒同意。
   * @returns {Promise<string>} 'granted' | 'denied' | 'default' | 'unsupported'
   */
  function requestPermission() {
    if (!supported) return Promise.resolve('unsupported')
    if (permission === 'granted' || permission === 'denied') return Promise.resolve(permission)
    try {
      const result = window.Notification.requestPermission()
      if (result && typeof result.then === 'function') {
        return result
          .then(value => {
            permission = value || permission
            return permission
          })
          .catch(() => permission)
      }
      // 早期浏览器的回调式签名
      return new Promise(resolve => {
        try {
          window.Notification.requestPermission(value => {
            permission = value || permission
            resolve(permission)
          })
        } catch {
          resolve(permission)
        }
      })
    } catch {
      return Promise.resolve(permission)
    }
  }

  /**
   * 弹一条系统通知。
   * @param {{tag: string, title: string, body: string, silent?: boolean, keep?: boolean}} options
   * @returns {boolean} 是否真的弹出来了（false 时调用方应回退到应用内弹窗）
   */
  function show(options) {
    if (!supported) return false
    if (readPermission() !== 'granted') return false
    const tag = typeof options.tag === 'string' ? options.tag : 'dsh-human-alert'
    try {
      const previous = active.get(tag)
      if (previous !== undefined) {
        try {
          previous.close()
        } catch {}
        active.delete(tag)
      }
      const notification = new window.Notification(options.title, {
        body: options.body,
        tag,
        // 我们的合成音负责"持续响"，系统音只在不弹应用内窗口时兜底
        silent: options.silent === true,
        // 一直留在通知中心，直到用户处理（不支持的环境会忽略这个字段）
        requireInteraction: options.keep === true,
      })
      notification.onclick = () => {
        try {
          notification.close()
        } catch {}
        // 点击是用户主动行为，此时聚焦不算"抢焦点"
        try {
          window.focus()
        } catch {}
      }
      const forget = () => {
        if (active.get(tag) === notification) active.delete(tag)
      }
      notification.onclose = forget
      // 系统可能"接受但丢掉"通知（Windows 没有 AppUserModelID、勿扰模式等）。
      // 这时 onerror 会触发，把控制权交回调用方去兜底（弹应用内窗口），
      // 保证"通知没出现"不会被误判为"已经提醒过了"。
      notification.onerror = () => {
        forget()
        if (typeof options.onFailure === 'function') {
          try {
            options.onFailure()
          } catch {}
        }
      }
      active.set(tag, notification)
      return true
    } catch {
      return false
    }
  }

  function closeAll() {
    for (const notification of active.values()) {
      try {
        notification.close()
      } catch {}
    }
    active.clear()
  }

  return { supported, readPermission, requestPermission, show, closeAll }
}

// ─────────────────────────────── 状态仓库 ────────────────────────────

/** 一条待确认项的去重键。 */
function pendingKey(item) {
  return `${item.sessionId}|${item.kind}|${item.id}`
}

/** 待确认集合的稳定签名：内容没变就不触发重渲染。 */
function pendingSignatureOf(list) {
  if (!Array.isArray(list)) return ''
  let out = ''
  for (const item of list) {
    if (item) out += `${pendingKey(item)};`
  }
  return out
}

/**
 * 一个极简的可订阅仓库。
 *
 * 之所以不用 useSyncExternalStore 之外的方案：slot 里的组件拿不到 ctx，
 * 而提醒状态必须跨「侧边栏面板」和「覆盖层弹窗」两个组件共享，
 * 所以状态必须活在 apply 世界里、由组件订阅。
 *
 * @param {{audio?: object, notifier?: object}} [options] 仅测试用：注入假的音频/通知引擎
 */
function createStore(options) {
  const injectedAudio = options && options.audio ? options.audio : null
  const injectedNotifier = options && options.notifier ? options.notifier : null
  let audio = injectedAudio
  let notifier = injectedNotifier
  const listeners = new Set()
  /** 已提醒过的 key，避免同一待确认项反复弹窗。 */
  const alerted = new Set()
  /** 上一次消费到的完成序号；null = 还没建立基线。 */
  let lastCompletionSeq = null

  let state = {
    settings: DEFAULT_SETTINGS,
    log: [],
    pending: [],
    popup: null,
    queue: [],
    storageOk: true,
    repairedHint: false,
    reachable: true,
    // 轮询失败的原因（每次成功轮询后清空）
    transportError: '',
    // 需要用户看见的硬错误（注册失败、测试无通道等），不会被轮询清掉
    lastError: '',
    // 启动阶段：本地设置在 idle 里才读出来，之前用默认值渲染不会闪
    hydrated: false,
    // 桌面通知能力与权限：'granted' | 'denied' | 'default' | 'unsupported'
    notifySupported: true,
    notifyPermission: 'default',
  }

  function emit() {
    for (const fn of listeners) {
      try {
        fn()
      } catch {}
    }
  }

  function set(patch) {
    state = { ...state, ...patch }
    emit()
  }

  /** 惰性取音频引擎：第一次真的要响时才创建。 */
  function audioEngine() {
    if (audio === null) audio = createAudioEngine()
    return audio
  }

  // ── 初始化：读持久化（只在 idle 时由 boot() 调一次） ──
  function hydrate() {
    const { settings, repaired } = normalizeSettings(readStored(STORAGE_SETTINGS))
    const { entries, repaired: logRepaired } = normalizeLog(readStored(STORAGE_LOG))
    set({
      settings,
      log: entries,
      repairedHint: repaired || logRepaired,
      hydrated: true,
    })
    // 设置被规整/迁移过就回写一次，下次启动不用再算
    if (repaired || logRepaired) {
      writeStored(STORAGE_SETTINGS, { version: SETTINGS_VERSION, ...settings })
      writeStored(STORAGE_LOG, { version: LOG_VERSION, entries })
    }
    // 顺手把系统通知的能力/权限读进来（只读，不会弹权限框）
    syncNotify()
  }

  function persistSettings(next) {
    const ok = writeStored(STORAGE_SETTINGS, { version: SETTINGS_VERSION, ...next })
    set({ settings: next, storageOk: ok })
    return ok
  }

  function persistLog(next) {
    const ok = writeStored(STORAGE_LOG, { version: LOG_VERSION, entries: next })
    set({ log: next, storageOk: ok })
  }

  /** 追加一条日志（三层上限在 appendLog 里统一处理）。 */
  function appendEntry(entry) {
    persistLog(appendLog(state.log, entry, LOG_LIMIT))
  }

  /** 开始播放/刷新铃声；失败不影响已入队的弹窗。 */
  function startSound(settings, onceOnly) {
    try {
      audioEngine().start({
        preset: settings.soundPreset,
        customUrl: settings.customSoundUrl,
        volume: settings.volume,
        loop: onceOnly === true ? false : settings.loopUntilAck,
      })
    } catch {}
  }

  function stopSound() {
    if (audio === null) return
    try {
      audio.stop()
    } catch {}
  }

  /**
   * 把一条提醒放进"正在显示 / 排队"。
   * 先入队列再放声音是刻意的顺序：弹窗是主通道，声音是辅通道。
   */
  function enqueueAlert(alert) {
    if (state.popup === null) {
      set({ popup: alert })
      return
    }
    const next = [...state.queue, alert].slice(-POPUP_QUEUE_MAX)
    set({ queue: next })
  }

  /** 惰性取通知引擎：第一次真的要弹桌面通知时才创建。 */
  function notifierEngine() {
    if (notifier === null) notifier = createDesktopNotifier()
    return notifier
  }

  /** 把通知能力/权限同步到 state，供面板显示。 */
  function syncNotify() {
    const engine = notifierEngine()
    set({ notifySupported: engine.supported, notifyPermission: engine.readPermission() })
  }

  /**
   * 申请系统通知权限（必须在用户手势里调用）。
   * @returns {Promise<string>} 'granted' | 'denied' | 'default' | 'unsupported'
   */
  function requestNotifyPermission() {
    const engine = notifierEngine()
    if (!engine.supported) {
      set({ notifySupported: false, notifyPermission: 'unsupported' })
      return Promise.resolve('unsupported')
    }
    const current = engine.readPermission()
    if (current === 'granted' || current === 'denied') {
      set({ notifySupported: true, notifyPermission: current })
      return Promise.resolve(current)
    }
    const pending = engine.requestPermission()
    Promise.resolve(pending).then(permission => {
      set({ notifySupported: true, notifyPermission: permission })
    })
    return pending
  }

  /**
   * 弹一条桌面系统通知。
   * @param {'approval'|'taskDone'} kind
   * @param {{title: string, message: string}} copy 用户自定义文案
   * @param {{toolName?: string, sessionId?: string, turn?: number}} detail
   * @param {boolean} silent 静音（把"响不响"交给插件自己的合成音）
   * @param {() => void} [onFailure] 系统接受后仍失败（onerror）时的兜底回调
   */
  function showDesktop(kind, copy, detail, silent, onFailure) {
    const meta = []
    if (kind === 'taskDone') {
      if (detail.sessionId !== '') meta.push(`会话 ${shortId(detail.sessionId)}`)
      if (detail.turn > 0) meta.push(`第 ${detail.turn} 轮`)
    } else {
      if (detail.toolName !== '') meta.push(`触发工具：${detail.toolName}`)
      if (detail.sessionId !== '') meta.push(`会话 ${shortId(detail.sessionId)}`)
    }
    const body = meta.length > 0 ? `${copy.message}\n${meta.join(' · ')}` : copy.message
    return notifierEngine().show({
      // 两类各用一个 tag：同类新通知替换旧的，两类互不覆盖
      tag: `${PLUGIN_NAME}:${kind}`,
      title: `${kindTag(kind)}${copy.title}`,
      body,
      silent: silent === true,
      keep: true,
      onFailure,
    })
  }

  /**
   * 触发一次提醒。
   *
   * 通道选择（桌面通知优先）：
   *  - 开了桌面通知 → 先弹系统通知；
   *  - 开了应用内弹窗 → 再弹一个（用户主动要两个通道）；
   *  - 只开了桌面通知但系统通知没弹出来（无权限/不支持/抛错）→ 自动回退应用内弹窗，
   *    不会出现"什么都没看见"。
   *
   * @param {'approval'|'taskDone'} kind
   * @param {{id?: string, toolName?: string, sessionId?: string, turn?: number, via?: string, test?: boolean}} detail
   * @returns {boolean} 是否真的提醒到了
   */
  function fire(kind, detail) {
    const extra = detail && typeof detail === 'object' ? detail : {}
    const settings = state.settings
    const copy = alertCopy(settings, kind)

    // 总开关 / 分类开关：任意一个关掉都不打扰
    if (settings.enabled !== true) return false
    if (copy.enabled !== true) return false

    const wantsDesktop = settings.desktopNotifyEnabled === true
    const wantsInApp = settings.popupEnabled === true
    if (!wantsDesktop && !wantsInApp) return false

    const detailOf = {
      toolName: typeof extra.toolName === 'string' ? extra.toolName : '',
      sessionId: typeof extra.sessionId === 'string' ? extra.sessionId : '',
      turn: typeof extra.turn === 'number' ? extra.turn : 0,
    }

    const alert = {
      id: `${kind}:${extra.id ?? extra.turn ?? Date.now()}`,
      kind,
      title: copy.title,
      message: copy.message,
      confirmLabel: copy.confirmLabel,
      pinned: settings.popupPinned,
      autoCloseSeconds: settings.autoCloseSeconds,
      toolName: detailOf.toolName,
      sessionId: detailOf.sessionId,
      turn: detailOf.turn,
      via: typeof extra.via === 'string' ? extra.via : '',
      test: extra.test === true,
      at: Date.now(),
    }

    // 兜底：系统"接受但丢弃"通知时（onerror），把应用内弹窗补上，别让这次提醒消失
    const fallbackToInApp = () => {
      if (state.popup !== null && state.popup.id === alert.id) return
      enqueueAlert(alert)
      if (state.settings.soundEnabled === true) startSound(state.settings, false)
    }

    // 应用内弹窗要显示时，系统通知就静音，避免"两声"
    let desktopShown = false
    if (wantsDesktop) {
      desktopShown = showDesktop(kind, copy, detailOf, wantsInApp, wantsInApp ? undefined : fallbackToInApp)
    }

    // 明确开了应用内 → 两个都弹；否则只在系统通知失败时兜底
    const needInApp = wantsInApp || !desktopShown
    if (needInApp) enqueueAlert(alert)

    // 声音：有应用内弹窗时由插件自己响（可循环到确认）；纯桌面通知时由系统发声
    if (needInApp && settings.soundEnabled === true) {
      startSound(settings, false)
    } else if (!needInApp && settings.soundEnabled === true && !desktopShown) {
      startSound(settings, true)
    }

    return desktopShown || needInApp
  }

  /** 用户确认/关闭当前弹窗：收掉声音（与系统通知），并把排队的下一条顶上来。 */
  function dismissPopup() {
    closeDesktopNotifications()
    if (state.popup === null) {
      // 没有弹窗（例如应用内弹窗关着、只发了系统通知）时也要能停掉声音
      stopSound()
      return
    }

    const queue = state.queue
    const next = queue.length > 0 ? queue[0] : null
    set({ popup: next, queue: queue.slice(1) })

    if (next !== null && state.settings.soundEnabled === true) {
      startSound(state.settings)
    } else {
      stopSound()
    }
  }

  /** 关掉全部应用内弹窗与排队（例如用户刚把弹窗开关关掉）。 */
  function clearPopups() {
    stopSound()
    closeDesktopNotifications()
    if (state.popup === null && state.queue.length === 0) return
    set({ popup: null, queue: [] })
  }

  /** 收掉已经弹出的系统通知（用户确认/关闭时同步清场）。 */
  function closeDesktopNotifications() {
    if (notifier === null) return
    try {
      notifier.closeAll()
    } catch {}
  }

  /** 声音相关的字段有没有变（只有变了才重启铃声，别改个标题就重新响一遍）。 */
  function soundChanged(prev, next) {
    return (
      prev.soundPreset !== next.soundPreset ||
      prev.customSoundUrl !== next.customSoundUrl ||
      prev.volume !== next.volume ||
      prev.loopUntilAck !== next.loopUntilAck ||
      prev.soundEnabled !== next.soundEnabled
    )
  }

  /** 更新设置（走钳制）。 */
  function updateSettings(patch) {
    const previous = state.settings
    const next = mergeSettings(previous, patch)
    persistSettings(next)

    // 用户刚把桌面通知打开：借这次点击（用户手势）把权限要下来
    if (next.desktopNotifyEnabled === true && previous.desktopNotifyEnabled !== true) {
      requestNotifyPermission()
    }

    const popup = state.popup
    if (popup !== null) {
      // 对应的分类被关掉、或应用内弹窗被关掉：立刻收起来，别留一个"过期"窗口
      if (next.enabled !== true || next.popupEnabled !== true || alertCopy(next, popup.kind).enabled !== true) {
        clearPopups()
      } else if (next.soundEnabled !== true) {
        stopSound()
      } else if (soundChanged(previous, next)) {
        startSound(next)
      }
    }
    return next
  }

  /**
   * 消费宿主快照。
   * @param {{pending?: unknown[], completions?: unknown[], completionSeq?: number}} payload
   */
  function ingest(payload) {
    const data = payload && typeof payload === 'object' ? payload : {}
    const pending = Array.isArray(data.pending) ? data.pending : []
    const completions = Array.isArray(data.completions) ? data.completions : []
    const hostSeq = typeof data.completionSeq === 'number' && Number.isFinite(data.completionSeq)
      ? data.completionSeq
      : 0

    // 内容没变就不 set：免得每秒一次轮询都让面板整体重渲染
    const patch = {}
    if (pendingSignatureOf(pending) !== pendingSignatureOf(state.pending)) patch.pending = pending
    if (state.reachable !== true || state.transportError !== '') {
      patch.reachable = true
      patch.transportError = ''
    }
    if (Object.keys(patch).length > 0) set(patch)

    // ── 1. 任务完成（边沿事件）：先算增量，弹窗放到审批之后 ──
    let maxSeq = hostSeq
    for (const item of completions) {
      if (item && typeof item.seq === 'number' && item.seq > maxSeq) maxSeq = item.seq
    }

    let freshCompletions = []
    if (lastCompletionSeq === null) {
      // 首帧只建立基线：加载页面之前就完成的轮次不该补弹
      lastCompletionSeq = maxSeq
    } else if (maxSeq < lastCompletionSeq) {
      // 宿主重启，序号归零：重建基线而不是把旧记录当新边沿
      lastCompletionSeq = maxSeq
    } else {
      freshCompletions = completions
        .filter(item => item && typeof item.seq === 'number' && item.seq > lastCompletionSeq)
        .sort((a, b) => a.seq - b.seq)
      lastCompletionSeq = maxSeq
    }

    // ── 2. 人工审批（持续状态）优先弹：人正卡在那里等拍板 ──
    const freshPending = pending.filter(item => item && !alerted.has(pendingKey(item)))
    if (freshPending.length > 0) handlePending(freshPending)
    if (freshCompletions.length > 0) handleCompletions(freshCompletions)
  }

  /** 一次轮询里新出现的待确认项：全部落日志，只对最新一条弹窗。 */
  function handlePending(fresh) {
    for (const item of fresh) {
      // 刻意不把 reason / prompt 写进日志：提问内容属于对话正文
      appendEntry(
        makeEntry({
          kind: 'approval',
          via: item.kind === 'question' ? 'question' : 'tool',
          toolName: item.toolName,
          sessionId: item.sessionId,
        }),
      )
    }

    for (const item of fresh) markAlerted(pendingKey(item))

    const newest = fresh[fresh.length - 1]
    const fired = fire('approval', {
      id: newest.id,
      toolName: newest.toolName,
      sessionId: newest.sessionId,
      via: newest.kind === 'question' ? 'question' : 'tool',
    })

    // 同一批多条时把数量显示出来（弹窗可能刚好被用户关掉，所以再判一次）
    if (fired && fresh.length > 1 && state.popup !== null) {
      set({
        popup: {
          ...state.popup,
          message: `${state.popup.message}\n（本次共 ${fresh.length} 项待确认）`,
        },
      })
    }
  }

  /** 一次轮询里新完成的轮次：全部落日志，只对最新一条弹窗。 */
  function handleCompletions(fresh) {
    for (const item of fresh) {
      appendEntry(
        makeEntry({
          kind: 'taskDone',
          via: 'turn',
          sessionId: typeof item.sessionId === 'string' ? item.sessionId : '',
        }),
      )
    }

    const newest = fresh[fresh.length - 1]
    fire('taskDone', {
      id: `done-${newest.seq}`,
      sessionId: typeof newest.sessionId === 'string' ? newest.sessionId : '',
      turn: typeof newest.turn === 'number' ? newest.turn : 0,
      via: 'turn',
    })
  }

  /** 记入"已提醒"，同时把集合裁到上限（超长会话不会无限涨）。 */
  function markAlerted(key) {
    alerted.add(key)
    while (alerted.size > ALERTED_MAX) {
      const oldest = alerted.values().next().value
      if (oldest === undefined) break
      alerted.delete(oldest)
    }
  }

  function markUnreachable(message) {
    const text = typeof message === 'string' ? message : ''
    if (state.reachable === false && state.transportError === text) return
    set({ reachable: false, transportError: text })
  }

  /** 注册失败等硬错误：显示在面板顶部，不让它静默消失。 */
  function reportError(message) {
    set({ lastError: typeof message === 'string' ? message : String(message) })
  }

  /** 测试按钮：不写日志、不进"已提醒"集合；借这次点击申请系统通知权限。 */
  function runTest(kind) {
    const settings = state.settings
    const alertKind = kind === 'taskDone' ? 'taskDone' : 'approval'
    if (settings.desktopNotifyEnabled !== true && settings.popupEnabled !== true) {
      // 至少给个反馈，否则按钮像坏的
      set({ lastError: '桌面通知与应用内弹窗都被关掉了，先把它们打开再测试' })
      return
    }
    // 点击是用户手势，正好用来解锁自动播放
    try {
      audioEngine().unlock()
    } catch {}

    const fireNow = () => {
      const fired = fire(alertKind, {
        id: `test-${Date.now()}`,
        sessionId: 'test',
        toolName: alertKind === 'approval' ? '示例工具' : '',
        via: 'test',
        test: true,
      })
      if (!fired) {
        set({ lastError: '这一类提醒已被关掉，或总开关下没有任何可用通道' })
      }
    }

    // 桌面通知要权限：先申请（用户手势里同意率高），拿到后再弹
    if (settings.desktopNotifyEnabled === true) {
      Promise.resolve(requestNotifyPermission()).then(fireNow, fireNow)
    } else {
      fireNow()
    }
  }

  function clearLogs() {
    persistLog(clearLog())
  }

  function unlockAudio() {
    if (state.settings.soundEnabled !== true) return
    try {
      audioEngine().unlock()
    } catch {}
  }

  function dispose() {
    stopSound()
    if (audio !== null && typeof audio.dispose === 'function') {
      try {
        audio.dispose()
      } catch {}
    }
    if (notifier !== null) {
      try {
        notifier.closeAll()
      } catch {}
    }
    listeners.clear()
  }

  return {
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    getState: () => state,
    hydrate,
    updateSettings,
    ingest,
    markUnreachable,
    reportError,
    dismissPopup,
    clearPopups,
    runTest,
    clearLogs,
    unlockAudio,
    requestNotifyPermission,
    dispose,
  }
}

// ─────────────────────────────── 样式 ────────────────────────────────

/**
 * 全部颜色来自宿主主题 token；不写死颜色，深色主题自动跟随。
 * 少数 `transparent` / `inherit` 是关键字，不属于色值。
 */
const S = {
  page: {
    height: '100%',
    overflowY: 'auto',
    padding: '20px 22px 32px',
    background: 'var(--dsw-alias-bg-base)',
    color: 'var(--dsw-alias-label-primary)',
    font: 'inherit',
    boxSizing: 'border-box',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
    marginBottom: '16px',
  },
  title: { margin: 0, fontSize: '16px', fontWeight: 600, letterSpacing: '0.01em' },
  subtitle: {
    margin: '4px 0 0',
    fontSize: '12px',
    color: 'var(--dsw-alias-label-tertiary)',
    lineHeight: 1.5,
  },
  headerActions: { display: 'flex', gap: '8px', flex: '0 0 auto' },
  banner: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '10px 12px',
    marginBottom: '14px',
    borderRadius: 'var(--dsw-radius-md)',
    background: 'var(--dsw-alias-state-warn-secondary)',
    color: 'var(--dsw-alias-label-primary)',
    fontSize: '13px',
  },
  bannerError: { background: 'var(--dsw-alias-state-error-secondary)' },
  group: {
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: 'var(--dsw-radius-lg)',
    background: 'var(--dsw-alias-settings-card-fill)',
    marginBottom: '12px',
    overflow: 'hidden',
  },
  groupHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    padding: '10px 14px',
    background: 'transparent',
    border: 0,
    color: 'inherit',
    font: 'inherit',
    fontSize: '13px',
    fontWeight: 600,
    cursor: 'pointer',
    textAlign: 'left',
  },
  groupBody: { padding: '4px 14px 12px' },
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
    padding: '8px 0',
    borderTop: '1px solid var(--dsw-alias-separator-primary)',
  },
  rowFirst: { borderTop: 0 },
  label: { fontSize: '13px', lineHeight: 1.5 },
  hint: { display: 'block', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', marginTop: '2px' },
  subTitle: {
    margin: '10px 0 2px',
    fontSize: '12px',
    fontWeight: 600,
    color: 'var(--dsw-alias-label-secondary)',
  },
  switch: {
    position: 'relative',
    flex: '0 0 auto',
    width: '36px',
    height: '20px',
    borderRadius: '999px',
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-fill-l2)',
    cursor: 'pointer',
    padding: 0,
    transition: 'background 120ms ease',
  },
  switchOn: { background: 'var(--dsw-alias-brand-primary)', borderColor: 'transparent' },
  thumb: {
    position: 'absolute',
    top: '2px',
    left: '2px',
    width: '14px',
    height: '14px',
    borderRadius: '999px',
    background: 'var(--dsw-alias-switch-thumb)',
    transition: 'transform 120ms ease',
  },
  thumbOn: { transform: 'translateX(16px)' },
  input: {
    width: '120px',
    padding: '5px 8px',
    borderRadius: 'var(--dsw-radius-sm)',
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-layer-1)',
    color: 'inherit',
    font: 'inherit',
    fontSize: '12px',
    boxSizing: 'border-box',
  },
  textarea: {
    width: '100%',
    minHeight: '58px',
    padding: '6px 8px',
    borderRadius: 'var(--dsw-radius-sm)',
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-layer-1)',
    color: 'inherit',
    font: 'inherit',
    fontSize: '12px',
    lineHeight: 1.5,
    resize: 'vertical',
    boxSizing: 'border-box',
  },
  range: { width: '140px', accentColor: 'var(--dsw-alias-brand-primary)' },
  button: {
    padding: '6px 12px',
    borderRadius: 'var(--dsw-radius-md)',
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-button-elevated-fill)',
    color: 'var(--dsw-alias-label-primary)',
    font: 'inherit',
    fontSize: '12px',
    cursor: 'pointer',
  },
  buttonPrimary: {
    padding: '7px 16px',
    borderRadius: 'var(--dsw-radius-md)',
    border: 0,
    background: 'var(--dsw-alias-button-primary-fill)',
    color: 'var(--dsw-alias-button-contrast-fill)',
    font: 'inherit',
    fontSize: '13px',
    fontWeight: 600,
    cursor: 'pointer',
  },
  buttonGhost: {
    padding: '4px 10px',
    borderRadius: 'var(--dsw-radius-sm)',
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'transparent',
    color: 'var(--dsw-alias-label-secondary)',
    font: 'inherit',
    fontSize: '12px',
    cursor: 'pointer',
  },
  logs: { maxHeight: '220px', overflowY: 'auto', margin: 0, padding: 0, listStyle: 'none' },
  logItem: {
    display: 'flex',
    gap: '8px',
    alignItems: 'baseline',
    padding: '6px 0',
    borderTop: '1px solid var(--dsw-alias-separator-primary)',
    fontSize: '12px',
    lineHeight: 1.5,
  },
  logTime: { color: 'var(--dsw-alias-label-tertiary)', fontVariantNumeric: 'tabular-nums', flex: '0 0 auto' },
  logMeta: { color: 'var(--dsw-alias-label-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  empty: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)', padding: '10px 0' },
  help: { fontSize: '12px', lineHeight: 1.7, color: 'var(--dsw-alias-label-secondary)' },
  loading: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)', padding: '14px 0' },
  mask: {
    position: 'fixed',
    inset: 0,
    zIndex: 2147483000,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '24px',
    background: 'var(--dsw-alias-bg-mask-2)',
  },
  dialog: {
    width: 'min(440px, 100%)',
    borderRadius: 'var(--dsw-radius-panel)',
    background: 'var(--dsw-alias-bg-layer-2)',
    boxShadow: 'var(--dsw-elevation-prominent)',
    border: '1px solid var(--dsw-alias-border-l1)',
    padding: '22px 22px 18px',
    color: 'var(--dsw-alias-label-primary)',
    boxSizing: 'border-box',
  },
  kindChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    padding: '2px 8px',
    borderRadius: '999px',
    fontSize: '11px',
    fontWeight: 600,
    lineHeight: 1.6,
    flex: '0 0 auto',
  },
  kindApproval: {
    background: 'var(--dsw-alias-state-warn-secondary)',
    color: 'var(--dsw-alias-state-warn-primary)',
  },
  kindTaskDone: {
    background: 'var(--dsw-alias-state-success-secondary)',
    color: 'var(--dsw-alias-state-success-primary)',
  },
  dialogTitle: { margin: 0, fontSize: '15px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px' },
  dialogBody: {
    margin: '10px 0 0',
    fontSize: '13px',
    lineHeight: 1.65,
    color: 'var(--dsw-alias-label-secondary)',
    whiteSpace: 'pre-wrap',
  },
  dialogMeta: {
    margin: '8px 0 0',
    fontSize: '12px',
    lineHeight: 1.5,
    color: 'var(--dsw-alias-label-tertiary)',
  },
  dialogFoot: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginTop: '18px' },
  countdown: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)', fontVariantNumeric: 'tabular-nums' },
}

// ───────────────────────────── 基础控件 ──────────────────────────────

/** 开关：保住宿主的 role/aria 语义，键盘可用。 */
function Switch({ checked, onChange, label }) {
  return React.createElement(
    'button',
    {
      type: 'button',
      role: 'switch',
      'aria-checked': checked === true,
      'aria-label': label,
      style: checked ? { ...S.switch, ...S.switchOn } : S.switch,
      onClick: () => onChange(checked !== true),
    },
    React.createElement('span', { style: checked ? { ...S.thumb, ...S.thumbOn } : S.thumb }),
  )
}

/** 一行「标签 + 控件」。 */
function Row({ label, hint, children, first }) {
  return React.createElement(
    'div',
    { style: first ? { ...S.row, ...S.rowFirst } : S.row },
    React.createElement(
      'div',
      { style: S.label },
      label,
      hint ? React.createElement('span', { style: S.hint }, hint) : null,
    ),
    children,
  )
}

/** 可折叠分组。 */
function Group({ title, children, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen !== false)
  return React.createElement(
    'section',
    { style: S.group },
    React.createElement(
      'button',
      {
        type: 'button',
        style: S.groupHead,
        'aria-expanded': open,
        onClick: () => setOpen(!open),
      },
      React.createElement('span', null, title),
      React.createElement('span', { style: S.hint, 'aria-hidden': true }, open ? '收起' : '展开'),
    ),
    open ? React.createElement('div', { style: S.groupBody }, children) : null,
  )
}

/** 类型标记：弹窗与日志共用同一套配色，两类一眼能分开。 */
function KindChip({ kind }) {
  const done = kind === 'taskDone'
  return React.createElement(
    'span',
    { style: done ? { ...S.kindChip, ...S.kindTaskDone } : { ...S.kindChip, ...S.kindApproval } },
    kindTag(kind),
  )
}

/** 系统通知权限 → 面板上的短标签。 */
function permissionLabel(supported, permission) {
  if (supported === false) return '当前环境不支持'
  if (permission === 'granted') return '已授权'
  if (permission === 'denied') return '已被拒绝'
  return '尚未授权'
}

/** 系统通知权限 → 面板上的说明文案。 */
function permissionHint(supported, permission) {
  if (supported === false) return '这个环境没有系统通知能力，只能用应用内弹窗兜底'
  if (permission === 'granted') return '系统通知可以正常弹出'
  if (permission === 'denied') return '需要在浏览器/系统的通知设置里恢复，否则回退到应用内弹窗'
  return '申请后才能在 DSH 最小化时弹通知'
}

/** 侧边栏图标（artwork，允许不依赖 token）。 */
function Icon() {
  return React.createElement(
    'svg',
    {
      width: 18,
      height: 18,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.6,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
    },
    React.createElement('path', {
      d: 'M12 3a6 6 0 0 0-6 6v3.2c0 .7-.25 1.4-.7 1.95L4 16h16l-1.3-1.85A3.2 3.2 0 0 1 18 12.2V9a6 6 0 0 0-6-6Z',
    }),
    React.createElement('path', { d: 'M9.5 19a2.5 2.5 0 0 0 5 0' }),
    React.createElement('circle', { cx: 17.5, cy: 6.5, r: 3.2, fill: 'currentColor', stroke: 'none' }),
  )
}

/**
 * 首帧之后再做的工作（用于面板正文的懒加载）。
 * 返回 false 表示"还在空闲队列里排着"。
 */
function useDeferredReady(timeout) {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let alive = true
    const cancel = scheduleIdle(() => {
      if (alive) setReady(true)
    }, timeout)
    return () => {
      alive = false
      cancel()
    }
  }, [timeout])
  return ready
}

// ───────────────────────────── 弹窗组件 ──────────────────────────────

/**
 * 覆盖层弹窗。挂在 `shell.overlay` slot 上，因此天然覆盖全站。
 * 组件自身只依赖 store 的 popup / queue 字段；popup 为空时什么都不渲染。
 *
 * 注意 slot 契约：`shell.overlay` 是 **list** 类型，注册时必须给 `id`
 * （给 `key` 会抛错，组件就永远不会挂载 —— 这正是 v1"只有声音没有弹窗"的根因）。
 */
function AlertPopup({ store }) {
  const state = useSyncExternalStore(store.subscribe, store.getState)
  const popup = state.popup
  const confirmRef = useRef(null)
  const [left, setLeft] = useState(0)

  const close = useCallback(() => store.dismissPopup(), [store])

  // 倒计时：autoCloseSeconds > 0 才启动
  useEffect(() => {
    if (popup === null) return undefined
    const total = typeof popup.autoCloseSeconds === 'number' ? popup.autoCloseSeconds : 0
    if (total <= 0) {
      setLeft(0)
      return undefined
    }
    setLeft(total)
    const startedAt = Date.now()
    const timer = window.setInterval(() => {
      const rest = total - Math.floor((Date.now() - startedAt) / 1000)
      if (rest <= 0) {
        window.clearInterval(timer)
        setLeft(0)
        close()
        return
      }
      setLeft(rest)
    }, 250)
    // 卸载或弹窗替换时清掉定时器，避免泄漏与二次关闭
    return () => window.clearInterval(timer)
  }, [popup, close])

  // 焦点与 Escape：这两条是用户对 Modal 的既有预期，必须保住
  useEffect(() => {
    if (popup === null) return undefined
    const node = confirmRef.current
    if (node !== null && typeof node.focus === 'function') node.focus()
    const onKeyDown = event => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [popup, close])

  if (popup === null) return null

  const meta = []
  if (popup.kind === 'taskDone') {
    if (popup.sessionId !== '') meta.push(`会话 ${shortId(popup.sessionId)}`)
    if (popup.turn > 0) meta.push(`第 ${popup.turn} 轮`)
  } else {
    if (popup.toolName !== '') meta.push(`触发工具：${popup.toolName}`)
    if (popup.sessionId !== '') meta.push(`会话 ${shortId(popup.sessionId)}`)
  }
  if (state.queue.length > 0) meta.push(`还有 ${state.queue.length} 条提醒在排队`)

  return React.createElement(
    'div',
    { style: S.mask, role: 'presentation' },
    React.createElement(
      'div',
      {
        role: 'alertdialog',
        'aria-modal': 'true',
        'aria-labelledby': 'dsh-human-alert-title',
        'data-alert-kind': popup.kind,
        style: S.dialog,
      },
      React.createElement(
        'h2',
        { id: 'dsh-human-alert-title', style: S.dialogTitle },
        React.createElement(KindChip, { kind: popup.kind }),
        popup.title,
      ),
      React.createElement('p', { style: S.dialogBody }, popup.message),
      meta.length > 0 ? React.createElement('p', { style: S.dialogMeta }, meta.join(' · ')) : null,
      React.createElement(
        'div',
        { style: S.dialogFoot },
        React.createElement(
          'span',
          { style: S.countdown },
          left > 0 ? `${left} 秒后自动关闭` : popup.test ? '这是一次测试提醒' : '',
        ),
        React.createElement(
          'div',
          { style: { display: 'flex', gap: '8px' } },
          React.createElement(
            'button',
            { type: 'button', style: S.buttonGhost, onClick: close },
            '关闭',
          ),
          React.createElement(
            'button',
            { type: 'button', ref: confirmRef, style: S.buttonPrimary, onClick: close },
            popup.confirmLabel,
          ),
        ),
      ),
    ),
  )
}

// ──────────────────────────── 设置面板组件 ───────────────────────────

/** 两类提醒的文案编辑区（结构一致，只是字段前缀不同）。 */
function CopyFields({ settings, update, prefix, title }) {
  return React.createElement(
    'div',
    null,
    React.createElement('div', { style: S.subTitle }, title),
    React.createElement(
      Row,
      { label: '弹窗标题', first: true },
      React.createElement('input', {
        type: 'text',
        value: settings[`${prefix}Title`],
        'aria-label': `${title}弹窗标题`,
        style: S.input,
        onChange: event => update({ [`${prefix}Title`]: event.target.value }),
      }),
    ),
    React.createElement(
      Row,
      { label: '确认按钮文字' },
      React.createElement('input', {
        type: 'text',
        value: settings[`${prefix}ConfirmLabel`],
        'aria-label': `${title}确认按钮文字`,
        style: S.input,
        onChange: event => update({ [`${prefix}ConfirmLabel`]: event.target.value }),
      }),
    ),
    React.createElement(
      'div',
      { style: { paddingTop: '8px' } },
      React.createElement('div', { style: S.label }, '提示文案'),
      React.createElement('textarea', {
        value: settings[`${prefix}Message`],
        'aria-label': `${title}提示文案`,
        style: { ...S.textarea, marginTop: '4px' },
        onChange: event => update({ [`${prefix}Message`]: event.target.value }),
      }),
    ),
  )
}

/** 面板骨架：首帧只画这些，正文等 idle 再上（避免打开面板时一次性算太多）。 */
function PanelSkeleton({ state }) {
  return React.createElement(
    'div',
    { style: S.page },
    React.createElement(
      'header',
      { style: S.header },
      React.createElement(
        'div',
        null,
        React.createElement('h1', { style: S.title }, PANEL_TITLE),
        React.createElement('p', { style: S.subtitle }, '桌面系统通知（DSH 最小化也可见）：人工审批 / 任务完成，各自独立开关与文案。'),
      ),
    ),
    state.storageOk === false
      ? React.createElement('div', { style: S.banner }, '浏览器不允许写入本地存储，本次设置与日志只在当前页面有效。')
      : null,
    React.createElement('p', { style: S.loading }, '正在加载设置面板…'),
  )
}

/**
 * 主面板。挂在 `main` slot 上（侧边栏入口点击后展示）。
 */
function AlertPanel({ store }) {
  const state = useSyncExternalStore(store.subscribe, store.getState)
  const ready = useDeferredReady(PANEL_DEFER_MS)
  const settings = state.settings
  const update = useCallback(patch => store.updateSettings(patch), [store])

  if (!ready) return React.createElement(PanelSkeleton, { state })

  return React.createElement(
    'div',
    { style: S.page },
    React.createElement(
      'header',
      { style: S.header },
      React.createElement(
        'div',
        null,
        React.createElement('h1', { style: S.title }, PANEL_TITLE),
        React.createElement(
          'p',
          { style: S.subtitle },
          '任务需要你审批、或某一轮跑完时，用桌面系统通知和声音叫你（DSH 最小化也看得见）。只提醒，不代替你做决定。',
        ),
      ),
      React.createElement(
        'div',
        { style: S.headerActions },
        React.createElement(
          'button',
          { type: 'button', style: S.button, onClick: () => store.runTest('approval') },
          '测试审批',
        ),
        React.createElement(
          'button',
          { type: 'button', style: S.button, onClick: () => store.runTest('taskDone') },
          '测试完成',
        ),
      ),
    ),

    state.storageOk === false
      ? React.createElement('div', { style: S.banner }, '浏览器不允许写入本地存储，本次设置与日志只在当前页面有效。')
      : null,

    state.settings.desktopNotifyEnabled === true &&
    state.notifySupported === true &&
    state.notifyPermission === 'denied'
      ? React.createElement(
          'div',
          { style: S.banner },
          '系统通知权限被拒绝：现在会用应用内弹窗兜底。到浏览器/系统的通知设置里允许后再试。',
        )
      : null,

    state.reachable === false
      ? React.createElement(
          'div',
          { style: S.banner },
          `暂时读不到宿主状态（${state.transportError !== '' ? state.transportError : '插件可能还没挂上'}）。` +
            '正在自动重试；若一直如此，请确认装完插件后重启过 DSH。',
        )
      : null,

    state.repairedHint === true
      ? React.createElement('div', { style: S.banner }, '检测到异常的本地设置/日志，已回退到默认值并回写。')
      : null,

    state.lastError !== ''
      ? React.createElement('div', { style: { ...S.banner, ...S.bannerError } }, state.lastError)
      : null,

    state.pending.length > 0
      ? React.createElement(
          'div',
          { style: S.banner },
          `当前有 ${state.pending.length} 项待确认，回到会话页处理即可。`,
        )
      : null,

    // ── 总开关 ──
    React.createElement(
      Group,
      { title: '总开关' },
      React.createElement(
        Row,
        { label: '启用提醒', hint: '关闭后不弹窗、不响铃（日志照常记录）', first: true },
        React.createElement(Switch, {
          checked: settings.enabled,
          label: '启用提醒',
          onChange: value => update({ enabled: value }),
        }),
      ),
    ),

    // ── 两类提醒各自开关 ──
    React.createElement(
      Group,
      { title: '提醒类型' },
      React.createElement(
        Row,
        { label: '【人工审批】提醒', hint: 'agent 要审批一个操作，或调用 ask_user_question 向你提问', first: true },
        React.createElement(Switch, {
          checked: settings.approvalEnabled,
          label: '人工审批提醒',
          onChange: value => update({ approvalEnabled: value }),
        }),
      ),
      React.createElement(
        Row,
        { label: '【任务完成】提醒', hint: '某一轮任务正常跑完（取消、报错、被拦截不算）' },
        React.createElement(Switch, {
          checked: settings.taskDoneEnabled,
          label: '任务完成提醒',
          onChange: value => update({ taskDoneEnabled: value }),
        }),
      ),
      React.createElement(
        'p',
        { style: S.hint },
        '按类型分开关与文案可以做到：审批要大动静，完成只轻提醒；或者反过来。',
      ),
    ),

    // ── 桌面通知（主通道） ──
    React.createElement(
      Group,
      { title: '桌面通知' },
      React.createElement(
        Row,
        {
          label: '系统桌面通知',
          hint: '右下角独立系统通知：DSH 最小化、切到别的窗口也能看到，不抢焦点',
          first: true,
        },
        React.createElement(Switch, {
          checked: settings.desktopNotifyEnabled,
          label: '系统桌面通知',
          onChange: value => update({ desktopNotifyEnabled: value }),
        }),
      ),
      React.createElement(
        Row,
        { label: '通知权限', hint: permissionHint(state.notifySupported, state.notifyPermission) },
        React.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          React.createElement('span', { style: S.label }, permissionLabel(state.notifySupported, state.notifyPermission)),
          state.notifySupported && state.notifyPermission !== 'granted'
            ? React.createElement(
                'button',
                {
                  type: 'button',
                  style: S.buttonGhost,
                  onClick: () => {
                    Promise.resolve(store.requestNotifyPermission()).catch(() => {})
                  },
                },
                '申请权限',
              )
            : null,
        ),
      ),
      React.createElement(
        'p',
        { style: S.hint },
        '通知由操作系统渲染：置顶、不抢焦点；点击通知才会回到 DSH。DSH 进程完全退出后无法提醒（这是浏览器内插件的边界）。',
      ),
    ),

    // ── 应用内弹窗（兜底） ──
    React.createElement(
      Group,
      { title: '应用内弹窗（兜底）' },
      React.createElement(
        Row,
        {
          label: '应用内弹窗',
          hint: '默认关闭；系统通知弹不出来时自动用它兜底。打开则两个通道都弹',
          first: true,
        },
        React.createElement(Switch, {
          checked: settings.popupEnabled,
          label: '应用内弹窗',
          onChange: value => update({ popupEnabled: value }),
        }),
      ),
      React.createElement(
        Row,
        { label: '始终置顶', hint: '应用内弹窗覆盖在所有内容之上，不随页面滚动' },
        React.createElement(Switch, {
          checked: settings.popupPinned,
          label: '始终置顶',
          onChange: value => update({ popupPinned: value }),
        }),
      ),
      React.createElement(
        Row,
        { label: '自动关闭', hint: '单位秒；填 0 表示一直等你确认' },
        React.createElement('input', {
          type: 'number',
          min: SETTINGS_LIMITS.autoCloseSeconds[0],
          max: SETTINGS_LIMITS.autoCloseSeconds[1],
          step: 5,
          value: settings.autoCloseSeconds,
          'aria-label': '自动关闭时长（秒）',
          style: S.input,
          onChange: event => update({ autoCloseSeconds: Number(event.target.value) }),
        }),
      ),
    ),

    // ── 声音 ──
    React.createElement(
      Group,
      { title: '声音' },
      React.createElement(
        Row,
        { label: '声音提醒', first: true },
        React.createElement(Switch, {
          checked: settings.soundEnabled,
          label: '声音提醒',
          onChange: value => update({ soundEnabled: value }),
        }),
      ),
      React.createElement(
        Row,
        { label: '提示音' },
        React.createElement(
          'select',
          {
            value: settings.soundPreset,
            'aria-label': '提示音来源',
            style: S.input,
            onChange: event => update({ soundPreset: event.target.value }),
          },
          React.createElement('option', { value: 'synth' }, '内置合成音'),
          React.createElement('option', { value: 'custom' }, '自定义音频'),
        ),
      ),
      settings.soundPreset === 'custom'
        ? React.createElement(
            Row,
            { label: '音频地址', hint: '支持 http(s) 或 data: 音频，例如一段铃声 URL' },
            React.createElement('input', {
              type: 'url',
              value: settings.customSoundUrl,
              placeholder: 'https://…/alarm.mp3',
              'aria-label': '自定义音频地址',
              style: S.input,
              onChange: event => update({ customSoundUrl: event.target.value }),
            }),
          )
        : null,
      React.createElement(
        Row,
        { label: '音量' },
        React.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          React.createElement('input', {
            type: 'range',
            min: 0,
            max: 100,
            step: 5,
            value: settings.volume,
            'aria-label': '音量',
            style: S.range,
            onChange: event => update({ volume: Number(event.target.value) }),
          }),
          React.createElement('span', { style: S.hint }, `${settings.volume}`),
        ),
      ),
      React.createElement(
        Row,
        { label: '持续响铃', hint: '一直响到你确认；关闭则只响一次' },
        React.createElement(Switch, {
          checked: settings.loopUntilAck,
          label: '持续响铃',
          onChange: value => update({ loopUntilAck: value }),
        }),
      ),
    ),

    // ── 文案（两类各一套） ──
    React.createElement(
      Group,
      { title: '提醒文案' },
      React.createElement(CopyFields, { settings, update, prefix: 'approval', title: '【人工审批】' }),
      React.createElement(CopyFields, { settings, update, prefix: 'taskDone', title: '【任务完成】' }),
    ),

    // ── 日志 ──
    React.createElement(
      Group,
      { title: `提醒日志（${state.log.length} / ${LOG_LIMIT}）` },
      state.log.length === 0
        ? React.createElement('p', { style: S.empty }, '还没有记录。等到第一次需要你确认、或某一轮跑完时会出现在这里。')
        : React.createElement(
            'ul',
            { style: S.logs },
            state.log.slice(0, LOG_RENDER_LIMIT).map(entry =>
              React.createElement(
                'li',
                { key: entry.id, style: S.logItem },
                React.createElement('span', { style: S.logTime }, formatTime(entry.at)),
                React.createElement(KindChip, { kind: entry.kind }),
                React.createElement(
                  'span',
                  { style: S.logMeta },
                  [
                    describeVia(entry.via) !== '' ? describeVia(entry.via) : null,
                    entry.toolName !== '' ? entry.toolName : null,
                    entry.sessionId !== '' ? `会话 ${shortId(entry.sessionId)}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ') || '—',
                ),
                entry.test ? React.createElement('span', { style: S.hint }, '测试') : null,
              ),
            ),
          ),
      React.createElement(
        'div',
        { style: { marginTop: '10px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' } },
        React.createElement(
          'span',
          { style: S.hint },
          `最多保存 ${LOG_LIMIT} 条（超出丢最旧的），面板只渲染最近 ${LOG_RENDER_LIMIT} 条。`,
        ),
        React.createElement(
          'button',
          { type: 'button', style: S.buttonGhost, onClick: () => store.clearLogs() },
          '清空日志',
        ),
      ),
    ),

    // ── 帮助 ──
    React.createElement(
      Group,
      { title: '帮助', defaultOpen: false },
      React.createElement(
        'div',
        { style: S.help },
        React.createElement('p', { style: { margin: '0 0 8px' } }, '什么时候会响？'),
        React.createElement(
          'ul',
          { style: { margin: '0 0 10px', paddingLeft: '18px' } },
          React.createElement('li', null, '【人工审批】agent 要执行需要审批的操作，或调用 ask_user_question 向你提问。'),
          React.createElement('li', null, '【任务完成】某一轮任务正常跑完（turn/end 且原因为 completed）。'),
          React.createElement('li', null, '子 agent（subagent）的内部轮次结束不会提醒；取消/报错也不会。'),
          React.createElement('li', null, '普通自动任务不会触发任何提醒，也不会被打断。'),
        ),
        React.createElement('p', { style: { margin: '0 0 8px' } }, '两类怎么区分？'),
        React.createElement(
          'p',
          { style: { margin: '0 0 10px' } },
          '开关独立、文案独立、日志标记独立（【人工审批】用警示色，【任务完成】用成功色）。关掉一类不影响另一类。',
        ),
        React.createElement('p', { style: { margin: '0 0 8px' } }, '弹窗长什么样？'),
        React.createElement(
          'p',
          { style: { margin: '0 0 10px' } },
          '默认是操作系统右下角的通知（标题带【人工审批】/【任务完成】），脱离 DSH 主窗口、不抢焦点；DSH 最小化或被别的窗口盖住也看得见。应用内弹窗默认关闭，只在系统通知弹不出来时兜底；也可以两个通道都打开。',
        ),
        React.createElement('p', { style: { margin: '0 0 8px' } }, '为什么最小化也能提醒？'),
        React.createElement(
          'p',
          { style: { margin: '0 0 10px' } },
          '客户端不靠定时器轮询（浏览器会把后台定时器节流到每分钟一次），而是向宿主发长轮询请求，状态一变宿主立刻回包。DSH 进程完全退出后没有进程能提醒，这是插件边界。',
        ),
        React.createElement('p', { style: { margin: '0 0 8px' } }, '插件会替我做决定吗？'),
        React.createElement('p', { style: { margin: '0 0 10px' } }, '不会。它只读监听事件，既不批准也不回答。'),
        React.createElement('p', { style: { margin: '0 0 8px' } }, '数据存在哪里？'),
        React.createElement(
          'p',
          { style: { margin: '0 0 10px' } },
          '设置与日志都存在你这台机器的浏览器 localStorage 里（键前缀 dsh-human-alert:），不上传、不跨设备同步。日志只记时间、类型、工具名与会话 id，不记对话内容。',
        ),
        React.createElement('p', { style: { margin: '0 0 8px' } }, '怎么完全关掉？'),
        React.createElement(
          'p',
          { style: { margin: 0 } },
          '把「启用提醒」关掉即可。彻底移除则从 profile 卸载插件：dsh plugin --profile desktop remove dsh-human-alert',
        ),
      ),
    ),
  )
}

// ─────────────────────── 状态订阅（长轮询 + 退化轮询） ─────────────────

/**
 * 订阅宿主状态。
 *
 * 主路径是**长轮询**：客户端发一个请求，宿主挂起它，状态一变立刻回包。
 * 这样做的原因很实际 —— 浏览器会把后台页面的定时器节流（隐藏 5 分钟后可能
 * 低到每分钟一次），纯 `setTimeout` 轮询在 DSH 最小化时提醒会迟到一分钟；
 * 而网络回调不受定时器节流影响，所以"最小化也能立刻弹通知"必须靠它。
 *
 * 退化路径：老宿主没有 `/wait`（404）或长轮询连续失败时，切回 `/state` 轮询，
 * 可见时 1s、隐藏时 5s，保证功能不因版本不匹配而失效。
 *
 * @param {ReturnType<typeof createStore>} store
 */
function startSubscription(store) {
  let stopped = false
  let controller = null
  let failures = 0
  let mode = 'wait'
  let lastRevision = -1

  function nextUrl() {
    if (mode === 'poll') return STATE_URL
    return `${WAIT_URL}?since=${encodeURIComponent(String(lastRevision))}`
  }

  function abortInFlight() {
    if (controller !== null) {
      try {
        controller.abort()
      } catch {}
      controller = null
    }
  }

  async function loop() {
    while (!stopped) {
      const Ctor = typeof AbortController === 'function' ? AbortController : null
      controller = Ctor === null ? null : new Ctor()
      const before = lastRevision
      try {
        const response = await fetch(nextUrl(), {
          method: 'GET',
          headers: { accept: 'application/json' },
          cache: 'no-store',
          ...(controller === null ? {} : { signal: controller.signal }),
        })
        if (stopped) return
        if (!response.ok) {
          const failure = new Error(`HTTP ${response.status}`)
          failure.status = response.status
          throw failure
        }
        const data = await response.json()
        if (stopped) return
        failures = 0
        if (data && typeof data.revision === 'number') lastRevision = data.revision
        store.ingest(data)
        if (mode === 'poll') {
          await delay(documentHidden() ? 5000 : POLL_MS)
        } else if (lastRevision === before) {
          // 防御：正常长轮询不会这样回包（它至少会等到超时），万一宿主立刻
          // 返回同一个版本，这里必须让出时间片，否则会变成自旋。
          await delay(POLL_MS)
        }
      } catch (error) {
        if (stopped) return
        if (error && error.name === 'AbortError') return
        failures += 1
        // 老宿主没有 /wait（404/405）：立刻退化成轮询，别等退避、别一直打 404。
        // 这种情况不算"读不到宿主"，所以不点亮错误横幅。
        if (mode === 'wait' && (error.status === 404 || error.status === 405)) {
          mode = 'poll'
          failures = 0
          continue
        }
        store.markUnreachable(error && error.message ? error.message : '')
        if (mode === 'wait' && failures >= WAIT_FAILURES_BEFORE_FALLBACK) {
          mode = 'poll'
          failures = 0
          continue
        }
        await delay(Math.min(POLL_MS * 2 ** Math.min(failures, 4), POLL_MAX_MS))
      }
    }
  }

  loop()

  return () => {
    stopped = true
    abortInFlight()
  }
}

// ─────────────────────────── 插件入口 ───────────────────────────────

const inject = ['slots']

/**
 * slot 标识符契约（**这就是 v1 弹窗不出现的根因**）：
 *  - `main`                 → keyed slot，用 `key`
 *  - `sidebar.panellist`    → list slot，用 `id`
 *  - `shell.overlay`        → list slot，用 `id`（写 `key` 会抛
 *                             `list slot "shell.overlay" requires options.id`）
 *
 * 记在常量里，既方便单测逐个核对，也避免以后凭印象再写错。
 */
const SLOT_CONTRACT = {
  'sidebar.panellist': 'id',
  main: 'key',
  'shell.overlay': 'id',
}

/**
 * 注册一个 slot 条目：失败只记录、不抛出。
 *
 * v1 的弹窗注册抛错后，错误被 slot 框架吞掉，界面表现为"有声音没弹窗"，
 * 用户和开发者都无从下手。现在把异常写进 store，面板顶部会直接显示原因。
 */
function registerSlot(ctx, store, slotName, descriptor, component) {
  try {
    ctx.slots.inject(slotName, () => {
      try {
        return ctx.slots.register({ name: slotName, ...descriptor }, component)
      } catch (error) {
        store.reportError(`${slotName} 注册失败：${error && error.message ? error.message : error}`)
        return undefined
      }
    })
  } catch (error) {
    store.reportError(`${slotName} 注入失败：${error && error.message ? error.message : error}`)
  }
}

function apply(ctx) {
  const store = createStore()

  let stopSubscription = null
  let booted = false
  let cancelBoot = null

  /**
   * 真正的初始化：读 localStorage、开始订阅宿主状态。
   * 全部推迟到空闲时执行，`apply()` 里不碰任何 I/O。
   */
  function boot() {
    if (booted) return
    booted = true
    try {
      store.hydrate()
    } catch {}
    // 长轮询一上来就建立：它自己会等，不需要延迟，也不占定时器
    stopSubscription = startSubscription(store)
  }

  // ① 初始化延迟到 idle：首屏只剩"注册组件"这点成本
  cancelBoot = scheduleIdle(boot, BOOT_TIMEOUT_MS)

  // ② 音频/通知权限都要用户手势：这里只挂两个一次性监听
  const unlock = () => {
    store.unlockAudio()
    // 首次点击顺手把系统通知权限要下来（这两件事都必须在用户手势里做）
    if (store.getState().settings.desktopNotifyEnabled === true) {
      Promise.resolve(store.requestNotifyPermission()).catch(() => {})
    }
  }
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('pointerdown', unlock, { once: true })
    window.addEventListener('keydown', unlock, { once: true })
  }

  // ③ 侧边栏/面板/覆盖层：注册的是"薄组件"，重活全在组件内部按需做
  registerSlot(
    ctx,
    store,
    'sidebar.panellist',
    { id: PLUGIN_NAME, order: 20, label: PANEL_TITLE },
    Icon,
  )

  registerSlot(ctx, store, 'main', { key: PLUGIN_NAME }, props =>
    React.createElement(AlertPanel, { ...props, store }),
  )

  // 覆盖层是 list slot：必须给 id。组件内部自己读 store，props 只做透传。
  registerSlot(ctx, store, 'shell.overlay', { id: PLUGIN_NAME, order: 100 }, props =>
    React.createElement(AlertPopup, { ...props, store }),
  )

  // 所有注册都走 ctx.effect，卸载/热重载时自动回收
  ctx.effect(() => () => {
    if (typeof cancelBoot === 'function') cancelBoot()
    if (typeof stopSubscription === 'function') stopSubscription()
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
    store.dispose()
  })
}

module.exports = {
  inject,
  apply,
  /**
   * 仅测试用的内部句柄：让 node --test 能在没有 DOM 的情况下驱动
   * store / 音频引擎 / 桌面通知 / 调度器，验证"两类提醒都弹窗""桌面通知失败要兜底"这类不变量。
   * 不属于对外契约，宿主不会读它。
   */
  __internals: {
    createStore,
    createAudioEngine,
    createDesktopNotifier,
    startSubscription,
    scheduleIdle,
    pendingKey,
    SLOT_CONTRACT,
    PLUGIN_NAME,
    constants: { LOG_LIMIT, LOG_RENDER_LIMIT, ALERTED_MAX, POPUP_QUEUE_MAX, POLL_MS, STATE_URL, WAIT_URL },
  },
}
