import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import type { ChatLunaTool } from 'koishi-plugin-chatluna/llm-core/platform/types'
import { userAvatarUrls } from './avatar'
import { buildAvatarObservation, cachedCall, onebotAuthorization, PERCEPTION_NOTE, sessionFrom, ToolDeps } from './common'
import { fmtTsLoose, fmtTsRel, pushIfLine, qqLevelCN, sexCN, truncate } from './format'
import { NapProfileReactionResult, NapStrangerInfo, rawGet, resolveDefaultUserId } from './napi'

// ─────────────────────────────────────────────
// 用户域工具（设计文档 §4）
// ─────────────────────────────────────────────

const userIdSchema = z
  .string()
  .optional()
  .describe('目标 QQ 号；留空则默认为当前消息发送者（私聊即对方）')

const userIdSchemaSelf = z
  .string()
  .optional()
  .describe('目标 QQ 号；留空则查询机器人自己')

function meta(tags: string[]): NonNullable<ChatLunaTool['meta']> {
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

export const userToolDefs: Record<string, (deps: ToolDeps) => ChatLunaTool> = {
  // §4.1
  user_profile: (deps) => ({
    description: '你看到的 TA 的 QQ 资料卡（好友/群友/陌生人通用）',
    selector: () => true,
    authorization: onebotAuthorization,
    meta: meta(['user', 'profile']),
    createTool: () =>
      tool(
        async (input: { user_id?: string }, runConfig) => {
          const session = sessionFrom(runConfig)
          const uid = resolveDefaultUserId(session, input.user_id)
          if (!uid) return '未提供 user_id，且当前会话没有可识别的目标用户。'
          const res = await cachedCall<NapStrangerInfo>({
            deps,
            key: `profile:${uid}`,
            label: '资料卡',
            session,
            run: (i) => i.getStrangerInfo(uid),
          })
          if (!res.ok) return res.error
          const p = res.data
          const lines: string[] = [`QQ 资料卡（${p.user_id || uid}）`]
          pushIfLine(lines, p.nickname, '昵称')
          pushIfLine(lines, sexCN(p.sex), '性别')
          pushIfLine(lines, p.age, '年龄')
          pushIfLine(lines, p.long_nick, '个性签名', (v) => truncate(String(v), 120))
          pushIfLine(lines, p.qqLevel, 'QQ等级', (v) => qqLevelCN(v) || String(v))
          pushIfLine(lines, p.reg_time, '注册时间', fmtTsRel)
          if (p.is_vip || p.is_years_vip || (p.vip_level ?? 0) > 0) {
            const vip = [`Lv.${p.vip_level ?? 0}`]
            if (p.is_years_vip) vip.push('年费')
            lines.push(`QQ会员: ${vip.join(' ')}`)
          }
          if ((p.birthday_year ?? 0) > 0) {
            lines.push(`生日: ${p.birthday_year}-${String(p.birthday_month ?? 0).padStart(2, '0')}-${String(p.birthday_day ?? 0).padStart(2, '0')}`)
          }
          pushIfLine(lines, p.homeTown, '家乡')
          const region = [p.province, p.city].filter(Boolean).join(' ')
          pushIfLine(lines, region, '所在地')
          pushIfLine(lines, p.college, '大学')
          pushIfLine(lines, p.interest, '兴趣标签', (v) => truncate(String(v), 80))
          pushIfLine(lines, p.remark, '我对TA的备注')
          if (lines.length === 1) return `未能从资料卡读取到 ${uid} 的公开信息（对方可能隐藏了资料）。`
          lines.push('（没列出来的项，说明对方没有公开、或我这边读不到，不代表异常）')
          return lines.join('\n')
        },
        {
          name: 'user_profile',
          description: [
            '你能看到任意 QQ 号的资料卡：昵称、性别、年龄、个性签名、QQ 等级、注册时间、会员状态、生日、家乡/所在地/大学/兴趣标签，以及你对 TA 的备注（是好友时才有）。',
            '',
            '当你想了解"某人是个什么样的账号"时使用。好友、群友、陌生人都能看。',
            '- user_id：要看的 QQ 号；留空就是此刻正在跟你说话的人。',
            '- 对方愿意公开多少取决于 TA 的隐私设置，因此看不到的项就是空的，不是出错。',
            '- 群内的头衔、入群时间这类"群内"信息不在资料卡里，要看那些用 member_detail。',
            `- ${PERCEPTION_NOTE}。`,
          ].join('\n'),
          schema: z.object({ user_id: userIdSchema }),
        },
      ),
  }),

  // §4.2（多模态）
  user_avatar: (deps) => ({
    description: '你亲眼看到的 TA 的头像',
    selector: () => true,
    authorization: onebotAuthorization,
    meta: meta(['user', 'avatar', 'vision']),
    createTool: () =>
      tool(
        async (input: { user_id?: string }, runConfig) => {
          const session = sessionFrom(runConfig)
          const uid = resolveDefaultUserId(session, input.user_id)
          if (!uid) return '未提供 user_id，且当前会话没有可识别的目标用户。'
          // 取昵称做说明（失败不影响看图）
          let name = uid
          const prof = await cachedCall<NapStrangerInfo>({
            deps,
            key: `profile:${uid}`,
            label: '资料卡',
            session,
            run: (i) => i.getStrangerInfo(uid),
          })
          if (prof.ok && prof.data?.nickname) name = `${prof.data.nickname} (${uid})`
          return (await buildAvatarObservation({
            deps,
            runConfig,
            // qlogo 只认 spec=0/40/100/140/640，写错（如 800）会 HTTP 400
            urls: userAvatarUrls(uid, deps.config.avatarSize),
            baseName: `user-${uid}`,
            what: `${name} 的 QQ 头像`,
            delivery: deps.config.avatarDelivery,
          })) as unknown as string
        },
        {
          name: 'user_avatar',
          description: [
            '你能亲眼看到某个 QQ 号现在的头像图片。',
            '',
            '当有人问"你看到我的头像是什么""评价一下 XX 的头像"时使用。',
            '- user_id：要看的 QQ 号；留空就是此刻正在跟你说话的人。',
            '- 图片会作为你实际看到的内容交给你：直接讲你看到的样子就好，不要说自己"调用了工具"或"拿到一个链接"。需要当前模型支持图片输入。',
            `- ${PERCEPTION_NOTE}。`,
          ].join('\n'),
          schema: z.object({ user_id: userIdSchema }),
        },
      ),
  }),

  // §4.3（只读查询）
  profile_reaction_stats: (deps) => ({
    description: '你看到的资料卡获赞情况',
    selector: () => true,
    authorization: onebotAuthorization,
    meta: meta(['user', 'reaction']),
    createTool: () =>
      tool(
        async (input: { user_id?: string; top?: number }, runConfig) => {
          const session = sessionFrom(runConfig)
          const isSelf = !input.user_id
          const params: Record<string, unknown> = { start: '0', count: String(Math.min(input.top ?? 5, 20)) }
          if (!isSelf) params.user_id = String(input.user_id)
          const res = await cachedCall<NapProfileReactionResult>({
            deps,
            key: `reaction-stats:${input.user_id ?? session?.selfId ?? 'self'}`,
            label: '资料卡互动数据',
            session,
            run: (i) => rawGet(i, 'get_profile_like', params),
          })
          if (!res.ok) return res.error
          const fav = res.data?.favoriteInfo || {}
          const vote = res.data?.voteInfo || {}
          deps.logger.debug(`资料卡互动原始返回：${JSON.stringify(res.data).slice(0, 600)}`)

          // 字段语义（据实机与 QQ 客户端对照校正）：
          //   voteInfo.total_count    = QQ 资料页顶部的「获赞总数」（实机 33147 ↔ 客户端 33147）
          //   favoriteInfo.today_count= 「今日获赞」
          //   favoriteInfo.total_count= 点赞过的人数（量级小于总赞数，且与 userInfos 同组）
          //   favoriteInfo.last_time  = 最近一次获赞时间，但实测会给出无意义的小数字 → 先归一化再决定要不要打印
          const who = isSelf ? '机器人自己' : `QQ ${input.user_id}`
          const lines = [`${who} 的资料卡互动数据`]
          const totalLikes = vote.total_count ?? fav.total_count
          pushIfLine(lines, totalLikes, '获赞总数')
          pushIfLine(lines, fav.today_count, '今日获赞')
          if (fav.today_count == null) pushIfLine(lines, vote.new_count, '今日新增')

          const lastTime = fmtTsLoose(fav.last_time)
          if (lastTime) lines.push(`最近一次获赞时间: ${lastTime}`)
          else if (fav.last_time != null) {
            deps.logger.debug(`资料卡 last_time 不是可信时间戳（原值 ${JSON.stringify(fav.last_time)}），已省略该行`)
          }

          if (fav.total_count != null && vote.total_count != null) {
            pushIfLine(lines, fav.total_count, '点赞人数')
          }
          const users = (fav.userInfos || []).slice(0, input.top ?? 5)
          if (users.length > 0) {
            lines.push(`最近点赞的人：${users.map((u) => `${u.nick || u.nickname || '匿名'} (${u.uin ?? ''})`).join('、')}`)
          }
          return lines.join('\n')
        },
        {
          name: 'profile_reaction_stats',
          description: [
            '你能看到某个 QQ 号资料卡的获赞情况：获赞总数、今日获赞、点赞人数、最近点赞的人。',
            '',
            '当有人问"我有多少赞""今天收到几个赞""TA 受欢迎吗"时使用。',
            '- user_id：留空就是你自己（机器人）的资料卡；填了就是看对方。',
            '- top：最近点赞的人显示几个。',
            '- 这里没有"今日排名"，别编名次；偶尔会有看不到的时候，可稍后再看。',
            `- ${PERCEPTION_NOTE}。`,
          ].join('\n'),
          schema: z.object({
            user_id: userIdSchemaSelf,
            top: z.number().int().min(1).optional().describe('最近点赞的人显示条数（默认 5）'),
          }),
        },
      ),
  }),
}
