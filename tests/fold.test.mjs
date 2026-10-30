// 会话事件折叠逻辑的单元测试（纯函数，用假的 event 对象喂入）
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  COMPLETION_KEEP,
  emptyState,
  applySessionEvent,
  dropSession,
  listPending,
  listCompletions,
  pendingSignature,
} from '../lib/shared/fold.mjs'

const approvalAsked = (id, toolName = 'edit_file') => ({
  type: 'approval/asked',
  data: { id, toolName, reason: 'writes outside workspace' },
})
const approvalDecided = (id, outcome = 'allowed-once') => ({
  type: 'approval/decided',
  data: { id, outcome },
})
const askCall = (callId) => ({ type: 'tool/call', data: { name: 'ask_user_question', callId } })
const otherCall = (callId) => ({ type: 'tool/call', data: { name: 'read_file', callId } })
const toolResult = (callId) => ({ type: 'tool/result', data: { callId } })
/** 宿主真实形状：callId 在 message 里，不在 data 顶层。 */
const toolResultMessage = (callId) => ({
  type: 'tool/result',
  data: { turn: 1, step: 1, message: { role: 'tool', callId, content: [] } },
})
const turnEnd = (turn, kind = 'completed') => ({ type: 'turn/end', data: { turn, reason: { kind } } })

test('空状态没有任何待确认项', () => {
  const state = emptyState()
  assert.deepEqual(listPending(state), [])
})

test('approval/asked 产生一条审批待确认项', () => {
  const state = applySessionEvent(emptyState(), 'S1', approvalAsked('A1'))
  const pending = listPending(state)
  assert.equal(pending.length, 1)
  assert.equal(pending[0].kind, 'approval')
  assert.equal(pending[0].id, 'A1')
  assert.equal(pending[0].toolName, 'edit_file')
  assert.equal(pending[0].sessionId, 'S1')
})

test('ask_user_question 的 tool/call 产生提问待确认项', () => {
  const state = applySessionEvent(emptyState(), 'S1', askCall('C1'))
  const pending = listPending(state)
  assert.equal(pending.length, 1)
  assert.equal(pending[0].kind, 'question')
  assert.equal(pending[0].callId, 'C1')
})

test('其它工具的 tool/call 不产生待确认项', () => {
  const state = applySessionEvent(emptyState(), 'S1', otherCall('C9'))
  assert.deepEqual(listPending(state), [])
})

test('approval/decided 移除对应审批项', () => {
  let state = applySessionEvent(emptyState(), 'S1', approvalAsked('A1'))
  state = applySessionEvent(state, 'S1', approvalDecided('A1'))
  assert.deepEqual(listPending(state), [])
})

test('approval/decided 不会误删其它审批项', () => {
  let state = applySessionEvent(emptyState(), 'S1', approvalAsked('A1'))
  state = applySessionEvent(state, 'S1', approvalAsked('A2'))
  state = applySessionEvent(state, 'S1', approvalDecided('A1'))
  const pending = listPending(state)
  assert.equal(pending.length, 1)
  assert.equal(pending[0].id, 'A2')
})

test('tool/result 清除对应提问项', () => {
  let state = applySessionEvent(emptyState(), 'S1', askCall('C1'))
  state = applySessionEvent(state, 'S1', toolResult('C1'))
  assert.deepEqual(listPending(state), [])
})

test('tool/result 用宿主真实形状（callId 在 message 里）也能清除提问项', () => {
  let state = applySessionEvent(emptyState(), 'S1', askCall('C-REAL'))
  assert.equal(listPending(state).length, 1)
  state = applySessionEvent(state, 'S1', toolResultMessage('C-REAL'))
  assert.deepEqual(listPending(state), [], '提问项必须在结果到达后清掉，不能一直挂着')
})

test('tool/result 的 nested toolCallId 也认', () => {
  let state = applySessionEvent(emptyState(), 'S1', askCall('C2'))
  state = applySessionEvent(state, 'S1', {
    type: 'tool/result',
    data: { message: { toolCallId: 'C2' } },
  })
  assert.deepEqual(listPending(state), [])
})

test('无法匹配的结果事件不改变状态也不报错', () => {
  const before = emptyState()
  const after = applySessionEvent(before, 'S1', approvalDecided('NOPE'))
  assert.deepEqual(listPending(after), [])
})

test('同一审批 id 重复到达不产生重复项', () => {
  let state = applySessionEvent(emptyState(), 'S1', approvalAsked('A1'))
  state = applySessionEvent(state, 'S1', approvalAsked('A1'))
  assert.equal(listPending(state).length, 1)
})

test('两个会话各自独立分桶', () => {
  let state = applySessionEvent(emptyState(), 'S1', approvalAsked('A1'))
  state = applySessionEvent(state, 'S2', approvalAsked('B1'))
  const pending = listPending(state)
  assert.equal(pending.length, 2)
  assert.deepEqual(pending.map(p => p.sessionId).sort(), ['S1', 'S2'])
})

test('dropSession 只清掉指定会话', () => {
  let state = applySessionEvent(emptyState(), 'S1', approvalAsked('A1'))
  state = applySessionEvent(state, 'S2', approvalAsked('B1'))
  state = dropSession(state, 'S1')
  const pending = listPending(state)
  assert.equal(pending.length, 1)
  assert.equal(pending[0].sessionId, 'S2')
  assert.ok(!('S1' in state.bySession), '不应残留已销毁会话的键')
})

test('payload 缺 id 时用回退 id 且不抛错', () => {
  const state = applySessionEvent(emptyState(), 'S1', { type: 'approval/asked', data: {} })
  const pending = listPending(state)
  assert.equal(pending.length, 1)
  assert.ok(typeof pending[0].id === 'string' && pending[0].id.length > 0)
})

test('畸形事件被忽略', () => {
  for (const bad of [null, undefined, {}, { type: 42 }, 'x']) {
    const state = applySessionEvent(emptyState(), 'S1', bad)
    assert.deepEqual(listPending(state), [])
  }
})

test('状态变化时返回新对象，无变化时返回同一引用（便于短路）', () => {
  const state = applySessionEvent(emptyState(), 'S1', approvalAsked('A1'))
  const same = applySessionEvent(state, 'S1', otherCall('C9'))
  assert.equal(same, state, '无变化应返回同一引用')
  const changed = applySessionEvent(state, 'S1', approvalDecided('A1'))
  assert.notEqual(changed, state, '有变化应返回新对象')
})

test('pendingSignature 顺序稳定且能区分不同集合', () => {
  let a = applySessionEvent(emptyState(), 'S1', approvalAsked('A1'))
  a = applySessionEvent(a, 'S1', askCall('C1'))
  let b = applySessionEvent(emptyState(), 'S1', askCall('C1'))
  b = applySessionEvent(b, 'S1', approvalAsked('A1'))
  assert.equal(pendingSignature(a), pendingSignature(b), '同集合不同插入顺序签名应一致')
  assert.notEqual(pendingSignature(a), pendingSignature(emptyState()))
})

test('折叠后的状态是纯 JSON（可直接序列化）', () => {
  let state = applySessionEvent(emptyState(), 'S1', approvalAsked('A1'))
  state = applySessionEvent(state, 'S1', askCall('C1'))
  state = applySessionEvent(state, 'S1', turnEnd(1))
  const round = JSON.parse(JSON.stringify(state))
  assert.deepEqual(round, state)
})

// ─────────────────────── 任务完成（turn/end 边沿） ───────────────────────

test('turn/end 且 completed 产生一条完成记录，seq 从 1 开始', () => {
  const state = applySessionEvent(emptyState(), 'S1', turnEnd(3))
  const done = listCompletions(state)
  assert.equal(done.length, 1)
  assert.equal(done[0].seq, 1)
  assert.equal(done[0].turn, 3)
  assert.equal(done[0].sessionId, 'S1')
  assert.equal(state.completionSeq, 1)
})

test('非 completed 的 turn/end 不算任务完成', () => {
  for (const kind of ['aborted', 'error', 'blocked', 'max-tokens', 'interrupted', 'legacy']) {
    const state = applySessionEvent(emptyState(), 'S1', turnEnd(1, kind))
    assert.deepEqual(listCompletions(state), [], `${kind} 不该被当成完成`)
  }
})

test('子 agent 的 turn/end 不产生完成记录', () => {
  const state = applySessionEvent(emptyState(), 'CHILD', turnEnd(1), { subagent: true })
  assert.deepEqual(listCompletions(state), [])
  // 但同一子 agent 的审批仍然要提醒（人还是得拍板）
  const withApproval = applySessionEvent(state, 'CHILD', approvalAsked('A9'), { subagent: true })
  assert.equal(listPending(withApproval).length, 1)
})

test('完成记录的 seq 单调递增，重放同一 turn 不重复入账', () => {
  let state = applySessionEvent(emptyState(), 'S1', turnEnd(1))
  state = applySessionEvent(state, 'S1', turnEnd(1))
  assert.equal(listCompletions(state).length, 1, '同一会话同一 turn 重复到达应被忽略')

  state = applySessionEvent(state, 'S1', turnEnd(2))
  assert.deepEqual(listCompletions(state).map(item => item.seq), [1, 2])
})

test('完成记录保持在内存上限内', () => {
  let state = emptyState()
  for (let i = 1; i <= COMPLETION_KEEP + 5; i += 1) {
    state = applySessionEvent(state, 'S1', turnEnd(i))
  }
  const done = listCompletions(state)
  assert.equal(done.length, COMPLETION_KEEP)
  assert.equal(done[done.length - 1].turn, COMPLETION_KEEP + 5)
  assert.equal(state.completionSeq, COMPLETION_KEEP + 5)
})

test('完成任务不会污染待确认列表', () => {
  let state = applySessionEvent(emptyState(), 'S1', approvalAsked('A1'))
  state = applySessionEvent(state, 'S1', turnEnd(1))
  assert.equal(listPending(state).length, 1)
  assert.equal(listCompletions(state).length, 1)
})

test('会话销毁时该会话的完成记录也一并清掉', () => {
  let state = applySessionEvent(emptyState(), 'S1', turnEnd(1))
  state = applySessionEvent(state, 'S2', turnEnd(1))
  state = dropSession(state, 'S1')
  const done = listCompletions(state)
  assert.equal(done.length, 1)
  assert.equal(done[0].sessionId, 'S2')
  assert.equal(state.completionSeq, 2, '序号不回收，避免客户端把旧边沿当新边沿')
})

test('空状态带两个字段：bySession 与完成序号', () => {
  const state = emptyState()
  assert.deepEqual(state.bySession, {})
  assert.deepEqual(state.completions, [])
  assert.equal(state.completionSeq, 0)
})
