import type { Context } from 'koishi'
import type { SenseLogger } from './log'
import {
  AvatarDelivery,
  deliverImageBytes,
  downloadImageBytes,
  MinimalStorageService,
  sniffImageMime,
} from './avatar'
import { fmtTsRel, truncate } from './format'
import { NapGetImageResult, NapGroupNotice, NapNoticePic } from './napi'

// ─────────────────────────────────────────────
// 群公告：返回结构归一化 + 预览/详情两段式渲染 + 图片解析
//
// NapCat 侧的三个事实（依据 NapCatQQ 源码 packages/napcat-onebot/action/group/GetGroupNotice.ts）：
//   1. 返回的是**数组**，但「发给新成员」的公告不在 feeds 里，而在 inst 里，由 NapCat 追加到末尾
//      并打上 send_to_new_member=true —— 旧版 NapCat 不读 inst，这类公告会整个消失；
//   2. 置顶状态只有 inst 条目能读到：settings.inst_no_pinned（0=置顶，1=未置顶）；
//   3. 图片只给 { id, width, height }，**没有 URL**，必须在插件侧解析。
// ─────────────────────────────────────────────

/** 结构解包结果 */
export type UnwrapResult =
  | { ok: true; list: NapGroupNotice[] }
  | { ok: false; reason: string }

/** 兼容数组本身与 {notice|notices|data|list|result:[…]} 包装 */
export function unwrapNoticeList(data: unknown): UnwrapResult {
  if (Array.isArray(data)) return { ok: true, list: data as NapGroupNotice[] }
  if (data && typeof data === 'object') {
    for (const key of ['notice', 'notices', 'data', 'list', 'result']) {
      const value = (data as Record<string, unknown>)[key]
      if (Array.isArray(value)) return { ok: true, list: value as NapGroupNotice[] }
    }
    const keys = Object.keys(data as Record<string, unknown>)
    return { ok: false, reason: keys.length ? `对象字段为 ${keys.join('/')}，其中没有公告数组` : '返回了空对象' }
  }
  return { ok: false, reason: `返回类型为 ${data === null ? 'null' : typeof data}` }
}

/** 出问题时把原始返回的形状写进 observation，便于定位 NapCat 版本差异 */
export function describeShape(data: unknown): string {
  if (Array.isArray(data)) return `数组（${data.length} 项）`
  if (data === null) return 'null'
  if (typeof data === 'object') return `对象 {${Object.keys(data as Record<string, unknown>).join(', ')}}`
  return `${typeof data} ${String(data).slice(0, 80)}`
}

/** 取公告正文文本 */
export function noticeText(notice: NapGroupNotice): string {
  return notice?.message?.text ?? ''
}

/** 取公告图片列表（image / images 兼容，过滤掉没有 id 的占位项） */
export function noticePics(notice: NapGroupNotice): NapNoticePic[] {
  const raw = notice?.message?.image ?? notice?.message?.images ?? []
  if (!Array.isArray(raw)) return []
  return raw.filter((p): p is NapNoticePic => !!p && typeof p === 'object')
}

/** 单条公告的标记（置顶 / 发给新成员） */
export function noticeTags(notice: NapGroupNotice): string[] {
  const pinned = notice.pinned ?? (notice.settings?.inst_no_pinned === 0 ? true : undefined)
  return [
    pinned ? '置顶' : '',
    notice.send_to_new_member ? '发给新成员' : '',
  ].filter(Boolean)
}

/** 预览行：模型据此决定要看哪一条的全文 */
export function renderNoticePreview(notices: NapGroupNotice[], limit: number): string {
  const shown = notices.slice(0, limit)
  const lines = shown.map((n, idx) => {
    const tags = noticeTags(n)
    const pics = noticePics(n)
    const meta = [
      `#${idx + 1}`,
      tags.length ? `[${tags.join('][')}]` : '',
      fmtTsRel(n.publish_time),
      `发布者 ${n.sender_id}`,
      n.read_num != null ? `已读${n.read_num}` : '',
      pics.length ? `含${pics.length}张图` : '',
    ]
      .filter(Boolean)
      .join(' ')
    return `${meta} id=${n.notice_id}\n   ${truncate(noticeText(n) || '(无文字)', 80)}`
  })
  const tail =
    notices.length > shown.length
      ? `\n（共 ${notices.length} 条，这里只列出前 ${shown.length} 条；想细看某条时，带上它末尾的 id 再看一次）`
      : '\n（这些只是摘录；想细看某条的完整正文或它带的图片时，带上该条末尾的 id 再看一次）'
  return `群公告（共 ${notices.length} 条）：\n${lines.join('\n')}${tail}`
}

export interface NoticeImageContext {
  ctx: Context
  logger: SenseLogger
  delivery: AvatarDelivery
  maxBytes: number
  maxImages: number
  storage?: MinimalStorageService
}

/**
 * 解析一条公告的图片：优先直接用条目里带的地址，其次问 NapCat get_image，
 * 最后才尝试 QQ 公告图片的通用 gdynamic 地址。
 * 每个候选都要通过真实图片校验，全部失败就如实返回失败说明。
 */
async function resolveNoticeImage(
  internal: { _get(action: string, params?: Record<string, unknown>): Promise<any> } | undefined,
  pic: NapNoticePic,
  ic: NoticeImageContext,
  index: number,
): Promise<{ bytes: Uint8Array } | { error: string }> {
  const id = pic.id ? String(pic.id) : ''
  const errors: string[] = []

  // 1) 条目自带地址（某些 NapCat 扩展/版本会带）
  const direct = [pic.url, pic.src, pic.file].find((v) => typeof v === 'string' && /^https?:/i.test(v))
  if (direct) {
    try {
      return { bytes: await downloadImageBytes(ic.ctx, direct) }
    } catch (e) {
      errors.push(`自带地址失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  if (!id) return { error: '该图片条目没有 id，无法解析' }

  // 2) 让 NapCat 自己解析（能解析出 URL 或 base64 最理想）
  if (internal) {
    try {
      const res = (await internal._get('get_image', { file_id: id })) as NapGetImageResult | undefined
      if (res?.base64) {
        const bytes = new Uint8Array(Buffer.from(res.base64, 'base64'))
        if (bytes.byteLength > 0) return { bytes }
      }
      const candidate = [res?.url, res?.file].find((v) => typeof v === 'string' && /^https?:/i.test(v))
      if (candidate) {
        try {
          return { bytes: await downloadImageBytes(ic.ctx, candidate) }
        } catch (e) {
          errors.push(`get_image 地址失败：${e instanceof Error ? e.message : String(e)}`)
        }
      } else {
        errors.push('get_image 未返回可用地址')
      }
    } catch (e) {
      errors.push(`get_image 调用失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // 3) 兜底：QQ 群公告图片的通用直链形态（未获官方文档确认，靠真实图片校验兜底）
  for (const url of [
    `https://gdynamic.qpic.cn/gdynamic/${id}/0`,
    `https://gdynamic.qpic.cn/gdynamic/${id}/1`,
  ]) {
    try {
      const bytes = await downloadImageBytes(ic.ctx, url)
      if (sniffImageMime(bytes)) return { bytes }
      errors.push('兜底地址返回的不是图片')
    } catch (e) {
      errors.push(`兜底地址失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  ic.logger.debug(`公告图片 #${index + 1}（id=${id}）解析失败：${errors.join('；')}`)
  return { error: errors[0] ?? '解析失败' }
}

/**
 * 渲染单条公告的完整版：正文 + 元信息 + 图片（图片与头像走同一条交付链）。
 * 返回多模态数组或纯文本。
 */
export async function renderNoticeDetail(opts: {
  notice: NapGroupNotice
  groupId: string
  internal?: { _get(action: string, params?: Record<string, unknown>): Promise<any> }
  image: NoticeImageContext
  /** 模型是否支持图片输入（false 时只给图片说明，不取图） */
  vision: boolean | undefined
  /** 该条公告在群里的序号，仅用于文案 */
  index?: number
}): Promise<any> {
  const { notice, groupId, internal, image } = opts
  const text = noticeText(notice)
  const pics = noticePics(notice)
  const tags = noticeTags(notice)

  const head = [
    `群公告正文（群 ${groupId}${opts.index != null ? `，第 ${opts.index + 1} 条` : ''}）`,
    `id: ${notice.notice_id}`,
    `发布: ${fmtTsRel(notice.publish_time)} 发布者: ${notice.sender_id}`,
    tags.length ? `标记: ${tags.join(' ')}` : '',
    notice.read_num != null ? `已读: ${notice.read_num}` : '',
    `正文:\n${text.trim() || '(无文字内容)'}`,
  ].filter(Boolean)

  if (pics.length === 0) return head.join('\n')

  // 文末统一说明图片情况，保证模型知道"有没有图、看到没有"
  const notes: string[] = []
  const parts: any[] = []

  if (opts.vision === false) {
    head.push(`本条公告带了 ${pics.length} 张图片，但你现在看不到图（当前模型不支持图片输入），只能读到上面的文字。`)
    return head.join('\n')
  }
  if (image.maxImages <= 0) {
    head.push(`本条公告带了 ${pics.length} 张图片（当前设置下你不去看图）。`)
    return head.join('\n')
  }

  const usable = pics.slice(0, image.maxImages)
  for (const [i, pic] of usable.entries()) {
    const res = await resolveNoticeImage(internal, pic, image, i)
    if ('bytes' in res) {
      try {
        const delivered = await deliverImageBytes({
          bytes: res.bytes,
          baseName: `notice-${notice.notice_id}-${i + 1}`,
          delivery: image.delivery,
          maxBytes: image.maxBytes,
          storage: image.storage,
          logger: image.logger,
        })
        parts.push(delivered.part)
        notes.push(`第 ${i + 1} 张图你看到了（${delivered.mime}）`)
      } catch (e) {
        notes.push(`第 ${i + 1} 张图这次看不清（${e instanceof Error ? e.message : String(e)}）`)
      }
    } else {
      notes.push(`第 ${i + 1} 张图取不到（${res.error}）`)
    }
  }
  if (pics.length > usable.length) {
    notes.push(`本条一共 ${pics.length} 张图，你这次只看了前 ${usable.length} 张`)
  }

  head.push(`图片：${notes.join('；')}。`)
  const textBlock = head.join('\n')

  if (parts.length === 0) return textBlock
  return [...parts, { type: 'text', text: textBlock }]
}
