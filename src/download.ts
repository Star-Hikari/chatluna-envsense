// ─────────────────────────────────────────────
// 通用下载 / 体积格式化（群文件、群相册共用）
// ─────────────────────────────────────────────

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const DOWNLOAD_TIMEOUT_MS = 30_000

export function formatBytes(n: number | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return '大小未知'
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(1)}GB`
}

/**
 * 下载任意文件字节（群文件 / 相册图共用）。
 * 先下后校验大小：QQ 的 CDN 不一定回 content-length，HEAD 也不一定支持，
 * 所以用「下载后超限即丢弃」的保守策略；上限由调用侧按配置传入。
 */
export async function downloadBytes(ctx: any, url: string, maxBytes: number): Promise<Buffer> {
  const raw = (await ctx.http.get(url, {
    responseType: 'arraybuffer' as const,
    headers: { 'User-Agent': BROWSER_UA, Accept: '*/*' },
    timeout: DOWNLOAD_TIMEOUT_MS,
  })) as unknown as ArrayBuffer
  const buf = Buffer.from(raw instanceof ArrayBuffer ? new Uint8Array(raw) : (raw as any))
  if (buf.length === 0) throw new Error('文件内容为空')
  if (buf.length > maxBytes) {
    throw new Error(`文件太大（${formatBytes(buf.length)} > ${formatBytes(maxBytes)}），没有下载`)
  }
  return buf
}