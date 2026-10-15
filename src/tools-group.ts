import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import type { ChatLunaTool } from 'koishi-plugin-chatluna/llm-core/platform/types'
import { groupAvatarUrls } from './avatar'
import { buildAvatarObservation, cachedCall, modelImageSupport, onebotAuthorization, PERCEPTION_NOTE, sessionFrom, ToolDeps } from './common'
import {
  fmtTs,
  fmtTsRel,
  nickOf,
  pushIfLine,
  qqLevelCN,
  relTs,
  roleCN,
  truncate,
} from './format'
import { describeShape, renderNoticeDetail, renderNoticePreview, unwrapNoticeList } from './notice'
import {
  NapEssenceItem,
  NapHonorInfo,
  NapMsgRecord,
  NapSignedItem,
  OnebotGroup,
  OnebotGroupMember,
  rawGet,
  resolveGroupId,
} from './napi'

// ─────────────────────────────────────────────
// 群域工具（设计文档 §3）
// ─────────────────────────────────────────────

const groupIdSchema = z
  .string()
  .optional()
  .describe('群号；留空则使用当前会话所在的群')

/** 精华消息 content 段数组 → 纯文本（图片记 [图]） */
function flattenEssence(content: NapEssenceItem['content']): string {
  if (!Array.isArray(content)) return '(内容不可读)'
  const text = content
    .map((seg) => {
      if (seg?.type === 'text') return seg.data?.text ?? ''
      if (seg?.type === 'image') return '[图]'
      if (seg?.type === 'record') return '[语音]'
      if (seg?.type === 'video') return '[视频]'
      return ''
    })
    .join(' ')
    .trim()
  return text || '(无文字内容)'
}

export const groupToolDefs: Record<string, (deps: ToolDeps) => ChatLunaTool> = {
  // §3.1
  group_overview: (deps) => ({
    description: '你身处的这个群的全貌',
    selector: () => true,
    authorization: onebotAuthorization,
    meta: toolMetaSafe(['group']),
    createTool: () =>
      tool(
        async (input: { group_id?: string }, runConfig) => {
          const session = sessionFrom(runConfig)
          const gid = resolveGroupId(session, input.group_id)
          if (!gid) return '当前不在群聊中，且未提供 group_id，无法确定要查询的群。'
          const res = await cachedCall<OnebotGroup>({
            deps,
            key: `overview:${gid}`,
            label: '群资料',
            session,
            run: (i) => i.getGroupInfo(gid),
          })
          if (!res.ok) return res.error
          const lines: string[] = [
            `群号: ${res.data.group_id}`,
            `群名称: ${res.data.group_name || '未知'}`,
          ]
          pushIfLine(lines, res.data.member_count, '成员数', (v) => `${v}${res.data.max_member_count ? `/${res.data.max_member_count}` : ''}`)
          if (res.data.group_all_shut) lines.push('全员禁言: 已开启')
          pushIfLine(lines, res.data.group_remark, '我给该群的备注')
          // 我在本群的身份
          if (session?.selfId) {
            const meRes = await cachedCall<OnebotGroupMember>({
              deps,
              key: `member:${gid}:${session.selfId}`,
              label: '群内自我介绍',
              session,
              run: (i) => i.getGroupMemberInfo(gid, session.selfId, true),
            })
            if (meRes.ok) {
              lines.push(
                `我在本群: 名片「${nickOf(meRes.data, '未设置')}」 身份: ${roleCN(meRes.data.role)}` +
                  (meRes.data.title ? ` 头衔: ${meRes.data.title}` : ''),
              )
            }
          }
          return lines.join('\n')
        },
        {
          name: 'group_overview',
          description: [
            '你能看到自己此刻身处的这个群的全貌：群名称、成员数量、是否全员禁言、你给这个群起的备注，以及你自己在这个群里的名片、身份（群主/管理员/成员）和头衔。',
            '',
            '当你想知道自己在一个什么样的群里、自己在这个群里是什么身份时使用。',
            '- group_id：留空就是当前会话所在的群。',
            '- 这里只有群的"全貌"；群公告和成员名单不在其中，想看那些有专门的感知。',
            `- ${PERCEPTION_NOTE}。`,
          ].join('\n'),
          schema: z.object({ group_id: groupIdSchema }),
        },
      ),
  }),

  // §3.2
  group_members: (deps) => ({
    description: '你看到的群成员名单',
    selector: () => true,
    authorization: onebotAuthorization,
    meta: toolMetaSafe(['group', 'members']),
    createTool: () =>
      tool(
        async (
          input: { group_id?: string; keyword?: string; role?: 'owner' | 'admin' | 'member'; limit?: number },
          runConfig,
        ) => {
          const session = sessionFrom(runConfig)
          const gid = resolveGroupId(session, input.group_id)
          if (!gid) return '当前不在群聊中，且未提供 group_id，无法确定要查询的群。'
          const res = await cachedCall<OnebotGroupMember[]>({
            deps,
            key: `members:${gid}`,
            label: '群成员列表',
            session,
            run: (i) => i.getGroupMemberList(gid),
          })
          if (!res.ok) return res.error
          let members = res.data || []
          const total = members.length
          if (input.keyword) {
            const kw = input.keyword.toLowerCase()
            members = members.filter(
              (m) =>
                (m.nickname || '').toLowerCase().includes(kw) ||
                (m.card || '').toLowerCase().includes(kw) ||
                String(m.user_id) === kw,
            )
          }
          if (input.role) members = members.filter((m) => m.role === input.role)
          const maxLimit = deps.config.group.memberLimit
          const limit = Math.min(input.limit ?? maxLimit, maxLimit, 200)
          if (members.length === 0) {
            return `群 ${gid}（共 ${total} 人）中没有匹配「${input.keyword ?? input.role ?? ''}」的成员。`
          }
          const shown = members.slice(0, limit)
          const lines = shown.map((m) => {
            const name = `${nickOf(m)} (${m.user_id})`
            const role = m.role && m.role !== 'member' ? ` ${roleCN(m.role)}` : ''
            const last = m.last_sent_time ? ` 最后发言${relTs(m.last_sent_time)}` : ''
            return `${name}${role} 入群${fmtTsRel(m.join_time)}${last}`
          })
          let out = `群 ${gid} 共 ${total} 人`
          if (input.keyword || input.role) out += `，匹配 ${members.length} 人`
          out += `\n${lines.join('\n')}`
          if (members.length > shown.length) {
            out += `\n（仅显示前 ${shown.length} 条，可用 keyword 参数按昵称/名片/QQ 号缩小范围）`
          }
          return out
        },
        {
          name: 'group_members',
          description: [
            '你能看到群里的成员名单：昵称、群名片、QQ 号、身份、入群时间、最后发言时间。',
            '',
            '当你想知道群里都有谁、某个人在不在这个群里、群里有哪些管理员时使用。',
            '- group_id：留空就是当前会话所在的群。',
            '- keyword：按昵称/群名片/QQ 号的片段筛选。大群里找具体某个人一定要带上它，否则名单会被截断、看不到目标。',
            '- role：只看某一类身份（群主/管理员/普通成员）。',
            '- limit：最多看多少行。',
            `- ${PERCEPTION_NOTE}。`,
          ].join('\n'),
          schema: z.object({
            group_id: groupIdSchema,
            keyword: z.string().optional().describe('按昵称/名片/QQ号模糊过滤'),
            role: z.enum(['owner', 'admin', 'member']).optional().describe('只看某身份的成员'),
            limit: z.number().int().min(1).optional().describe('最多返回行数（受配置上限约束）'),
          }),
        },
      ),
  }),

  // §3.3
  member_detail: (deps) => ({
    description: '某位成员在这个群里的处境',
    selector: () => true,
    authorization: onebotAuthorization,
    meta: toolMetaSafe(['group', 'member']),
    createTool: () =>
      tool(
        async (input: { group_id?: string; user_id?: string }, runConfig) => {
          const session = sessionFrom(runConfig)
          const gid = resolveGroupId(session, input.group_id)
          if (!gid) return '当前不在群聊中，且未提供 group_id。'
          const uid = input.user_id || session?.userId
          if (!uid) return '未提供 user_id 且当前会话没有可识别的目标用户。'
          const res = await cachedCall<OnebotGroupMember>({
            deps,
            key: `member:${gid}:${uid}`,
            label: '成员详情',
            session,
            run: (i) => i.getGroupMemberInfo(gid, uid),
          })
          if (!res.ok) return res.error
          const m = res.data
          const lines: string[] = [
            `群内成员详情（群 ${gid}）`,
            `昵称: ${m.nickname || '未知'} (QQ ${m.user_id})`,
          ]
          pushIfLine(lines, m.card, '群名片')
          pushIfLine(lines, m.role, '身份', roleCN)
          pushIfLine(lines, m.title, '专属头衔')
          pushIfLine(lines, m.level, '群聊等级')
          pushIfLine(lines, m.qq_level, 'QQ等级', (v) => qqLevelCN(v) || String(v))
          pushIfLine(lines, m.join_time, '入群时间', fmtTsRel)
          pushIfLine(lines, m.last_sent_time, '最后发言', fmtTsRel)
          if (m.shut_up_timestamp && m.shut_up_timestamp * 1000 > Date.now()) {
            lines.push(`禁言中，直到 ${fmtTs(m.shut_up_timestamp)}`)
          }
          if (m.is_robot) lines.push('该成员是机器人')
          return lines.join('\n')
        },
        {
          name: 'member_detail',
          description: [
            '你能看到某个成员在这个群里的具体处境：群名片、专属头衔、群聊等级、入群时间、最后发言时间、是否被禁言、身份（群主/管理员/成员）。',
            '',
            '当你想了解某个人"在这个群里"是什么样时使用。',
            '- user_id：要看的 QQ 号；留空就是此刻正在跟你说话的人。',
            '- 想看的是 TA 账号本身的资料（个性签名、QQ 等级、生日等）而不是群内处境时，用 user_profile。',
            `- ${PERCEPTION_NOTE}。`,
          ].join('\n'),
          schema: z.object({
            group_id: groupIdSchema,
            user_id: z.string().optional().describe('目标 QQ 号；留空=当前消息发送者'),
          }),
        },
      ),
  }),

  // §3.4
  group_notices: (deps) => ({
    description: '你看到的群公告（概览，或按 id 看完整版）',
    selector: () => true,
    authorization: onebotAuthorization,
    meta: toolMetaSafe(['group', 'notice']),
    createTool: () =>
      tool(
        async (input: { group_id?: string; limit?: number; notice_id?: string }, runConfig) => {
          const session = sessionFrom(runConfig)
          const gid = resolveGroupId(session, input.group_id)
          if (!gid) return '当前不在群聊中，且未提供 group_id。'
          const res = await cachedCall<unknown>({
            deps,
            key: `notices:${gid}`,
            label: '群公告',
            session,
            run: (i) => i.getGroupNotice(gid),
          })
          if (!res.ok) return res.error

          // NapCat 各版本对 get_group_notice 的返回结构不一致：可能是公告数组本身，
          // 也可能是 { notice: [...] } / { data: [...] } / { notices: [...] } 之类的包装对象。
          // 这里统一解包，并记录原始结构，避免"接口其实返回了但被当成空"。
          const unwrapped = unwrapNoticeList(res.data)
          deps.logger.debug(`群公告原始返回：${describeShape(res.data)}`)

          if (!unwrapped.ok) {
            return (
              `我这会儿看不清这个群的公告（看到的格式是：${unwrapped.reason}）。` +
              `这不是"没有公告"——原始内容：${describeShape(res.data)}，可以交给维护者排查。`
            )
          }
          let notices = unwrapped.list
          if (!deps.config.group.noticesIncludeNewMember) {
            notices = notices.filter((n) => !n.send_to_new_member)
          }
          if (notices.length === 0) {
            // 「发给新成员」的公告只能从 inst 字段读到（NapCat 的 GetGroupNotice 才读它）。
            // 旧版 NapCat 只回 feeds，这类公告会整个消失 —— 日志里点一句，便于定位。
            if (unwrapped.list.length === 0) {
              deps.logger.info(
                `群 ${gid} 的公告接口返回空列表。若群里确实有公告（尤其"发给新成员"那条），` +
                  '多半是 NapCat 版本较旧：它只读 feeds、不读 inst，请升级 NapCat 后重试。',
              )
            }
            return deps.config.group.noticesIncludeNewMember
              ? `群 ${gid} 当前没有公告（含"发送给新成员"的公告）。`
              : `群 ${gid} 当前没有公告（已按配置过滤掉"发送给新成员"的公告）。`
          }

          // 两段式：默认只给预览清单，模型带 notice_id 再来要某条的完整正文与图片
          const noticeId = input.notice_id ? String(input.notice_id).trim() : ''
          if (!noticeId) {
            const limit = Math.min(input.limit ?? 5, 10)
            return renderNoticePreview(notices, limit)
          }

          const target = notices.find((n) => String(n.notice_id) === noticeId)
          if (!target) {
            const ids = notices.map((n) => String(n.notice_id)).join('、')
            return `群 ${gid} 没有 id 为 ${noticeId} 的公告。现有公告 id：${ids}`
          }
          return (await renderNoticeDetail({
            notice: target,
            groupId: gid,
            internal: (session?.bot as any)?.internal,
            index: notices.indexOf(target),
            vision: modelImageSupport(runConfig),
            image: {
              ctx: deps.ctx,
              logger: deps.logger,
              delivery: deps.config.avatarDelivery,
              maxBytes: deps.config.avatarMaxKb * 1024,
              maxImages: deps.config.group.noticeImageLimit,
              storage: deps.storage,
            },
          })) as unknown as string
        },
        {
          name: 'group_notices',
          description: [
            '你能看到这个群的公告。先给你一份概览：每条的发布时间、发布者、是否置顶、是否「发给新成员」、已读人数、图片张数、正文开头，以及这一条的 id。',
            '',
            '当你想知道群里贴了哪些公告、公告讲了什么时使用。',
            '- group_id：留空就是当前会话所在的群。',
            '- limit：概览最多列几条。',
            '- notice_id：填上概览里某一条的 id，你就会再一次、更完整地看到那一条——完整的正文，以及它带的图片（需要当前模型支持图片输入）。',
            '- 概览只是摘录。用户想听完整内容、或问公告里的图是什么时，记得带上 id 再看一次完整版。',
            '- 偶尔会有看不清楚的时候：那就如实说你这次没看到、稍后再看；如果你看到的是"没有公告"，那就是真的没有。',
            `- ${PERCEPTION_NOTE}。`,
          ].join('\n'),
          schema: z.object({
            group_id: groupIdSchema,
            limit: z.number().int().min(1).optional().describe('概览最多显示几条（默认 5，上限 10）'),
            notice_id: z
              .string()
              .optional()
              .describe('要完整看的那条公告 id（取自概览里每条末尾的 id）；留空则只给概览'),
          }),
        },
      ),
  }),

  // §3.5
  group_honors: (deps) => ({
    description: '你看到的群荣誉榜',
    selector: () => true,
    authorization: onebotAuthorization,
    meta: toolMetaSafe(['group', 'honor']),
    createTool: () =>
      tool(
        async (input: { group_id?: string }, runConfig) => {
          const session = sessionFrom(runConfig)
          const gid = resolveGroupId(session, input.group_id)
          if (!gid) return '当前不在群聊中，且未提供 group_id。'
          const res = await cachedCall<NapHonorInfo>({
            deps,
            key: `honors:${gid}`,
            label: '群荣誉',
            session,
            run: (i) => i.getGroupHonorInfo(gid, 'all'),
          })
          if (!res.ok) return res.error
          const h = res.data || {}
          const lines: string[] = [`群 ${gid} 荣誉榜：`]
          const entry = (list: NapHonorInfo['talkative_list'], name: string, withDays = false) => {
            if (!Array.isArray(list) || list.length === 0) return
            const shown = list
              .slice(0, 5)
              .map((e) => `${e.nickname || '未知'} (${e.user_id ?? ''})${withDays && e.day_count ? ` x${e.day_count}天` : ''}`)
              .join('、')
            lines.push(`${name}: ${shown}`)
          }
          if (h.current_talkative?.nickname) {
            lines.push(`当前龙王: ${h.current_talkative.nickname} (${h.current_talkative.user_id ?? ''})`)
          }
          entry(h.talkative_list, '龙王（历史）')
          entry(h.performer_list, '群聊之火')
          entry(h.legend_list, '群聊炽热')
          entry(h.emotion_list, '快乐源泉')
          entry(h.strong_newbie_list, '冒尖小春笋')
          if (lines.length === 1) return `群 ${gid} 暂无荣誉数据（新群或成员均未获得称号）。`
          return lines.join('\n')
        },
        {
          name: 'group_honors',
          description: [
            '你能看到这个群的荣誉榜：现在的龙王、历代龙王、群聊之火、群聊炽热、快乐源泉、冒尖小春笋等称号的获得者。',
            '',
            '当你想说清"群里谁最活跃""谁是龙王""这个群的气氛怎么样"时，优先看这里。',
            '- group_id：留空就是当前会话所在的群。',
            '- 它比一条条翻聊天记录省事得多，随口问"谁最活跃"时先用它。',
            `- ${PERCEPTION_NOTE}。`,
          ].join('\n'),
          schema: z.object({ group_id: groupIdSchema }),
        },
      ),
  }),

  // §3.6
  group_activity: (deps) => ({
    description: '你看到的近期发言活跃度（较费事）',
    selector: () => true,
    authorization: onebotAuthorization,
    meta: toolMetaSafe(['group', 'activity']),
    createTool: () =>
      tool(
        async (input: { group_id?: string; count?: number }, runConfig) => {
          const session = sessionFrom(runConfig)
          const gid = resolveGroupId(session, input.group_id)
          if (!gid) return '当前不在群聊中，且未提供 group_id。'
          const count = Math.min(input.count ?? deps.config.group.activityCount, 500)
          const res = await cachedCall<{ messages?: NapMsgRecord[] }>({
            deps,
            key: `activity:${gid}:${count}`,
            label: '历史消息',
            session,
            run: (i) => rawGet(i, 'get_group_msg_history', { group_id: String(gid), count: String(count) }),
          })
          if (!res.ok) return `${res.error}（若提示"消息不存在"通常表示近期无可拉取的历史消息）`
          const messages = res.data?.messages || []
          if (messages.length === 0) return '没有拉取到历史消息。'
          const stats = new Map<string, { name: string; n: number }>()
          let earliest = Infinity
          let latest = 0
          for (const msg of messages) {
            const uid = String(msg.sender?.user_id ?? '未知')
            const name = msg.sender?.card || msg.sender?.nickname || '未知'
            const cur = stats.get(uid) || { name, n: 0 }
            cur.n += 1
            stats.set(uid, cur)
            if (msg.time) {
              earliest = Math.min(earliest, msg.time)
              latest = Math.max(latest, msg.time)
            }
          }
          const ranked = [...stats.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 10)
          const lines = ranked.map(([uid, s], i) => `${i + 1}. ${s.name} (${uid}): ${s.n} 条 (${Math.round((s.n / messages.length) * 100)}%)`)
          const span = Number.isFinite(earliest) ? `，覆盖 ${fmtTs(earliest)} ~ ${fmtTs(latest)}` : ''
          return `群 ${gid} 最近 ${messages.length} 条消息的发言统计${span}：\n${lines.join('\n')}`
        },
        {
          name: 'group_activity',
          description: [
            '你能看到群里最近一段时间谁说话最多：每个人的条数与占比、前十名，以及这段时间的跨度。',
            '',
            '当你想量化地回答"群里谁最活跃""最近聊得多不多"时使用。',
            '- group_id：留空就是当前会话所在的群。',
            '- count：翻多少条聊天记录来统计（默认按配置）。',
            '- 这样翻记录比较费事；只是随口问"谁最活跃"时，先看 group_honors 的荣誉榜。',
            `- ${PERCEPTION_NOTE}。`,
          ].join('\n'),
          schema: z.object({
            group_id: groupIdSchema,
            count: z.number().int().min(50).max(500).optional().describe('拉取消息条数（默认按配置）'),
          }),
        },
      ),
  }),

  // §3.7
  group_essence: (deps) => ({
    description: '你看到的群精华消息',
    selector: () => true,
    authorization: onebotAuthorization,
    meta: toolMetaSafe(['group', 'essence']),
    createTool: () =>
      tool(
        async (input: { group_id?: string; limit?: number }, runConfig) => {
          const session = sessionFrom(runConfig)
          const gid = resolveGroupId(session, input.group_id)
          if (!gid) return '当前不在群聊中，且未提供 group_id。'
          const res = await cachedCall<NapEssenceItem[]>({
            deps,
            key: `essence:${gid}`,
            label: '精华消息',
            session,
            run: (i) => i.getEssenceMsgList(gid),
          })
          if (!res.ok) return res.error
          const items = res.data || []
          if (items.length === 0) return `群 ${gid} 还没有精华消息。`
          const limit = Math.min(input.limit ?? 10, 30)
          const lines = items.slice(0, limit).map((e, i) => {
            const t = e.operator_time ? `${fmtTsRel(e.operator_time)} ` : ''
            return `${i + 1}. ${t}${e.sender_nick || '未知'} (${e.sender_id})：${truncate(flattenEssence(e.content), 100)}`
          })
          return `群 ${gid} 精华消息（共 ${items.length} 条，显示前 ${Math.min(limit, items.length)} 条）：\n${lines.join('\n')}`
        },
        {
          name: 'group_essence',
          description: [
            '你能看到这个群的精华消息（被群主/管理员加精收藏的发言）：谁说的、什么时候被加精、内容大意。',
            '',
            '当有人问"群里有什么经典发言""精华里有什么""这个群有什么老梗"时使用。',
            '- group_id：留空就是当前会话所在的群。',
            '- limit：最多看几条。',
            `- ${PERCEPTION_NOTE}。`,
          ].join('\n'),
          schema: z.object({
            group_id: groupIdSchema,
            limit: z.number().int().min(1).optional().describe('最多显示几条（默认 10，上限 30）'),
          }),
        },
      ),
  }),

  // §3.8
  group_signed: (deps) => ({
    description: '你看到的今日打卡榜',
    selector: () => true,
    authorization: onebotAuthorization,
    meta: toolMetaSafe(['group', 'signed']),
    createTool: () =>
      tool(
        async (input: { group_id?: string }, runConfig) => {
          const session = sessionFrom(runConfig)
          const gid = resolveGroupId(session, input.group_id)
          if (!gid) return '当前不在群聊中，且未提供 group_id。'
          const res = await cachedCall<NapSignedItem[]>({
            deps,
            key: `signed:${gid}`,
            label: '打卡榜',
            session,
            run: (i) => i.getGroupSignedList(gid),
          })
          if (!res.ok) {
            const hint = res.error.includes('打卡') || res.error.includes('sign') ? '（该群可能未开启群签到/打卡功能）' : ''
            return `${res.error}${hint}`
          }
          const items = res.data || []
          if (items.length === 0) return `群 ${gid} 今天还没有人打卡。`
          const sorted = [...items].sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999))
          const lines = sorted.slice(0, 10).map((s) => `${s.rank ?? '-'}. ${s.nick || '未知'} (${s.user_id}) ${fmtTs(s.time)}`)
          return `群 ${gid} 今日打卡 ${items.length} 人：\n${lines.join('\n')}`
        },
        {
          name: 'group_signed',
          description: [
            '你能看到群里今天打卡（签到）的名单和排名。',
            '',
            '当有人问"今天谁打卡了""打卡情况怎么样""有没有比我更早签到的"时使用。',
            '- group_id：留空就是当前会话所在的群。',
            `- ${PERCEPTION_NOTE}。`,
          ].join('\n'),
          schema: z.object({ group_id: groupIdSchema }),
        },
      ),
  }),

  // §3.9（多模态）
  group_avatar: (deps) => ({
    description: '你亲眼看到的群头像',
    selector: () => true,
    authorization: onebotAuthorization,
    meta: toolMetaSafe(['group', 'avatar', 'vision']),
    createTool: () =>
      tool(
        async (input: { group_id?: string }, runConfig) => {
          const session = sessionFrom(runConfig)
          const gid = resolveGroupId(session, input.group_id)
          if (!gid) return '当前不在群聊中，且未提供 group_id。'
          // 直接把链接交给模型时供应商常抓不到（实测"看不到图"），故统一取回字节再交付：
          // storage 临时文件 → base64 内联兜底，见 common.ts 的 buildAvatarObservation。
          // 地址用 groupAvatarUrls 生成：qlogo 只认 0/40/100/140/640，写错尺寸会 HTTP 400。
          return (await buildAvatarObservation({
            deps,
            runConfig,
            urls: groupAvatarUrls(gid, deps.config.avatarSize),
            baseName: `group-${gid}`,
            what: `群 ${gid} 的群头像`,
            delivery: deps.config.avatarDelivery,
          })) as unknown as string
        },
        {
          name: 'group_avatar',
          description: [
            '你能亲眼看到当前群的头像图片。',
            '',
            '当有人问"你知道我们群头像是什么吗""评价一下群头像"时使用。',
            '- group_id：留空就是当前会话所在的群。',
            '- 图片会作为你实际看到的内容交给你：直接讲你看到的样子就好，不要说自己"调用了工具"或"拿到一个链接"。需要当前模型支持图片输入。',
            `- ${PERCEPTION_NOTE}。`,
          ].join('\n'),
          schema: z.object({ group_id: groupIdSchema }),
        },
      ),
  }),
}

// ChatLunaTool['meta'] 在部分类型链路下推导偏严，包一层确保类型可用
function toolMetaSafe(tags: string[]): NonNullable<ChatLunaTool['meta']> {
  return {
    source: 'extension',
    group: 'envsense',
    tags: ['envsense', ...tags],
    defaultAvailability: {
      enabled: true,
      main: true,
      subAgent: true,
      chatluna: true,
      characterScope: 'all',
    },
  }
}
