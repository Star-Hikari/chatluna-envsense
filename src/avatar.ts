import type { Context } from 'koishi'
import type { SenseLogger } from './log'

// ─────────────────────────────────────────────
// 图片获取/交付层（群头像、用户头像、群公告图片共用）
//
// 为什么不能直接把外链交给模型：
//   1. qlogo 直链的扩展名是接口路径（headimg_dl / 600），chatluna 侧按扩展名猜 mime 会得到
//      image/* 之外的兜底值，转 data URI 后部分供应商拒收；
//   2. 部分供应商网关不主动抓取外链，模型实际收到的是空内容（"看不到图片"）；
//   3. 群公告图片根本没有直链（NapCat 只给 {id,w,h}），必须在插件侧解析。
// 因此本层统一：拿到字节 → 魔数嗅探真实 mime → 校验确实是图片 → 交付：
//   storage：经 chatluna_storage 转存成带正确扩展名的临时文件（供应商需能访问该地址）
//   inline ：data:image/xxx;base64 直接内联（不依赖任何外部抓取，默认）
// 对齐 chatluna 自身处理消息图片的做法（index.cjs 的 img 拦截器）与 livingdiary 的
// prepareInteractionMedia（storage 失败即降级 base64）。
// ─────────────────────────────────────────────

/** chatluna_storage 服务的最小结构面（未安装 storage 插件时为 undefined） */
export interface MinimalStorageService {
  createTempFile(
    buffer: Buffer,
    filename: string,
    expireHours?: number,
    mimeType?: string,
  ): Promise<{ url: string }>
}

/** 图片交付方式 */
export type AvatarDelivery = 'storage' | 'inline' | 'link'

/** 单张图片允许内联给模型的最大字节数（base64 编码后约 1.33 倍） */
export const MAX_INLINE_IMAGE_BYTES = 1.5 * 1024 * 1024

const DOWNLOAD_TIMEOUT_MS = 15_000
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** 魔数探测图片真实类型（外链没有可信扩展名，只能看字节） */
export function sniffImageMime(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png'
  }
  if (bytes.length >= 6) {
    const head = String.fromCharCode(...bytes.slice(0, 6))
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif'
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  ) {
    return 'image/webp'
  }
  return undefined
}

/** 明显不是图片（HTML/JSON 错误页）：绝不能当图片交给模型 */
export function looksLikeNonImage(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.slice(0, 200)).toString('utf8').trimStart().toLowerCase()
  return head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('{') || head.startsWith('[')
}

/** mime → 文件扩展名（存临时文件时用，确保 storage URL 带正确扩展名） */
export function imageExtension(mime: string): string {
  if (mime === 'image/jpeg') return 'jpg'
  return mime.split('/')[1] || 'bin'
}

export function imageDataUrl(bytes: Uint8Array, mime: string): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`
}

/** 回环/内网地址判定：这类地址远程模型供应商抓不到，只能靠 base64 内联 */
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '0.0.0.0' ||
      host.startsWith('192.168.') ||
      host.startsWith('10.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    )
  } catch {
    return false
  }
}

// ─────────────────────────────────────────────
// qlogo 地址构造
//
// 实测（2026-10-15）：qlogo 只接受固定几档尺寸，其余一律 **HTTP 400 且返回空 body**：
//   0 = 原图 / 40 / 100 / 140 / 640  ✅
//   160 / 200 / 300 / 500 / 600 / 800 ❌
// 之前群头像误用了 /600，于是每次取图都 400、工具只能报"取不到"。
// 这里给出合法档位并按用户偏好排序，配置填了非法值也能自动兜底到可用档位。
// ─────────────────────────────────────────────

/** qlogo 可用尺寸（从大到小） */
export const QLOGO_SIZES = [640, 140, 100, 40, 0] as const

function candidateSizes(preferred: number): number[] {
  const all = [preferred, ...QLOGO_SIZES].filter((s) => Number.isFinite(s) && s >= 0)
  return [...new Set(all)]
}

/** 群头像候选地址（按优先级，取第一个能下到的） */
export function groupAvatarUrls(groupId: string | number, preferred = 640): string[] {
  return candidateSizes(preferred).map(
    (s) => `https://p.qlogo.cn/gh/${groupId}/${groupId}/${s}`,
  )
}

/** 用户头像候选地址（按优先级，取第一个能下到的） */
export function userAvatarUrls(userId: string | number, preferred = 640): string[] {
  return candidateSizes(preferred).map(
    (s) => `https://q.qlogo.cn/headimg_dl?dst_uin=${userId}&spec=${s}`,
  )
}

/** 下载图片字节并校验（空内容 / 错误页一律抛错，避免把垃圾塞给模型） */
export async function downloadImageBytes(ctx: Context, url: string): Promise<Uint8Array> {
  const raw = (await ctx.http.get(url, {
    responseType: 'arraybuffer' as const,
    headers: { 'User-Agent': BROWSER_UA, Accept: 'image/*,*/*' },
    timeout: DOWNLOAD_TIMEOUT_MS,
  })) as unknown as ArrayBuffer
  const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw as any)
  if (!bytes || bytes.byteLength === 0) throw new Error('图片内容为空')
  if (looksLikeNonImage(bytes)) throw new Error('接口返回的不是图片内容（可能是错误页/鉴权页）')
  return bytes
}

export interface DeliveredImage {
  /** 交给模型的内容块 */
  part: { type: 'image_url'; image_url: { url: string } }
  mime: string
  bytes: number
  /** 实际交付通道：storage=临时文件 URL / inline=base64 data URI */
  via: 'storage' | 'inline'
  /** 提示文本：说明 via / 降级原因，模型可据此在回复里给出可点链接 */
  note: string
}

export interface DeliverImageOptions {
  bytes: Uint8Array
  mime?: string
  /** 临时文件命名主体（不含扩展名），如 group-216914030 / notice-xxx-1 */
  baseName: string
  delivery: AvatarDelivery
  /** base64 内联时的字节上限（默认 MAX_INLINE_IMAGE_BYTES） */
  maxBytes?: number
  storage?: MinimalStorageService
  logger?: SenseLogger
  /** link 模式下回填给模型的原始地址 */
  linkUrl?: string
}

/**
 * 把已有的图片字节交给模型（头像与公告图片共用这条交付链）。
 * 任一步失败抛错，由调用侧降级为文本说明。
 */
export async function deliverImageBytes(opts: DeliverImageOptions): Promise<DeliveredImage> {
  const { bytes, baseName, delivery, storage, logger } = opts
  const mime = opts.mime ?? sniffImageMime(bytes) ?? 'image/jpeg'
  const size = bytes.byteLength

  if (delivery === 'link') {
    const url = opts.linkUrl ?? ''
    return {
      part: { type: 'image_url', image_url: { url } },
      mime,
      bytes: size,
      via: 'inline',
      note: url ? `（图片直链 ${url}）` : '（未提供直链）',
    }
  }

  // storage：落成临时文件（URL 自带正确扩展名，chatluna 据此判 mime）。
  // 注意 storage 的默认 serverPath 是 http://127.0.0.1:5140 —— 远程模型供应商取不到，
  // 所以默认走 base64 内联；本分支只在用户显式选择 storage 且服务就绪时使用。
  if (delivery === 'storage') {
    if (storage) {
      try {
        const file = await storage.createTempFile(
          Buffer.from(bytes),
          `${baseName}.${imageExtension(mime)}`,
          24,
          mime,
        )
        if (file?.url) {
          if (isLoopbackUrl(file.url)) {
            logger?.warn?.(
              `chatluna_storage 返回的地址 ${file.url} 是本机回环地址，远程模型供应商无法抓取；` +
                `如需走存储地址请在 chatluna-storage-service 里把 serverPath 配成公网地址，或改用 avatarDelivery=inline`,
            )
          }
          return {
            part: { type: 'image_url', image_url: { url: file.url } },
            mime,
            bytes: size,
            via: 'storage',
            note: `（图片已转存到 chatluna_storage：${file.url}）`,
          }
        }
      } catch (e) {
        logger?.warn?.(`图片转存 chatluna_storage 失败，改用 base64 内联：${e instanceof Error ? e.message : String(e)}`)
      }
    } else {
      logger?.info?.('未安装 chatluna-storage-service，图片将以 base64 内联方式交给模型')
    }
  }

  // 兜底（或显式 inline）：base64 内联，供应商无需抓取任何外部地址
  const maxBytes = opts.maxBytes ?? MAX_INLINE_IMAGE_BYTES
  if (size > maxBytes) {
    throw new Error(
      `图片过大（${Math.round(size / 1024)}KB > ${Math.round(maxBytes / 1024)}KB），无法内联给模型`,
    )
  }
  return {
    part: { type: 'image_url', image_url: { url: imageDataUrl(bytes, mime) } },
    mime,
    bytes: size,
    via: 'inline',
    note: '（图片以 base64 内联方式随本次对话直接提交给模型，无需外部抓取）',
  }
}

export interface LoadAvatarOptions {
  ctx: Context
  url: string
  /** 用于临时文件命名的文件名主体（不含扩展名），如 group-216914030 */
  baseName: string
  delivery: AvatarDelivery
  maxBytes?: number
  storage?: MinimalStorageService
  logger?: SenseLogger
}

/** 取回一张网络图片并转成可直接交给模型的 observation 内容块 */
export async function loadAvatarImage(opts: LoadAvatarOptions): Promise<DeliveredImage> {
  const { ctx, url, logger } = opts
  let bytes: Uint8Array
  try {
    bytes = await downloadImageBytes(ctx, url)
  } catch (e) {
    logger?.warn?.(`图片下载失败：${url}（${e instanceof Error ? e.message : String(e)}）`)
    throw e
  }
  return deliverImageBytes({
    bytes,
    baseName: opts.baseName,
    delivery: opts.delivery,
    maxBytes: opts.maxBytes,
    storage: opts.storage,
    logger: opts.logger,
    linkUrl: url,
  })
}

/** 模型明确不支持视觉时的统一话术（保留直链，方便用户自行点开看） */
export function unsupportedVisionText(what: string, url: string): string {
  return (
    `我现在看不到图片（当前模型不支持图片输入），所以没法评价${what}。` +
    `别假装看到了：告诉用户换个能看图的模型，或者把图片直接发到会话里。`
  )
}
