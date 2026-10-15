// ─────────────────────────────────────────────
// observation 文本格式化（行式中文，模型读行式比 JSON 稳）
// ─────────────────────────────────────────────

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

/** Unix 秒 → `2026-10-13 16:42`；非法值返回 "未知" */
export function fmtTs(seconds: number | undefined | null): string {
  if (typeof seconds !== 'number' || seconds <= 0) return '未知'
  const d = new Date(seconds * 1000)
  if (Number.isNaN(d.getTime())) return '未知'
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Unix 秒 → 相对时间括注，如 `（3 天前）`；未来/非法返回空串 */
export function relTs(seconds: number | undefined | null): string {
  if (typeof seconds !== 'number' || seconds <= 0) return ''
  const diff = Date.now() - seconds * 1000
  if (diff < 0) return ''
  if (diff < MIN) return '（刚刚）'
  if (diff < HOUR) return `（${Math.floor(diff / MIN)} 分钟前）`
  if (diff < DAY) return `（${Math.floor(diff / HOUR)} 小时前）`
  if (diff < 365 * DAY) return `（${Math.floor(diff / DAY)} 天前）`
  return `（${Math.floor(diff / (365 * DAY))} 年前）`
}

export function fmtTsRel(seconds: number | undefined | null): string {
  return `${fmtTs(seconds)}${relTs(seconds)}`
}

/**
 * 宽松时间戳归一化：接口偶尔把时间给成毫秒、数字字符串，或者干脆给个无意义的小数字
 * （实测 get_profile_like 的 favoriteInfo.last_time 会返回 ~2e7 量级的值，按秒解释就成了 1970 年）。
 * 这里：数字/数字字符串都收 → 毫秒降级为秒 → 落在可信区间之外一律判为不可用。
 * 返回 undefined 表示"不是可信时间戳"，调用侧应省略该行，而不是打印一个假日期。
 */
export function normalizeTs(value: unknown): number | undefined {
  let n: number
  if (typeof value === 'number') n = value
  else if (typeof value === 'string' && value.trim() !== '') n = Number(value)
  else return undefined
  if (!Number.isFinite(n) || n <= 0) return undefined
  if (n >= 1e12) n = Math.floor(n / 1000)
  const MIN = 946684800 // 2000-01-01：早于它的值不可能是正常业务时间戳
  const MAX = Math.floor(Date.now() / 1000) + 86400 * 365 * 100
  if (n < MIN || n > MAX) return undefined
  return n
}

/** 宽松时间戳 → `YYYY-MM-DD HH:mm`；不可信时返回 undefined */
export function fmtTsLoose(value: unknown): string | undefined {
  const n = normalizeTs(value)
  return n === undefined ? undefined : fmtTs(n)
}

/** 成员显示名：群名片优先 */
export function nickOf(member: { nickname?: string; card?: string; nick?: string }, fallback = '无名'): string {
  const name = member.card || member.nickname || member.nick
  return name && name.trim() ? name.trim() : fallback
}

const ROLE_CN: Record<string, string> = {
  owner: '群主',
  admin: '管理员',
  member: '普通成员',
}

export function roleCN(role?: string): string {
  if (!role) return '未知身份'
  return ROLE_CN[role] || role
}

const SEX_CN: Record<string, string> = {
  male: '男',
  female: '女',
}

export function sexCN(sex?: string): string | undefined {
  if (!sex) return undefined
  const cn = SEX_CN[sex]
  return cn && cn !== 'unknown' ? cn : undefined
}

export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** 空/零值/纯空白过滤：资料卡等隐私字段大量为空，只输出有信息量的行 */
export function pushIfLine(lines: string[], value: unknown, label: string, render?: (v: any) => string): void {
  if (value === undefined || value === null || value === '') return
  if (typeof value === 'number' && value <= 0) return
  if (typeof value === 'string' && value.trim() === '') return
  const text = render ? render(value) : String(value)
  if (!text || text.trim() === '') return
  lines.push(`${label}: ${text}`)
}

/** QQ 等级数值 → 皇冠/太阳/月亮/星星描述（QQ 惯例 1皇冠=16太阳，1太阳=4月亮，1月亮=4星星） */
export function qqLevelCN(level: number | undefined): string | undefined {
  if (!level || level <= 0) return undefined
  const crown = Math.floor(level / 64)
  const sun = Math.floor((level % 64) / 16)
  const moon = Math.floor((level % 16) / 4)
  const star = level % 4
  const parts: string[] = []
  if (crown) parts.push(`${crown}皇冠`)
  if (sun) parts.push(`${sun}太阳`)
  if (moon) parts.push(`${moon}月亮`)
  if (star) parts.push(`${star}星星`)
  return parts.length ? `${parts.join(' ')}（Lv.${level}）` : `Lv.${level}`
}
