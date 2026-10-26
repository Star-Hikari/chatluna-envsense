import type { ChatLunaTool } from 'koishi-plugin-chatluna/llm-core/platform/types'
import { Context, h } from 'koishi'
import type { Notifier } from '@koishijs/plugin-notifier' // 类型增强：ctx.notifier（可选服务，运行期不 import）
import 'koishi-plugin-chatluna' // 确保 Context.chatluna 类型扩展被加载
import { createLogger } from 'koishi-plugin-chatluna/utils/logger'
import { Config } from './config'
import { ToolDeps } from './common'
import { createSenseLogger } from './log'
import { createApiLimiter, TtlCache } from './napi'
import { MinimalStorageService } from './avatar'
import { groupToolDefs } from './tools-group'
import { userToolDefs } from './tools-user'
import { forwardToolDefs, registerQuoteForwardFix } from './tools-forward'
import { ActionState } from './action-state'
import { ActionRuntime } from './actions'
import { startAutoCheckin } from './auto-checkin'
import { makeActionToolDefs } from './tools-action'

export const name = 'chatluna-envsense'
// required/optional 会被控制台插件页自动渲染为"必需服务/可选服务（已加载）"状态行（memes-api 模式）
// chatluna_storage 来自 chatluna-storage-service：装了就让头像转存临时文件，没装自动降级 base64 内联
// database 只用于主动工具的"当天一次"状态持久化；没装时自动退化为内存
export const inject = { required: ['chatluna'], optional: ['notifier', 'chatluna_storage', 'database'] }

export { Config } from './config'
// 日志门面也导出：便于冒烟测试直接验证 debug 门控，其它插件想沿用同一套
// "debug 控制过程日志、warn/error 始终输出"的策略时也可以复用。
export { createSenseLogger } from './log'
export type { SenseLogger } from './log'
// 主动工具的纯函数也导出：冒烟测试直接验证"本地日期/白名单/排期"，不依赖真实定时器
export { actionKey, localDateKey } from './action-state'
export { isGroupActionAllowed } from './actions'
export { computeNextRun, isDailyTimePassed } from './auto-checkin'
export { startAutoCheckin } from './auto-checkin'
// 供冒烟/诊断构造离线 runtime（不经过 Koishi 生命周期）
export { ActionRuntime, resolveAutoGroups, runAutoCheckin } from './actions'
export { ActionState } from './action-state'
export { createApiLimiter } from './napi'

// 控制台「使用说明」页。控制台用 k-markdown 的 unsafe 模式渲染 usage，可内嵌 <style>。
// 只放简介：具体工具、配置项、投递方式都不在这里展开（配置页自己会渲染，README 里有完整说明）。
export const usage = `
<style>
.markdown .envsense-usage { line-height: 1.8; color: var(--fg1); }
.markdown .envsense-usage p { margin: .6em 0; }
.markdown .envsense-usage strong { color: var(--fg1); font-weight: 600; }
.markdown .envsense-usage code { color: var(--fg1); font-weight: 600; padding: .12em .45em; background: var(--k-color-primary-fade); border-radius: 4px; }
.markdown .envsense-usage .note { margin-top: .9em; padding: .6em .95em; border-left: 3px solid var(--k-color-primary); background: var(--k-color-primary-fade); border-radius: 0 6px 6px 0; font-size: .96em; }
</style>

<div class="envsense-usage">

<p><strong>ChatLuna 环境感知扩展</strong>：为 Agent（plugin 模式）提供一组<strong>环境感知工具</strong>，让模型按需了解自己所在的群、群成员、群公告、群荣誉 / 精华 / 打卡，以及某个 QQ 的资料卡、头像与获赞情况。</p>

<p>查询工具<strong>只读</strong>，平时<strong>不注入任何提示词</strong>：不看就不花 token。另有默认关闭的<strong>主动工具</strong>（当前群打卡、给当前发言人/私聊对象点赞），只作用于当前会话环境，并受白名单与"每天一次"约束。全部仅 <strong>NapCat（onebot）</strong> 生效。</p>

<div class="note">在下方配置里可以逐项开关工具、调整缓存与图片投递方式；主动工具默认关闭，打开 <code>debug</code> 可查看详细日志。</div>

</div>
`.trim()

/** 控制台状态卡片快照（notifier 为可选服务，晚到时用最近快照补渲染） */
interface StatusSnapshot {
  type: 'primary' | 'success' | 'warning' | 'danger'
  lines: string[]
}

/** 日志/状态卡片里的工具清单：最多列前 5 个，其余省略，避免刷屏 */
function briefList(names: string[], max = 5): string {
  if (names.length <= max) return names.join('、')
  return `${names.slice(0, max).join('、')} 等 ${names.length} 个`
}

export function apply(ctx: Context, config: Config) {
  const logger = createLogger(ctx, 'chatluna-envsense')
  // 详细日志门面：debug 关闭时 info/debug 静默，只留 warn/error（报错类）
  const slog = createSenseLogger(logger, () => config.debug === true)

  // 主动工具的"当天一次"状态：默认内存；装了 database 就持久化（重启不重复）。
  // 没有 database 时 apply 仍可正常工作，只是重启后会忘记今天做过什么。
  const actionState = new ActionState(slog)
  const actionRuntime = new ActionRuntime({ ctx, config, logger: slog, state: actionState })
  // 只读查询的并发闸门 + 同 key in-flight 去重：多会话同时查 NapCat 时不会无限并发/重复请求
  const apiLimiter = createApiLimiter(4)
  const inflight = new Map<string, Promise<any>>()
  // 只有真的开了主动能力才建表/注入 database，默认配置下不碰数据库
  if (config.action.checkin.enabled || config.action.like.enabled || config.action.checkin.auto.enabled) {
    ctx.inject(['database'], (ctx) => {
      actionState.attachDatabase(ctx)
    })
  }

  // 就绪摘要所需的两个状态：注册结果 + NapCat 版本（版本可能要等 bot 连上才知道）
  let readySummary: { count: number; quoteFix: boolean; actionCount: number; auto: boolean } | null = null
  let napCatVersion = ''
  let versionProbeDone = false
  let readyLogged = false
  /** 关闭 debug 时也保留的**一行**就绪信息；等版本探测有结论后再打，避免打两条 */
  const flushReady = () => {
    if (readyLogged || !readySummary || !versionProbeDone) return
    readyLogged = true
    const parts = [
      `${readySummary.count} 个工具`,
      readySummary.actionCount > 0 ? `主动工具 ${readySummary.actionCount} 个` : '',
      readySummary.auto ? '自动打卡已开启' : '',
      readySummary.quoteFix ? '引用合并消息修复已开启' : '',
      `缓存 ${config.cacheTtlSeconds}s`,
      `头像 ${config.avatarDelivery}`,
      // napCatVersion 已含名字（实测 app_name 是 "NapCat.Onebot"），此处不要再补前缀
      napCatVersion,
    ].filter(Boolean)
    logger.info(`chatluna-envsense 已就绪：${parts.join(' · ')}`)
  }

  // ── 控制台状态卡片（memes-api 模式：notifier 可选注入 + 注册结果摘要） ──
  let notifier: Notifier | undefined
  let lastStatus: StatusSnapshot = { type: 'primary', lines: ['chatluna-envsense 初始化中……'] }
  const setStatus = (type: StatusSnapshot['type'], ...lines: string[]) => {
    lastStatus = { type, lines }
    notifier?.update({ type, content: lines.map((l) => h('p', l)) })
  }
  // notifier 服务可能晚于 apply 就绪：就绪时用最近一次快照补渲染
  ctx.inject(['notifier'], () => {
    notifier = ctx.notifier.create({ type: lastStatus.type, content: lastStatus.lines.map((l) => h('p', l)) })
  })

  // chatluna_storage 可选服务（chatluna-storage-service）：头像类工具用它把图片转存成
  // 临时文件再交给模型；未安装/晚就绪时 toolDeps.storage 保持 undefined，工具自动降级为
  // base64 内联（见 avatar.ts），功能不依赖它。
  const toolDeps: { storage?: MinimalStorageService } = {}
  ctx.inject(['chatluna_storage'], (ctx) => {
    // 该属性由 chatluna-storage-service 声明，本插件不依赖它的类型（未安装也能编译）
    toolDeps.storage = (ctx as unknown as { chatluna_storage: MinimalStorageService }).chatluna_storage
    slog.info('已接入 chatluna_storage，头像图片将优先转存为临时文件')
  })

  // 工具注册结果与 onebot 实例探测分开维护，合并渲染（配置热重载时 effect 会再次执行）
  let toolStatus: StatusSnapshot = { type: 'primary', lines: ['环境感知工具注册中……'] }
  const hasOnebot = () => ctx.bots.some((bot) => bot.platform === 'onebot')
  const renderStatus = () => {
    const lines = [...toolStatus.lines]
    let type = toolStatus.type
    if (type === 'success' && !hasOnebot()) {
      lines.push('未检测到 onebot（NapCat）实例：工具仅在 onebot 会话可用，实例接入后自动生效')
      type = 'warning'
    }
    setStatus(type, ...lines)
  }

  // 注册在 effect 域内进行：插件 dispose / HMR 重载时自动调用各 registerTool 的 disposer，
  // 不残留旧闭包（platform.registerTool 返回 disposer，见 .memory/chatluna-plugin-mode-and-tools.md §7.1）
  ctx.effect(() => {
    const deps: ToolDeps = {
      config,
      cache: new TtlCache(config.cacheTtlSeconds),
      logger: slog,
      ctx,
      storage: toolDeps.storage,
      limiter: apiLimiter,
      inflight,
    }

    const g = config.group
    const u = config.user
    const f = config.forward
    const a = config.action
    const enabledMap: Record<string, boolean> = {
      // 群域
      group_overview: g.overview,
      group_members: g.members,
      member_detail: g.memberDetail,
      group_notices: g.notices,
      group_honors: g.honors,
      group_activity: g.activity,
      group_essence: g.essence,
      group_signed: g.signed,
      group_avatar: g.avatar,
      // 用户域
      user_profile: u.profile,
      user_avatar: u.avatar,
      profile_reaction_stats: u.reactionStats,
      // 合并转发
      read_forward_msg: f.tool,
      // 主动工具（会改变 QQ 侧状态，默认关闭）
      group_checkin: a.checkin.enabled,
      profile_like: a.like.enabled,
    }

    const allDefs: Record<string, (d: ToolDeps) => ChatLunaTool> = {
      ...groupToolDefs,
      ...userToolDefs,
      ...forwardToolDefs,
      ...makeActionToolDefs(actionRuntime),
    }

    const registered: string[] = []
    const failed: string[] = []
    const skipped: string[] = []
    const disposers: (() => void)[] = []
    for (const [toolName, build] of Object.entries(allDefs)) {
      if (enabledMap[toolName] === false) continue
      // 同名工具守卫：chatluna 的 registerTool 是"按名字覆盖 + dispose 时按名字删除"，
      // 和别的插件撞名会互相顶掉（HMR 时尤其明显）。这里只在名字被**其它插件**占用时让路，
      // 自己的残留注册（主动工具的 meta.group 是 envsense-action）照常覆盖。
      const occupied = ctx.chatluna.platform.getTool(toolName)
      const ownGroup = (group?: string) => typeof group === 'string' && (group === 'envsense' || group.startsWith('envsense-'))
      if (occupied?.meta != null && !ownGroup(occupied.meta.group)) {
        skipped.push(toolName)
        logger.warn(
          `工具名 ${toolName} 已被其它插件占用（meta.group=${occupied.meta.group ?? '未知'}），本插件跳过注册以免互相覆盖。` +
            `若要使用本插件的实现，请停用同名工具的来源（例如 chatluna-forward-msg 的读取工具）。`,
        )
        continue
      }
      try {
        const dispose = ctx.chatluna.platform.registerTool(toolName, build(deps))
        disposers.push(dispose)
        registered.push(toolName)
      } catch (e) {
        failed.push(toolName)
        logger.error(`注册工具 ${toolName} 失败:`, e)
      }
    }

    const ACTION_TOOL_NAMES = ['group_checkin', 'profile_like']
    const actionTools = registered.filter((name) => ACTION_TOOL_NAMES.includes(name))
    const autoGroups = a.checkin.auto.groups
      .map((id) => String(id).trim())
      .filter((id) => /^\d+$/.test(id))
    const allowedAutoGroups = autoGroups.filter(
      (id) => !a.common.whitelistEnabled || a.common.groups.some((g) => String(g).trim() === id),
    )
    let autoOn = false
    if (a.checkin.auto.enabled) {
      try {
        disposers.push(startAutoCheckin(actionRuntime))
        // 列表为空/全部被白名单挡掉时调度器不会执行任何群，摘要里也不要说"已开启"
        autoOn = allowedAutoGroups.length > 0
      } catch (e) {
        logger.error('启动自动打卡失败（该功能本次未生效）:', e)
      }
    }

    // 引用修复：chatluna 只在最外层消息上检查 forward 状态，引用（回复）里的聊天记录永远拿不到
    // <forward id> 标记 —— 这里替它补上。钩子只做本地字符串/元素操作，异常全吞，不会影响对话。
    let quoteFixOn = false
    if (f.quoteFix) {
      try {
        disposers.push(registerQuoteForwardFix(ctx, deps))
        quoteFixOn = true
        const readToolReady =
          registered.includes('read_forward_msg') ||
          skipped.includes('read_forward_msg') ||
          ctx.chatluna.platform.getTool('read_forward_msg')?.meta != null
        if (!readToolReady) {
          logger.warn(
            '已开启「引用合并消息修复」，但当前没有可用的 read_forward_msg 工具' +
              '（本插件的工具开关关着，也没装 chatluna-forward-msg）：标记会出现，但没人能读它。',
          )
        }
        slog.info('已启用引用合并消息修复：被引用/回复的聊天记录会补上 <forward id> 标记')
      } catch (e) {
        logger.error('挂载引用合并消息修复失败（该功能本次未生效）:', e)
      }
    }

    // 详细日志：完整工具清单；关闭 debug 时改由下面的一行就绪信息概括
    slog.info(
      registered.length > 0
        ? `已注册 ${registered.length} 个工具: ${briefList(registered)}`
        : '所有工具均已禁用，未注册任何工具',
    )
    readySummary = { count: registered.length, quoteFix: quoteFixOn, actionCount: actionTools.length, auto: autoOn }
    flushReady()

    // 主动工具的摘要（开关全部关闭时不占行）
    const actionBits = actionTools.map((name) => (name === 'group_checkin' ? '群打卡' : '资料卡点赞'))
    const actionSummary =
      actionBits.length || autoOn
        ? `主动工具：${actionBits.length ? actionBits.join('、') : '自动打卡'}${autoOn && actionBits.length ? '；自动打卡已开启' : ''}`
        : ''

    // 状态卡片：注册结果摘要（danger > warning > success）
    if (failed.length) {
      toolStatus = {
        type: 'danger',
        lines: [
          `注册失败 ${failed.length} 个工具：${failed.join('、')}！请检查 chatluna 版本与工具配置，错误详情见日志`,
          registered.length ? `已注册 ${registered.length} 个：${briefList(registered)}` : '没有工具注册成功，插件不生效',
        ],
      }
    } else if (registered.length) {
      toolStatus = {
        type: 'success',
        lines: [`已注册 ${registered.length} 个工具`, briefList(registered)],
      }
    } else {
      toolStatus = { type: 'warning', lines: ['所有工具均已禁用，未注册任何工具'] }
    }
    if (skipped.length) {
      toolStatus = {
        type: toolStatus.type === 'success' ? 'warning' : toolStatus.type,
        lines: [...toolStatus.lines, `跳过 ${skipped.length} 个与其它插件同名的工具：${briefList(skipped)}`],
      }
    }
    if (quoteFixOn) toolStatus = { ...toolStatus, lines: [...toolStatus.lines, '引用合并消息修复：已开启'] }
    if (actionSummary) toolStatus = { ...toolStatus, lines: [...toolStatus.lines, actionSummary] }
    if (
      a.common.whitelistEnabled &&
      a.common.groups.length === 0 &&
      (a.checkin.enabled || a.like.enabled || a.checkin.auto.enabled)
    ) {
      toolStatus = {
        type: 'warning',
        lines: [...toolStatus.lines, '主动工具白名单已开启但为空：所有群都不能使用主动工具（自动打卡也不会执行）'],
      }
    } else if (a.checkin.auto.enabled && autoGroups.length === 0) {
      toolStatus = {
        type: 'warning',
        lines: [...toolStatus.lines, '自动打卡已开启但自动打卡群列表为空：不会自动执行（不会回退到全部群）'],
      }
    } else if (a.checkin.auto.enabled && allowedAutoGroups.length === 0) {
      toolStatus = {
        type: 'warning',
        lines: [...toolStatus.lines, '自动打卡群都不在主动工具白名单内：不会自动执行'],
      }
    }
    renderStatus()

    // scope dispose（停服/HMR）时逐一注销
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {}
      }
    }
  })

  // onebot 实例可能晚于插件启动：ready 与 bot 连接事件时刷新平台探测结果，并顺手记录 NapCat 版本
  // （能否读到「发给新成员」的群公告取决于 NapCat 版本，见 notice.ts 顶部说明）
  let versionLogged = false
  const logNapCatVersion = () => {
    if (versionLogged) return
    // 注意：adapter-onebot 走 WS 时只在 socket 打开期间给 internal 挂 _request（关闭即 delete），
    // 所以优先挑真正在线的实例；都没有就等 bot-connect 再试（不算探测完成）。
    const bots = ctx.bots.filter((b) => b.platform === 'onebot') as any[]
    const bot = bots.find((b) => typeof b?.internal?._request === 'function') ?? bots[0]
    const internal = bot?.internal
    if (!internal || typeof internal._get !== 'function') {
      // 根本没有 onebot 实例：没有可探测的东西，放行就绪摘要（不显示版本）
      versionProbeDone = true
      flushReady()
      return
    }
    versionLogged = true
    const probe = async () => {
      const errors: string[] = []
      for (const action of ['get_version_info', 'get_status']) {
        try {
          const info = await internal._get(action, {})
          const name = info?.app_name ?? '未知'
          const ver = info?.app_version ?? info?.version ?? ''
          if (name !== '未知' || ver) {
            // app_name 实测是 "NapCat.Onebot"，所以直接用名字，缺名字时才补 "NapCat"
            const label = name !== '未知' ? name : 'NapCat'
            napCatVersion = `${label} ${ver}`.trim()
            // 详细日志里给全（含协议版本）；关闭 debug 时版本已并入上面那行就绪信息
            slog.info(`NapCat 版本：${label} ${ver}（协议 ${info?.protocol_version ?? '?'}）`)
            versionProbeDone = true
            flushReady()
            return
          }
          errors.push(`${action} 未返回版本字段`)
        } catch (e) {
          errors.push(`${action}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      versionLogged = false
      versionProbeDone = true
      slog.debug(`读取 NapCat 版本失败（${errors.join('；')}）`)
      flushReady()
    }
    void probe()
  }
  const refresh = () => {
    renderStatus()
    logNapCatVersion()
  }

  /**
   * 同名工具归属检查。
   *
   * 背景：chatluna 的 platform.registerTool 是"按名字覆盖"，而 chatluna-forward-msg
   * 也注册一个叫 read_forward_msg 的工具，且它在 ready 期（还会 await 几个初始化）才注册，
   * 所以两者同时开启时对方会覆盖本插件的实现；对方被卸载/HMR 时又可能把名字删掉。
   * 这里挂在 chatluna/tool-updated 上做一次带防抖的检查，把结果明确写进日志，
   * 免得出现"改了配置却没生效"这种无声的困惑。只在归属发生变化时打一条。
   */
  let forwardOwnerWarned: string | null = null
  const checkForwardToolOwner = () => {
    if (config.forward?.tool === false) return
    try {
      const owner = ctx.chatluna.platform.getTool('read_forward_msg')?.meta?.group ?? null
      if (owner != null && owner !== 'envsense') {
        if (forwardOwnerWarned === owner) return
        forwardOwnerWarned = owner
        logger.warn(
          `read_forward_msg 目前由其它插件提供（meta.group=${owner}），本插件的同名实现被覆盖了——` +
            '功能仍然可用，只是走的是对方的实现；想让本插件接管，请停用对方（例如 chatluna-forward-msg 的读取工具）。',
        )
      } else if (forwardOwnerWarned != null) {
        forwardOwnerWarned = null
        slog.info('read_forward_msg 已切回本插件的实现')
      }
    } catch (e) {
      slog.debug(`同名工具归属检查失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  ctx.on('ready', refresh)
  ctx.on('bot-connect', refresh)
  // 工具表每次变动都会发 chatluna/tool-updated：延后一拍（等同一批注册做完）再核对归属
  ctx.on('chatluna/tool-updated', () => ctx.setTimeout(checkForwardToolOwner, 50))
  // HMR 重载时 ready 不会再次触发，这里立即探测一次（无 bot 时内部会直接返回，等事件再试）
  refresh()
  ctx.setTimeout(checkForwardToolOwner, 800)
}
