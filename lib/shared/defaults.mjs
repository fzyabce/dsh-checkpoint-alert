/**
 * 设置的默认值、边界与规整逻辑（纯函数，无 DOM / 无浏览器 API）。
 *
 * 这个模块被两端共用：
 *  - 宿主侧 index.js 用它兜底读取（若有）
 *  - 客户端把它内联进 client.js（见 scripts/build-client.mjs）
 *
 * 规整原则：**任何脏数据都不能抛异常**。读到不合法值就回落到默认值，
 * 并通过返回值里的 `repaired` 标记告诉调用方"这次是修过的"，
 * 界面据此提示用户。
 *
 * v2 的两处结构变化（都带向后兼容）：
 *  1. 提醒分两类，各自有独立开关与独立文案：
 *     `approval*`（人工审批）与 `taskDone*`（任务完成）。
 *  2. v1 只有一套文案（`popupTitle` / `popupMessage` / `confirmLabel`），
 *     升级时**静默迁移**成「人工审批」的文案 —— 老用户不会发现自己的措辞被换掉。
 *
 * v3 起提醒主通道是**系统桌面通知**（右下角 toast，DSH 最小化也看得见）：
 * 新增 `desktopNotifyEnabled`；应用内弹窗从"默认开"改成"默认关"（只做兜底），
 * 并从 v2 设置一次性迁移过去 —— 否则老用户会同时看到两个弹窗。
 */

/** localStorage 里设置的 schema 版本；将来结构变更时递增并写迁移。 */
export const SETTINGS_VERSION = 3

/** 数值字段的合法闭区间。 */
export const SETTINGS_LIMITS = {
  autoCloseSeconds: [0, 600],
  volume: [0, 100],
}

/** 提示音来源枚举。 */
export const SOUND_PRESETS = ['synth', 'custom']

/** 两类提醒的稳定标识（日志、设置、弹窗都用这套字面量）。 */
export const ALERT_KINDS = ['approval', 'taskDone']

/** 文本字段的最大长度，防止脏数据把界面撑爆。 */
const TEXT_MAX = 500

/** 出厂默认设置。 */
export const DEFAULT_SETTINGS = {
  enabled: true,

  // 两类提醒各自的总开关（关掉一类不影响另一类）
  approvalEnabled: true,
  taskDoneEnabled: true,

  // 通道：桌面系统通知为主，应用内弹窗默认关闭（系统通知不可用时自动兜底）
  desktopNotifyEnabled: true,
  popupEnabled: false,
  popupPinned: true,
  autoCloseSeconds: 20,

  // 声音
  soundEnabled: true,
  soundPreset: 'synth',
  customSoundUrl: '',
  volume: 60,
  loopUntilAck: true,

  // 文案：人工审批（类型标记由弹窗的 KindChip 统一渲染，标题里不再重复）
  approvalTitle: '需要你拍板',
  approvalMessage: 'agent 停在需要人工审批的操作上，请回到 DeepSeek Harness 处理。',
  approvalConfirmLabel: '去处理',

  // 文案：任务完成
  taskDoneTitle: '这一轮任务完成了',
  taskDoneMessage: 'agent 已完成本轮任务，可以回来查看结果。',
  taskDoneConfirmLabel: '知道了',
}

/** v1 文案字段 → v2 字段的迁移表。 */
const LEGACY_COPY = {
  popupTitle: 'approvalTitle',
  popupMessage: 'approvalMessage',
  confirmLabel: 'approvalConfirmLabel',
}

/**
 * 把任意输入收敛成 [min, max] 区间内的有限数。
 * 非数字、NaN、空值一律回落 `fallback`；±Infinity 收敛到边界。
 */
export function clampNumber(value, min, max, fallback) {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback
  if (value === Infinity) return max
  if (value === -Infinity) return min
  return Math.min(max, Math.max(min, value))
}

/** 布尔字段：保留真布尔，其它一律按真假值转换。 */
function toBool(value, fallback) {
  if (typeof value === 'boolean') return value
  if (value === undefined || value === null) return fallback
  return Boolean(value)
}

/** 文本字段：去首尾空白；空串回落默认；超长截断。 */
function toText(value, fallback) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (trimmed === '') return fallback
  return trimmed.length > TEXT_MAX ? trimmed.slice(0, TEXT_MAX) : trimmed
}

/**
 * v1 → v2 的迁移（只在缺 v2 字段时生效）。
 * 输入会被复制，不修改调用方的对象。
 * @returns {{ input: object, legacy: boolean }} legacy=true 表示读到的是 v1 形状的设置
 */
function migrateLegacyCopy(raw) {
  const input = { ...raw }
  let legacy = false
  for (const [legacyKey, nextKey] of Object.entries(LEGACY_COPY)) {
    if (!(nextKey in input) && typeof input[legacyKey] === 'string') {
      input[nextKey] = input[legacyKey]
      legacy = true
    }
  }
  return { input, legacy }
}

/**
 * 规整设置对象。
 * @param {unknown} raw 从 localStorage 或调用方拿到的任意值
 * @returns {{ settings: typeof DEFAULT_SETTINGS, repaired: boolean }}
 */
export function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  let repaired = source !== raw
  const { input, legacy } = migrateLegacyCopy(source)

  /**
   * v3 迁移：还没写过 `desktopNotifyEnabled` 的设置来自 v2 之前。
   * 那时应用内弹窗是唯一通道且默认开；v3 起桌面通知接管，若还保留
   * `popupEnabled: true` 就会同一件事弹两个窗 —— 所以一次性把它关掉，
   * 用户随时可以在面板里重新打开。
   */
  const legacyChannel = !('desktopNotifyEnabled' in source)
  if (legacyChannel && 'popupEnabled' in source) input.popupEnabled = false

  const pick = (key, normalize) => {
    const result = normalize(input[key])
    // 只有当输入里真的存在该键、且规整后与输入不同，才算"修过"
    if (key in input && input[key] !== result) repaired = true
    // 老 schema 本来就没有新字段，缺它们不算数据损坏
    if (!(key in input) && !legacy && !legacyChannel) repaired = true
    return result
  }

  const settings = {
    enabled: pick('enabled', v => toBool(v, DEFAULT_SETTINGS.enabled)),

    approvalEnabled: pick('approvalEnabled', v => toBool(v, DEFAULT_SETTINGS.approvalEnabled)),
    taskDoneEnabled: pick('taskDoneEnabled', v => toBool(v, DEFAULT_SETTINGS.taskDoneEnabled)),

    desktopNotifyEnabled: pick('desktopNotifyEnabled', v =>
      toBool(v, DEFAULT_SETTINGS.desktopNotifyEnabled),
    ),
    popupEnabled: pick('popupEnabled', v => toBool(v, DEFAULT_SETTINGS.popupEnabled)),
    popupPinned: pick('popupPinned', v => toBool(v, DEFAULT_SETTINGS.popupPinned)),
    autoCloseSeconds: pick('autoCloseSeconds', v =>
      clampNumber(v, ...SETTINGS_LIMITS.autoCloseSeconds, DEFAULT_SETTINGS.autoCloseSeconds),
    ),

    soundEnabled: pick('soundEnabled', v => toBool(v, DEFAULT_SETTINGS.soundEnabled)),
    soundPreset: pick('soundPreset', v =>
      SOUND_PRESETS.includes(v) ? v : DEFAULT_SETTINGS.soundPreset,
    ),
    customSoundUrl: pick('customSoundUrl', v => toText(v, DEFAULT_SETTINGS.customSoundUrl)),
    volume: pick('volume', v => clampNumber(v, ...SETTINGS_LIMITS.volume, DEFAULT_SETTINGS.volume)),
    loopUntilAck: pick('loopUntilAck', v => toBool(v, DEFAULT_SETTINGS.loopUntilAck)),

    approvalTitle: pick('approvalTitle', v => toText(v, DEFAULT_SETTINGS.approvalTitle)),
    approvalMessage: pick('approvalMessage', v => toText(v, DEFAULT_SETTINGS.approvalMessage)),
    approvalConfirmLabel: pick('approvalConfirmLabel', v =>
      toText(v, DEFAULT_SETTINGS.approvalConfirmLabel),
    ),

    taskDoneTitle: pick('taskDoneTitle', v => toText(v, DEFAULT_SETTINGS.taskDoneTitle)),
    taskDoneMessage: pick('taskDoneMessage', v => toText(v, DEFAULT_SETTINGS.taskDoneMessage)),
    taskDoneConfirmLabel: pick('taskDoneConfirmLabel', v =>
      toText(v, DEFAULT_SETTINGS.taskDoneConfirmLabel),
    ),
  }

  return { settings, repaired }
}

/**
 * 局部更新：把 patch 合进当前设置，再整体规整一遍。
 * 返回**新对象**，不原地修改（React 依赖引用变化触发重渲染）。
 */
export function mergeSettings(current, patch) {
  const base = current && typeof current === 'object' ? current : DEFAULT_SETTINGS
  const next = { ...base, ...(patch && typeof patch === 'object' ? patch : {}) }
  return normalizeSettingsForWrite(next)
}

/** 写入路径专用：只需要结果，不需要 repaired 标记。 */
function normalizeSettingsForWrite(raw) {
  const { settings } = normalizeSettings({ ...DEFAULT_SETTINGS, ...raw })
  return settings
}

/**
 * 取某一类提醒的文案。
 * 让界面、弹窗、测试按钮都走同一个函数，避免两处写死不同的字段名。
 * @param {typeof DEFAULT_SETTINGS} settings
 * @param {'approval'|'taskDone'} kind
 * @returns {{ title: string, message: string, confirmLabel: string, enabled: boolean }}
 */
export function alertCopy(settings, kind) {
  const base = settings && typeof settings === 'object' ? settings : DEFAULT_SETTINGS
  if (kind === 'taskDone') {
    return {
      title: base.taskDoneTitle ?? DEFAULT_SETTINGS.taskDoneTitle,
      message: base.taskDoneMessage ?? DEFAULT_SETTINGS.taskDoneMessage,
      confirmLabel: base.taskDoneConfirmLabel ?? DEFAULT_SETTINGS.taskDoneConfirmLabel,
      enabled: base.taskDoneEnabled !== false,
    }
  }
  return {
    title: base.approvalTitle ?? DEFAULT_SETTINGS.approvalTitle,
    message: base.approvalMessage ?? DEFAULT_SETTINGS.approvalMessage,
    confirmLabel: base.approvalConfirmLabel ?? DEFAULT_SETTINGS.approvalConfirmLabel,
    enabled: base.approvalEnabled !== false,
  }
}
