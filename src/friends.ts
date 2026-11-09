import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import type { ChatLunaTool } from 'koishi-plugin-chatluna/llm-core/platform/types'
import { cachedCall, onebotAuthorization, PERCEPTION_NOTE, sessionFrom, ToolDeps, toolMeta } from './common'
import { truncate } from './format'
import { OnebotFriend, OnebotFriendCategory, OnebotUnidirectionalFriend, rawGet } from './napi'

// ─────────────────────────────────────────────
// 好友域工具（只读）
//
// 数据源：
//   get_friend_list            —— 好友总数 / 昵称 / 备注 / 分组（adapter 已包装）
//   get_friends_with_category  —— 分组名 + 每组人数（未包装，用 rawGet）
//   get_unidirectional_friend_list —— 单向好友（对方加了我、我没加对方）
//
// 隐私：只输出昵称 / QQ / 备注 / 分组，不读也不输出手机号、邮箱、生日等字段；
// 不提供任何写操作（不加好友、不改备注、不删好友）。
// 好友申请（可疑好友申请）按需求**不展示**，连接口都不调。
// ─────────────────────────────────────────────

function categoryOf(friend: OnebotFriend): string | undefined {
  return friend.categoryName?.trim() || undefined
}

function sortFriends(list: OnebotFriend[]): OnebotFriend[] {
  const name = (f: OnebotFriend) => (f.remark?.trim() || f.nickname || String(f.user_id)).toLowerCase()
  return list.slice().sort((a, b) => name(a).localeCompare(name(b), 'zh-Hans-CN'))
}

function friendLine(f: OnebotFriend): string {
  const bits = [`${f.remark?.trim() || f.nickname || '未命名'} (${f.user_id})`]
  if (f.remark?.trim() && f.nickname && f.remark.trim() !== f.nickname) bits.push(`昵称：${truncate(f.nickname, 30)}`)
  const cat = categoryOf(f)
  if (cat) bits.push(`分组：${truncate(cat, 20)}`)
  return bits.join('｜')
}

export const friendToolDefs: Record<string, (deps: ToolDeps) => ChatLunaTool> = {
  friend_overview: (deps) => ({
    description: '你自己的好友概况（总数 / 分组 / 单向好友）',
    selector: () => true,
    authorization: onebotAuthorization,
    meta: toolMeta(['user', 'friend', 'overview']),
    createTool: () =>
      tool(
        async (_input: Record<string, never>, runConfig) => {
          const session = sessionFrom(runConfig)
          const friends = await cachedCall<OnebotFriend[]>({
            deps,
            key: 'friends:list',
            label: '好友列表',
            session,
            run: (i) => i.getFriendList(),
          })
          if (!friends.ok) return friends.error
          const list = Array.isArray(friends.data) ? friends.data : []

          const cats = await cachedCall<OnebotFriendCategory[]>({
            deps,
            key: 'friends:categories',
            label: '好友分组',
            session,
            run: (i) => rawGet(i, 'get_friends_with_category', {}),
          })

          const uni = await cachedCall<OnebotUnidirectionalFriend[]>({
            deps,
            key: 'friends:unidirectional',
            label: '单向好友',
            session,
            run: (i) => i.getUnidirectionalFriendList(),
          })

          const lines = [`你有 ${list.length} 个好友。`]

          if (cats.ok && Array.isArray(cats.data) && cats.data.length > 0) {
            const rows = cats.data
              .map((c) => ({
                name: String(c?.categoryName ?? '未分组'),
                count: Number(c?.categoryMbCount ?? c?.buddyList?.length ?? 0) || 0,
              }))
              .filter((c) => c.name)
              .sort((a, b) => b.count - a.count)
            if (rows.length > 0) {
              lines.push('分组：')
              rows.slice(0, 10).forEach((c, i) => lines.push(`${i + 1}. ${truncate(c.name, 20)}：${c.count} 人`))
              if (rows.length > 10) lines.push(`……还有 ${rows.length - 10} 个分组`)
            }
          } else if (list.length > 0) {
            // 分组接口失败时用好友列表里的 categoryName 兜底
            const counts = new Map<string, number>()
            for (const f of list) {
              const c = categoryOf(f) ?? '未分组'
              counts.set(c, (counts.get(c) ?? 0) + 1)
            }
            const rows = [...counts.entries()].sort((a, b) => b[1] - a[1])
            if (rows.length > 0) {
              lines.push('分组：')
              rows.slice(0, 10).forEach(([name, n], i) => lines.push(`${i + 1}. ${truncate(name, 20)}：${n} 人`))
            }
          }

          if (uni.ok) {
            const n = Array.isArray(uni.data) ? uni.data.length : 0
            lines.push(
              n > 0
                ? `另有 ${n} 个单向好友（对方加了你、你还没加对方）。`
                : '没有单向好友。',
            )
          }

          lines.push(`- ${PERCEPTION_NOTE}。`)
          return lines.join('\n')
        },
        {
          name: 'friend_overview',
          description: [
            '你能看到自己这个账号的好友概况：一共有多少好友、分成哪些组、有没有单向好友。',
            '',
            '当有人问"你有多少好友""你的好友都是谁""谁加了你但你没加"时使用。',
            '- 只看数量和分组，不会列出全部好友；要看具体的人用 friend_search。',
            '- 不含好友申请相关的信息。',
            `- ${PERCEPTION_NOTE}。`,
          ].join('\n'),
          schema: z.object({}),
        },
      ),
  }),

  friend_search: (deps) => ({
    description: '你自己的好友名单里找人 / 判断是不是好友',
    selector: () => true,
    authorization: onebotAuthorization,
    meta: toolMeta(['user', 'friend', 'search']),
    createTool: () =>
      tool(
        async (input: { keyword?: string; user_id?: string; limit?: number }, runConfig) => {
          const session = sessionFrom(runConfig)
          const friends = await cachedCall<OnebotFriend[]>({
            deps,
            key: 'friends:list',
            label: '好友列表',
            session,
            run: (i) => i.getFriendList(),
          })
          if (!friends.ok) return friends.error
          const list = Array.isArray(friends.data) ? friends.data : []

          const uid = String(input.user_id ?? '').trim()
          if (uid) {
            if (!/^\d+$/.test(uid)) return 'QQ 号看起来不对。'
            const hit = list.find((f) => String(f.user_id) === uid)
            if (!hit) {
              return `QQ ${uid} 不在你的好友列表里（可能是群友或陌生人）。你一共有 ${list.length} 个好友。`
            }
            const bits = [`QQ ${uid} 是你的好友。`]
            if (hit.nickname) bits.push(`昵称：${truncate(hit.nickname, 30)}`)
            if (hit.remark?.trim()) bits.push(`备注：${truncate(hit.remark, 30)}`)
            const cat = categoryOf(hit)
            if (cat) bits.push(`分组：${truncate(cat, 20)}`)
            if (typeof hit.level === 'number' && hit.level > 0) bits.push(`QQ 等级：${hit.level}`)
            return bits.join('\n')
          }

          const keyword = String(input.keyword ?? '').trim()
          if (!keyword) {
            return `你一共有 ${list.length} 个好友。想定位具体的人，可以按 QQ 号或昵称/备注里的关键词再看一次。`
          }

          const lower = keyword.toLowerCase()
          const matched = sortFriends(
            list.filter((f) => {
              const hay = `${f.nickname ?? ''}\n${f.remark ?? ''}\n${f.qid ?? ''}`.toLowerCase()
              return hay.includes(lower)
            }),
          )
          if (matched.length === 0) {
            return `你的 ${list.length} 个好友里没有匹配「${truncate(keyword, 30)}」的。`
          }

          const max = Math.max(1, Math.min(deps.config.user.friendLimit || 10, 100))
          const want = Math.floor(input.limit ?? max)
          const limit = Math.max(1, Math.min(Number.isFinite(want) ? want : max, max))
          const show = matched.slice(0, limit)
          const lines = [`共 ${list.length} 个好友，匹配「${truncate(keyword, 30)}」的有 ${matched.length} 个：`]
          show.forEach((f, i) => lines.push(`${i + 1}. ${friendLine(f)}`))
          if (matched.length > show.length) {
            lines.push(`……还有 ${matched.length - show.length} 个没列出来（换个更精确的关键词，或者把 limit 调大一点，就能看到更多）。`)
          }
          lines.push(`- ${PERCEPTION_NOTE}。`)
          return lines.join('\n')
        },
        {
          name: 'friend_search',
          description: [
            '你能在自己账号的好友名单里找人，也能判断某个人是不是你的好友。',
            '',
            '当有人问"你是不是加了我好友""你的好友里有没有 XX""帮我找找备注叫 XX 的人"时使用。',
            '- user_id：填 QQ 号，精确判断是不是好友，并给出备注/分组。',
            '- keyword：按昵称或备注模糊找，最多列 limit 个。',
            '- 两者都不填时只告诉你好友总数。',
            `- ${PERCEPTION_NOTE}。`,
          ].join('\n'),
          schema: z.object({
            user_id: z.string().optional().describe('要判断的 QQ 号'),
            keyword: z.string().optional().describe('按昵称/备注模糊查找'),
            limit: z.number().int().min(1).max(100).optional().describe('最多列几个（默认按配置）'),
          }),
        },
      ),
  }),
}