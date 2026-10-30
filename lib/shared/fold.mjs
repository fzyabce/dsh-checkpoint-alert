/**
 * 会话事件 → 提醒状态的折叠逻辑（纯函数）。
 *
 * 输入是 DSH 的 `session/event` 事件流里我们关心的几类事件：
 *   - `approval/asked`    工具调用需要人工审批  → 加一条 pending（kind: approval）
 *   - `tool/call`         且工具名 ask_user_question → 加一条 pending（kind: question）
 *   - `approval/decided` / `tool/result` → 移除已解决的 pending
 *   - `turn/end`          且 reason.kind === 'completed' → 追加一条「任务完成」记录
 *
 * 为什么「任务完成」不能沿用 pending 列表：pending 表达的是**持续状态**
 * （"现在还有事等人"），而完成是**一次性边沿**（"刚刚这一轮结束了"）。
 * 用状态表达边沿，客户端一秒一次的轮询很容易错过；所以这里用一个单调
 * 递增的 `seq` + 最近若干条完成记录，客户端只处理 `seq > 上次看到的 seq`
 * 的新记录，天然做到"不重不漏"。
 *
 * 设计要点：
 *  1. **纯函数**：不读时钟以外的东西，不写文件，不发请求，可直接单测。
 *  2. **无变化返回同一引用**：调用方可以靠 `next === prev` 短路，避免无谓广播。
 *  3. **永不抛错**：事件形状不可控（不同插件/版本都可能塞怪东西），
 *     畸形输入直接忽略，绝不让提醒插件把宿主搞崩。
 *  4. **状态是纯 JSON**：不含 Date / Map / Set，方便序列化与跨进程传输。
 */

/** 提问工具的名字。用常量避免各处写字面量写错。 */
export const QUESTION_TOOL_NAME = 'ask_user_question'

/** 完成记录最多保留多少条（内存上限；客户端另有自己的日志上限）。 */
export const COMPLETION_KEEP = 20

/** 空状态。 */
export function emptyState() {
  return { bySession: {}, completions: [], completionSeq: 0 }
}

let fallbackCounter = 0

/** 生成一个不会与真实 id 冲突的回退 id。 */
function fallbackId(prefix, sessionId) {
  fallbackCounter += 1
  return `${prefix}-${sessionId}-${Date.now()}-${fallbackCounter}`
}

/** 从事件里安全取字符串字段。 */
function str(value) {
  return typeof value === 'string' ? value : ''
}

/**
 * 取事件的 data 负载。DSH 的会话事件把业务字段放在 `event.data` 下；
 * 有的版本可能直接平铺在事件上，所以两边都认。
 */
function payloadOf(event) {
  const data = event && typeof event.data === 'object' && event.data !== null ? event.data : null
  return data ?? event ?? {}
}

/** 取待确认列表里的某一桶（不存在则返回 undefined）。 */
function bucketOf(state, sessionId) {
  return state.bySession[sessionId]
}

/** 在某个会话桶里追加一条（若同 id 已存在则原样返回）。 */
function addPending(state, sessionId, entry) {
  const existing = bucketOf(state, sessionId)
  const list = existing ? existing.pending : []
  if (list.some(item => item.kind === entry.kind && item.id === entry.id)) return state
  return {
    bySession: {
      ...state.bySession,
      [sessionId]: { pending: [...list, entry] },
    },
  }
}

/** 在某个会话桶里删除匹配条件的条目（无匹配则返回原引用）。 */
function removePending(state, sessionId, predicate) {
  const existing = bucketOf(state, sessionId)
  if (!existing) return state
  const kept = existing.pending.filter(item => !predicate(item))
  if (kept.length === existing.pending.length) return state
  return {
    bySession: {
      ...state.bySession,
      [sessionId]: { pending: kept },
    },
  }
}

/** 当前状态里的完成记录（兼容没有该字段的旧状态对象）。 */
function completionsOf(state) {
  return Array.isArray(state.completions) ? state.completions : []
}

/**
 * 把 `turn/end` 的 reason 归一成 kind 字符串。
 * DSH 的 TurnEndReason 是 `{ kind: 'completed' | 'aborted' | 'blocked' | 'error' | … }`，
 * 但历史数据里也见过直接给字符串的形态，两种都认。
 */
function turnEndKind(reason) {
  if (typeof reason === 'string') return reason
  if (reason && typeof reason === 'object' && typeof reason.kind === 'string') return reason.kind
  return ''
}

/**
 * 追加一条「任务完成」记录。
 * @returns {object} 新状态；同一会话同一 turn 重复到达时返回原引用
 */
function addCompletion(state, sessionId, data) {
  const turn = typeof data.turn === 'number' && Number.isFinite(data.turn) ? data.turn : 0
  const list = completionsOf(state)

  // 重放/重复投递保护：最后一条就是同一会话同一轮，说明这已经是处理过的边沿
  const last = list.length > 0 ? list[list.length - 1] : null
  if (last !== null && last.sessionId === sessionId && last.turn === turn) return state

  const seq = (typeof state.completionSeq === 'number' ? state.completionSeq : 0) + 1
  const entry = { seq, at: Date.now(), sessionId, turn }
  return {
    ...state,
    completions: [...list, entry].slice(-COMPLETION_KEEP),
    completionSeq: seq,
  }
}

/**
 * 把一个会话事件折叠进状态。
 * @param {object} state 上一状态（emptyState() 或上次返回值）
 * @param {string} sessionId 事件所属会话
 * @param {unknown} event 会话事件
 * @param {{subagent?: boolean}} [meta] 会话元信息（子 agent 的轮次结束不提醒）
 * @returns {object} 新状态；无变化时返回 `state` 本身
 */
export function applySessionEvent(state, sessionId, event, meta = {}) {
  if (!state || typeof state !== 'object' || !state.bySession) return emptyState()
  const sid = typeof sessionId === 'string' && sessionId !== '' ? sessionId : 'default'
  if (!event || typeof event !== 'object') return state

  const type = event.type
  if (typeof type !== 'string') return state

  const data = payloadOf(event)

  if (type === 'approval/asked') {
    const id = str(data.id) || fallbackId('a', sid)
    return addPending(state, sid, {
      id,
      kind: 'approval',
      toolName: str(data.toolName),
      callId: str(data.callId),
      reason: str(data.reason),
      at: Date.now(),
    })
  }

  if (type === 'approval/decided') {
    const id = str(data.id)
    if (id === '') return state
    return removePending(state, sid, item => item.kind === 'approval' && item.id === id)
  }

  if (type === 'tool/call') {
    const name = str(data.name) || str(data.toolName)
    if (name !== QUESTION_TOOL_NAME) return state
    const callId = str(data.callId) || fallbackId('q', sid)
    return addPending(state, sid, {
      id: `q:${callId}`,
      kind: 'question',
      toolName: name,
      callId,
      reason: str(data.prompt) || str(data.question),
      at: Date.now(),
    })
  }

  if (type === 'tool/result') {
    // 真实 payload 是 { turn, step, message: ToolResultMessage }，callId 在 message 里；
    // 只认平铺的 data.callId 会让提问项永远清不掉（面板一直显示"有待确认"）。
    const message = data.message && typeof data.message === 'object' ? data.message : {}
    const callId = str(data.callId) || str(message.callId) || str(message.toolCallId)
    if (callId === '') return state
    return removePending(state, sid, item => item.kind === 'question' && item.callId === callId)
  }

  if (type === 'turn/end') {
    // 只有"正常跑完"才叫任务完成；取消/报错/被拦截/超长都不该弹「完成」
    if (turnEndKind(data.reason) !== 'completed') return state
    // 子 agent 是内部实现细节，它的一轮结束不该打断用户
    if (meta && meta.subagent === true) return state
    return addCompletion(state, sid, data)
  }

  return state
}

/** 会话销毁：整桶丢弃（完成记录里该会话的行也一并清掉，避免长期留下会话 id）。 */
export function dropSession(state, sessionId) {
  if (!state || typeof state !== 'object' || !state.bySession) return emptyState()
  if (typeof sessionId !== 'string') return state

  const inBuckets = sessionId in state.bySession
  const list = completionsOf(state)
  const keptCompletions = list.filter(item => item.sessionId !== sessionId)
  const completionsChanged = keptCompletions.length !== list.length
  if (!inBuckets && !completionsChanged) return state

  const next = { ...state.bySession }
  delete next[sessionId]
  return {
    ...state,
    bySession: next,
    ...(completionsChanged ? { completions: keptCompletions } : {}),
  }
}

/**
 * 摊平所有会话的待确认项，按会话分桶顺序输出。
 * 每项附带 `sessionId` 便于界面与日志使用。
 */
export function listPending(state) {
  if (!state || typeof state !== 'object' || !state.bySession) return []
  const out = []
  for (const [sessionId, bucket] of Object.entries(state.bySession)) {
    if (!bucket || !Array.isArray(bucket.pending)) continue
    for (const item of bucket.pending) out.push({ ...item, sessionId })
  }
  return out
}

/** 当前的完成记录（返回副本，调用方随便改都不会污染内部状态）。 */
export function listCompletions(state) {
  if (!state || typeof state !== 'object') return []
  return completionsOf(state).map(item => ({ ...item }))
}

/**
 * 待确认集合的稳定签名，用于客户端做"是否变化"的判断。
 * 排序保证同一集合不同插入顺序得到相同签名。
 */
export function pendingSignature(state) {
  const keys = listPending(state)
    .map(item => `${item.sessionId}|${item.kind}|${item.id}`)
    .sort()
  return keys.join(';')
}
