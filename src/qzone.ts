import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import type { Session } from 'koishi'
import type { ChatLunaTool } from 'koishi-plugin-chatluna/llm-core/platform/types'
import { deliverImageBytes, prepareInlineImage, sniffImageMime } from './avatar'
import { onebotAuthorization, PERCEPTION_NOTE, sessionFrom, takeImageBudget, ToolDeps, toolMeta } from './common'
import { downloadBytes } from './download'
import { fmtTsRel, normalizeTs, truncate } from './format'
import {
  NapQzoneDetail,
  NapQzoneFeedItem,
  NapQzoneFeedsResult,
  NapQzoneMsgItem,
  NapQzoneMsgListResult,
  NapQzoneProfile,
  OneBotInternal,
  rawRequest,
} from './napi'

// ─────────────────────────────────────────────
// QQ 空间感知（只读四件套）
//
//   qzone_feeds        好友动态（get_qzone_feeds）
//   qzone_posts        某人/自己的说说列表（get_qzone_msg_list）
//   qzone_post_detail  单条说说的正文与评论（get_qzone_msg_detail）
//   qzone_profile      空间名称与说明（get_qzone_profile）
//
// 依据：.memory/napcat-4.18.42-qzone-survey.md。要点：
//  1. 这些 action 是 NapCat **4.18.42** 才新增的，老版本会返回"不支持的 API"；
//  2. 它们没被 adapter-onebot define() 包装，只能走 _get/_request —— 这里统一用
//     rawRequest，因为 NapCat 的错误大多是业务语义（游标过期/登录态失效），
//     `_get` 抛的 SenderError 会把 message 吞掉；
//  3. 默认 format=snowluma（字段干净）；native 才带 feed_ref，本模块暂不做评论翻页；
//  4. 游标是 NapCat 进程内的短期 token（TTL 10 分钟、绑定账号），过期后只能重看第一页；
//  5. 好友动态/说说内容属于他人隐私：只读、只进本次上下文，不落库。
//
// 编号机制：两个列表工具都会把结果存进「本会话最近一次列表」快照，
// qzone_post_detail 只认快照里的 index，避免把 tid/feed_ref 这类内部标识喂给模型。
// 快照 10 分钟过期（与 NapCat 游标同寿），过期后如实说"不记得刚才那份列表了"。
// ─────────────────────────────────────────────

const LIST_TTL_MS = 10 * 60 * 1000
const MAX_SNAPSHOTS = 200
const MAX_QZONE_IMAGE_DOWNLOAD_BYTES = 8 * 1024 * 1024
const QZONE_EXPIRED = /游标|过期|重新获取第一页|请先获取/

interface QzoneListItem {
  index: number
  tid?: string
  /** get_qzone_msg_detail 需要的 target_uin（空间所属者） */
  targetUin?: string
  authorId?: string
  authorName: string
  time?: number
  content: string
  imageUrls: string[]
  likeCount?: number
  commentCount?: number
}

interface QzoneSnapshot {
  at: number
  title: string
  items: QzoneListItem[]
  /** 好友动态的下一页游标 */
  cursor?: string
  /** 说说列表的下一页偏移 */
  nextOffset?: number
  targetUin?: string
}

/** 会话 → 最近一次列表快照（模块级，插件重载即清空，与相册的 lastDetailAt 同思路） */
const snapshots = new Map<string, QzoneSnapshot>()

type QzoneResult<T> = { ok: true; data: T } | { ok: false; error: string; expired?: boolean }

function snapshotKey(session: Session | undefined): string {
  if (!session) return 'anonymous'
  const scope = session.isDirect ? `p:${session.userId ?? ''}` : `g:${session.guildId ?? ''}`
  return `${session.platform ?? ''}:${session.selfId ?? ''}:${scope}`
}

function saveSnapshot(key: string, snap: Omit<QzoneSnapshot, 'at'>): void {
  if (snapshots.size >= MAX_SNAPSHOTS) snapshots.clear()
  snapshots.set(key, { ...snap, at: Date.now() })
}

function loadSnapshot(key: string): QzoneSnapshot | undefined {
  const snap = snapshots.get(key)
  if (!snap) return undefined
  if (Date.now() - snap.at > LIST_TTL_MS) {
    snapshots.delete(key)
    return undefined
  }
  return snap
}

function countOf(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(div|p|li)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 列表行用：压成一行并截断 */
function flatText(content: unknown, html: unknown, max = 200): string {
  const text =
    typeof content === 'string' && content.trim()
      ? content
      : typeof html === 'string' && html.trim()
        ? stripHtml(html)
        : ''
  return truncate(text, max)
}

/** 详情正文用：保留换行 */
function clip(text: string, max: number): string {
  const t = text.trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

function imageUrlsOf(raw: { images?: unknown }): string[] {
  const list = raw?.images
  if (!Array.isArray(list)) return []
  return list.filter((u): u is string => typeof u === 'string' && !!u.trim())
}

function normalizeFeedItem(raw: NapQzoneFeedItem, index: number): QzoneListItem {
  const uid = typeof raw.uin === 'number' ? String(raw.uin) : undefined
  return {
    index,
    tid: typeof raw.tid === 'string' && raw.tid.trim() ? raw.tid.trim() : undefined,
    targetUin: uid,
    authorId: uid,
    authorName: raw.nickname?.trim() || uid || '某人',
    time: normalizeTs(raw.time),
    content: flatText(raw.content, raw.html),
    imageUrls: imageUrlsOf(raw),
    likeCount: countOf(raw.like_count),
    commentCount: countOf(raw.comment_count),
  }
}

function normalizePostItem(
  raw: NapQzoneMsgItem,
  index: number,
  targetUin?: string,
  fallbackName = '某人',
): QzoneListItem {
  return {
    index,
    tid: typeof raw.tid === 'string' && raw.tid.trim() ? raw.tid.trim() : undefined,
    targetUin,
    authorName: targetUin || fallbackName,
    time: normalizeTs(raw.time),
    content: flatText(raw.content, undefined),
    imageUrls: imageUrlsOf(raw),
    commentCount: countOf(raw.comment_num),
  }
}

function listLine(item: QzoneListItem): string {
  const when = item.time ? ` ${fmtTsRel(item.time)}` : ''
  const pics = item.imageUrls.length > 0 ? `${item.imageUrls.length} 张图` : ''
  const stats = [
    item.likeCount !== undefined ? `赞 ${item.likeCount}` : '',
    item.commentCount !== undefined ? `评论 ${item.commentCount}` : '',
  ].filter(Boolean)
  const extra = [pics, ...stats].filter(Boolean).join(' · ')
  const body = item.content || '（这条没有文字）'
  return `${item.index}. ${truncate(item.authorName, 20)}${when}：${truncate(body, 120)}${extra ? `（${extra}）` : ''}`
}

function clampCount(value: number | undefined, fallback: number, max: number): number {
  const want = Math.floor(Number(value ?? fallback))
  const limit = Math.max(1, Math.floor(max))
  if (!Number.isFinite(want)) return Math.min(Math.max(1, fallback), limit)
  return Math.max(1, Math.min(want, limit))
}

/** `mine` / 显式 QQ 号 / 会话里的对端或发言人 → target_uin；undefined 表示"我自己的空间" */
function resolveTarget(
  session: Session | undefined,
  input: { user_id?: string; mine?: boolean },
): { uin?: string; error?: string } {
  if (input.mine) return {}
  const explicit = String(input.user_id ?? '').trim()
  if (explicit) {
    return /^[1-9]\d{0,19}$/.test(explicit)
      ? { uin: explicit }
      : { error: `“${truncate(explicit, 20)}”不像一个 QQ 号，我需要一串数字才能找到那个人的空间。` }
  }
  const fromSession = String(session?.userId ?? '').trim()
  if (/^[1-9]\d{0,19}$/.test(fromSession)) return { uin: fromSession }
  return { error: '我还不知道要看谁的空间——告诉我要看的 QQ 号吧。' }
}

/**
 * 空间动态的「最老可看」截止时间（Unix 秒）；undefined = 不限制。
 * 配置 `qzone.maxAgeDays` 默认 14 天，0 表示不限。
 */
function recentCutoff(deps: ToolDeps): number | undefined {
  const days = Number(deps.config.qzone?.maxAgeDays ?? 0)
  if (!Number.isFinite(days) || days <= 0) return undefined
  return Math.floor(Date.now() / 1000) - Math.round(days * 86400)
}

function ageLimitDays(deps: ToolDeps): number {
  const days = Number(deps.config.qzone?.maxAgeDays ?? 0)
  return Number.isFinite(days) && days > 0 ? Math.round(days) : 0
}

/** 这条是否已经超出可看范围；时间缺失/异常时宁可保留（无法证明它超期） */
function olderThan(time: number | undefined, cutoff: number | undefined): boolean {
  if (cutoff === undefined) return false
  return typeof time === 'number' && Number.isFinite(time) && time > 0 && time < cutoff
}

/**
 * 统一调用：并发闸门 → 原始信封 → 错误文案归一化 → 可选 TTL 缓存。
 * 用 rawRequest 而不是 callApi/_get，是为了拿到 NapCat 的 message（游标过期、登录态失效都在里面）。
 */
async function qzoneCall<T>(opts: {
  deps: ToolDeps
  session: Session | undefined
  action: string
  params: Record<string, unknown>
  label: string
  cacheKey?: string
}): Promise<QzoneResult<T>> {
  const { deps, session } = opts
  if (opts.cacheKey) {
    const hit = deps.qzoneCache?.get<T>(opts.cacheKey)
    if (hit !== undefined) return { ok: true, data: hit }
  }

  const internal = (session?.bot as any)?.internal as OneBotInternal | undefined
  if (!internal || typeof internal._request !== 'function') {
    return { ok: false, error: '我这会儿连不上 QQ，看不了空间里的内容。' }
  }

  try {
    const env = await deps.limiter.run(() => rawRequest<T>(internal, opts.action, opts.params))
    if (env.retcode !== 0) {
      const message = String(env.message ?? '').trim() || `错误码 ${env.retcode}`
      deps.logger.debug(`[${opts.action}] 失败：${message}`)
      return {
        ok: false,
        error: `我这会儿没看清${opts.label}（${truncate(message, 90)}）`,
        expired: QZONE_EXPIRED.test(message),
      }
    }
    const data = env.data as T
    if (opts.cacheKey) deps.qzoneCache?.set(opts.cacheKey, data)
    return { ok: true, data }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    deps.logger.debug(`[${opts.action}] 异常：`, e)
    return { ok: false, error: `我这会儿没看清${opts.label}（${truncate(message, 90)}）` }
  }
}

const UNSUPPORTED_HINT = '（也可能是 NapCat 版本太旧——这些能力要 4.18.42 以上才有）'

/**
 * 把图片交给模型（复用头像/相册那条交付链）。
 *
 * 2026-11-02 413 事故后改：不再用 4MB 的宽松上限直接内联，而是
 *   下载（≤8MB）→ 压到单张 imageMaxKb → 查会话预算 → 内联。
 * 任何一步不满足就跳过（计入 skipped），由调用侧说明"这次先不看了"，绝不硬塞。
 *
 * 2026-11-06 校准：`chatluna-request-meter` 只重写**最终请求体里的 base64**
 *   （http 链接在它的 post 钩子之前早被 ChatLuna 下载成了 base64），
 *   所以这里**必须继续交 base64**：交 URL 不省请求体，反而让每轮请求多下载一次。
 *   压缩的作用也随之变成"省历史体积 + 保画质"，不再承担防止 413 的主要责任。
 */
async function collectImages(
  deps: ToolDeps,
  session: Session | undefined,
  urls: string[],
  baseName: string,
): Promise<{ parts: any[]; failed: number; skipped: number }> {
  const parts: any[] = []
  let failed = 0
  let skipped = 0

  const inlineMax = Math.max(64, deps.config.imageMaxKb ?? 512) * 1024
  for (const url of urls) {
    try {
      const raw = await downloadBytes(deps.ctx, url, MAX_QZONE_IMAGE_DOWNLOAD_BYTES)
      const prepared = await prepareInlineImage(
        raw,
        sniffImageMime(raw) ?? 'image/jpeg',
        inlineMax,
        deps.config.imageMaxSide ?? 1280,
      )
      const budget = takeImageBudget(deps, session, prepared.bytes.byteLength)
      if (!budget.ok) {
        skipped++
        deps.logger.info(
          `空间图片跳过内联：本会话已用满图片预算（剩余 ${Math.round(budget.remainingBytes / 1024)}KB）`,
        )
        continue
      }
      const delivered = await deliverImageBytes({
        bytes: prepared.bytes,
        mime: prepared.mime,
        baseName,
        delivery: deps.config.avatarDelivery,
        maxBytes: inlineMax,
        maxSide: deps.config.imageMaxSide ?? 1280,
        storage: deps.storage,
        logger: deps.logger,
        linkUrl: url,
      })
      parts.push(delivered.part)
    } catch (e) {
      failed++
      deps.logger.debug(`空间图片加载失败：${url}（${e instanceof Error ? e.message : String(e)}）`)
    }
  }
  return { parts, failed, skipped }
}

export const qzoneToolDefs: Record<string, (deps: ToolDeps) => ChatLunaTool> = {
  qzone_feeds: (deps) => ({
    description: '你能看到的 QQ 空间好友动态',
    selector: () => true,
    authorization: onebotAuthorization,
    meta: toolMeta(['qzone', 'feed']),
    createTool: () =>
      tool(
        async (input: { count?: number; more?: string }, runConfig): Promise<any> => {
          const session = sessionFrom(runConfig)
          const cfg = deps.config.qzone
          const count = clampCount(input.count ?? cfg.count, cfg.count, Math.min(cfg.max, 50))
          const cursor = String(input.more ?? '').trim()

          const res = await qzoneCall<NapQzoneFeedsResult>({
            deps,
            session,
            action: 'get_qzone_feeds',
            params: cursor ? { count, cursor } : { page_num: 1, count },
            label: '朋友们的空间动态',
            cacheKey: cursor ? undefined : `qzone:feeds:${session?.selfId ?? ''}:${count}`,
          })
          if (!res.ok) {
            if (res.expired) return '刚才那一页朋友动态放太久，我这边已经翻不回去了——我重新从最新的一页看起吧。'
            return res.error.includes('不支持') ? res.error + UNSUPPORTED_HINT : res.error
          }

          const feeds = Array.isArray(res.data?.feeds) ? res.data!.feeds! : []
          const cutoff = recentCutoff(deps)
          const days = ageLimitDays(deps)
          const allItems = feeds.map((raw, i) => normalizeFeedItem(raw, i + 1))
          // 只保留时间窗内的条目；列表是倒序的，一旦出现超期条目，后面的只会更早，不再翻页
          const items = allItems.filter((item) => !olderThan(item.time, cutoff))
          const dropped = allItems.length - items.length
          const tooOldOnly = items.length === 0 && dropped > 0

          if (items.length === 0) {
            return tooOldOnly
              ? `朋友们最近 ${days} 天没有发新动态（更早的我就不翻了）。`
              : '这会儿朋友们的空间里没有什么新动态。'
          }

          saveSnapshot(snapshotKey(session), {
            title: '朋友们的动态',
            items,
            cursor:
              dropped === 0 && res.data?.has_more && typeof res.data?.next_cursor === 'string'
                ? res.data.next_cursor
                : undefined,
          })

          const lines = [`朋友们最近的空间动态（新的在前，显示 ${items.length} 条）：`]
          for (const item of items) lines.push(listLine(item))
          if (dropped > 0) {
            lines.push(`更早的动态超过 ${days} 天了，就不往下翻了。`)
          } else if (res.data?.has_more && res.data?.next_cursor) {
            lines.push(`再往前还有更早的动态，带 more=${res.data.next_cursor} 接着翻。`)
          }
          lines.push('想看哪一条的全部内容和评论，带上 index=序号 再翻一次。')
          lines.push(`- ${PERCEPTION_NOTE}。`)
          return lines.join('\n')
        },
        {
          name: 'qzone_feeds',
          description: [
            '你能看到朋友们最近在 QQ 空间里发的动态（新的在前，带序号）。',
            '',
            '当有人问"朋友们最近发了什么""空间里有什么新鲜事"时使用。',
            '- 不传参数：看最新一页。',
            '- 带 more：接着往前翻更早的一页（more 用上一次结果末尾给的值）。',
            '- 想看某一条的全文和评论：带上那条的 index 再翻一次。',
            ...(ageLimitDays(deps) > 0 ? [`- 只看最近 ${ageLimitDays(deps)} 天内的动态，更早的翻不到。`] : []),
            `- ${PERCEPTION_NOTE}。`,
          ].join('\n'),
          schema: z.object({
            count: z.number().int().min(1).max(50).optional().describe('这次看几条（默认按配置，最多 50）'),
            more: z.string().optional().describe('更早一页的分页标记（上一次结果里给过）'),
          }),
        },
      ),
  }),

  qzone_posts: (deps) => ({
    description: '你能看到的某人（或自己）的空间说说',
    selector: () => true,
    authorization: onebotAuthorization,
    meta: toolMeta(['qzone', 'post']),
    createTool: () =>
      tool(
        async (input: { user_id?: string; mine?: boolean; count?: number; offset?: number }, runConfig): Promise<any> => {
          const session = sessionFrom(runConfig)
          const cfg = deps.config.qzone
          const target = resolveTarget(session, input)
          if (target.error) return target.error

          const count = clampCount(input.count ?? cfg.count, cfg.count, Math.min(cfg.max, 100))
          const offset = Math.max(0, Math.min(Math.floor(input.offset ?? 0), 2000))

          const res = await qzoneCall<NapQzoneMsgListResult>({
            deps,
            session,
            action: 'get_qzone_msg_list',
            params: {
              ...(target.uin ? { target_uin: target.uin } : {}),
              pos: offset,
              num: count,
            },
            label: target.uin ? `${target.uin} 的空间说说` : '我自己空间的说说',
            cacheKey: `qzone:posts:${session?.selfId ?? ''}:${target.uin ?? 'self'}:${offset}:${count}`,
          })
          if (!res.ok) return res.error.includes('不支持') ? res.error + UNSUPPORTED_HINT : res.error

          const rawList = Array.isArray(res.data?.msglist) ? res.data!.msglist! : []
          const cutoff = recentCutoff(deps)
          const days = ageLimitDays(deps)
          const allItems = rawList.map((raw, i) => normalizePostItem(raw, i + 1, target.uin, '我'))
          // 只保留时间窗内的条目（重新编号，保证 index 与快照一致）
          const kept = allItems.filter((item) => !olderThan(item.time, cutoff))
          const items = kept.map((item, i) => ({ ...item, index: i + 1 }))
          const dropped = allItems.length - items.length
          const tooOldOnly = items.length === 0 && dropped > 0

          if (items.length === 0) {
            if (tooOldOnly) {
              return `${target.uin ? `${target.uin} 的空间` : '我的空间'}里，最近 ${days} 天没有新的说说了（更早的我就不翻了）。`
            }
            return offset > 0
              ? '再往前就没有更早的说说了。'
              : `${target.uin ? `${target.uin} 的空间` : '我的空间'}里还没有说说。`
          }

          const total = countOf(res.data?.total)
          // 翻页游标按「接口原始条数」推进，不能按过滤后的条数（否则会漏页）
          const nextOffset = offset + rawList.length
          const canPage = dropped === 0 && total !== undefined && nextOffset < total
          saveSnapshot(snapshotKey(session), {
            title: target.uin ? `${target.uin} 的说说` : '我的说说',
            items,
            nextOffset: canPage ? nextOffset : undefined,
            targetUin: target.uin,
          })

          const head = target.uin ? `${target.uin} 的空间说说` : '我自己的空间说说'
          const totalText = total !== undefined && dropped === 0 ? ` / 共 ${total} 条` : ''
          const lines = [`${head}（新的在前，这次显示 ${items.length} 条${totalText}）：`]
          for (const item of items) lines.push(listLine(item))
          if (dropped > 0) {
            lines.push(`更早的说说超过 ${days} 天了，就不往下翻了。`)
          } else if (canPage) {
            lines.push(`还有更早的 ${total! - nextOffset} 条，带 offset=${nextOffset} 接着看。`)
          }
          lines.push('想看哪一条的全部内容和评论，带上 index=序号 再翻一次。')
          lines.push(`- ${PERCEPTION_NOTE}。`)
          return lines.join('\n')
        },
        {
          name: 'qzone_posts',
          description: [
            '你能看到某个人（或者你自己）在 QQ 空间里发过的说说，新的在前、带序号。',
            '',
            '当有人问"你最近发了什么""看看他的空间""翻翻上个月的说"时使用。',
            '- 不传 user_id：看此刻正在跟你说话的那个人的空间。',
            '- mine=true：看你自己（bot 这个号）的空间。',
            '- 传 user_id：看指定 QQ 号的空间。',
            '- 带 offset：往后翻更早的说说（offset 用上一次结果末尾给的值）。',
            '- 想看某一条的全文和评论：带上那条的 index 再翻一次。',
            ...(ageLimitDays(deps) > 0 ? [`- 只看最近 ${ageLimitDays(deps)} 天内的说说，更早的翻不到。`] : []),
            `- ${PERCEPTION_NOTE}。`,
          ].join('\n'),
          schema: z.object({
            user_id: z.string().optional().describe('要看谁的空间（QQ 号）；留空就是当前说话的人'),
            mine: z.boolean().optional().describe('true = 看我自己（bot）的空间'),
            count: z.number().int().min(1).max(100).optional().describe('这次看几条（默认按配置，最多 100）'),
            offset: z.number().int().min(0).optional().describe('从第几条开始（默认 0，往后翻时用上一次给的值）'),
          }),
        },
      ),
  }),

  qzone_post_detail: (deps) => ({
    description: '某一条空间说说的全文与评论',
    selector: () => true,
    authorization: onebotAuthorization,
    meta: toolMeta(['qzone', 'post', 'detail']),
    createTool: () =>
      tool(
        async (
          input: { index?: number; tid?: string; user_id?: string; mine?: boolean; comments?: number; images?: number },
          runConfig,
        ): Promise<any> => {
          const session = sessionFrom(runConfig)
          const cfg = deps.config.qzone
          const key = snapshotKey(session)
          let tid = String(input.tid ?? '').trim()
          let targetUin: string | undefined
          let cached: QzoneListItem | undefined

          if (input.index !== undefined) {
            const index = Math.floor(input.index)
            const snap = loadSnapshot(key)
            if (!snap) {
              return '刚才那份列表我这边已经不记得了（放太久或者换了个会话）——再说一次要看谁的空间，我重新看一遍。'
            }
            cached = snap.items.find((item) => item.index === index)
            if (!cached) {
              return `刚才那份列表里没有第 ${index} 条（一共 ${snap.items.length} 条，从 1 开始编号）。`
            }
            tid = cached.tid ?? ''
            targetUin = cached.targetUin
            if (!tid) {
              return '这一条我打不开全文——可能是转发或者特殊类型的内容，我只能看到列表里的那一行。'
            }
          } else if (tid) {
            // 直接给 tid 时，target_uin 决定去哪片空间找这条说说
            const target = resolveTarget(session, input)
            if (target.error) return target.error
            targetUin = target.uin
          }

          if (!tid) {
            return '要看哪一条呢？可以先看朋友们的动态或者某人的说说列表，再用列表里的编号让我打开。'
          }

          const wantComments = clampCount(input.comments ?? cfg.detailOptions?.commentCount ?? 20, cfg.detailOptions?.commentCount ?? 20, 50)
          const res = await qzoneCall<NapQzoneDetail>({
            deps,
            session,
            action: 'get_qzone_msg_detail',
            params: {
              tid,
              ...(targetUin ? { target_uin: targetUin } : {}),
              pos: 0,
              num: wantComments,
            },
            label: '这条说说的内容',
            cacheKey: `qzone:detail:${session?.selfId ?? ''}:${tid}:${wantComments}`,
          })
          if (!res.ok) return res.error.includes('不支持') ? res.error + UNSUPPORTED_HINT : res.error

          const detail = res.data ?? {}
          const body = clip(
            typeof detail.content === 'string' && detail.content.trim()
              ? detail.content
              : cached?.content ?? '',
            1500,
          )

          const header = cached
            ? `第 ${cached.index} 条 · ${truncate(cached.authorName, 20)}${cached.time ? ` ${fmtTsRel(cached.time)}` : ''}`
            : '空间里的这条说说'
          const lines = [header]
          lines.push(body || '（这条没有文字）')

          const totalComments = countOf(detail.comment_num) ?? cached?.commentCount
          const comments = Array.isArray(detail.comments) ? detail.comments : []
          const imageUrls = cached?.imageUrls ?? []
          const wantImages = Math.max(0, Math.min(Math.floor(input.images ?? cfg.detailOptions?.imageLimit ?? 0), 4))

          const meta = [
            imageUrls.length > 0 ? `${imageUrls.length} 张图` : '',
            cached?.likeCount !== undefined ? `赞 ${cached.likeCount}` : '',
            totalComments !== undefined ? `评论 ${totalComments}` : '',
          ].filter(Boolean)
          if (meta.length > 0) lines.push(meta.join(' · '))

          if (comments.length > 0) {
            const shownTotal = totalComments !== undefined ? ` / 共 ${totalComments} 条` : ''
            lines.push(`评论（显示 ${comments.length}${shownTotal}）：`)
            comments.slice(0, wantComments).forEach((c, i) => {
              const name = c.name?.trim() || '某人'
              const when = c.time ? ` ${fmtTsRel(c.time)}` : ''
              lines.push(`${i + 1}. ${truncate(name, 20)}${when}：${truncate(c.content ?? '', 200)}`)
              const replies = Array.isArray(c.replies) ? c.replies : []
              for (const r of replies.slice(0, 3)) {
                const rn = r.name?.trim() || '某人'
                lines.push(`   ↳ ${truncate(rn, 16)}：${truncate(r.content ?? '', 120)}`)
              }
              if (replies.length > 3) lines.push(`   ↳ 还有 ${replies.length - 3} 条回复`)
            })
            if (totalComments !== undefined && totalComments > comments.length) {
              lines.push(`还有 ${totalComments - comments.length} 条评论这会儿没显示出来。`)
            }
          } else if (totalComments && totalComments > 0) {
            lines.push(`这条有 ${totalComments} 条评论，不过这页没有带出评论内容。`)
          }

          let parts: any[] = []
          if (wantImages > 0 && imageUrls.length > 0) {
            const picked = imageUrls.slice(0, wantImages)
            const got = await collectImages(deps, session, picked, `qzone-${tid.slice(0, 12)}`)
            parts = got.parts
            if (got.parts.length > 0) {
              lines.push(`这次看了 ${got.parts.length} 张图${got.failed ? `（${got.failed} 张没加载出来）` : ''}。`)
            } else if (got.skipped > 0) {
              lines.push(
                '这几张图我这次先不展开看了——刚才已经看过不少，再看下去这段对话就太长了；想看图的话过一会儿再说。',
              )
            } else if (got.failed > 0) {
              lines.push('这几张图这会儿都加载不出来。')
            }
            if (imageUrls.length > picked.length) lines.push(`这条还有 ${imageUrls.length - picked.length} 张图没看。`)
          }
          lines.push(`- ${PERCEPTION_NOTE}。`)

          return parts.length > 0 ? [...parts, { type: 'text', text: lines.join('\n') }] : lines.join('\n')
        },
        {
          name: 'qzone_post_detail',
          description: [
            '你能打开某一条空间说说，看到它的全文和下面的评论（含楼中楼）。',
            '',
            '当有人问"那条说说到底写了什么""底下都怎么评论的"时使用。',
            '- index：用上一次列表里的编号（最省事）。',
            '- tid + user_id：已知说说标识和作者时也可以直接打开。',
            '- images：这次想不想真的看图（默认按配置，最多 4 张）。',
            '- 列表可能放久就记不得了，那时重新看一遍列表再带编号来。',
            `- ${PERCEPTION_NOTE}。`,
          ].join('\n'),
          schema: z.object({
            index: z.number().int().min(1).optional().describe('列表里的序号（从 1 开始）'),
            tid: z.string().optional().describe('说说标识；一般用 index 就够了'),
            user_id: z.string().optional().describe('这条说说所属的 QQ 号（用 tid 直接打开时建议一起给）'),
            mine: z.boolean().optional().describe('true = 这是我自己的说说'),
            comments: z.number().int().min(1).max(50).optional().describe('这次最多看多少条评论'),
            images: z.number().int().min(0).max(4).optional().describe('这次最多看几张图（0 = 不看图）'),
          }),
        },
      ),
  }),

  qzone_profile: (deps) => ({
    description: '某个 QQ 空间的名字和说明',
    selector: () => true,
    authorization: onebotAuthorization,
    meta: toolMeta(['qzone', 'profile']),
    createTool: () =>
      tool(
        async (input: { user_id?: string; mine?: boolean }, runConfig): Promise<any> => {
          const session = sessionFrom(runConfig)
          const target = resolveTarget(session, input)
          if (target.error) return target.error

          const res = await qzoneCall<NapQzoneProfile>({
            deps,
            session,
            action: 'get_qzone_profile',
            params: target.uin ? { target_uin: target.uin } : {},
            label: '那个人的空间资料',
            cacheKey: `qzone:profile:${session?.selfId ?? ''}:${target.uin ?? 'self'}`,
          })
          if (!res.ok) return res.error.includes('不支持') ? res.error + UNSUPPORTED_HINT : res.error

          const name = res.data?.name?.trim() || ''
          const description = res.data?.description?.trim() || ''
          if (!name && !description) return '这个空间没有填名字和说明。'

          const who = target.uin ? `${target.uin} 的空间` : '我的空间'
          const lines = [`${who}：`]
          if (name) lines.push(`名字：${truncate(name, 60)}`)
          if (description) lines.push(`说明：${clip(description, 300)}`)
          lines.push(`- ${PERCEPTION_NOTE}。`)
          return lines.join('\n')
        },
        {
          name: 'qzone_profile',
          description: [
            '你能看到某个 QQ 的空间名称和空间说明。',
            '',
            '当有人问"他的空间叫什么""空间签名写了什么"时使用。',
            '- 不传 user_id：看此刻正在跟你说话的那个人。',
            '- mine=true：看你自己（bot）的空间。',
            `- ${PERCEPTION_NOTE}。`,
          ].join('\n'),
          schema: z.object({
            user_id: z.string().optional().describe('要看谁的 QQ 号；留空就是当前说话的人'),
            mine: z.boolean().optional().describe('true = 看我自己（bot）的空间'),
          }),
        },
      ),
  }),
}