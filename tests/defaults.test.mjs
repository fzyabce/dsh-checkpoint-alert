// 设置规整逻辑的单元测试（纯函数，无 DOM、无浏览器 API）
// 运行：node --test tests/
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_SETTINGS,
  SETTINGS_LIMITS,
  SETTINGS_VERSION,
  SETTINGS_LIMITS as LIMITS,
  SOUND_PRESETS,
  ALERT_KINDS,
  alertCopy,
  clampNumber,
  normalizeSettings,
  mergeSettings,
} from '../lib/shared/defaults.mjs'

test('默认设置包含两类提醒的独立开关与独立文案', () => {
  const expected = [
    'enabled',
    'approvalEnabled', 'taskDoneEnabled',
    'desktopNotifyEnabled', 'popupEnabled', 'popupPinned', 'autoCloseSeconds',
    'soundEnabled', 'soundPreset', 'customSoundUrl', 'volume', 'loopUntilAck',
    'approvalTitle', 'approvalMessage', 'approvalConfirmLabel',
    'taskDoneTitle', 'taskDoneMessage', 'taskDoneConfirmLabel',
  ]
  for (const key of expected) {
    assert.ok(key in DEFAULT_SETTINGS, `默认设置缺少字段 ${key}`)
  }
  assert.equal(DEFAULT_SETTINGS.enabled, true)
  assert.equal(DEFAULT_SETTINGS.approvalEnabled, true)
  assert.equal(DEFAULT_SETTINGS.taskDoneEnabled, true)
  // v3：桌面系统通知是主通道，应用内弹窗只做兜底、默认关闭
  assert.equal(DEFAULT_SETTINGS.desktopNotifyEnabled, true)
  assert.equal(DEFAULT_SETTINGS.popupEnabled, false)
  assert.equal(DEFAULT_SETTINGS.soundEnabled, true)
  assert.equal(DEFAULT_SETTINGS.loopUntilAck, true)
  assert.equal(SETTINGS_VERSION, 3)
  assert.deepEqual([...ALERT_KINDS].sort(), ['approval', 'taskDone'])
  assert.deepEqual([...SETTINGS_LIMITS.autoCloseSeconds], [0, 600])
  assert.deepEqual([...LIMITS.volume], [0, 100])
})

test('clampNumber：越界收敛、非数字回落', () => {
  assert.equal(clampNumber(50, 0, 100, 60), 50)
  assert.equal(clampNumber(-5, 0, 100, 60), 0)
  assert.equal(clampNumber(150, 0, 100, 60), 100)
  assert.equal(clampNumber('abc', 0, 100, 60), 60)
  assert.equal(clampNumber(NaN, 0, 100, 60), 60)
  assert.equal(clampNumber(undefined, 0, 100, 60), 60)
  assert.equal(clampNumber(Infinity, 0, 100, 60), 100)
})

test('normalizeSettings：空输入回落全默认且标记已修复', () => {
  const { settings, repaired } = normalizeSettings(undefined)
  assert.deepEqual(settings, DEFAULT_SETTINGS)
  assert.equal(repaired, true)
})

test('normalizeSettings：合法输入原样保留且不标记修复', () => {
  const input = { ...DEFAULT_SETTINGS, volume: 80, popupEnabled: false, autoCloseSeconds: 10 }
  const { settings, repaired } = normalizeSettings(input)
  assert.equal(settings.volume, 80)
  assert.equal(settings.popupEnabled, false)
  assert.equal(settings.autoCloseSeconds, 10)
  assert.equal(repaired, false)
})

test('normalizeSettings：数值越界被钳制到边界并标记修复', () => {
  const low = normalizeSettings({ ...DEFAULT_SETTINGS, autoCloseSeconds: -5 })
  assert.equal(low.settings.autoCloseSeconds, SETTINGS_LIMITS.autoCloseSeconds[0])
  assert.equal(low.repaired, true)

  const high = normalizeSettings({ ...DEFAULT_SETTINGS, volume: 99999 })
  assert.equal(high.settings.volume, SETTINGS_LIMITS.volume[1])
  assert.equal(high.repaired, true)
})

test('normalizeSettings：未知枚举回落默认值', () => {
  const { settings, repaired } = normalizeSettings({ ...DEFAULT_SETTINGS, soundPreset: 'weird' })
  assert.equal(settings.soundPreset, 'synth')
  assert.equal(repaired, true)
})

test('normalizeSettings：布尔字段带出真实布尔值', () => {
  const { settings } = normalizeSettings({ ...DEFAULT_SETTINGS, enabled: 'yes' })
  assert.equal(settings.enabled, true)
  assert.equal(typeof settings.enabled, 'boolean')

  const off = normalizeSettings({ ...DEFAULT_SETTINGS, enabled: 0 })
  assert.equal(off.settings.enabled, false)

  // 两类开关各自独立：只关掉完成提醒，审批提醒必须还在
  const approvalOnly = normalizeSettings({ ...DEFAULT_SETTINGS, taskDoneEnabled: false })
  assert.equal(approvalOnly.settings.taskDoneEnabled, false)
  assert.equal(approvalOnly.settings.approvalEnabled, true)
})

test('normalizeSettings：文本字段空串回落默认、超长裁剪', () => {
  const blank = normalizeSettings({ ...DEFAULT_SETTINGS, approvalTitle: '   ' })
  assert.equal(blank.settings.approvalTitle, DEFAULT_SETTINGS.approvalTitle)

  const long = normalizeSettings({ ...DEFAULT_SETTINGS, taskDoneMessage: 'x'.repeat(5000) })
  assert.ok(long.settings.taskDoneMessage.length <= 500)
})

test('normalizeSettings：丢弃未知字段，保持白名单', () => {
  const { settings } = normalizeSettings({ ...DEFAULT_SETTINGS, evil: '<script>' })
  assert.ok(!('evil' in settings))
})

test('normalizeSettings：v1 的老文案被迁移到「人工审批」，且不算数据损坏', () => {
  const legacy = {
    version: 1,
    enabled: true,
    popupEnabled: true,
    popupPinned: true,
    autoCloseSeconds: 20,
    soundEnabled: true,
    soundPreset: 'synth',
    customSoundUrl: '',
    volume: 60,
    loopUntilAck: true,
    popupTitle: '我的标题',
    popupMessage: '我的正文',
    confirmLabel: '我的按钮',
  }
  const { settings, repaired } = normalizeSettings(legacy)
  assert.equal(settings.approvalTitle, '我的标题')
  assert.equal(settings.approvalMessage, '我的正文')
  assert.equal(settings.approvalConfirmLabel, '我的按钮')
  // 完成文案没有历史值，回落到默认
  assert.equal(settings.taskDoneTitle, DEFAULT_SETTINGS.taskDoneTitle)
  // 迁移不是"修复"：不该让用户看到"已回退默认值"的提示
  assert.equal(repaired, false)
})

test('normalizeSettings：v2 字段存在时不会被 v1 文案覆盖', () => {
  const input = {
    ...DEFAULT_SETTINGS,
    popupTitle: '旧标题',
    approvalTitle: '新标题',
  }
  const { settings } = normalizeSettings(input)
  assert.equal(settings.approvalTitle, '新标题')
})

test('normalizeSettings：v2 → v3 一次性把应用内弹窗关掉（桌面通知接管）', () => {
  const v2 = {
    version: 2,
    enabled: true,
    approvalEnabled: true,
    taskDoneEnabled: true,
    popupEnabled: true,
    popupPinned: true,
    autoCloseSeconds: 20,
    soundEnabled: true,
    soundPreset: 'synth',
    customSoundUrl: '',
    volume: 60,
    loopUntilAck: true,
    approvalTitle: 'A',
    approvalMessage: 'B',
    approvalConfirmLabel: 'C',
    taskDoneTitle: 'D',
    taskDoneMessage: 'E',
    taskDoneConfirmLabel: 'F',
  }
  const { settings, repaired } = normalizeSettings(v2)
  assert.equal(settings.desktopNotifyEnabled, true, '新通道默认打开')
  assert.equal(settings.popupEnabled, false, '否则老用户会同时看到两个弹窗')
  assert.equal(settings.approvalTitle, 'A', '文案保持不变')
  assert.equal(repaired, false, '迁移不是数据损坏')
})

test('normalizeSettings：写了 desktopNotifyEnabled 就不再强制关应用内弹窗', () => {
  const explicit = { ...DEFAULT_SETTINGS, desktopNotifyEnabled: false, popupEnabled: true }
  const { settings, repaired } = normalizeSettings(explicit)
  assert.equal(settings.desktopNotifyEnabled, false)
  assert.equal(settings.popupEnabled, true)
  assert.equal(repaired, false)
})

test('mergeSettings：局部更新只影响给定字段', () => {
  const base = { ...DEFAULT_SETTINGS }
  const next = mergeSettings(base, { volume: 20 })
  assert.equal(next.volume, 20)
  assert.equal(next.taskDoneTitle, base.taskDoneTitle)
  assert.notEqual(next, base, '应当返回新对象而不是原地修改')
})

test('mergeSettings：更新也会走钳制', () => {
  const next = mergeSettings(DEFAULT_SETTINGS, { volume: -100 })
  assert.equal(next.volume, 0)
})

test('alertCopy：两类各给各的文案与开关', () => {
  const settings = mergeSettings(DEFAULT_SETTINGS, {
    approvalTitle: 'A',
    taskDoneTitle: 'B',
    taskDoneEnabled: false,
  })
  assert.equal(alertCopy(settings, 'approval').title, 'A')
  assert.equal(alertCopy(settings, 'approval').enabled, true)
  assert.equal(alertCopy(settings, 'taskDone').title, 'B')
  assert.equal(alertCopy(settings, 'taskDone').enabled, false)
  // 未知类型按审批处理，绝不返回 undefined 让界面崩
  assert.equal(alertCopy(settings, 'nope').title, 'A')
  assert.equal(alertCopy(undefined, 'taskDone').title, DEFAULT_SETTINGS.taskDoneTitle)
})

test('SOUND_PRESETS 覆盖 synth 与 custom', () => {
  assert.deepEqual([...SOUND_PRESETS].sort(), ['custom', 'synth'])
})
