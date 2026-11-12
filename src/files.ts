import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import type { ChatLunaTool } from 'koishi-plugin-chatluna/llm-core/platform/types'
import { deliverImageBytes, prepareInlineImage, sniffImageMime } from './avatar'
import { cachedCall, onebotAuthorization, PERCEPTION_NOTE, sessionFrom, takeImageBudget, ToolDeps, toolMeta } from './common'
import { downloadBytes, formatBytes } from './download'
import { fmtTsRel, truncate } from './format'
import { extractDocxText, extractPptxText, extractXlsxText } from './ooxml'
import { callApi, NapGroupFile, NapGroupFileList, NapGroupFileSystemInfo, rawGet, resolveGroupId } from './napi'

// ─────────────────────────────────────────────
// 群文件工具
//
// 两段式：
//   1) 不传 file_id → 列目录（文件夹 + 文件元数据）；
//   2) 传 file_id + file_name → 下载并（在允许时）解析内容。
//
// 配置层级：
//   group.files          —— 工具总开关
//   group.fileListOnly   —— 只显示文件列表（默认开；这是前提）
//   group.fileParse      —— 尝试解析文件内容（默认关；只在 fileListOnly=false 后生效）
//
// 解析范围：txt/md/json/csv/log/xml/yaml/html + docx/pptx/xlsx + 图片；
// pdf 不解析正文（只给下载链接）；其它格式只给元数据。
// ─────────────────────────────────────────────

const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'json', 'csv', 'log', 'xml', 'yml', 'yaml', 'html', 'htm', 'ini', 'conf', 'tsv',
])
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'])
const MAX_CHARS_HARD = 100_000

function extOf(name: string): string {
  const base = String(name).split(/[\\/]/).pop() ?? ''
  const idx = base.lastIndexOf('.')
  return idx >= 0 ? base.slice(idx + 1).toLowerCase() : ''
}

/** 明显是二进制（含 NUL）就不按文本解析 */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4096)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

function decodeText(buf: Buffer): string {
  return buf
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
}

export const fileToolDefs: Record<string, (deps: ToolDeps) => ChatLunaTool> = {
  group_files: (deps) => ({
    description: '你能看到的群文件列表与内容',
    selector: () => true,
    authorization: onebotAuthorization,
    meta: toolMeta(['group', 'file']),
    createTool: () =>
      tool(
        async (
          input: {
            group_id?: string
            folder_id?: string
            file_id?: string
            file_name?: string
            busid?: number
            limit?: number
          },
          runConfig,
        ): Promise<any> => {
          const session = sessionFrom(runConfig)
          const gid = resolveGroupId(session, input.group_id)
          if (!gid) return '这会儿不在群里，我也不知道该看哪个群——先告诉我群号吧。'
          const cfg = deps.config.group
          const limit = Math.max(1, Math.min(Math.floor(input.limit ?? 50), 200))

          // ── 读取单个文件 ──
          if (input.file_id) {
            if ((cfg.fileOptions?.listOnly ?? true)) {
              return '当前网络不好，文件的具体内容暂时没有加载出来呢，我只能看到文件列表（名字、大小、谁传的）。'
            }
            if (!(cfg.fileOptions?.parse ?? false)) {
              return '当前网络不好，暂时没有加载出文件具体内容呢，我只能先看到文件名、大小这些信息。'
            }
            const fileId = String(input.file_id).trim()
            const fileName = String(input.file_name ?? '').trim()
            if (!fileId) return '没带上文件 ID，我不知道要翻开哪一个。'
            if (!fileName) return '要翻开这个文件，得把列表里的 file_name 一起带上——不然我不知道它是什么类型。'

            const urlRes = await callApi<string>({
              session,
              label: '群文件链接',
              logger: deps.logger,
              limiter: deps.limiter,
              run: (i) => i.getGroupFileUrl(gid, fileId, input.busid),
            })
            if (!urlRes.ok) return `${urlRes.error}（可能文件已被删除，或链接已过期）`
            const url = String(urlRes.data ?? '').trim()
            if (!url) return '这个文件我没能打开（可能已经被删了，或者链接过期了）。'

            const maxBytes = Math.max(64, cfg.fileOptions?.maxKb ?? 8192) * 1024
            let bytes: Buffer
            try {
              bytes = await downloadBytes(deps.ctx, url, maxBytes)
            } catch (e) {
              const reason = e instanceof Error ? e.message : String(e)
              deps.logger.warn(`群文件下载失败：${fileName}（${reason}）`)
              return `这个文件这会儿下载不下来（${reason}），等会儿可以再试试。链接：${url}`
            }

            const ext = extOf(fileName)
            const meta = `文件：${truncate(fileName, 80)}（${formatBytes(bytes.length)}）`

            // 图片：走现有图片交付链（模型支持视觉时直接看图）
            const sniffed = sniffImageMime(bytes)
            if (IMAGE_EXT.has(ext) || sniffed) {
              if (!sniffed) return `${meta}打开后不是一张正常的图，我没能看清它的内容。链接：${url}`
              try {
                // 2026-11-02：不再用 4MB 直塞。先压到单张上限，再受会话图片预算约束。
                const inlineMax = Math.max(64, deps.config.imageMaxKb ?? 512) * 1024
                const prepared = await prepareInlineImage(bytes, sniffed, inlineMax, deps.config.imageMaxSide ?? 1280)
                const budget = takeImageBudget(deps, session, prepared.bytes.byteLength)
                if (!budget.ok) {
                  deps.logger.info(
                    `群文件图片跳过内联：本会话已用满图片预算（剩余 ${Math.round(budget.remainingBytes / 1024)}KB）`,
                  )
                  return `${meta}是一张图片，我这次先不展开看了——刚才已经看过不少，再看下去这段对话就太长了。链接：${url}`
                }
                const delivered = await deliverImageBytes({
                  bytes: prepared.bytes,
                  mime: prepared.mime,
                  baseName: `group-file-${gid}`,
                  delivery: deps.config.avatarDelivery,
                  maxBytes: inlineMax,
                  storage: deps.storage,
                  logger: deps.logger,
                  linkUrl: url,
                })
                return [
                  delivered.part,
                  {
                    type: 'text',
                    text: `${meta}是一张图片，你看到了它——直接自然地聊聊图里的内容就好。${delivered.note}`,
                  },
                ]
              } catch (e) {
                const reason = e instanceof Error ? e.message : String(e)
                return `${meta}是张图片，可这会儿没能带到你眼前（${reason}）。链接：${url}`
              }
            }

            const textLimit = Math.max(500, Math.min(cfg.fileOptions?.textLimit ?? 20000, MAX_CHARS_HARD))

            try {
              let text = ''
              let kind = ''
              if (TEXT_EXT.has(ext)) {
                if (looksBinary(bytes)) return `${meta}打开后不是纯文本，我读不出里面的内容。链接：${url}`
                text = decodeText(bytes)
                kind = '文本'
              } else if (ext === 'docx') {
                text = extractDocxText(bytes)
                kind = 'Word 文档'
              } else if (ext === 'pptx') {
                text = extractPptxText(bytes)
                kind = 'PPT'
              } else if (ext === 'xlsx') {
                text = extractXlsxText(bytes)
                kind = 'Excel 表格'
              } else if (ext === 'pdf') {
                return `${meta}是 PDF，这里面的文字我暂时读不出来，只能把链接给你：${url}`
              } else {
                return `${meta}这个格式（.${ext || '未知'}）我暂时打不开，看不到里面的内容；链接：${url}`
              }

              if (!text.trim()) return `${meta}里没读到文字内容（可能是纯图片文档，或者本身是空的）。链接：${url}`
              const clipped = text.length > textLimit
              const body = clipped ? text.slice(0, textLimit) : text
              return [
                `${meta}（${kind}${clipped ? `，先加载了前 ${textLimit} 字` : ''}）的内容：`,
                body,
                clipped ? `……（后面还有 ${text.length - textLimit} 字没显示，需要的话可以只看关键部分）` : '',
              ]
                .filter(Boolean)
                .join('\n')
            } catch (e) {
              const reason = e instanceof Error ? e.message : String(e)
              deps.logger.warn(`群文件解析失败：${fileName}（${reason}）`)
              return `${meta}这会儿没加载出内容（${reason}）。链接：${url}`
            }
          }

          // ── 列目录 ──
          const folderId = String(input.folder_id ?? '').trim()
          const key = `files:${gid}:${folderId || 'root'}:${limit}`
          const listRes = await cachedCall<NapGroupFileList>({
            deps,
            key,
            label: '群文件列表',
            session,
            run: (i) =>
              folderId
                ? rawGet(i, 'get_group_files_by_folder', {
                    group_id: String(gid),
                    folder_id: folderId,
                    file_count: limit,
                  })
                : rawGet(i, 'get_group_root_files', { group_id: String(gid), file_count: limit }),
          })
          if (!listRes.ok) return listRes.error
          const data = listRes.data ?? { files: [], folders: [] }
          const files = Array.isArray(data.files) ? data.files : []
          const folders = Array.isArray(data.folders) ? data.folders : []

          const sys = await cachedCall<NapGroupFileSystemInfo>({
            deps,
            key: `files:sys:${gid}`,
            label: '群文件空间',
            session,
            run: (i) => i.getGroupFileSystemInfo(gid),
          })

          const where = folderId ? `文件夹 ${folderId}` : '根目录'
          const lines = [`群 ${gid} 的群文件（${where}）：${files.length} 个文件、${folders.length} 个文件夹。`]
          if (sys.ok && sys.data) {
            const s = sys.data
            lines.push(
              `空间：已用 ${formatBytes(s.used_space)} / 共 ${formatBytes(s.total_space)}；文件数 ${s.file_count ?? '?'} / 上限 ${s.limit_count ?? '?'}。`,
            )
          }

          if (folders.length > 0) {
            lines.push('文件夹：')
            folders.slice(0, 30).forEach((f, i) => {
              const count = typeof f.total_file_count === 'number' ? `，${f.total_file_count} 个文件` : ''
              lines.push(`${i + 1}. ${truncate(f.folder_name || '(未命名)', 40)}${count} [folder_id=${f.folder_id}]`)
            })
            if (folders.length > 30) lines.push(`……还有 ${folders.length - 30} 个文件夹`)
          }

          if (files.length > 0) {
            lines.push('文件：')
            files.slice(0, limit).forEach((f: NapGroupFile, i) => {
              const up = f.uploader_name ? ` ${truncate(f.uploader_name, 20)}` : ''
              const when = f.upload_time ? ` ${fmtTsRel(f.upload_time)}` : ''
              lines.push(
                `${i + 1}. ${truncate(f.file_name || '(未命名)', 60)}（${formatBytes(f.size ?? f.file_size)}）${up}${when} [file_id=${f.file_id}]`,
              )
            })
            if (files.length > limit) lines.push(`……还有 ${files.length - limit} 个文件没列出来（想看更多就把 limit 调大）`)
          }

          if ((cfg.fileOptions?.listOnly ?? true)) {
            lines.push('（文件的具体内容这会儿加载不出来，先看看列表吧）')
          } else if (!(cfg.fileOptions?.parse ?? false)) {
            lines.push('（文件内容暂时没加载出来，只能先看到文件名、大小这些）')
          } else {
            lines.push('（想翻开某个文件，把它的 file_id 和 file_name 一起带上，我就能看看里面的内容）')
          }
          lines.push(`- ${PERCEPTION_NOTE}。`)
          return lines.join('\n')
        },
        {
          name: 'group_files',
          description: [
            '你能看到这个群的文件：文件夹、文件名、大小、上传者、上传时间；还能读到部分文件里的文字和图片（有时内容会加载不出来）。',
            '',
            '当有人问"群文件里有什么""那个课件讲了什么""群文件里有没有 XX"时使用。',
            '- 不传 file_id：列目录（默认根目录；带上 folder_id 看子文件夹）。',
            '- 传 file_id：翻开这个文件看内容，需要同时带上列表里的 file_name。',
            '- 能读：txt/md/json/csv/docx/pptx/xlsx 和图片；pdf 只能给链接；其它格式只能看到名字、大小这些基本信息。',
            '- 翻具体文件之前，得先看一次文件列表拿到 file_id（列表是翻开的前提）。',
            `- ${PERCEPTION_NOTE}。`,
          ].join('\n'),
          schema: z.object({
            group_id: z.string().optional().describe('群号；留空就是当前会话所在的群'),
            folder_id: z.string().optional().describe('要看的文件夹 ID；留空看根目录'),
            file_id: z.string().optional().describe('要读取的文件 ID（从文件列表里复制）'),
            file_name: z.string().optional().describe('要读取的文件名（从文件列表里复制，用来判断类型）'),
            busid: z.number().int().optional().describe('文件的 busid（列表里一般用不到，留空即可）'),
            limit: z.number().int().min(1).max(200).optional().describe('最多列多少个文件（默认 50）'),
          }),
        },
      ),
  }),
}