/**
 * 提醒日志：环形缓冲 + 类型标记 + 时间格式化（纯函数）。
 *
 * v2 起日志区分两类提醒：
 *   - `approval`  → 【人工审批】（审批请求、agent 提问都归到这一类）
 *   - `taskDone`  → 【任务完成】（一轮 turn 正常结束）
 *
 * 日志只记录"提醒发生过"这一事实（时间、类型、工具名、会话、来源），
 * 不记录对话内容 —— 避免把用户的任务正文泄漏进浏览器本地存储。
 *
 * 条数上限：内存/存储都是 {@link LOG_LIMIT}（200）条，界面只渲染最近
 * {@link LOG_RENDER_LIMIT}（50）条。上限在**写入路径**上就生效，
 * 所以不会有"先涨到几千条再裁剪"的启动/滚动开销。
 */

/** localStorage 里日志的 schema 版本。v2 = 区分 approval / taskDone。 */
export const LOG_VERSION = 2

/** 环形缓冲上限：超出丢弃最旧的。 */
export const LOG_LIMIT = 200

/** 界面上一次渲染的条数上限（日志再长也不拖慢首屏）。 */
export const LOG_RENDER_LIMIT = 50

/** 合法的提醒类型。 */
const KINDS = ['approval', 'taskDone']

/** v1 遗留类型：提问曾经是独立类型，v2 起并入「人工审批」。 */
const LEGACY_KINDS = { question: 'approval' }

/** 合法的来源标记。 */
const VIAS = ['tool', 'question', 'turn', 'test']

let idCounter = 0

/** 生成条目 id（同一毫秒内也不会重复）。 */
function nextId() {
  idCounter += 1
  return `e-${Date.now().toString(36)}-${idCounter.toString(36)}`
}

/** 空日志。 */
export function createLog() {
  return []
}

/**
 * 把任意 kind 规整成合法类型。
 * @param {unknown} value
 * @returns {{ kind: string, migrated: boolean }} migrated=true 表示这是 v1 遗留值被迁移
 */
export function normalizeKind(value) {
  if (KINDS.includes(value)) return { kind: value, migrated: false }
  const legacy = LEGACY_KINDS[value]
  if (legacy !== undefined) return { kind: legacy, migrated: true }
  return { kind: 'approval', migrated: false }
}

/**
 * 造一条日志条目。缺省字段填空串 / false，保证结构稳定。
 * @param {{id?: string, kind?: string, at?: number, toolName?: string, sessionId?: string, via?: string, test?: boolean, reason?: string}} input
 */
export function makeEntry(input = {}) {
  const { kind, migrated } = normalizeKind(input.kind)
  // v1 的 question 条目迁移后补上来源，日志里仍能看出"这条来自提问工具"
  const fallbackVia = kind === 'taskDone' ? 'turn' : 'tool'
  const via = migrated
    ? 'question'
    : VIAS.includes(input.via)
      ? input.via
      : fallbackVia
  return {
    id: typeof input.id === 'string' && input.id !== '' ? input.id : nextId(),
    kind,
    via,
    at: typeof input.at === 'number' && Number.isFinite(input.at) ? input.at : Date.now(),
    toolName: typeof input.toolName === 'string' ? input.toolName : '',
    sessionId: typeof input.sessionId === 'string' ? input.sessionId : '',
    reason: typeof input.reason === 'string' ? input.reason.slice(0, 200) : '',
    test: input.test === true,
  }
}

/**
 * 追加一条日志。最新的一条放在索引 0（界面从上往下读就是时间倒序）。
 * 不修改入参，返回新数组。
 */
export function appendLog(entries, entry, limit = LOG_LIMIT) {
  const base = Array.isArray(entries) ? entries : []
  const cap = typeof limit === 'number' && limit > 0 ? limit : LOG_LIMIT
  return [entry, ...base].slice(0, cap)
}

/** 清空日志（返回新空数组，保持不可变风格）。 */
export function clearLog() {
  return []
}

/** 两位补零。 */
function pad2(value) {
  return String(value).padStart(2, '0')
}

/**
 * 把时间戳格式化成 `YYYY-MM-DD HH:mm:ss`（本地时区）。
 * 非法输入返回 `--`，绝不让界面因为一条坏日志整块崩掉。
 */
export function formatTime(ts) {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return '--'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '--'
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  )
}

/** 类型 → 中文可读文案。 */
export function describeKind(kind) {
  if (kind === 'approval') return '人工审批'
  if (kind === 'taskDone') return '任务完成'
  return '未知'
}

/**
 * 类型 → 日志标记（带括号的短标记，界面与日志里一眼能分开两类）。
 * 这就是需求里的「日志标记区分」。
 */
export function kindTag(kind) {
  if (kind === 'approval') return '【人工审批】'
  if (kind === 'taskDone') return '【任务完成】'
  return '【提醒】'
}

/** 来源 → 中文说明（审批 vs 提问 vs 轮次结束）。 */
export function describeVia(via) {
  if (via === 'question') return '提问'
  if (via === 'turn') return '轮次结束'
  if (via === 'test') return '测试'
  if (via === 'tool') return '工具审批'
  return ''
}

/**
 * 规整读到的日志：过滤畸形条目、迁移 v1 类型、按时间倒序、裁剪到上限。
 *
 * `repaired` 只反映"数据异常"（条目被丢弃/顺序被纠正/超上限裁剪），
 * v1 → v2 的类型迁移不算异常，避免老用户一升级就看到"已回退默认值"的吓人提示。
 *
 * @param {unknown} raw
 * @returns {{ entries: object[], repaired: boolean }}
 */
export function normalizeLog(raw) {
  if (!Array.isArray(raw)) return { entries: [], repaired: true }

  const valid = []
  let dropped = false
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      dropped = true
      continue
    }
    const { kind, migrated } = normalizeKind(item.kind)
    // 既不是 v2 类型、也不是 v1 遗留类型的，属于脏数据
    if (!KINDS.includes(kind) || (!migrated && !KINDS.includes(item.kind))) {
      dropped = true
      continue
    }
    if (typeof item.at !== 'number' || !Number.isFinite(item.at)) {
      dropped = true
      continue
    }
    const via = VIAS.includes(item.via)
      ? item.via
      : migrated
        ? 'question'
        : kind === 'taskDone'
          ? 'turn'
          : 'tool'
    // 读回来的 `reason` 一律清空：v1 曾把提问正文写进去，升级时顺手洗掉
    valid.push({ ...item, kind, via, reason: '' })
  }

  const sorted = [...valid].sort((a, b) => b.at - a.at)
  const orderChanged = sorted.some((item, index) => item !== valid[index])
  const trimmed = sorted.slice(0, LOG_LIMIT)
  const wasTrimmed = trimmed.length !== valid.length

  return {
    entries: trimmed,
    // 迁移过类型就顺手回写一次，但不当成"数据损坏"
    repaired: dropped || orderChanged || wasTrimmed,
  }
}
