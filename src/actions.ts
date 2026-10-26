import type { Context } from 'koishi'
import type { Config } from './config'
import type { SenseLogger } from './log'
import { ActionRecord, ActionState, actionKey, dayCounterKey, localDateKey } from './action-state'
import { canRawRequest, OneBotInternal, rawRequest } from './napi'

// ─────────────────────────────────────────────
// 主动工具的执行核心
//
// 设计要点：
// 1. 目标永远由 session 决定（群号 = session.guildId；点赞对象 = session.userId），
//    工具参数里不暴露任何可指定的目标 ID。
// 2. 群打卡与自动打卡共用同一个 `groupCheckin()` 和同一份状态，所以无论谁先触发，
//    当天都只会成功一次。
// 3. 所有动作串行执行（`ActionRuntime.enqueue`），避免同一进程内两个会话同时通过
//    "今天还没做过"的检查。
// 4. 具体错误原因从 NapCat 响应信封的 message 读取（`rawRequest`），而不是 `_get` 的 retcode。
// ─────────────────────────────────────────────

export interface ActionDeps {
  ctx: Context
  config: Config
  logger: SenseLogger
  state: ActionState
}

/** 只依赖 bot 的最小形状，便于离线测试伪造 */
export interface OneBotLikeBot {
  selfId: string
  platform: string
  internal?: OneBotInternal
}

export type ActionOutcomeStatus = 'ok' | 'already' | 'pending' | 'blocked' | 'failed' | 'offline'

export interface ActionOutcome {
  status: ActionOutcomeStatus
  text: string
  /** 失败分类，供自动打卡决定要不要中止整轮 */
  note?: 'packet' | 'group' | 'limit' | 'unreachable' | 'rate' | 'offline' | 'unknown'
}

export interface AutoCheckinSummary {
  total: number
  ok: number
  skipped: number
  failed: number
  note?:
    | 'disabled'
    | 'no-bot'
    | 'auto-list-empty'
    | 'whitelist-empty'
    | 'not-joined'
    | 'no-groups'
    | 'group-list-failed'
}

const PENDING_TTL_MS = 2 * 60 * 1000
const FAILED_COOLDOWN_MS = 60 * 1000

/** 群动作是否被白名单允许（白名单关闭 = 全部允许；开启且为空 = 全禁） */
export function isGroupActionAllowed(config: Config, guildId: string | undefined): boolean {
  const common = config.action.common
  if (!guildId) return false
  if (!common.whitelistEnabled) return true
  if (common.groups.length === 0) return false
  const gid = String(guildId).trim()
  return common.groups.some((id) => String(id).trim() === gid)
}

/** 从在线 bot 里挑一个真正能发原始请求的 onebot 实例（自动打卡用） */
export function pickOneBot(ctx: Context): OneBotLikeBot | undefined {
  const bots = ctx.bots.filter((bot) => bot.platform === 'onebot') as unknown as OneBotLikeBot[]
  return bots.find((bot) => canRawRequest(bot.internal))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function errorText(res: { message?: string; wording?: string; retcode: number }): string {
  const text = res.message || res.wording || ''
  return text.trim() || `错误码 ${res.retcode}`
}

function isPacketError(message: string): boolean {
  return /packetBackend|packet.*(不可用|失败|状态)/i.test(message)
}

/**
 * 「协议端没有这个 action」类错误。
 *
 * NapCat 里 `send_group_sign` 与 `set_group_sign` 是同一个实现的两个名字，但老版本/魔改版本
 * 可能只注册了其中一个（`group-sign` 插件一直用的是 set_group_sign）。命中这里时回退到另一个名字，
 * 而不是把一次本可以成功的打卡判死。
 */
function isUnsupportedAction(message: string): boolean {
  return /不支持的?\s*(api|action|接口|请求)|unknown\s*action|not\s*(supported|implemented)|no\s*such\s*action|1404/i.test(
    message,
  )
}

/** 打卡后核对：榜单里能不能看到 bot 自己（'unknown' = 榜单取不到，不能下结论） */
export type CheckinVerifyResult = 'ok' | 'missing' | 'unknown'

/**
 * 用 `get_group_signed_list` 核对机器人是否真的出现在今日打卡榜里。
 *
 * 为什么必须核对：`send_group_sign` 在 NapCat 里是 **fire-and-forget** 的 OIDB 包
 * （operationContext.GroupSign 只 sendOidbPacket(req)，不等待服务端响应），
 * `retcode === 0` 只代表「包交给协议端了」。把它当成打卡成功，一旦包被丢弃/群没开签到，
 * 当天就会被状态锁死、再也不会重试——这正是「模型说打了，榜上却没有」的来源。
 */
export async function verifyGroupCheckin(
  bot: OneBotLikeBot,
  groupId: string,
  opts: { delayMs?: number; logger?: SenseLogger } = {},
): Promise<CheckinVerifyResult> {
  const internal = bot.internal
  if (!canRawRequest(internal)) return 'unknown'
  await sleep(Math.max(0, opts.delayMs ?? 2000))
  const res = await rawRequest(internal, 'get_group_signed_list', { group_id: groupId }, 8000)
  if (res.retcode !== 0) {
    opts.logger?.debug?.(`打卡核对：读不到今日打卡榜（${errorText(res)}），按"请求已受理"处理`)
    return 'unknown'
  }
  const raw = res.data as any
  const list: any[] | undefined = Array.isArray(raw) ? raw : Array.isArray(raw?.list) ? raw.list : undefined
  if (!list) {
    opts.logger?.debug?.('打卡核对：打卡榜返回结构无法识别，按"请求已受理"处理')
    return 'unknown'
  }
  const selfId = String(bot.selfId ?? '')
  const found = list.some((item) => String(item?.user_id ?? item?.uin ?? '') === selfId)
  return found ? 'ok' : 'missing'
}

function isLikeLimit(message: string): boolean {
  return /上限/.test(message)
}

function isLikeUnreachable(message: string): boolean {
  return /账号转换失败/.test(message)
}

function isRateLimited(message: string): boolean {
  return /频繁|频率|太快|操作过快/.test(message)
}

/** 命中"当天已做过"时给模型的提示；成功/失败/冷却文案也在这里统一 */
function blockedByRecord(rec: ActionRecord | undefined, today: string, kind: 'sign' | 'like'): ActionOutcome | undefined {
  if (!rec || rec.date !== today) return undefined
  const now = Date.now()
  if (rec.status === 'ok') {
    return {
      status: 'already',
      text:
        kind === 'sign'
          ? '这个群今天已经打过卡了，一天一次就够啦。'
          : '今天已经给你点过赞了，明天再来吧。',
    }
  }
  if (rec.status === 'blocked') {
    return {
      status: 'already',
      text:
        kind === 'sign'
          ? '这个群今天已经打过卡了，一天一次就够啦。'
          : /账号|转换/.test(rec.note ?? '')
            ? '这个账号今天点不了赞（QQ 对陌生账号有限制），明天再看吧。'
            : '今天给你点赞的次数已经到上限了，明天再来吧。',
    }
  }
  if (rec.status === 'pending' && now - rec.at < PENDING_TTL_MS) {
    return {
      status: 'pending',
      text: kind === 'sign' ? '这个群的打卡正在处理中，稍等一下。' : '正在给你点赞，稍等一下。',
    }
  }
  if (rec.status === 'failed' && now - rec.at < FAILED_COOLDOWN_MS) {
    return {
      status: 'failed',
      text:
        kind === 'sign'
          ? '刚刚尝试过打卡但没成功，等一会儿再试。'
          : '刚才点赞没成功，等一会儿再试。',
      note: 'unknown',
    }
  }
  return undefined
}

/**
 * 主动动作运行时：串行队列 + 具体动作。
 * 群打卡和自动打卡都通过同一个实例执行，因此状态天然共享。
 */
export class ActionRuntime {
  /** 串行链：所有动作排队执行，避免并发下"当天一次"被同时通过 */
  private chain: Promise<unknown> = Promise.resolve()

  constructor(public readonly deps: ActionDeps) {}

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(
      () => fn(),
      () => fn(),
    )
    this.chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * 群打卡：只能给传入的群号打卡（调用方只会传 session.guildId）。
   * source 仅用于日志区分"模型调用"与"自动打卡"。
   */
  groupCheckin(bot: OneBotLikeBot, groupId: string, source: 'tool' | 'auto' = 'tool'): Promise<ActionOutcome> {
    return this.enqueue(() => this.doGroupCheckin(bot, groupId, source))
  }

  /** 资料卡点赞：只能给传入的 userId 点赞（调用方只会传 session.userId） */
  like(bot: OneBotLikeBot, userId: string, source: 'tool' | 'auto' = 'tool'): Promise<ActionOutcome> {
    return this.enqueue(() => this.doLike(bot, userId, source))
  }

  private async doGroupCheckin(bot: OneBotLikeBot, rawGroupId: string, source: 'tool' | 'auto'): Promise<ActionOutcome> {
    const { config, logger, state } = this.deps
    const groupId = String(rawGroupId ?? '').trim()
    if (!/^\d+$/.test(groupId)) {
      return { status: 'failed', text: '群号看起来不对，没法打卡。', note: 'group' }
    }
    if (!isGroupActionAllowed(config, groupId)) {
      return { status: 'blocked', text: '这个群不在允许主动操作的名单里。', note: 'group' }
    }
    const internal = bot.internal
    if (!canRawRequest(internal)) {
      return { status: 'offline', text: '我现在连不上 QQ，等连接恢复后再试。', note: 'offline' }
    }

    const selfId = String(bot.selfId ?? '')
    const today = localDateKey()
    const key = actionKey({
      platform: bot.platform || 'onebot',
      selfId,
      action: 'group_checkin',
      scope: 'group',
      id: groupId,
    })

    const previous = await state.get(key)
    const blocked = blockedByRecord(previous, today, 'sign')
    if (blocked) return blocked

    await state.set(key, { date: today, at: Date.now(), status: 'pending' })

    // 显式传字符串：NapCat 的 payload schema 是 Type.String()
    let res = await rawRequest(internal, 'send_group_sign', { group_id: groupId })
    // 兼容只注册了 go-cqhttp 名字的协议端（group-sign 插件用的就是 set_group_sign）
    if (res.retcode !== 0 && isUnsupportedAction(errorText(res))) {
      logger.info(`主动打卡：群 ${groupId} 的 send_group_sign 不可用，回退 set_group_sign（${source}）`)
      res = await rawRequest(internal, 'set_group_sign', { group_id: groupId })
    }
    if (res.retcode === 0) {
      // 请求受理 ≠ 打卡成功：NapCat 发包后不等待服务端响应，必须用榜单核对（除非用户关掉 verify）
      const verifyEnabled = config.action.checkin.verify !== false
      const verified = verifyEnabled
        ? await verifyGroupCheckin(bot, groupId, { logger })
        : ('unknown' as CheckinVerifyResult)

      if (verified === 'missing') {
        await state.set(key, { date: today, at: Date.now(), status: 'failed', note: '打卡榜上没有我' })
        logger.warn(`主动打卡：群 ${groupId} 请求已受理，但今日打卡榜上没有看到自己（${source}）`)
        return {
          status: 'failed',
          text: '打卡请求已经发出去了，但今日打卡榜上暂时还没看到我（可能榜单还没刷新）。过一会儿可以再试一次。',
          note: 'unknown',
        }
      }

      await state.set(key, verified === 'ok'
        ? { date: today, at: Date.now(), status: 'ok', verified: true }
        : { date: today, at: Date.now(), status: 'ok' })
      logger.info(
        `主动打卡：群 ${groupId} 已发送打卡请求（${source}）` +
          (verified === 'ok' ? '，已在今日打卡榜核对到自己' : '，榜单不可用未核对'),
      )
      return {
        status: 'ok',
        text: verified === 'ok'
          ? '已经打卡成功了，今天的打卡榜上能看到我。'
          : '已经发出打卡请求。QQ 不会返回打卡结果：如果今天早些时候已经打过，这次不会再有额外效果。',
      }
    }

    const reason = errorText(res)
    await state.set(key, { date: today, at: Date.now(), status: 'failed', note: reason })
    logger.warn(`主动打卡：群 ${groupId} 失败（${source}）：${reason}`)

    if (isPacketError(reason)) {
      return {
        status: 'failed',
        text: '现在群打卡不可用：协议端的打卡服务（PacketBackend）没有开启，需要管理员在 NapCat 高级配置里打开后再试。',
        note: 'packet',
      }
    }
    return {
      status: 'failed',
      text: `这次打卡没发出去（${reason}）。可以稍后再试。`,
      note: /群/.test(reason) ? 'group' : 'unknown',
    }
  }

  private async doLike(bot: OneBotLikeBot, rawUserId: string, source: 'tool' | 'auto'): Promise<ActionOutcome> {
    const { config, logger, state } = this.deps
    const userId = String(rawUserId ?? '').trim()
    const selfId = String(bot.selfId ?? '')
    if (!/^\d+$/.test(userId) || userId === selfId) {
      return { status: 'failed', text: '目标账号看起来不对，没法点赞。', note: 'unreachable' }
    }

    const internal = bot.internal
    if (!canRawRequest(internal)) {
      return { status: 'offline', text: '我现在连不上 QQ，等连接恢复后再试。', note: 'offline' }
    }

    const today = localDateKey()
    const key = actionKey({
      platform: bot.platform || 'onebot',
      selfId,
      action: 'profile_like',
      scope: 'private',
      id: userId,
    })

    const previous = await state.get(key)
    const blocked = blockedByRecord(previous, today, 'like')
    if (blocked) return blocked

    // 当天全局上限：防止大量陌生私聊/群聊各要一次赞
    const counterKey = dayCounterKey({
      platform: bot.platform || 'onebot',
      selfId,
      action: 'profile_like',
      date: today,
    })
    const counter = await state.get(counterKey)
    const used = counter && counter.date === today ? counter.count ?? 0 : 0
    const maxPerDay = Math.max(1, Math.floor(config.action.like.maxPerDay || 20))
    if (used >= maxPerDay) {
      return { status: 'blocked', text: '今天点赞的次数已经用完了，明天再来吧。', note: 'limit' }
    }

    await state.set(key, { date: today, at: Date.now(), status: 'pending' })

    const times = Math.max(1, Math.min(20, Math.floor(config.action.like.times || 10)))
    const res = await rawRequest(internal, 'send_like', { user_id: userId, times })
    if (res.retcode === 0) {
      await state.set(key, { date: today, at: Date.now(), status: 'ok' })
      await state.set(counterKey, { date: today, at: Date.now(), status: 'ok', count: used + 1 })
      logger.info(`主动点赞：QQ ${userId} 已受理（${source}，times=${times}）`)
      return { status: 'ok', text: '已经给你点过赞啦。' }
    }

    const reason = errorText(res)
    logger.warn(`主动点赞：QQ ${userId} 失败（${source}）：${reason}`)

    if (isLikeLimit(reason)) {
      await state.set(key, { date: today, at: Date.now(), status: 'blocked', note: reason })
      return { status: 'blocked', text: '今天给你点的赞已经到上限了，明天再来吧。', note: 'limit' }
    }
    if (isLikeUnreachable(reason)) {
      await state.set(key, { date: today, at: Date.now(), status: 'blocked', note: reason })
      return {
        status: 'blocked',
        text: '我这边还认不出这个账号，可能没法点赞（QQ 对陌生人有限制）。',
        note: 'unreachable',
      }
    }
    if (isRateLimited(reason)) {
      await state.set(key, { date: today, at: Date.now(), status: 'failed', note: reason })
      return { status: 'failed', text: '刚才操作太快被拦了一下，等一会儿再试。', note: 'rate' }
    }

    await state.set(key, { date: today, at: Date.now(), status: 'failed', note: reason })
    return { status: 'failed', text: `这次点赞没成功（${reason}），等会儿再试。`, note: 'unknown' }
  }
}

/** 自动打卡用：拿 bot 已加入的群号集合；拿不到返回 undefined（调用方决定降级策略） */
async function fetchJoinedGroups(bot: OneBotLikeBot): Promise<Set<string> | undefined> {
  const internal = bot.internal
  if (!internal || typeof internal.getGroupList !== 'function') return undefined
  try {
    const list = await internal.getGroupList()
    if (!Array.isArray(list)) return undefined
    return new Set(list.map((g) => String(g.group_id)).filter((id) => /^\d+$/.test(id)))
  } catch {
    return undefined
  }
}

/**
 * 自动打卡要处理的群：
 * 1. 只认 `auto.groups` 这个独立列表（留空 = 不自动打卡，绝不再枚举"全部群"）；
 * 2. 群白名单开启时还要与白名单取交集（防止自动打卡绕过主动工具白名单）；
 * 3. 能拿到 bot 群列表时，再过滤掉已经不在的群；拿不到就用列表本身。
 */
export async function resolveAutoGroups(
  runtime: ActionRuntime,
  bot: OneBotLikeBot,
): Promise<{ groups: string[]; note?: AutoCheckinSummary['note'] }> {
  const { common, checkin } = runtime.deps.config.action
  const cap = Math.max(1, Math.floor(checkin.auto.maxGroups || 50))
  const configured = checkin.auto.groups
    .map((id) => String(id).trim())
    .filter((id) => /^\d+$/.test(id))

  // 独立列表为空：明确不自动打卡（不要回退到"所有群"）
  if (configured.length === 0) return { groups: [], note: 'auto-list-empty' }

  const allowed = configured.filter((id) => isGroupActionAllowed(runtime.deps.config, id))
  if (allowed.length === 0) {
    return { groups: [], note: common.whitelistEnabled ? 'whitelist-empty' : 'no-groups' }
  }

  const joined = await fetchJoinedGroups(bot)
  const list = joined ? allowed.filter((id) => joined.has(id)) : allowed
  if (list.length === 0) return { groups: [], note: 'not-joined' }
  if (list.length > cap) {
    runtime.deps.logger.warn(`自动打卡：自动打卡列表 ${list.length} 个群超过上限 ${cap}，本次只处理前 ${cap} 个`)
  }
  return { groups: list.slice(0, cap) }
}

/** 跑一轮自动打卡（供调度器与冒烟直接调用） */
export async function runAutoCheckin(runtime: ActionRuntime): Promise<AutoCheckinSummary> {
  const { config, ctx, logger } = runtime.deps
  const auto = config.action.checkin.auto
  if (!auto.enabled) return { total: 0, ok: 0, skipped: 0, failed: 0, note: 'disabled' }

  const bot = pickOneBot(ctx)
  if (!bot) {
    logger.debug('自动打卡：没有在线的 onebot 实例，等连接后再试')
    return { total: 0, ok: 0, skipped: 0, failed: 0, note: 'no-bot' }
  }

  const { groups, note } = await resolveAutoGroups(runtime, bot)
  if (!groups.length) {
    if (note === 'auto-list-empty') {
      logger.warn('自动打卡已开启，但自动打卡群列表为空：按配置不会自动打卡（不会回退到全部群）')
    } else if (note === 'whitelist-empty') {
      logger.warn('自动打卡：自动打卡列表里的群都不在主动工具白名单内，本轮跳过')
    } else if (note === 'not-joined') {
      logger.warn('自动打卡：自动打卡列表里的群都不在当前 bot 已加入的群中，本轮跳过')
    } else if (note === 'group-list-failed') {
      logger.warn('自动打卡：拿不到群列表，本轮跳过')
    }
    return { total: 0, ok: 0, skipped: 0, failed: 0, note: note ?? 'no-groups' }
  }

  let ok = 0
  let skipped = 0
  let failed = 0
  for (const groupId of groups) {
    const outcome = await runtime.groupCheckin(bot, groupId, 'auto')
    if (outcome.status === 'ok') ok++
    else if (outcome.status === 'already' || outcome.status === 'pending') skipped++
    else failed++

    if (outcome.status === 'offline') break
    if (outcome.note === 'packet') {
      logger.warn('自动打卡：PacketBackend 不可用，本轮中止（其余群不再尝试）')
      break
    }
    // 群与群之间拉开一点间隔，避免同一时刻连续发包
    if (groupId !== groups[groups.length - 1]) {
      const gap = Math.max(0, Math.floor(auto.intervalSeconds || 3)) * 1000 + Math.floor(Math.random() * 1500)
      await sleep(gap)
    }
  }

  logger.info(`自动打卡完成：${groups.length} 个群，成功 ${ok}，跳过 ${skipped}，失败 ${failed}`)
  return { total: groups.length, ok, skipped, failed }
}