import { ActionRuntime, pickOneBot, runAutoCheckin } from './actions'

// ─────────────────────────────────────────────
// 自动打卡调度
//
// - 每天 `checkin.auto.time`（本地时区）触发一轮，额外加 0..jitterMinutes 的随机延迟；
// - 与模型调用共享同一份状态：当天已经成功过的群会被跳过；
// - bot 掉线/启动晚时，可在当天补跑（catchUp）；
// - 用 ctx.setTimeout 递归排期，插件卸载/HMR 时由返回的 disposer 清理。
// ─────────────────────────────────────────────

const RETRY_COOLDOWN_MS = 60 * 1000

/** "HH:mm" → 当天的毫秒时间戳（不处理跨天） */
export function parseDailyTime(now: Date, time: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(time).trim())
  if (!match) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour > 23 || minute > 59) return undefined
  const target = new Date(now)
  target.setHours(hour, minute, 0, 0)
  return target.getTime()
}

/** 下一次执行时间（今天未过则今天，否则明天；含随机抖动） */
export function computeNextRun(now: Date, time: string, jitterMinutes: number): number {
  const base = parseDailyTime(now, time)
  if (base === undefined) return now.getTime() + 24 * 60 * 60 * 1000
  const jitterMs = jitterMinutes > 0 ? Math.floor(Math.random() * jitterMinutes * 60 * 1000) : 0
  let target = base + jitterMs
  if (target <= now.getTime()) target += 24 * 60 * 60 * 1000
  return target
}

/** 今天的目标时间是否已过（用于补签判定，不加抖动） */
export function isDailyTimePassed(now: Date, time: string): boolean {
  const base = parseDailyTime(now, time)
  return base !== undefined && now.getTime() >= base
}

export function startAutoCheckin(runtime: ActionRuntime): () => void {
  const { ctx, config, logger } = runtime.deps
  const auto = config.action.checkin.auto
  if (!auto.enabled) return () => {}
  // 自动打卡只认独立列表；空列表就是不自动打卡，绝不再回退到"全部群"
  if (auto.groups.length === 0) {
    logger.warn('自动打卡已开启，但自动打卡群列表为空：不会自动打卡（不会回退到全部群）')
    return () => {}
  }

  let disposed = false
  let timer: (() => void) | undefined
  let scheduledFor = 0
  let running = false
  let lastRunAt = 0

  const clearTimer = () => {
    timer?.()
    timer = undefined
    scheduledFor = 0
  }

  const logSetup = () => {
    logger.info(
      `自动打卡已启用：每天 ${auto.time}` +
        (auto.jitterMinutes > 0 ? `（+0~${auto.jitterMinutes} 分钟随机延迟）` : '') +
        (auto.catchUp ? '，当天掉线会在恢复后补跑' : ''),
    )
  }

  const runOnce = async (reason: 'timer' | 'catchup') => {
    if (disposed || running) return
    if (Date.now() - lastRunAt < RETRY_COOLDOWN_MS) return
    running = true
    try {
      const summary = await runAutoCheckin(runtime)
      // 没有在线 bot 时不算"跑过"：否则 bot 晚几秒连上会被 60s 冷却挡掉，错过当天补签
      if (summary.note !== 'no-bot') lastRunAt = Date.now()
      if (summary.note === 'no-bot') {
        logger.debug(`自动打卡（${reason}）：当前没有在线的 onebot 实例，等连接恢复`)
      } else if (summary.total > 0) {
        logger.info(
          `自动打卡（${reason}）：${summary.total} 个群，成功 ${summary.ok}，跳过 ${summary.skipped}，失败 ${summary.failed}`,
        )
      }
    } catch (e) {
      lastRunAt = Date.now()
      logger.error('自动打卡执行失败：', e)
    } finally {
      running = false
    }
  }

  const scheduleNext = (force = false) => {
    if (disposed) return
    // bot-connect/ready 会反复触发 evaluate；已有当天定时器时不要重置（否则抖动会不断后移）
    if (!force && timer && scheduledFor > Date.now()) return
    clearTimer()
    const now = new Date()
    const nextAt = computeNextRun(now, auto.time, auto.jitterMinutes)
    scheduledFor = nextAt
    const delay = Math.max(1000, nextAt - now.getTime())
    // 单次延迟最多约 26h（24h + 抖动），远小于 Node 的定时器上限，无需分段
    const wait = Math.max(1000, delay)
    timer = ctx.setTimeout(() => {
      timer = undefined
      scheduledFor = 0
      if (disposed) return
      void runOnce('timer').finally(() => scheduleNext())
    }, wait)
  }

  const evaluate = () => {
    if (disposed) return
    const now = new Date()
    if (auto.catchUp && isDailyTimePassed(now, auto.time) && pickOneBot(ctx)) {
      // 当天已过目标时间：补跑一轮；runOnce 内部有 60s 冷却，不会因反复 bot-connect 刷屏
      clearTimer()
      void runOnce('catchup').finally(() => scheduleNext())
      return
    }
    scheduleNext()
  }

  logSetup()
  const offReady = ctx.on('ready', evaluate)
  const offBotConnect = ctx.on('bot-connect', evaluate)
  // HMR 时 ready 可能已经触发过，这里立即评估一次
  evaluate()

  return () => {
    disposed = true
    clearTimer()
    offReady()
    offBotConnect()
  }
}

/** 供冒烟/诊断：当前是否应该补签（不做副作用） */
export function shouldCatchUp(now: Date, time: string): boolean {
  return isDailyTimePassed(now, time)
}