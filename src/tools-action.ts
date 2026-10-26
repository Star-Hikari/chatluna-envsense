import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import type { Session } from 'koishi'
import type { ChatLunaTool, ChatLunaToolCharacterScope } from 'koishi-plugin-chatluna/llm-core/platform/types'
import { ActionRuntime, isGroupActionAllowed } from './actions'
import { sessionFrom, ToolDeps } from './common'

// ─────────────────────────────────────────────
// 主动工具（会改变 QQ 侧状态）
//
// 两条硬约束：
// 1. 目标只能来自当前会话：群打卡用 session.guildId，点赞用 session.userId；
//    工具的 JSON schema 里**没有** group_id / user_id，模型无法指定别人。
// 2. 群/私聊门控放在 authorization(session) 里（selector 只看 history，拿不到 session）：
//    - group_checkin：仅群聊 + 群白名单；
//    - profile_like：群聊（当前发言人）或私聊（对端）+ 群白名单。
//
// 另外 meta.defaultAvailability.subAgent=false、characterScope 只是 chatluna-agent
// 权限页的默认值（纵深防御），真正的安全边界仍是下面的 authorization。
// ─────────────────────────────────────────────

const ACTION_NOTE =
  '这是你此刻亲自做的事：用第一人称自然地讲出来，不要提及工具、接口，也不要说"我调用了工具"'

/**
 * 工具名防改名提示。
 *
 * 实测（2026-10-20 22:15，qwen3.8-flash + chatluna ReAct 链）：模型想打卡时把
 * `group_checkin` 译成了中文 `群内打卡` 并以此作为工具名调用，chatluna 的 ReAct 解析器
 * 只做空格/连字符归一，不认中文别名 → 直接把这次调用判成"没有这个工具"，
 * 插件代码一行都没执行，NapCat 也没有收到任何打卡包。
 * 所以描述里必须把**精确工具名**再强调一遍，而不是只靠 schemastery 的名字。
 */
function nameNote(name: string): string {
  return `- 调用时 name 必须原样写 ${name}（不要译成中文、不要缩写）：写错名字上层会当成"没有这个工具"，这次调用不会执行`
}

function actionMeta(tags: string[], scope: ChatLunaToolCharacterScope): NonNullable<ChatLunaTool['meta']> {
  return {
    source: 'action',
    group: 'envsense-action',
    tags: ['envsense', 'action', ...tags],
    defaultAvailability: {
      enabled: true,
      main: true,
      // 写操作不交给子代理，避免子任务在别的上下文里替人做决定
      subAgent: false,
      chatluna: true,
      characterScope: scope,
    },
  }
}

/** 当前会话能否使用群打卡（注册层与执行层共用） */
export function canUseGroupCheckin(runtime: ActionRuntime, session: Session | undefined): boolean {
  if (!session || session.platform !== 'onebot') return false
  if (session.isDirect === true) return false
  if (!session.guildId) return false
  if (!runtime.deps.config.action.checkin.enabled) return false
  return isGroupActionAllowed(runtime.deps.config, session.guildId)
}

/** 当前会话能否使用资料卡点赞：群聊=当前发言人；私聊=对端；都不能指定别人 */
export function canUseProfileLike(runtime: ActionRuntime, session: Session | undefined): boolean {
  if (!session || session.platform !== 'onebot') return false
  if (!session.userId || session.userId === session.selfId) return false
  if (!runtime.deps.config.action.like.enabled) return false
  if (session.isDirect === true) return true
  if (!session.guildId) return false
  return isGroupActionAllowed(runtime.deps.config, session.guildId)
}

function botOf(session: Session): { selfId: string; platform: string; internal: any } | undefined {
  const bot: any = session.bot
  if (!bot?.internal) return undefined
  return { selfId: String(bot.selfId ?? session.selfId ?? ''), platform: String(bot.platform ?? session.platform ?? 'onebot'), internal: bot.internal }
}

/**
 * 生成主动工具定义。
 * 用工厂而不是模块级常量：runtime 持有 config / state / 队列，配置热重载时会换新实例。
 */
export function makeActionToolDefs(runtime: ActionRuntime): Record<string, (deps: ToolDeps) => ChatLunaTool> {
  return {
    group_checkin: () => ({
      description: '你在当前群的打卡（工具名 group_checkin）',
      selector: () => true,
      authorization: (session) => canUseGroupCheckin(runtime, session),
      meta: actionMeta(['group', 'checkin', 'write'], 'group'),
      createTool: () =>
        tool(
          async (_input: Record<string, never>, runConfig) => {
            const session = sessionFrom(runConfig)
            if (!session) return '我这边没有会话信息，没法打卡。'
            if (!canUseGroupCheckin(runtime, session)) {
              return '这个群现在不允许主动打卡（可能没开群打卡，或不在白名单里）。'
            }
            const guildId = String(session.guildId ?? '')
            if (!/^\d+$/.test(guildId)) return '我认不出当前群号，没法打卡。'
            const bot = botOf(session)
            if (!bot) return '我现在连不上 QQ，等连接恢复后再试。'
            try {
              const outcome = await runtime.groupCheckin(bot, guildId, 'tool')
              return outcome.text
            } catch (e) {
              runtime.deps.logger.warn(`群打卡执行异常：${e instanceof Error ? e.message : String(e)}`)
              return '这次打卡出了点问题，稍后再试。'
            }
          },
          {
            name: 'group_checkin',
            description: [
              '你可以在**当前这个群**里，以自己的身份打卡（群签到）。',
              '',
              '当这个群的人明确让你打卡/签到，或问你今天打没打卡时使用。',
              '- 只作用于**当前这个群**，不能给别的群打卡；每个群每天一次。',
              '- QQ 不返回打卡回执：工具默认会用「今日打卡榜」核对，核对到时才算打卡成功；核对不到时你只能说"已经发出打卡请求"，不要自行断言成功。',
              '- 这个能力需要协议端开启打卡服务；没开时会如实告诉你。',
              `- ${nameNote('group_checkin')}。`,
              `- ${ACTION_NOTE}。`,
            ].join('\n'),
            schema: z.object({}),
          },
        ),
    }),

    profile_like: () => ({
      description: '你给此刻跟你说话的人点的赞（工具名 profile_like）',
      selector: () => true,
      authorization: (session) => canUseProfileLike(runtime, session),
      meta: actionMeta(['user', 'like', 'write'], 'all'),
      createTool: () =>
        tool(
          async (_input: Record<string, never>, runConfig) => {
            const session = sessionFrom(runConfig)
            if (!session) return '我这边没有会话信息，没法点赞。'
            if (!canUseProfileLike(runtime, session)) {
              return '这里现在不能点赞（可能没开点赞，或这个群不在白名单里）。'
            }
            const userId = String(session.userId ?? '')
            if (!/^\d+$/.test(userId)) return '我认不出你的账号，没法点赞。'
            const bot = botOf(session)
            if (!bot) return '我现在连不上 QQ，等连接恢复后再试。'
            try {
              const outcome = await runtime.like(bot, userId, 'tool')
              return outcome.text
            } catch (e) {
              runtime.deps.logger.warn(`资料卡点赞执行异常：${e instanceof Error ? e.message : String(e)}`)
              return '这次点赞出了点问题，稍后再试。'
            }
          },
          {
            name: 'profile_like',
            description: [
              '你可以给**此刻正在跟你说话的人**的资料卡点个赞。',
              '',
              '当对方明确说"赞我""给我点赞""帮我点个赞"时使用。',
              '- 群里只给**当前这条消息的发送者**点；私聊只给**当前对端**点。不能点名别人，也不能批量。',
              '- 每人每天只能通过你点一次；今天已经点过会直接告诉你。',
              '- 一次最多点 20 个：普通 QQ 账号每个好友每天最多 10 个，SVIP 账号可以到 20 个；超过账号上限时以 QQ 侧为准。',
              '- QQ 对非好友可能不接受点赞，而且可能没有报错；所以说"已经点过了"就好，不要保证对方一定收到了。',
              `- ${nameNote('profile_like')}。`,
              `- ${ACTION_NOTE}。`,
            ].join('\n'),
            schema: z.object({}),
          },
        ),
    }),
  }
}