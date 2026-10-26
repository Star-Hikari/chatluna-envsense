import type { Context } from 'koishi'
import type { SenseLogger } from './log'

// ─────────────────────────────────────────────
// 主动工具的状态存储
//
// 目标：同一环境（群 / 私聊用户）的同一种动作，一天只允许成功执行一次。
// 默认放内存；如果装了 database，则额外持久化，重启后仍然认账。
//
// 注意：日期必须按**本地时区**算。用 toISOString().slice(0, 10) 会得到 UTC 日期，
// 在 Asia/Shanghai 的 00:00–08:00 会算成前一天，导致"当天一次"失效。
// ─────────────────────────────────────────────

export type ActionStatus = 'pending' | 'ok' | 'failed' | 'blocked'

export interface ActionRecord {
  /** 本地日期 YYYY-MM-DD */
  date: string
  /** 毫秒时间戳 */
  at: number
  status: ActionStatus
  /** 失败/封禁时的简短原因（给日志与下一次提示用） */
  note?: string
  /** 仅用于全局计数（如当天已点赞人数） */
  count?: number
  /**
   * 群打卡专用：是否用「今日打卡榜」核对到 bot 自己。
   * - true：榜上确实有自己
   * - undefined：请求已受理，但榜单取不到（无法确认，按成功处理）
   * 不会出现 false：核对到"榜上没我"时状态直接记 failed，允许冷却后重试。
   */
  verified?: boolean
}

const TABLE = 'chatluna_envsense_state'
const TTL_MS = 7 * 24 * 60 * 60 * 1000
const MAX_MEMORY = 1000

interface DatabaseLike {
  get(table: string, query: Record<string, unknown>, fields?: string[]): Promise<Array<Record<string, any>>>
  upsert(table: string, rows: Array<Record<string, any>>): Promise<any>
  remove(table: string, query: Record<string, unknown>): Promise<any>
}

interface ModelLike {
  extend(name: string, fields: Record<string, unknown>, options?: Record<string, unknown>): void
}

/** 本地日期键（YYYY-MM-DD），传入 Date 便于测试 */
export function localDateKey(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** 状态 key：带平台 / 账号 / 动作 / 作用域，避免多 bot、多群串味 */
export function actionKey(opts: {
  platform: string
  selfId: string
  action: string
  scope: 'group' | 'private' | 'day'
  id: string
}): string {
  return `v1:${opts.platform}:${opts.selfId}:${opts.action}:${opts.scope}:${opts.id}`
}

/** 当天全局计数 key（如点赞人数上限） */
export function dayCounterKey(opts: { platform: string; selfId: string; action: string; date: string }): string {
  return actionKey({ platform: opts.platform, selfId: opts.selfId, action: opts.action, scope: 'day', id: opts.date })
}

function isRecord(value: unknown): value is ActionRecord {
  if (!value || typeof value !== 'object') return false
  const rec = value as ActionRecord
  return (
    typeof rec.date === 'string' &&
    typeof rec.at === 'number' &&
    (rec.status === 'pending' || rec.status === 'ok' || rec.status === 'failed' || rec.status === 'blocked')
  )
}

export class ActionState {
  private memory = new Map<string, ActionRecord>()
  private db?: DatabaseLike
  private cleanupTimer?: () => void

  constructor(private logger: SenseLogger) {}

  /** 是否已接入 database（用于启动提示与测试断言） */
  get persistent(): boolean {
    return !!this.db
  }

  /**
   * 在 ctx.inject(['database']) 里调用。
   * 这里用结构化的 DatabaseLike，避免把 database 变成硬依赖（未安装也能编译/运行）。
   */
  attachDatabase(ctx: Context): void {
    const model = (ctx as unknown as { model?: ModelLike }).model
    const database = (ctx as unknown as { database?: DatabaseLike }).database
    if (!model || !database) return

    try {
      model.extend(
        TABLE,
        {
          key: 'string(127)',
          value: 'text',
          expire: 'timestamp',
        },
        { primary: 'key' },
      )
    } catch (e) {
      // 表结构冲突/数据库只读等情况：不影响工具可用，退回内存状态
      this.logger.warn(`主动工具状态表初始化失败，将只使用内存状态：${e instanceof Error ? e.message : String(e)}`)
      return
    }
    this.db = database
    this.cleanupTimer?.()
    this.cleanupTimer = ctx.setInterval(() => {
      void this.cleanup()
    }, 12 * 60 * 60 * 1000)
    this.logger.info('主动工具状态已接入 database（同一天内重启也不会重复执行）')
  }

  async get(key: string): Promise<ActionRecord | undefined> {
    const hit = this.memory.get(key)
    if (hit) return hit
    if (!this.db) return undefined
    try {
      const [row] = await this.db.get(TABLE, { key }, ['value'])
      if (!row?.value) return undefined
      const parsed = JSON.parse(String(row.value))
      if (!isRecord(parsed)) return undefined
      this.memory.set(key, parsed)
      return parsed
    } catch (e) {
      this.logger.debug(`读取主动工具状态失败（${key}）：${e instanceof Error ? e.message : String(e)}`)
      return undefined
    }
  }

  async set(key: string, record: ActionRecord): Promise<void> {
    this.memory.set(key, record)
    this.pruneMemory()
    if (!this.db) return
    try {
      await this.db.upsert(TABLE, [
        {
          key,
          value: JSON.stringify(record),
          expire: new Date(Date.now() + TTL_MS),
        },
      ])
    } catch (e) {
      this.logger.debug(`写入主动工具状态失败（${key}）：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** 删除一条状态（仅用于需要"撤销 pending"的内部场景） */
  async delete(key: string): Promise<void> {
    this.memory.delete(key)
    if (!this.db) return
    try {
      await this.db.remove(TABLE, { key })
    } catch (e) {
      this.logger.debug(`删除主动工具状态失败（${key}）：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private async cleanup(): Promise<void> {
    if (!this.db) return
    try {
      await this.db.remove(TABLE, { expire: { $lt: new Date() } })
    } catch (e) {
      this.logger.debug(`清理主动工具状态失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private pruneMemory(): void {
    if (this.memory.size <= MAX_MEMORY) return
    const today = localDateKey()
    for (const [key, rec] of this.memory) {
      if (this.memory.size <= MAX_MEMORY / 2) break
      if (rec.date !== today) this.memory.delete(key)
    }
  }
}