// 提醒日志环形缓冲的单元测试
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  LOG_VERSION,
  LOG_LIMIT,
  LOG_RENDER_LIMIT,
  createLog,
  appendLog,
  clearLog,
  formatTime,
  describeKind,
  describeVia,
  kindTag,
  normalizeKind,
  normalizeLog,
  makeEntry,
} from '../lib/shared/logbuf.mjs'

test('createLog 返回空数组', () => {
  assert.deepEqual(createLog(), [])
})

test('appendLog 最新的排在最前', () => {
  let log = createLog()
  log = appendLog(log, makeEntry({ kind: 'approval', at: 1000 }))
  log = appendLog(log, makeEntry({ kind: 'taskDone', at: 2000 }))
  assert.equal(log.length, 2)
  assert.equal(log[0].at, 2000, '最新的一条应在索引 0')
  assert.equal(log[1].at, 1000)
})

test('appendLog 不修改原数组', () => {
  const original = createLog()
  const next = appendLog(original, makeEntry({ kind: 'approval' }))
  assert.equal(original.length, 0)
  assert.equal(next.length, 1)
})

test('appendLog 超过上限时丢弃最旧的', () => {
  let log = createLog()
  for (let i = 0; i < LOG_LIMIT + 5; i += 1) {
    log = appendLog(log, makeEntry({ kind: 'approval', at: i }))
  }
  assert.equal(log.length, LOG_LIMIT)
  // 循环写入 at = 0..LOG_LIMIT+4，最大值为 LOG_LIMIT+4
  assert.equal(log[0].at, LOG_LIMIT + 4, '索引 0 仍应是最新一条')
  assert.ok(!log.some(e => e.at === 0), '最旧的应被丢弃')
})

test('日志有两层上限：存储/内存 200，渲染 50', () => {
  assert.equal(LOG_LIMIT, 200)
  assert.equal(LOG_RENDER_LIMIT, 50)
  assert.ok(LOG_RENDER_LIMIT < LOG_LIMIT)
})

test('clearLog 返回空数组且是新引用', () => {
  const log = appendLog(createLog(), makeEntry({ kind: 'approval' }))
  const cleared = clearLog()
  assert.deepEqual(cleared, [])
  assert.notEqual(cleared, log)
})

test('formatTime 输出 YYYY-MM-DD HH:mm:ss 且补零', () => {
  const ts = new Date(2026, 0, 5, 3, 4, 9).getTime() // 本地时间 2026-01-05 03:04:09
  assert.equal(formatTime(ts), '2026-01-05 03:04:09')
})

test('formatTime 对非法输入返回占位符而不抛错', () => {
  assert.equal(formatTime(undefined), '--')
  assert.equal(formatTime('abc'), '--')
})

test('两类提醒有各自的可读类型与日志标记', () => {
  assert.equal(describeKind('approval'), '人工审批')
  assert.equal(describeKind('taskDone'), '任务完成')
  assert.equal(describeKind('other'), '未知')

  assert.equal(kindTag('approval'), '【人工审批】')
  assert.equal(kindTag('taskDone'), '【任务完成】')
  assert.notEqual(kindTag('approval'), kindTag('taskDone'), '两类标记必须可区分')
})

test('来源说明区分工具审批 / 提问 / 轮次结束', () => {
  assert.equal(describeVia('tool'), '工具审批')
  assert.equal(describeVia('question'), '提问')
  assert.equal(describeVia('turn'), '轮次结束')
  assert.equal(describeVia('nope'), '')
})

test('normalizeKind：v1 的 question 并入审批并标记迁移', () => {
  assert.deepEqual(normalizeKind('question'), { kind: 'approval', migrated: true })
  assert.deepEqual(normalizeKind('taskDone'), { kind: 'taskDone', migrated: false })
  assert.deepEqual(normalizeKind('???'), { kind: 'approval', migrated: false })
})

test('makeEntry 生成带 id 与默认字段的条目', () => {
  const entry = makeEntry({ kind: 'approval' })
  assert.ok(typeof entry.id === 'string' && entry.id.length > 0)
  assert.equal(entry.kind, 'approval')
  assert.equal(entry.via, 'tool')
  assert.equal(typeof entry.at, 'number')
  assert.equal(entry.toolName, '')
  assert.equal(entry.sessionId, '')
  assert.equal(entry.test, false)
})

test('makeEntry 同一毫秒两次调用 id 不重复', () => {
  const a = makeEntry({ kind: 'approval', at: 1 })
  const b = makeEntry({ kind: 'approval', at: 1 })
  assert.notEqual(a.id, b.id)
})

test('makeEntry 给完成类条目默认来源为 turn', () => {
  const entry = makeEntry({ kind: 'taskDone', at: 5 })
  assert.equal(entry.via, 'turn')
})

test('makeEntry 迁移 question 条目时保留来源', () => {
  const entry = makeEntry({ kind: 'question' })
  assert.equal(entry.kind, 'approval')
  assert.equal(entry.via, 'question')
})

test('normalizeLog 丢弃畸形条目并按时间倒序', () => {
  const raw = [
    { id: 'old', kind: 'approval', at: 100 },
    null,
    { kind: 'bogus', at: 500 },
    { id: 'new', kind: 'taskDone', at: 900 },
    'x',
  ]
  const { entries, repaired } = normalizeLog(raw)
  assert.equal(entries.length, 2)
  assert.equal(entries[0].id, 'new')
  assert.equal(entries[0].kind, 'taskDone')
  assert.equal(entries[1].id, 'old')
  assert.equal(repaired, true)
})

test('normalizeLog 把 v1 的 question 条目迁移成审批，且不算数据损坏', () => {
  const raw = [{ id: 'q1', kind: 'question', at: 100, toolName: 'ask_user_question' }]
  const { entries, repaired } = normalizeLog(raw)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].kind, 'approval')
  assert.equal(entries[0].via, 'question')
  assert.equal(repaired, false, '类型迁移不该触发"已回退默认值"提示')
})

test('normalizeLog 读回时清空 reason（v1 曾把提问正文写进去）', () => {
  const raw = [{ id: 'q1', kind: 'question', at: 100, reason: '这就是用户的原问题正文' }]
  const { entries } = normalizeLog(raw)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].reason, '')
})

test('normalizeLog 非数组回落空日志', () => {
  for (const bad of [undefined, null, 42, 'x', {}]) {
    const { entries, repaired } = normalizeLog(bad)
    assert.deepEqual(entries, [])
    assert.equal(repaired, true)
  }
})

test('normalizeLog 超长输入被裁剪到上限', () => {
  const raw = Array.from({ length: LOG_LIMIT + 20 }, (_, i) => ({ id: 'e' + i, kind: 'approval', at: i }))
  const { entries } = normalizeLog(raw)
  assert.equal(entries.length, LOG_LIMIT)
  assert.equal(entries[0].at, LOG_LIMIT + 20 - 1)
})

test('LOG_VERSION 为数字且已升到 2', () => {
  assert.equal(typeof LOG_VERSION, 'number')
  assert.equal(LOG_VERSION, 2)
})
