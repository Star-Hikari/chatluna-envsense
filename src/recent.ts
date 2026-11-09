import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import type { ChatLunaTool } from 'koishi-plugin-chatluna/llm-core/platform/types'
import { onebotAuthorization, PERCEPTION_NOTE, sessionFrom, ToolDeps, toolMeta } from './common'
import { truncate } from './format'
import { renderSegments } from './forward'
import { callApi, NapMsgRecord, rawGet } from './napi'

// ─────────────────────────────────────────────
// recent_messages：当前会话最近的聊天记录（群聊 / 私聊共用）
//
// 为什么需要它：chatluna 在 allow_reply 阶段就把「没触发 bot 的消息」STOP 掉了，
// 这些消息不会进对话历史。群漫游记录（get_group_msg_history / get_friend_msg_history）
// 能拿到包括未触发在内的最近消息，正好补上这个缺口。
//
// 安全约束：只看**当前会话**——群聊看当前群，私聊看当前对端，不接受任何目标 ID。
// ─────────────────────────────────────────────

const MAX_LINE = 200
const MAX_CHARS = 6000

/** 段数组 / CQ 串 / 纯文本 → 一行正文 */
function messageText(record: NapMsgRecord): string {
  const msg = record.message
  if (Array.isArray(msg)) {
    return renderSegments(msg as any)
  }
  if (typeof msg === 'string' && msg.length > 0) {
    // 少数配置会把 message 给成 CQ 串；把常见段折成占位符，避免把 CQ 码原样喂给模型
    return msg
      .replace(/\[CQ:image[^\]]*\]/g, '[图]')
      .replace(/\[CQ:record[^\]]*\]/g, '[语音]')
      .replace(/\[CQ:video[^\]]*\]/g, '[视频]')
      .replace(/\[CQ:file[^\]]*\]/g, '[文件]')
      .replace(/\[CQ:face[^\]]*\]/g, '[表情]')
      .replace(/\[CQ:reply[^\]]*\]/g, '')
      .replace(/\[CQ:[^\]]*\]/g, '')
      .trim()
  }
  return String(record.raw_message ?? '').trim()
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** 今天只显示 HH:mm，跨天补上 MM-DD */
function fmtClock(seconds: number | undefined): string {
  if (typeof seconds !== 'number' || seconds <= 0) return '??:??'
  const d = new Date(seconds * 1000)
  if (Number.isNaN(d.getTime())) return '??:??'
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  return sameDay ? clock : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${clock}`
}

function senderName(record: NapMsgRecord): string {
  const s = record.sender ?? {}
  return String(s.card || s.nickname || '未知')
}

function senderId(record: NapMsgRecord): string {
  return String(record.sender?.user_id ?? '')
}

export interface RecentMessagesResult {
  action: 'get_group_msg_history' | 'get_friend_msg_history'
  targetId: string
  isDirect: boolean
}

/** 会话 → 该用哪个 action（供冒烟直接验证，不发起请求） */
export function resolveRecentTarget(session: {
  isDirect?: boolean
  guildId?: string
  userId?: string
} | undefined): RecentMessagesResult | undefined {
  if (!session) return undefined
  if (session.isDirect === true) {
    const uid = String(session.userId ?? '').trim()
    if (!/^\d+$/.test(uid)) return undefined
    return { action: 'get_friend_msg_history', targetId: uid, isDirect: true }
  }
  const gid = String(session.guildId ?? '').trim()
  if (!/^\d+$/.test(gid)) return undefined
  return { action: 'get_group_msg_history', targetId: gid, isDirect: false }
}

export const recentToolDefs: Record<string, (deps: ToolDeps) => ChatLunaTool> = {
  recent_messages: (deps) => ({
    description: '你能看到的最近聊天记录（群聊或私聊）',
    selector: () => true,
    authorization: onebotAuthorization,
    meta: toolMeta(['recent', 'context']),
    createTool: () =>
      tool(
        async (input: { count?: number; before?: string }, runConfig) => {
          const session = sessionFrom(runConfig)
          const target = resolveRecentTarget(session as any)
          if (!target) return '这会儿既不在群聊也不在私聊里，我没什么聊天记录可看。'

          const max = Math.max(1, Math.min(deps.config.recent.max || 100, 100))
          const want = Math.floor(input.count ?? deps.config.recent.count ?? 30)
          const count = Math.max(1, Math.min(Number.isFinite(want) ? want : 30, max))

          const params: Record<string, unknown> = {
            count,
            message_seq: input.before ? String(input.before) : '',
            reverse_order: false,
            // 不解析下载链接：这一步只关心文字，关掉能少一轮文件/链接解析
            disable_get_url: true,
            parse_mult_msg: true,
          }
          if (target.isDirect) params.user_id = target.targetId
          else params.group_id = target.targetId

          const res = await callApi<{ messages?: NapMsgRecord[] }>({
            session,
            label: target.isDirect ? '私聊记录' : '群聊记录',
            logger: deps.logger,
            limiter: deps.limiter,
            run: (i) => rawGet(i, target.action, params),
          })
          if (!res.ok) return res.error

          const messages = (res.data?.messages ?? [])
            .filter((m) => m && typeof m === 'object')
            .slice()
            .sort((a, b) => Number(a.time ?? 0) - Number(b.time ?? 0))
          if (messages.length === 0) {
            return target.isDirect
              ? `我和 ${target.targetId} 这边，暂时没看到最近的聊天记录。`
              : `群 ${target.targetId} 这边，暂时没看到最近的聊天记录。`
          }

          const selfId = String((session?.bot as any)?.selfId ?? session?.selfId ?? '')
          const lines: string[] = []
          let chars = 0
          let truncated = false
          for (const m of messages) {
            const body = messageText(m)
            if (!body) continue
            const who = senderName(m)
            const uid = senderId(m)
            const mine = uid && selfId && uid === selfId
            const line = `${fmtClock(Number(m.time ?? 0))} ${who}${uid ? ` (${uid})` : ''}${mine ? '（你）' : ''}：${truncate(body, MAX_LINE)}`
            if (chars + line.length + 1 > MAX_CHARS) {
              truncated = true
              break
            }
            lines.push(line)
            chars += line.length + 1
          }
          if (lines.length === 0) return '最近的记录里没什么看得清的文字内容。'

          const earliest = messages[0]
          const seq = earliest?.message_seq ?? earliest?.message_id
          const head = target.isDirect
            ? `和 ${target.targetId} 最近的聊天记录（${lines.length} 条，按时间从早到晚）：`
            : `群 ${target.targetId} 最近的聊天记录（${lines.length} 条，按时间从早到晚）：`
          const tail: string[] = []
          if (truncated) tail.push('（内容有点多，先看到这里）')
          if (messages.length >= count && seq != null && String(seq).length > 0) {
            tail.push(`（想看更早的，带上 before=${seq} 再往前翻一翻）`)
          }
          return [head, ...lines, ...tail].join('\n')
        },
        {
          name: 'recent_messages',
          description: [
            '你能看到这个会话最近的聊天记录，包括**没有跟你说话**的那些消息。',
            '',
            '当有人问"刚才 / 前面聊了什么""你怎么看刚才的话题"，或你想接上之前的话题时使用。',
            '- 群聊只能看当前这个群；私聊只能看当前对端。不能看别的群或别人。',
            '- count：看多少条（默认 30，最多 100）。',
            '- before：想看更早的记录，就填上一次结果里最早那条的序号。',
            '- 记录里的图片、语音、文件只会让你看到一个占位记号，看不到具体内容。',
            `- ${PERCEPTION_NOTE}。`,
          ].join('\n'),
          schema: z.object({
            count: z.number().int().min(1).max(100).optional().describe('看多少条（默认 30，最多 100）'),
            before: z.string().optional().describe('从哪条更早的消息开始看（上一次结果里最早那条的序号）'),
          }),
        },
      ),
  }),
}