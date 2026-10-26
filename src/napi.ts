import type { Context, Logger, Session } from 'koishi'
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
  /** 我加入的所有群（自动打卡用它过滤掉已经退出的群；不再用于"枚举全部群打卡"） */
  getGroupList(no_cache?: boolean): Promise<OnebotGroup[]>
  getGroupMemberList(group_id: string | number): Promise<OnebotGroupMember[]>
  getGroupMemberInfo(group_id: string | number, user_id: string | number, no_cache?: boolean): Promise<OnebotGroupMember>
  /** action: _get_group_notice（公告，WebApi 通道） */
  getGroupNotice(group_id: string | number): Promise<NapGroupNotice[]>
  /** 群荣誉（WebApi 通道），type 传 'all' 拿全部榜单 */
  getGroupHonorInfo(group_id: string | number, type?: string): Promise<NapHonorInfo>
  getGroupSignedList(group_id: string | number): Promise<NapSignedItem[]>
  getEssenceMsgList(group_id: string | number): Promise<NapEssenceItem[]>
  getStrangerInfo(user_id: string | number, no_cache?: boolean): Promise<NapStrangerInfo>
  /**
   * 合并转发记录内容（action: get_forward_msg）。
   * adapter 用 defineExtract('get_forward_msg', 'messages', 'message_id') 包装，
   * 所以这个方法**直接返回 messages 数组**（retcode!=0 时抛 SenderError）。
   * 注意 prepareArg 会把 <2^32 的 *_id 参数转成 Number —— 转发 res_id 是 19 位，不会被转。
   */
  getForwardMsg(message_id: string | number): Promise<ForwardMessageRecord[]>
  /** 单条消息原文（action: get_msg），用于从"装着转发的普通消息"里反查转发记录 ID */
  getMsg(message_id: string | number): Promise<Record<string, any>>
  /** 底层通道：adapter 未包装的 action 由此直发（retcode!=0 抛 SenderError） */
  _get(action: string, params?: Record<string, unknown>): Promise<any>
  /**
   * adapter 的原始请求通道（由连接层在在线期间注入；断开即 delete）。
   * 与 _get 的区别：**不抛 SenderError**，返回完整信封，能读到 NapCat 的 message/wording。
   * 主动工具（群打卡/点赞）必须用它，否则错误原因会丢。
   */
  _request?(action: string, params?: Record<string, unknown>): Promise<OneBotEnvelope>
}

/** OneBot/NapCat 的统一响应信封 */
export interface OneBotEnvelope<T = any> {
  status?: string
  retcode: number
  data?: T
  /** NapCat 的具体错误文案（如"点赞失败 今日同一好友点赞数已达上限"） */
  message?: string
  wording?: string
}

/** get_forward_msg 返回的单条记录（只声明用到的字段） */
export interface ForwardMessageRecord {
  message_id?: string | number
  real_id?: string | number
  message_seq?: string | number
  time?: number | string
  sender?: { user_id?: string | number; nickname?: string; card?: string }
  user_id?: string | number
  nickname?: string
  /** 段数组（多数实现），少数实现给 CQ 串 */
  message?: unknown
  raw_message?: string
  data?: { message?: unknown }
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
 * 只读 API 的并发闸门。
 *
 * 多个会话可以同时请求 NapCat（尤其是 WebApi 类接口：成员列表/公告/荣誉/历史消息），
 * 不限制的话一次群活动就可能并发几十个请求。这里做成"最多 N 个在飞、其余排队"，
 * 排队期间不开始计时（超时从真正拿到槽位后算），避免超时后任务还在后台补发请求。
 */
export interface ApiLimiter {
  run<T>(fn: () => Promise<T>): Promise<T>
}

export function createApiLimiter(maxConcurrent = 4, maxQueue = 100): ApiLimiter {
  const limit = Math.max(1, Math.floor(maxConcurrent))
  const queueLimit = Math.max(limit, Math.floor(maxQueue))
  let active = 0
  const queue: Array<() => void> = []

  const next = () => {
    while (active < limit && queue.length > 0) {
      active++
      const start = queue.shift()!
      start()
    }
  }

  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        // 队列也不设上限的话，突发流量会把任务堆在内存里；超限直接 fail-fast
        if (active >= limit && queue.length >= queueLimit) {
          reject(new Error('当前查询太多了，排队已满，请稍后再试'))
          return
        }
        queue.push(() => {
          void (async () => {
            try {
              resolve(await fn())
            } catch (e) {
              reject(e)
            } finally {
              active--
              next()
            }
          })()
        })
        next()
      })
    },
  }
}

/**
 * 统一 API 调用包装：取 internal → 并发闸门 → 超时 → 错误归一化为 { ok:false, error }。
 * 工具层拿到 error 直接作为 observation 文本回喂模型。
 */
export async function callApi<T>(opts: {
  session: Session | undefined
  label: string
  timeoutMs?: number
  logger: SenseLogger
  /** 只读 API 并发闸门（可选；不传则直接执行，仍带超时） */
  limiter?: ApiLimiter
  run: (internal: OneBotInternal) => Promise<T>
}): Promise<ApiResult<T>> {
  const internal = (opts.session?.bot as any)?.internal as OneBotInternal | undefined
  if (!internal || typeof internal._get !== 'function') {
    return { ok: false, error: '我现在看不到这些信息：当前会话不是 NapCat(onebot) 机器人。' }
  }
  const timeoutMs = opts.timeoutMs ?? 15000
  // 超时从"真正开始执行"算，不把排队等待算进去；也不会在超时后留下一个排队任务去补发请求
  const execute = async (): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race<T>([
        opts.run(internal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`等太久没等到（${timeoutMs / 1000}s）`)), timeoutMs)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  try {
    const data = opts.limiter ? await opts.limiter.run(execute) : await execute()
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

/** 当前 internal 是否真的能发原始请求（WS 断开时 adapter 会删掉 _request） */
export function canRawRequest(internal: OneBotInternal | undefined): boolean {
  return !!internal && typeof internal._request === 'function'
}

/**
 * 主动工具专用：发原始请求并拿完整信封。
 *
 * 为什么不用 `_get`：adapter 的 `_get` 在 retcode!=0 时抛 SenderError，
 * 而 SenderError.message 只有 action/args/retcode，**NapCat 的 message 会丢**；
 * 对于点赞这种依赖"今日同一好友点赞数已达上限 / 账号转换失败"区分的操作，必须读原文。
 *
 * 永远不抛错：传输失败/超时归一化为 `{ retcode: -1, message }`，由调用侧决定提示文案。
 */
export async function rawRequest<T = any>(
  internal: OneBotInternal | undefined,
  action: string,
  params: Record<string, unknown> = {},
  timeoutMs = 15_000,
): Promise<OneBotEnvelope<T>> {
  if (!canRawRequest(internal)) {
    return { retcode: -1, message: '当前没有在线的 NapCat 连接' }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const response = await Promise.race([
      internal!._request!(action, params),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`等太久没等到（${timeoutMs / 1000}s）`)), timeoutMs)
      }),
    ])
    if (!response || typeof response !== 'object' || typeof response.retcode !== 'number') {
      return { retcode: -1, message: '返回格式异常' }
    }
    return response as OneBotEnvelope<T>
  } catch (e) {
    return { retcode: -1, message: e instanceof Error ? e.message : String(e) }
  } finally {
    if (timer) clearTimeout(timer)
  }
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
    // 防膨胀：先清过期；仍超上限时按插入顺序淘汰最旧的，避免大群/多转发把内存拖大
    const maxEntries = 200
    if (this.map.size >= maxEntries) {
      const now = Date.now()
      for (const [k, v] of this.map) if (now > v.expireAt) this.map.delete(k)
      while (this.map.size >= maxEntries) {
        const oldest = this.map.keys().next().value
        if (oldest === undefined) break
        this.map.delete(oldest)
      }
    }
    this.map.set(key, { expireAt: Date.now() + this.ttlSeconds * 1000, value })
  }

  /**
   * 主动丢弃一条缓存。
   * 用途：某些接口抓取失败时会**静默返回空结果**（如 NapCat 的荣誉榜），把空结果留在缓存里
   * 会让瞬时失败粘住整个 TTL。工具拿到空结果后调这个删掉，下次就会重新实查；
   * 顺带也能把"修复之前已经被写进去的空缓存"自愈掉。
   */
  delete(key: string): void {
    this.map.delete(key)
  }
}

// ─────────────────────────────────────────────
// 群荣誉榜「直连兜底」
//
// 背景（2026-10-19 实测）：腾讯把 qun.qq.com/interactive/honorlist 从服务端渲染页改成了 SPA，
// 返回的 HTML 里**不再有 window.__INITIAL_STATE__**（实测 8.6KB 的 SPA 外壳，数据改由前端请求）。
// 而 NapCat 的 get_group_honor_info 仍按老格式解析：
//
//   const match = /window\.__INITIAL_STATE__=(.*?);/.exec(res)
//   return type === 1 ? resJson?.talkativeList : resJson?.actorList
//
// 正则永远匹配不上 → getHonorList 打「获取类型 N 的荣誉信息失败」后 return []（静默回全空），
// 四个 type 于是全部失败。这是 NapCat 侧的回归。
//
// 兜底做法：用与页面同款的 cookie + bkn 直连新版 cgi 接口（接口从 SPA 的 honorlist-*.js 读出）：
//   GET /cgi-bin/qunapp/honor_talkative?gc&num&bkn                               → data.current_talkative / data.talkative_list
//   GET /cgi-bin/new_honor/list_honor/list_richer_honor?group_code&num&start&bkn → data.current_richer_honor / data.richer_honor_list
//   GET /cgi-bin/qunapp/honor_emotion?gc&num&bkn                                 → data.emotion_list
// 信封统一为 { retcode, msg, data }，retcode === 0 才算成功（无 cookie 时 retcode=100000 login error）。
// bkn 直接用 NapCat get_cookies 给出的值——实测其算法与页面一致（DJB hash from skey）。
//
// ⚠️ 这是**临时兜底**，只在「NapCat 返回全空」时才跑（天生自失效）。等 NapCat 修好解析后整块可删。
// ─────────────────────────────────────────────

const HONOR_BASE = 'https://qun.qq.com'
const HONOR_REFERER = 'https://qun.qq.com/interactive/honorlist'
const HONOR_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const HONOR_TIMEOUT_MS = 15_000

/** 新版接口的名单项：uin/nick 是页面自己的字段名，与 NapCat 映射后的 user_id/nickname 不同 */
interface HonorApiEntry {
  uin?: string | number
  nick?: string
  day_count?: number
  day_count_history?: number
}

function honorToEntry(raw: HonorApiEntry | undefined): NapHonorEntry | undefined {
  if (!raw) return undefined
  const uid = raw.uin != null ? String(raw.uin) : ''
  if (!uid && !raw.nick) return undefined
  const num = Number(uid)
  const days = raw.day_count_history ?? raw.day_count
  const entry: NapHonorEntry = {}
  if (uid && Number.isFinite(num) && num > 0) entry.user_id = num
  if (raw.nick) entry.nickname = raw.nick
  if (typeof days === 'number' && days > 0) entry.day_count = days
  return entry
}

function honorToEntryList(list: unknown): NapHonorEntry[] {
  if (!Array.isArray(list)) return []
  return list.map((item) => honorToEntry(item as HonorApiEntry)).filter((x): x is NapHonorEntry => !!x)
}

/**
 * 直连新版接口取群荣誉数据。
 * 返回 undefined 表示兜底不可用（拿不到 cookie/bkn，或所有请求都没成功）——调用侧继续按"没读到"处理。
 */
export async function fetchHonorsDirect(opts: {
  ctx: Context
  internal: { _get(action: string, params?: Record<string, unknown>): Promise<any> } | undefined
  gid: string
  logger?: SenseLogger
}): Promise<NapHonorInfo | undefined> {
  const { ctx, internal, gid, logger } = opts
  if (!internal || typeof internal._get !== 'function') return undefined

  let cookies = ''
  let bkn = ''
  try {
    const ck = (await internal._get('get_cookies', { domain: 'qun.qq.com' })) as
      | { cookies?: string; bkn?: string }
      | undefined
    cookies = typeof ck?.cookies === 'string' ? ck.cookies : ''
    bkn = typeof ck?.bkn === 'string' ? ck.bkn : ''
  } catch (e) {
    logger?.debug?.(`荣誉榜兜底：取 cookie 失败（${e instanceof Error ? e.message : String(e)}）`)
    return undefined
  }
  if (!cookies || !bkn) {
    logger?.debug?.('荣誉榜兜底：没有可用的 qun.qq.com cookie/bkn，跳过')
    return undefined
  }

  const fetchOne = async (
    path: string,
    params: Record<string, string | number>,
  ): Promise<any | undefined> => {
    const query = new URLSearchParams(
      Object.entries({ ...params, bkn }).map(([k, v]) => [k, String(v)]),
    ).toString()
    try {
      const res: any = await ctx.http.get(`${HONOR_BASE}${path}?${query}`, {
        headers: { Cookie: cookies, Referer: HONOR_REFERER, 'User-Agent': HONOR_UA },
        timeout: HONOR_TIMEOUT_MS,
      })
      // koishi 的 http 对 application/json 会自动解析；个别情况给到字符串，这里都兜住
      const body = typeof res === 'string' ? JSON.parse(res) : res
      if (!body || body.retcode !== 0) {
        logger?.debug?.(`荣誉榜兜底：${path} retcode=${body?.retcode} msg=${body?.msg ?? ''}`)
        return undefined
      }
      return body.data
    } catch (e) {
      logger?.debug?.(`荣誉榜兜底：${path} 请求失败（${e instanceof Error ? e.message : String(e)}）`)
      return undefined
    }
  }

  const [talkative, richer, emotion] = await Promise.all([
    fetchOne('/cgi-bin/qunapp/honor_talkative', { gc: gid, num: 3000 }),
    fetchOne('/cgi-bin/new_honor/list_honor/list_richer_honor', { group_code: gid, num: 3000, start: 0 }),
    fetchOne('/cgi-bin/qunapp/honor_emotion', { gc: gid, num: 3000 }),
  ])
  if (!talkative && !richer && !emotion) return undefined

  const info: NapHonorInfo = {
    group_id: Number(gid) || undefined,
    current_talkative: honorToEntry(talkative?.current_talkative),
    talkative_list: honorToEntryList(talkative?.talkative_list),
    performer_list: honorToEntryList(richer?.richer_honor_list),
    emotion_list: honorToEntryList(emotion?.emotion_list),
    // 新接口里没有对应数据：群聊炽热未在 SPA 中定位到，冒尖小春笋已被 QQ 下线
    legend_list: [],
    strong_newbie_list: [],
  }

  const total = info.talkative_list!.length + info.performer_list!.length + info.emotion_list!.length
  if (total === 0 && !info.current_talkative) return undefined

  // 兜底成功属于"过程细节"，用 debug 级别：只有打开 debug 开关时才输出，默认静默
  logger?.debug?.(
    `荣誉榜兜底成功（NapCat 解析因页面改版失效）：龙王 ${info.talkative_list!.length} 人、` +
      `群聊之火 ${info.performer_list!.length} 人、快乐源泉 ${info.emotion_list!.length} 人`,
  )
  return info
}
