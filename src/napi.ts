import type { Logger, Session } from 'koishi'
import type { SenseLogger } from './log'

// ─────────────────────────────────────────────
// NapCat(onebot11) API 访问层
// 字段与行为依据 .memory/napcat-group-info-survey.md / napcat-user-info-survey.md（源码级调研）
// ─────────────────────────────────────────────

/**
 * adapter-onebot `bot.internal` 的结构化声明（仅本插件用到的子集）。
 * 方法名 = onebot action 的 camelize 形式（adapter Internal.define 自动生成，
 * 见 koishi-plugin-adapter-onebot/lib/index.js:150）。
 */
export interface OneBotInternal {
  getGroupInfo(group_id: string | number, no_cache?: boolean): Promise<OnebotGroup>
  getGroupMemberList(group_id: string | number): Promise<OnebotGroupMember[]>
  getGroupMemberInfo(group_id: string | number, user_id: string | number, no_cache?: boolean): Promise<OnebotGroupMember>
  /** action: _get_group_notice（公告，WebApi 通道） */
  getGroupNotice(group_id: string | number): Promise<NapGroupNotice[]>
  /** 群荣誉（WebApi 通道），type 传 'all' 拿全部榜单 */
  getGroupHonorInfo(group_id: string | number, type?: string): Promise<NapHonorInfo>
  getGroupSignedList(group_id: string | number): Promise<NapSignedItem[]>
  getEssenceMsgList(group_id: string | number): Promise<NapEssenceItem[]>
  getStrangerInfo(user_id: string | number, no_cache?: boolean): Promise<NapStrangerInfo>
  /** 底层通道：adapter 未包装的 action 由此直发（retcode!=0 抛 SenderError） */
  _get(action: string, params?: Record<string, unknown>): Promise<any>
}

// ── 主要返回结构（只声明用到的字段，NapCat 返回值常多于声明）──

export interface OnebotGroup {
  group_id: number
  group_name: string
  member_count?: number
  max_member_count?: number
  group_all_shut?: number
  group_remark?: string
}

export interface OnebotGroupMember {
  group_id: number
  user_id: number
  nickname: string
  card?: string
  sex?: string
  age?: number
  area?: string
  level?: string
  qq_level?: number
  join_time?: number
  last_sent_time?: number
  role?: 'owner' | 'admin' | 'member'
  title?: string
  is_robot?: boolean
  shut_up_timestamp?: number
}

/** 群公告里的图片条目（NapCat 只给 id/尺寸，不给 URL；见 GetGroupNotice.ts 的 toNotice） */
export interface NapNoticePic {
  id?: string
  /** 少数版本/扩展可能直接带地址，优先用 */
  url?: string
  src?: string
  file?: string
  width?: number | string
  height?: number | string
}

export interface NapGroupNotice {
  notice_id: string
  sender_id: number
  publish_time: number
  message: { text?: string; image?: NapNoticePic[]; images?: NapNoticePic[] }
  /** 仅「发给新成员」条目带 inst_no_pinned：0 = 置顶中，1 = 未置顶 */
  settings?: { inst_no_pinned?: number } & Record<string, unknown>
  read_num?: number
  pinned?: boolean
  send_to_new_member?: boolean
}

/** get_image / get_file 的返回（把公告图片 id 解析成可取回的内容） */
export interface NapGetImageResult {
  /** 本地路径 */
  file?: string
  /** 下载 URL */
  url?: string
  file_size?: string
  file_name?: string
  /** NapCat 在 enableLocalFile2Url 时直接回 base64 */
  base64?: string
}

export interface NapHonorEntry {
  user_id?: number
  nickname?: string
  day_count?: number
}

export interface NapHonorInfo {
  group_id?: number
  current_talkative?: NapHonorEntry
  talkative_list?: NapHonorEntry[]
  performer_list?: NapHonorEntry[]
  legend_list?: NapHonorEntry[]
  emotion_list?: NapHonorEntry[]
  strong_newbie_list?: NapHonorEntry[]
}

export interface NapSignedItem {
  user_id: number
  nick: string
  time: number
  rank: number
}

export interface NapEssenceSeg {
  type?: string
  data?: { text?: string }
}

export interface NapEssenceItem {
  sender_id: number
  sender_nick?: string
  operator_id?: number
  operator_nick?: string
  operator_time?: number
  content?: NapEssenceSeg[]
}

export interface NapStrangerInfo {
  user_id: number
  nickname?: string
  sex?: string
  age?: number
  long_nick?: string
  qqLevel?: number
  reg_time?: number
  is_vip?: boolean
  is_years_vip?: boolean
  vip_level?: number
  remark?: string
  uid?: string
  qid?: string
  // spread 段字段（取决于对方隐私设置，多为 undefined/空串）
  birthday_year?: number
  birthday_month?: number
  birthday_day?: number
  homeTown?: string
  province?: string
  city?: string
  college?: string
  interest?: string
  constellation?: number
  shengXiao?: number
}

export interface NapMsgRecord {
  time?: number
  sender?: { user_id?: number; nickname?: string; card?: string }
  message?: unknown
  raw_message?: string
}

export interface NapProfileReactionEntry {
  uin?: number
  nick?: string
  nickname?: string
  do_time?: number
}

export interface NapProfileReactionResult {
  favoriteInfo?: {
    userInfos?: NapProfileReactionEntry[]
    total_count?: number
    today_count?: number
    last_time?: number
  }
  voteInfo?: {
    userInfos?: NapProfileReactionEntry[]
    total_count?: number
    new_count?: number
  }
}

// ── 会话路由解析 ──

/** 从 session 取群号（显式传参优先）；非群聊且未显式传参返回 null */
export function resolveGroupId(session: Session | undefined, input?: string): string | null {
  if (input) return String(input).trim()
  const gid = session?.guildId || session?.channelId
  if (!gid || gid.startsWith('private:')) return null
  return gid
}

/** 从 session 取默认目标 QQ（群聊=发送者；私聊=对端） */
export function resolveDefaultUserId(session: Session | undefined, input?: string): string | null {
  if (input) return String(input).trim()
  return session?.userId || null
}

// ── 结果归一化 ──

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string }

/** 已知错误码 → 中文短语（NapCat/onebot11 惯例） */
const RETCODE_HINTS: Record<number, string> = {
  1200: '机器人不在该群或无权限查看',
  1400: '请求参数无效，或操作被频率限制',
  1401: '机器人无该操作权限（需要群管理）',
  1450: '对方账号无法被访问（隐私限制或已注销）',
}

function briefError(e: unknown): string {
  const code = (e as any)?.code
  if (typeof code === 'number' && RETCODE_HINTS[code]) return `${RETCODE_HINTS[code]}（错误码 ${code}）`
  let msg = e instanceof Error ? e.message : String(e)
  if (msg.length > 140) msg = `${msg.slice(0, 140)}…`
  return msg || '未知错误'
}

/**
 * 统一 API 调用包装：取 internal → 超时 → 错误归一化为 { ok:false, error }。
 * 工具层拿到 error 直接作为 observation 文本回喂模型。
 */
export async function callApi<T>(opts: {
  session: Session | undefined
  label: string
  timeoutMs?: number
  logger: SenseLogger
  run: (internal: OneBotInternal) => Promise<T>
}): Promise<ApiResult<T>> {
  const internal = (opts.session?.bot as any)?.internal as OneBotInternal | undefined
  if (!internal || typeof internal._get !== 'function') {
    return { ok: false, error: '我现在看不到这些信息：当前会话不是 NapCat(onebot) 机器人。' }
  }
  const timeoutMs = opts.timeoutMs ?? 15000
  try {
    const data = await Promise.race<T>([
      opts.run(internal),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`等太久没等到（${timeoutMs / 1000}s）`)), timeoutMs),
      ),
    ])
    return { ok: true, data }
  } catch (e) {
    opts.logger?.debug?.(`[${opts.label}] API 失败:`, e)
    // 用"我这会儿没看清"而不是"XX 失败/接口出错"，避免模型把查询机制讲给用户听
    return { ok: false, error: `我这会儿没看清${opts.label}（${briefError(e)}）` }
  }
}

/** adapter 未包装 action 的直发包装（get_group_msg_history 带 count / 资料卡互动数据 get_profile_like） */
export function rawGet(internal: OneBotInternal, action: string, params: Record<string, unknown>): Promise<any> {
  return internal._get(action, params)
}

// ── TTL 缓存 ──

export class TtlCache {
  private map = new Map<string, { expireAt: number; value: unknown }>()

  constructor(private ttlSeconds: number) {}

  get<T>(key: string): T | undefined {
    if (this.ttlSeconds <= 0) return undefined
    const hit = this.map.get(key)
    if (!hit) return undefined
    if (Date.now() > hit.expireAt) {
      this.map.delete(key)
      return undefined
    }
    return hit.value as T
  }

  set(key: string, value: unknown): void {
    if (this.ttlSeconds <= 0) return
    // 简单防膨胀：条目过多时清掉已过期的
    if (this.map.size > 200) {
      const now = Date.now()
      for (const [k, v] of this.map) if (now > v.expireAt) this.map.delete(k)
    }
    this.map.set(key, { expireAt: Date.now() + this.ttlSeconds * 1000, value })
  }
}
