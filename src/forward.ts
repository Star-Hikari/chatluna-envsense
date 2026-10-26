import type { Session } from 'koishi'
import type { SenseLogger } from './log'
import { ApiLimiter, callApi, OneBotInternal, TtlCache } from './napi'
import { fmtTsLoose, nickOf, truncate } from './format'

// ─────────────────────────────────────────────
// 合并转发（聊天记录）读取
//
// 背景（源码级调研见 .memory/chatluna-forward-msg-survey.md）：
//  · chatluna 主插件**不会**去读聊天记录正文，只会在消息末尾追加一个 <forward id="…"/> 占位标记，
//    正文必须由工具（本文件 + tools-forward.ts）去 OneBot 取；
//  · OneBot 收到的转发段是 { type:'forward', data:{ id } }，koishi 渲染成 <forward id="…"/>，
//    而 chatluna 的 pickForwardMessageId 只认 attrs.message_id / messageId —— 所以这里既提供
//    「补键名」（让 chatluna 自己的标记带上真实 ID），也提供真正读正文的实现；
//  · 引用（回复）合并转发是 chatluna 的结构性缺口：它只在最外层消息上检查 forward 状态，
//    引用子转换里的 ID 会被丢弃。所以引用那条由 tools-forward.ts 的钩子自己补标记。
//
// 本文件只依赖 napi/format，不依赖 forward-msg 插件（对应实现按 OneBot11 规范与 NapCat 文档重写）。
// ─────────────────────────────────────────────

// ── 元素层：识别 / 取 ID / 补键名 ──

/** koishi 元素的最小形状：只需要 type/attrs 就能判定，不必依赖 h() */
export interface MinimalElement {
  type?: string
  attrs?: Record<string, any>
}

/** 转发元素判定（与 chatluna utils/koishi.ts 的 isForwardMessageElement 对齐） */
export function isForwardElement(el?: MinimalElement | null): boolean {
  if (!el) return false
  if (el.type === 'forward') return true
  if (el.type !== 'message') return false
  const flag = String(el.attrs?.forward ?? '')
  return flag === 'true' || flag === '1'
}

/**
 * 取转发记录 ID。
 * 注意顺序：OneBot 把 ID 放在 `id`，chatluna 只认 `message_id`/`messageId`
 * （koishi 的 h() 会把 message_id 归一成 messageId），所以三个键都要认。
 */
export function forwardIdOf(el?: MinimalElement | null): string | undefined {
  const attrs = el?.attrs ?? {}
  for (const key of ['id', 'message_id', 'messageId']) {
    const raw = attrs[key]
    const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : ''
    if (text) return text
  }
  return undefined
}

/**
 * 把 OneBot 的 `id` 补成 chatluna 认的 `message_id`（原地改 attrs）。
 * 这是「直发聊天记录」能被 chatluna 打上带 ID 标记的唯一前提；
 * 属性键直接用 snake_case 即可 —— chatluna 两个键都查。
 */
export function patchForwardElementAttrs(elements?: unknown): void {
  for (const el of (elements as MinimalElement[] | undefined) ?? []) {
    if (!isForwardElement(el) || !el.attrs) continue
    const existing = el.attrs.message_id ?? el.attrs.messageId
    if (existing != null && String(existing).trim() !== '') continue
    const id = forwardIdOf(el)
    if (id) el.attrs.message_id = id
  }
}

/** 收集一批元素里的转发 ID（去重、保序） */
export function collectForwardIds(elements?: unknown): string[] {
  const ids: string[] = []
  for (const el of (elements as MinimalElement[] | undefined) ?? []) {
    if (!isForwardElement(el)) continue
    const id = forwardIdOf(el)
    if (id && !ids.includes(id)) ids.push(id)
  }
  return ids
}

/** 模型可能用来指代"当前这条消息"的占位词（实测它会自己编一个 current 出来） */
const CURRENT_ALIASES = new Set(['current', 'now', 'latest', 'this', '本条', '这条', '当前', '本消息', '本條', '當前'])

export function isCurrentAlias(value?: string): boolean {
  const text = (value ?? '').trim().toLowerCase()
  return text === '' || CURRENT_ALIASES.has(text)
}

/** 取引用（回复）消息的元素数组：koishi 的 session.quote 在类型上各版本有差异，这里做宽松取值 */
export function quoteElementsOf(session?: Session): MinimalElement[] | undefined {
  const quote = (session as unknown as { quote?: { elements?: MinimalElement[] } } | undefined)?.quote
  return quote?.elements
}

/**
 * 解析要读哪些 ID（按优先级，全部尝试直到读到内容）：
 *  1. 显式传入且不是占位词 → 就用它；
 *  2. 当前消息自带的聊天记录 → 引用（回复）消息里的聊天记录；
 *  3. 当前消息自身的 ID（NapCat 的 get_msg 能反查出它里面那条转发记录的 ID）。
 */
export function resolveForwardTargets(session?: Session, input?: string): string[] {
  const explicit = (input ?? '').trim()
  if (explicit && !isCurrentAlias(explicit)) return [explicit]
  const ids: string[] = []
  const push = (id?: string) => {
    if (id && !ids.includes(id)) ids.push(id)
  }
  for (const elements of [session?.elements, quoteElementsOf(session)]) {
    for (const id of collectForwardIds(elements)) push(id)
  }
  push(session?.messageId)
  return ids
}

// ── OneBot 层：取值 ──

export interface ForwardSegment {
  type?: string
  data?: Record<string, any>
}

/** 聊天记录里的一条（各家实现字段略有出入，这里只声明用到的部分） */
export interface ForwardMessage {
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

/** 各家返回信封兼容：数组 / {messages} / {data:{messages}} / {data:{data:{messages}}} / {result:{messages}} */
function extractMessagesArray(raw: unknown): ForwardMessage[] {
  if (Array.isArray(raw)) return raw as ForwardMessage[]
  if (!raw || typeof raw !== 'object') return []
  const envelope = raw as Record<string, any>
  for (const candidate of [envelope.messages, envelope.data?.messages, envelope.data?.data?.messages, envelope.result?.messages]) {
    if (Array.isArray(candidate)) return candidate as ForwardMessage[]
  }
  return []
}

const CQ_PATTERN = /\[CQ:([a-zA-Z_]+)((?:,[^\]]*)?)\]/g

/** CQ 串 → 段数组（只在个别实现给字符串时用得上） */
function parseCq(text: string): ForwardSegment[] {
  const segments: ForwardSegment[] = []
  let last = 0
  for (const match of text.matchAll(CQ_PATTERN)) {
    const index = match.index ?? 0
    if (index > last) segments.push({ type: 'text', data: { text: text.slice(last, index) } })
    const data: Record<string, string> = {}
    for (const pair of (match[2] ?? '').replace(/^,/, '').split(',')) {
      const eq = pair.indexOf('=')
      if (eq > 0) data[pair.slice(0, eq)] = pair.slice(eq + 1)
    }
    segments.push({ type: match[1], data })
    last = index + match[0].length
  }
  if (last < text.length) segments.push({ type: 'text', data: { text: text.slice(last) } })
  return segments
}

/** 一条消息 → 段数组：数组直接用，字符串按 CQ 解析，最后兜 raw_message */
function normalizeSegments(value: unknown, rawFallback?: string): ForwardSegment[] {
  if (Array.isArray(value)) return value as ForwardSegment[]
  if (typeof value === 'string' && value.trim()) return parseCq(value)
  if (typeof rawFallback === 'string' && rawFallback.trim()) return parseCq(rawFallback)
  return []
}

/** get_forward_msg：优先走 adapter 包装好的 getForwardMsg（直接返回 messages），再退回裸 action */
async function tryGetForward(internal: OneBotInternal, id: string): Promise<ForwardMessage[]> {
  const attempts: (() => Promise<unknown>)[] = []
  if (typeof internal.getForwardMsg === 'function') attempts.push(() => internal.getForwardMsg(id))
  attempts.push(() => internal._get('get_forward_msg', { message_id: id }))
  attempts.push(() => internal._get('get_forward_msg', { id }))
  for (const run of attempts) {
    try {
      const messages = extractMessagesArray(await run())
      if (messages.length > 0) return messages
    } catch {
      // 换下一种参数/通道
    }
  }
  return []
}

/** get_msg：拿单条消息原文（用于"传进来的是装着转发的那条普通消息 ID"的反查） */
async function tryGetMsg(internal: OneBotInternal, id: string): Promise<Record<string, any> | undefined> {
  const attempts: (() => Promise<unknown>)[] = []
  if (typeof internal.getMsg === 'function') attempts.push(() => internal.getMsg(id))
  attempts.push(() => internal._get('get_msg', { message_id: id }))
  for (const run of attempts) {
    try {
      const data = await run()
      if (data && typeof data === 'object') return data as Record<string, any>
    } catch {
      // 同上
    }
  }
  return undefined
}

/** 从一条原始消息里挖出它包含的转发记录 ID */
function nestedForwardIdsOf(detail?: Record<string, any>): string[] {
  const ids: string[] = []
  for (const segments of [normalizeSegments(detail?.message), normalizeSegments(detail?.data?.message)]) {
    for (const seg of segments) {
      if (seg?.type !== 'forward') continue
      const id = String(seg.data?.id ?? seg.data?.message_id ?? '').trim()
      if (id && !ids.includes(id)) ids.push(id)
    }
  }
  return ids
}

/** 转发段自带的内联内容（部分实现 [收] 时会给 content 数组，可省一次 API） */
function inlineMessagesOf(detail?: Record<string, any>): ForwardMessage[] {
  const out: ForwardMessage[] = []
  for (const segments of [normalizeSegments(detail?.message), normalizeSegments(detail?.data?.message)]) {
    for (const seg of segments) {
      if (seg?.type !== 'forward' && seg?.type !== 'node') continue
      const content = seg.data?.content
      if (Array.isArray(content) && content.length > 0) out.push(...(content as ForwardMessage[]))
    }
  }
  return out
}

/**
 * 取出一叠聊天记录：直取 → 内联内容 → get_msg 反查。
 * 反查这一层是必要的：模型/上游完全可能把"装着转发的普通消息 ID"当成转发 ID 传进来。
 */
async function fetchForwardMessages(internal: OneBotInternal, id: string, logger: SenseLogger): Promise<ForwardMessage[]> {
  const direct = await tryGetForward(internal, id)
  if (direct.length > 0) return direct

  const detail = await tryGetMsg(internal, id)
  if (detail) {
    const inline = inlineMessagesOf(detail)
    if (inline.length > 0) return inline
    for (const nestedId of nestedForwardIdsOf(detail)) {
      const nested = await tryGetForward(internal, nestedId)
      if (nested.length > 0) return nested
    }
  }

  logger.debug(`聊天记录 ${id} 取到 0 条（可能已被清理，或该 ID 不是转发记录）`)
  return []
}

// ── 渲染层：段数组 → 行式中文 ──

const SEG_MARK: Record<string, string> = {
  mface: '表情包',
  face: '表情',
  record: '语音',
  video: '视频',
  json: '卡片',
  xml: '卡片',
  share: '分享',
  music: '音乐',
  contact: '名片',
  location: '位置',
  markdown: 'markdown',
  lightapp: '小程序',
  dice: '骰子',
  rps: '猜拳',
  poke: '戳一戳',
  gift: '礼物',
}

/** 段数组 → 一行正文（node/forward/reply 由调用侧单独处理） */
function renderSegments(segments: ForwardSegment[]): string {
  let out = ''
  const push = (text: string, spaced = false) => {
    if (!text) return
    if (out && spaced && !/\s$/.test(out)) out += ' '
    out += text
  }
  for (const seg of segments) {
    const type = String(seg?.type ?? '')
    const data = seg?.data ?? {}
    if (type === 'text') {
      push(String(data.text ?? ''))
      continue
    }
    if (type === 'at') {
      push(`@${data.qq ?? '某人'}`, true)
      continue
    }
    if (type === 'image' || type === 'mface') {
      const url = String(data.url ?? '').trim()
      push(url ? `[图 ${url}]` : '[图]', true)
      continue
    }
    if (type === 'file') {
      const name = String(data.name ?? data.file ?? '').trim()
      push(`[文件${name ? ` ${name}` : ''}]`, true)
      continue
    }
    if (type === 'reply' || type === 'node' || type === 'forward') continue
    const mark = SEG_MARK[type]
    if (mark) push(`[${mark}]`, true)
    else if (type) push(`[${type}]`, true)
  }
  return out.trim()
}

interface RenderState {
  lines: string[]
  count: number
  chars: number
  truncated: boolean
}

function pushLine(state: RenderState, line: string, maxChars: number): boolean {
  state.lines.push(line)
  state.chars += line.length + 1
  if (state.chars >= maxChars) state.truncated = true
  return !state.truncated
}

interface WalkOptions {
  internal: OneBotInternal
  level: number
  maxDepth: number
  maxEntries: number
  maxChars: number
  visited: Set<string>
  state: RenderState
  logger: SenseLogger
}

/** 递归渲染一叠聊天记录（同层与嵌套共用一份 state，便于统一限条数/限字数） */
async function walkMessages(options: WalkOptions, messages: ForwardMessage[], prefix = ''): Promise<void> {
  const { internal, level, maxDepth, maxEntries, maxChars, visited, state, logger } = options
  const indent = '  '.repeat(level)
  const bodyIndent = `${indent}  `
  // 编号按"层内已渲染条数"走（跳过的空条目不占号），嵌套用 3.1 / 3.2 这样的前缀
  let index = 0

  for (const message of messages) {
    if (state.count >= maxEntries) {
      state.truncated = true
      return
    }
    const segments = normalizeSegments(message.message ?? message.data?.message, message.raw_message)
    const quoteId = String(segments.find((seg) => seg?.type === 'reply')?.data?.id ?? '').trim()
    const body = renderSegments(segments)
    const nestedForward = segments.filter((seg) => seg?.type === 'forward')
    const nestedNodes = segments.filter((seg) => seg?.type === 'node')
    if (!body && !quoteId && nestedForward.length === 0 && nestedNodes.length === 0) continue

    index += 1
    state.count += 1
    const sender = message.sender ?? {}
    const name = nickOf(sender as { nickname?: string; card?: string; nick?: string }, '未知')
    const uid = sender.user_id ?? message.user_id
    const time = fmtTsLoose(message.time)
    // 顶层是 "1."，嵌套是 "3.1" / "3.1.2"（不带尾点，读起来更干净）
    const number = prefix ? `${prefix}${index}` : `${index}`
    const label = prefix ? number : `${number}.`
    if (!pushLine(state, `${indent}${label} ${name}${uid ? ` (${uid})` : ''}${time ? ` ${time}` : ''}`, maxChars)) return
    if (quoteId && !pushLine(state, `${bodyIndent}[引用了另一条消息]`, maxChars)) return
    if (body && !pushLine(state, `${bodyIndent}${truncate(body, 400)}`, maxChars)) return

    if (nestedForward.length === 0 && nestedNodes.length === 0) continue
    if (level + 1 >= maxDepth) {
      if (!pushLine(state, `${bodyIndent}[里面还套着一叠聊天记录，未展开]`, maxChars)) return
      continue
    }
    const childPrefix = `${number}.`

    // node 段自带 content，直接当一层用
    const inlineNodes: ForwardMessage[] = []
    for (const seg of nestedNodes) {
      const content = seg.data?.content
      if (Array.isArray(content) && content.length > 0) {
        inlineNodes.push({ sender: { user_id: seg.data?.user_id, nickname: seg.data?.nickname }, time: seg.data?.time, message: content })
      }
    }
    if (inlineNodes.length > 0) {
      await walkMessages(options, inlineNodes, childPrefix)
      if (state.truncated) return
    }

    for (const seg of nestedForward) {
      if (state.count >= maxEntries || state.truncated) {
        state.truncated = true
        return
      }
      const inlineContent = seg.data?.content
      if (Array.isArray(inlineContent) && inlineContent.length > 0) {
        await walkMessages(options, inlineContent as ForwardMessage[], childPrefix)
        continue
      }
      const nestedId = String(seg.data?.id ?? seg.data?.message_id ?? '').trim()
      if (!nestedId || visited.has(nestedId)) continue
      visited.add(nestedId)
      try {
        const nested = await fetchForwardMessages(internal, nestedId, logger)
        if (nested.length > 0) await walkMessages(options, nested, childPrefix)
      } catch (e) {
        logger.debug(`嵌套聊天记录 ${nestedId} 读取失败：${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }
}

// ── 对外入口 ──

export type ReadForwardResult = { ok: true; text: string; count?: number } | { ok: false; error: string }

export interface ReadForwardOptions {
  session?: Session
  /** 模型给的 id；留空或占位词表示"当前这条消息/它引用的消息里的聊天记录" */
  messageId?: string
  maxDepth: number
  maxEntries: number
  maxChars: number
  logger: SenseLogger
  /** 只读 API 并发闸门（与其它查询共用） */
  limiter?: ApiLimiter
  /** 命中同一叠记录时直接复用上次的渲染结果 */
  cache?: TtlCache
}

/**
 * 读取一叠聊天记录并渲染成行式中文。
 * 失败一律返回中文文案（与插件其它工具一致：说"没看清"，不抛错误码）。
 */
export async function readForwardTranscript(options: ReadForwardOptions): Promise<ReadForwardResult> {
  const { session, logger } = options
  const targets = resolveForwardTargets(session, options.messageId)
  if (targets.length === 0) {
    return { ok: false, error: '这条消息里没有合并转发，也没有可用的消息 ID，我读不到聊天记录。' }
  }

  const cacheKey = `forward:v1:${targets.join(',')}:d${options.maxDepth}:n${options.maxEntries}:c${options.maxChars}`
  const cached = options.cache?.get<string>(cacheKey)
  if (typeof cached === 'string') return { ok: true, text: cached }

  const result = await callApi<{ text: string; count: number }>({
    session,
    label: '聊天记录',
    timeoutMs: 20000,
    logger,
    limiter: options.limiter,
    run: async (internal) => {
      for (const id of targets) {
        const messages = await fetchForwardMessages(internal, id, logger)
        if (messages.length === 0) continue
        const state: RenderState = { lines: [], count: 0, chars: 0, truncated: false }
        await walkMessages(
          {
            internal,
            level: 0,
            maxDepth: options.maxDepth,
            maxEntries: options.maxEntries,
            maxChars: options.maxChars,
            visited: new Set([id]),
            state,
            logger,
          },
          messages,
        )
        if (state.count === 0) continue
        const lines = [`合并转发聊天记录（共 ${state.count} 条${state.truncated ? '，内容较多已截断' : ''}）：`, ...state.lines]
        if (state.truncated) lines.push('（后面还有，没全部展开；需要的话可以再让我看看具体哪一段）')
        return { text: lines.join('\n'), count: state.count }
      }
      return { text: '', count: 0 }
    },
  })

  if (!result.ok) return { ok: false, error: result.error }
  if (!result.data.text) {
    return { ok: false, error: '我点开了这叠聊天记录，但里面是空的（可能已经被平台清理，或这条转发记录已经不在了）。' }
  }
  options.cache?.set(cacheKey, result.data.text)
  return { ok: true, text: result.data.text, count: result.data.count }
}