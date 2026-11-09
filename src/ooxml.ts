import { inflateRawSync } from 'zlib'

// ─────────────────────────────────────────────
// 最小 OOXML 读取器（docx / pptx / xlsx 都是 zip + XML）
//
// 为什么不引第三方库：只需要读几个已知 XML，Node 自带 zlib 就够；
// 手写 zip 读取还能顺便把 zip 炸弹的上限一起做了（单条目/总量/条目数）。
// 只支持 stored(0) 与 deflate(8)，这两种覆盖所有 Office 文件。
// ─────────────────────────────────────────────

export interface ZipLimits {
  /** 最多允许多少个条目（默认 500） */
  maxEntries?: number
  /** 单个条目解压后最大字节数（默认 5MB） */
  maxEntryBytes?: number
  /** 所有条目解压后总计最大字节数（默认 10MB） */
  maxTotalBytes?: number
}

interface ZipEntry {
  method: number
  compSize: number
  uncompSize: number
  localOff: number
}

function findEocd(buf: Buffer): number {
  const start = Math.max(0, buf.length - 65_558)
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i
  }
  return -1
}

/**
 * 读出 zip 里的指定条目（惰性解压：只解压调用 read 的条目）。
 * 结构损坏 / 超出限制时抛错，由调用侧转成"这个文件读不了"。
 */
export function readZipEntries(buf: Buffer, limits: ZipLimits = {}): {
  names: () => string[]
  has: (name: string) => boolean
  read: (name: string) => Buffer | undefined
} {
  const maxEntries = limits.maxEntries ?? 500
  const maxEntryBytes = limits.maxEntryBytes ?? 5 * 1024 * 1024
  const maxTotalBytes = limits.maxTotalBytes ?? 10 * 1024 * 1024

  const eocd = findEocd(buf)
  if (eocd < 0) throw new Error('不是有效的 zip/Office 文件（找不到目录尾部）')
  const total = buf.readUInt16LE(eocd + 10)
  if (total > maxEntries) throw new Error(`文件里的条目太多（${total} > ${maxEntries}）`)
  let off = buf.readUInt32LE(eocd + 16)
  if (off <= 0 || off >= buf.length) throw new Error('不是有效的 zip/Office 文件（目录偏移异常）')

  const entries = new Map<string, ZipEntry>()
  for (let n = 0; n < total; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) throw new Error('zip 中央目录损坏')
    const method = buf.readUInt16LE(off + 10)
    const compSize = buf.readUInt32LE(off + 20)
    const uncompSize = buf.readUInt32LE(off + 24)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const localOff = buf.readUInt32LE(off + 42)
    if (off + 46 + nameLen > buf.length) throw new Error('zip 中央目录损坏')
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8')
    entries.set(name, { method, compSize, uncompSize, localOff })
    off += 46 + nameLen + extraLen + commentLen
  }

  let totalRead = 0
  const read = (name: string): Buffer | undefined => {
    const e = entries.get(name)
    if (!e) return undefined
    if (e.uncompSize > maxEntryBytes) throw new Error(`条目 ${name} 解压后太大（${e.uncompSize} 字节）`)
    totalRead += e.uncompSize
    if (totalRead > maxTotalBytes) throw new Error('文件解压后总体积超出限制')
    const lo = e.localOff
    if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== 0x04034b50) throw new Error('zip 本地头损坏')
    const nameLen = buf.readUInt16LE(lo + 26)
    const extraLen = buf.readUInt16LE(lo + 28)
    const start = lo + 30 + nameLen + extraLen
    if (start + e.compSize > buf.length) throw new Error('zip 数据越界')
    const data = buf.slice(start, start + e.compSize)
    if (e.method === 0) return data
    if (e.method !== 8) throw new Error(`不支持的 zip 压缩方式（${e.method}）`)
    return inflateRawSync(data, { maxOutputLength: maxEntryBytes }) as Buffer
  }

  return {
    names: () => [...entries.keys()],
    has: (name: string) => entries.has(name),
    read,
  }
}

// ── XML → 文本 ──

export function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      try {
        return String.fromCodePoint(parseInt(h, 16))
      } catch {
        return ''
      }
    })
    .replace(/&#(\d+);/g, (_, d) => {
      try {
        return String.fromCodePoint(Number(d))
      } catch {
        return ''
      }
    })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function stripXml(xml: string, paraTag: string, extra: (s: string) => string = (s) => s): string {
  // 先替换段落/单元格等结构标记，再统一去标签；顺序反了表格会粘成一坨
  let text = xml.replace(new RegExp(`</${paraTag}>`, 'g'), '\n')
  text = extra(text)
  text = text
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:br\/>/g, '\n')
    .replace(/<[^>]+>/g, '')
  return decodeXmlEntities(text)
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** docx → 段落 + 表格文本（单元格用制表符分隔） */
export function extractDocxText(buf: Buffer): string {
  const zip = readZipEntries(buf)
  const doc = zip.read('word/document.xml')
  if (!doc) return ''
  return stripXml(doc.toString('utf8'), 'w:p', (s) => s.replace(/<\/w:tc>/g, '\t').replace(/<\/w:tr>/g, '\n'))
}

/** pptx → 按页输出；每页文本按段落换行 */
export function extractPptxText(buf: Buffer): string {
  const zip = readZipEntries(buf)
  const slides = zip
    .names()
    .map((name) => ({ name, index: Number((name.match(/^ppt\/slides\/slide(\d+)\.xml$/) ?? [])[1] ?? 0) }))
    .filter((s) => s.index > 0)
    .sort((a, b) => a.index - b.index)
  if (slides.length === 0) return ''
  const out: string[] = []
  for (const slide of slides) {
    const xml = zip.read(slide.name)
    if (!xml) continue
    const text = stripXml(xml.toString('utf8'), 'a:p')
    if (text) out.push(`--- 第 ${slide.index} 页 ---\n${text}`)
  }
  return out.join('\n\n')
}

/** xlsx → 每个工作表按行输出（单元格用制表符分隔；只取有值的单元格） */
export function extractXlsxText(buf: Buffer): string {
  const zip = readZipEntries(buf)

  // 共享字符串表
  const shared: string[] = []
  const ss = zip.read('xl/sharedStrings.xml')
  if (ss) {
    const xml = ss.toString('utf8')
    for (const si of xml.match(/<si\b[\s\S]*?<\/si>/g) ?? []) {
      const parts = [...si.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1])
      shared.push(decodeXmlEntities(parts.join('')))
    }
  }

  const sheets = zip
    .names()
    .map((name) => ({ name, index: Number((name.match(/^xl\/worksheets\/sheet(\d+)\.xml$/) ?? [])[1] ?? 0) }))
    .filter((s) => s.index > 0)
    .sort((a, b) => a.index - b.index)

  const out: string[] = []
  for (const sheet of sheets) {
    const xmlBuf = zip.read(sheet.name)
    if (!xmlBuf) continue
    const xml = xmlBuf.toString('utf8')
    const rows: string[] = []
    for (const rowXml of xml.match(/<row\b[\s\S]*?<\/row>/g) ?? []) {
      const cells: string[] = []
      for (const c of rowXml.match(/<c\b[\s\S]*?(?:<\/c>|\/>)/g) ?? []) {
        const type = (c.match(/\bt="([^"]+)"/) ?? [])[1]
        let value = ''
        if (type === 'inlineStr') {
          value = [...c.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join('')
          value = decodeXmlEntities(value)
        } else {
          const raw = (c.match(/<v\b[^>]*>([\s\S]*?)<\/v>/) ?? [])[1]
          if (raw != null) {
            value = decodeXmlEntities(raw)
            if (type === 's') {
              const idx = Number(value)
              value = Number.isFinite(idx) ? shared[idx] ?? '' : ''
            }
          }
        }
        if (value !== '') cells.push(value)
      }
      if (cells.length > 0) rows.push(cells.join('\t'))
      if (rows.length >= 500) break
    }
    if (rows.length > 0) out.push(`--- 工作表 ${sheet.index} ---\n${rows.join('\n')}`)
  }
  return out.join('\n\n')
}