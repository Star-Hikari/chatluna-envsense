import type { Logger } from 'koishi'

// ─────────────────────────────────────────────
// 日志门面
//
// 插件里有两类日志：
//   1. 报错类（warn/error）—— 任何时候都要能看到，帮助定位"这次为什么没拿到数据"；
//   2. 过程类（info/debug）—— 工具调用明细、原始返回、图片取用过程、启动清单等，
//      正常运行时属于噪音，只有排查问题才需要。
//
// 配置项 debug 控制第 2 类：默认关闭，此时 info/debug 一并静默，只留第 1 类；
// 关闭时仍会打一行简短的就绪信息（由 index.ts 直接用 koishi 原生 logger 输出，
// 不走这个门面，所以不会被这里静默掉）。
// ─────────────────────────────────────────────

export interface SenseLogger {
  debug(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

/**
 * 包一层 koishi logger。
 * `isVerbose` 传函数而不是布尔值：配置热重载后 apply 会重新执行，但 toolDeps 里
 * 持有的门面可能被复用，用函数取值可以始终读到当前配置。
 */
export function createSenseLogger(logger: Logger, isVerbose: () => boolean): SenseLogger {
  return {
    debug(message, ...args) {
      if (isVerbose()) logger.debug(message, ...args)
    },
    info(message, ...args) {
      if (isVerbose()) logger.info(message, ...args)
    },
    warn(message, ...args) {
      logger.warn(message, ...args)
    },
    error(message, ...args) {
      logger.error(message, ...args)
    },
  }
}
