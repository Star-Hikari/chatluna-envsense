import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import type { ChatLunaTool } from 'koishi-plugin-chatluna/llm-core/platform/types'
import { deliverImageBytes, prepareInlineImage, sniffImageMime } from './avatar'
import { cachedCall, onebotAuthorization, PERCEPTION_NOTE, sessionFrom, takeImageBudget, ToolDeps, toolMeta } from './common'
import { downloadBytes, formatBytes } from './download'
import { fmtTsRel, truncate } from './format'
import { NapAlbumItem, NapAlbumMedia, rawGet, resolveGroupId } from './napi'

// ─────────────────────────────────────────────
// 群相册工具（两段式，参照 group_notices）
//
//   1) 不传 album_id → 列相册；只有一个相册时自动进入上传记录；
//   2) 传 album_id → 列上传批次（谁 / 什么时候 / 多少张 / 配文），带序号；
//   3) 传 album_id + batch → 看这一批的详情与图片（可 offset 续看）。
//
// 关于评论：NapCat 只有「发表评论」的 action，没有读取评论的 action。
// 这里会先看媒体列表里有没有 comments / comment_list 字段（决策 C：有就显示），
// 没有就只能显示评论数、不能显示内容。debug 打开时会打印媒体项字段名，方便以后确认。
//
// 频率限制：详情调用按「群 + 相册 + 会话」做冷却，防止模型连续刷图。
// ─────────────────────────────────────────────

interface AlbumEntry {
  id: string
  name: string
  cover?: string
  createTime?: number
  count?: number
}

interface AlbumComment {
  name: string
  content: string
  time?: number
}

interface MediaEntry {
  lloc?: string
  batchId?: string
  time?: number
  uploaderId: string
  uploaderName: string
  caption?: string
  url?: string
  comments: AlbumComment[]
  commentCount?: number
}

interface AlbumBatch {
  key: string
  uploaderId: string
  uploaderName: string
  time?: number
  items: MediaEntry[]
  caption?: string
  comments: AlbumComment[]
  commentCount?: number
}

const lastDetailAt = new Map<string, number>()

function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return undefined
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const v of values) {
    const n = typeof v === 'number' ? v : Number(v)
    if (Number.isFinite(n) && n > 0) return n
  }
  return undefined
}

function normalizeAlbum(raw: NapAlbumItem): AlbumEntry | undefined {
  const id = firstString(raw.album_id, raw.albumId)
  if (!id) return undefined
  return {
    id,
    name: firstString(raw.album_name, raw.albumName) ?? '未命名相册',
    cover: firstString(raw.cover_url, raw.coverUrl),
    createTime: firstNumber(raw.create_time, raw.createTime),
    count: firstNumber(raw.upload_count, raw.photo_count, raw.media_count),
  }
}

function normalizeComment(raw: any): AlbumComment | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const content = firstString(raw.content, raw.text, raw.comment, raw.msg, raw.comment_content)
  if (!content) return undefined
  const name = firstString(raw.nickname, raw.nick, raw.name, raw.user_name, raw.uin, raw.user_id) ?? '某人'
  return { name, content, time: firstNumber(raw.time, raw.create_time, raw.ctime) }
}

function commentsOf(raw: NapAlbumMedia): AlbumComment[] {
  const candidates = [
    raw.comments,
    raw.comment_list,
    (raw as any).commentList,
    (raw as any).comment_list_v2,
    (raw as any).comment?.list,
  ]
  for (const c of candidates) {
    if (!Array.isArray(c)) continue
    const list = c.map(normalizeComment).filter((x): x is AlbumComment => !!x)
    if (list.length > 0) return list
  }
  return []
}

function normalizeMedia(raw: NapAlbumMedia): MediaEntry | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const url = firstString(
    raw.url,
    raw.photo_url,
    raw.pic_url,
    raw.raw_url,
    (raw as any).photoUrl,
    (raw as any).picUrl,
    (raw as any).rawUrl,
    (raw as any).src,
  )
  const uploaderRaw = raw.uploader ?? (raw as any).uploader_uin ?? (raw as any).uin
  const uploaderId =
    typeof uploaderRaw === 'number'
      ? String(uploaderRaw)
      : firstString(uploaderRaw, raw.uploader_name, (raw as any).uploader_nick, (raw as any).nick) ?? '未知'
  const uploaderName =
    firstString(raw.uploader_name, raw.uploaderName, (raw as any).uploader_nick, (raw as any).nick) ?? uploaderId
  return {
    lloc: firstString(raw.lloc, raw.media_id, raw.mediaId),
    batchId: firstString(raw.batch_id, raw.batchId),
    time: firstNumber(raw.upload_time, raw.uploadTime),
    uploaderId,
    uploaderName,
    caption: firstString(raw.desc, raw.content, raw.text),
    url,
    comments: commentsOf(raw),
    commentCount: firstNumber(raw.comment_count, raw.commentCount),
  }
}

function dedupeComments(list: AlbumComment[]): AlbumComment[] {
  const seen = new Set<string>()
  const out: AlbumComment[] = []
  for (const c of list) {
    const key = `${c.name}\0${c.content}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(c)
  }
  return out
}

/** 把同一批上传（batch_id 相同；没有 batch_id 时按上传者 + 分钟）归组 */
export function groupAlbumBatches(media: MediaEntry[]): AlbumBatch[] {
  const map = new Map<string, AlbumBatch>()
  for (const m of media) {
    const key = m.batchId || `${m.uploaderId}|${Math.floor((m.time ?? 0) / 60)}`
    let b = map.get(key)
    if (!b) {
      b = {
        key,
        uploaderId: m.uploaderId,
        uploaderName: m.uploaderName,
        time: m.time,
        items: [],
        comments: [],
        commentCount: 0,
      }
      map.set(key, b)
    }
    b.items.push(m)
    if (m.time && (!b.time || m.time < b.time)) b.time = m.time
    if (!b.caption && m.caption) b.caption = m.caption
    b.comments.push(...m.comments)
    if (m.commentCount) b.commentCount = (b.commentCount ?? 0) + m.commentCount
  }
  for (const b of map.values()) {
    b.comments = dedupeComments(b.comments)
    b.items.sort((a, b2) => (a.time ?? 0) - (b2.time ?? 0))
  }
  return [...map.values()].sort((a, b) => (b.time ?? 0) - (a.time ?? 0))
}

function pickImages(count: number, configured: number): number {
  const max = Math.max(0, Math.min(configured, 9))
  const want = Math.floor(count)
  return Math.max(0, Math.min(Number.isFinite(want) ? want : max, max))
}

function cooldownLeft(key: string, seconds: number): number {
  const last = lastDetailAt.get(key)
  if (!last || seconds <= 0) return 0
  const left = seconds * 1000 - (Date.now() - last)
  return left > 0 ? Math.ceil(left / 1000) : 0
}

export const albumToolDefs: Record<string, (deps: ToolDeps) => ChatLunaTool> = {
  group_albums: (deps) => ({
    description: '你能看到的群相册与上传记录',
    selector: () => true,
    authorization: onebotAuthorization,
    meta: toolMeta(['group', 'album']),
    createTool: () =>
      tool(
        async (
          input: {
            group_id?: string
            album_id?: string
            batch?: number
            offset?: number
            images?: number
            more?: string
          },
          runConfig,
        ): Promise<any> => {
          const session = sessionFrom(runConfig)
          const gid = resolveGroupId(session, input.group_id)
          if (!gid) return '这会儿不在群里，我也不知道该看哪个群的相册——先告诉我群号吧。'

          const cfg = deps.config.group
          const albumId = String(input.album_id ?? '').trim()
          const more = String(input.more ?? '').trim()

          // ── 相册列表（也是拿相册名 / 单相册自动进入的依据）──
          const albumsRes = await cachedCall<{ album_list?: NapAlbumItem[] }>({
            deps,
            key: `albums:list:${gid}`,
            label: '群相册列表',
            session,
            run: (i) => rawGet(i, 'get_qun_album_list', { group_id: String(gid), attach_info: '' }),
          })
          const albums = (albumsRes.ok && Array.isArray(albumsRes.data?.album_list) ? albumsRes.data!.album_list : [])
            .map(normalizeAlbum)
            .filter((a): a is AlbumEntry => !!a)

          // 没有指定相册：列相册；只有一个就自动进入
          if (!albumId) {
            if (!albumsRes.ok) return `${albumsRes.error}（群相册这会儿打不开，可能是网络或登录状态的问题）`
            if (albums.length === 0) return `群 ${gid} 还没有相册。`
            if (albums.length > 1) {
              const lines = [`群 ${gid} 有 ${albums.length} 个相册：`]
              albums.slice(0, 10).forEach((a, i) => {
                const c = a.count ? `，共 ${a.count} 张` : ''
                const t = a.createTime ? `，创建于 ${fmtTsRel(a.createTime)}` : ''
                lines.push(`${i + 1}. 《${truncate(a.name, 30)}》${c}${t} [album_id=${a.id}]`)
              })
              if (albums.length > 10) lines.push(`……还有 ${albums.length - 10} 个相册`)
              lines.push(`想看某个相册的上传记录，带上它的 album_id 再翻一次。`)
              lines.push(`- ${PERCEPTION_NOTE}。`)
              return lines.join('\n')
            }
          }

          const selected = albumId
            ? albums.find((a) => a.id === albumId) ?? { id: albumId, name: `相册 ${albumId}` }
            : albums[0]
          if (!selected) return `群 ${gid} 还没有相册。`

          // ── 拉相册媒体 ──
          const mediaRes = await cachedCall<{ media_list?: NapAlbumMedia[]; attach_info?: string; has_more?: boolean }>({
            deps,
            key: `albums:media:${gid}:${selected.id}:${more}`,
            label: '相册媒体',
            session,
            run: (i) =>
              rawGet(i, 'get_group_album_media_list', {
                group_id: String(gid),
                album_id: selected.id,
                attach_info: more,
              }),
          })
          if (!mediaRes.ok) return `${mediaRes.error}（相册可能已经被删了，或者这会儿加载不出来）`
          const rawMedia = Array.isArray(mediaRes.data?.media_list) ? mediaRes.data!.media_list : []
          if (deps.config.debug && rawMedia[0]) {
            deps.logger.debug(`相册媒体字段：${Object.keys(rawMedia[0]).join(', ')}`)
          }
          const media = rawMedia.map(normalizeMedia).filter((m): m is MediaEntry => !!m)
          const batches = groupAlbumBatches(media)
          if (batches.length === 0) return `《${truncate(selected.name, 30)}》里还没有照片。`

          // ── 看某一批详情 ──
          if (input.batch != null) {
            const index = Math.floor(input.batch) - 1
            const batch = batches[index]
            if (!batch) {
              return `没有第 ${input.batch} 批；《${truncate(selected.name, 30)}》当前列表里只有 ${batches.length} 批（新的在前，从 1 开始编号）。`
            }

            // 冷却只拦"真的要看图"的重复调用；编号写错不消耗冷却
            const key = `${session?.platform ?? 'onebot'}:${session?.selfId ?? ''}:${gid}:${selected.id}`
            const left = cooldownLeft(key, cfg.albumCooldownSeconds || 0)
            if (left > 0) {
              return `这批相册的详情我刚刚才翻过一遍，等 ${left} 秒才能再看（翻太快我会看不过来）。`
            }
            lastDetailAt.set(key, Date.now())
            if (lastDetailAt.size > 500) lastDetailAt.clear()

            const want = pickImages(input.images ?? cfg.albumImageLimit ?? 3, cfg.albumImageLimit ?? 3)
            const offset = Math.max(0, Math.min(Math.floor(input.offset ?? 0), batch.items.length))
            const slice = batch.items.slice(offset, offset + want)
            // 2026-11-02：相册曾经也按 4MB 内联，和空间一样会把历史撑爆。
            // 现在统一：单张压到 imageMaxKb，再受会话图片预算约束。
            const inlineMax = Math.max(64, deps.config.imageMaxKb ?? 512) * 1024
            const downloadMax = Math.max(inlineMax, 8 * 1024 * 1024)

            const parts: any[] = []
            const failed: string[] = []
            let skipped = 0
            for (const item of slice) {
              if (!item.url) {
                failed.push('有一张没能加载出来')
                continue
              }
              try {
                const raw = await downloadBytes(deps.ctx, item.url, downloadMax)
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
                    `相册图片跳过内联：本会话已用满图片预算（剩余 ${Math.round(budget.remainingBytes / 1024)}KB）`,
                  )
                  continue
                }
                const delivered = await deliverImageBytes({
                  bytes: prepared.bytes,
                  mime: prepared.mime,
                  baseName: `album-${gid}-${selected.id}`,
                  delivery: deps.config.avatarDelivery,
                  maxBytes: inlineMax,
                  maxSide: deps.config.imageMaxSide ?? 1280,
                  storage: deps.storage,
                  logger: deps.logger,
                  linkUrl: item.url,
                })
                parts.push(delivered.part)
              } catch (e) {
                failed.push(e instanceof Error ? e.message : String(e))
              }
            }

            const head = `第 ${input.batch} 批：${truncate(batch.uploaderName, 20)}${batch.time ? ` 于 ${fmtTsRel(batch.time)}` : ''} 上传了 ${batch.items.length} 张`
            const lines = [head]
            if (batch.caption) lines.push(`配文：${truncate(batch.caption, 300)}`)
            if (batch.comments.length > 0) {
              lines.push(`评论（${batch.comments.length} 条）：`)
              batch.comments.slice(0, 10).forEach((c, i) => {
                lines.push(`${i + 1}. ${truncate(c.name, 20)}：${truncate(c.content, 120)}`)
              })
              if (batch.comments.length > 10) lines.push(`……还有 ${batch.comments.length - 10} 条评论`)
            } else if (batch.commentCount && batch.commentCount > 0) {
              lines.push(`评论有 ${batch.commentCount} 条，不过我这边没加载出评论内容，只数得出有多少条。`)
            }

            const shownFrom = offset + 1
            const shownTo = offset + slice.length
            if (slice.length > 0) lines.push(`图片：第 ${shownFrom}-${shownTo} 张 / 共 ${batch.items.length} 张`)
            if (offset + slice.length < batch.items.length) {
              lines.push(`这一批还有 ${batch.items.length - offset - slice.length} 张没看，想接着看就带 offset=${offset + slice.length} 往后翻。`)
            }
            if (failed.length > 0) lines.push(`有 ${failed.length} 张图片这会儿加载不出来（${truncate(failed[0], 80)}）`)
            if (skipped > 0) {
              lines.push(`另外 ${skipped} 张我这次先不展开看了——刚才已经看过不少，再看下去这段对话就太长了；过一会儿再看也行。`)
            }
            if (parts.length === 0 && skipped === 0) lines.push('这次一张图都没能看到。')
            lines.push(`- ${PERCEPTION_NOTE}。`)

            return parts.length > 0 ? [...parts, { type: 'text', text: lines.join('\n') }] : lines.join('\n')
          }

          // ── 上传批次概览 ──
          const limit = Math.max(1, Math.min(cfg.albumBatchLimit || 20, 100))
          const show = batches.slice(0, limit)
          const lines = [
            `《${truncate(selected.name, 30)}》这一页有 ${batches.length} 个上传批次（新的在前，显示前 ${show.length} 个）：`,
          ]
          show.forEach((b, i) => {
            const when = b.time ? ` ${fmtTsRel(b.time)}` : ''
            const caption = b.caption ? `：${truncate(b.caption, 60)}` : ''
            const comments = b.comments.length > 0 ? `（评论 ${b.comments.length} 条）` : b.commentCount ? `（评论 ${b.commentCount} 条）` : ''
            lines.push(`${i + 1}. ${truncate(b.uploaderName, 20)}${when} 上传了 ${b.items.length} 张${caption}${comments}`)
          })
          if (batches.length > show.length) {
            lines.push(`……还有 ${batches.length - show.length} 个更早的批次没列出来`)
          }
          if (mediaRes.data?.has_more && mediaRes.data?.attach_info) {
            lines.push(`想看更早的批次，带 more=${mediaRes.data.attach_info} 继续往前翻。`)
          }
          const moreHint = more ? `&more=${more}` : ''
          lines.push(`要看第几批的详情和图片，带上 album_id=${selected.id}${moreHint}&batch=序号 再翻一次。`)
          lines.push(`- ${PERCEPTION_NOTE}。`)
          return lines.join('\n')
        },
        {
          name: 'group_albums',
          description: [
            '你能看到这个群的相册：有哪些相册，以及每个相册里「谁在什么时候上传了多少张照片、配文是什么」。',
            '选中某一批照片后，你还能看到图片本身和读得到的评论。',
            '',
            '当有人问"群相册里有什么""最近谁传了照片""看看那张图"时使用。',
            '- 不传 album_id：先列相册；群里只有一个相册时会直接进入上传记录。',
            '- 传 album_id：列出这个相册的上传批次（新的在前，带序号）。',
            '- 传 album_id + batch：看第 N 批的详情和图片；图片多时带 offset 继续往后翻。',
            '- 同一批详情刚翻过会缓一会儿，别连着猛翻。',
            `- ${PERCEPTION_NOTE}。`,
          ].join('\n'),
          schema: z.object({
            group_id: z.string().optional().describe('群号；留空就是当前会话所在的群'),
            album_id: z.string().optional().describe('相册 ID；留空先列相册'),
            batch: z.number().int().min(1).optional().describe('要看第几批上传（从 1 开始，新的在前）'),
            offset: z.number().int().min(0).optional().describe('从这一批的第几张开始看（默认 0）'),
            images: z.number().int().min(0).max(9).optional().describe('这次最多取几张图（默认按配置）'),
            more: z.string().optional().describe('更早批次的分页标记（上一次结果里给过）'),
          }),
        },
      ),
  }),
}