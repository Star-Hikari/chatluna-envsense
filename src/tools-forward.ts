import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import type { Context } from 'koishi'
import type { ChatLunaTool } from 'koishi-plugin-chatluna/llm-core/platform/types'
import { onebotAuthorization, PERCEPTION_NOTE, sessionFrom, toolMeta, ToolDeps } from './common'
import {
  forwardIdOf,
  isForwardElement,
  MinimalElement,
  patchForwardElementAttrs,
  quoteElementsOf,
  readForwardTranscript,
} from './forward'

// ─────────────────────────────────────────────
// 合并转发（聊天记录）
//
// 两件事：
//  1. read_forward_msg —— 真正去读聊天记录正文的工具（自研实现，不依赖 forward-msg 插件）；
//  2. 引用修复 —— chatluna 只在最外层消息上检查 forward 状态，被引用/回复的聊天记录永远拿不到
//     ID 标记（源码见 .memory/chatluna-forward-msg-survey.md §2.5），这里在引用子转换里补上标记。
//
// 注意 messageId 的兜底：模型很可能拿到的是没有 id 的 <forward/>，历史上实测它会自己编一个
// "current" 出来。所以工具接受占位词，并回落到 session（本条消息 → 引用消息 → 消息自身 ID）。
// ─────────────────────────────────────────────

function clampDepth(value: unknown, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
  return Math.min(8, Math.max(1, n))
}

export const forwardToolDefs: Record<string, (deps: ToolDeps) => ChatLunaTool> = {
  read_forward_msg: (deps) => ({
    description: '你打开的合并转发聊天记录（那一叠里每一条都能看到）',
    selector: () => true,
    authorization: onebotAuthorization,
    meta: toolMeta(['forward', 'record']),
    createTool: () =>
      tool(
        async (input: { messageId?: string; maxDepth?: number }, runConfig) => {
          const session = sessionFrom(runConfig)
          const forwardConfig = deps.config.forward
          const maxDepth = clampDepth(input.maxDepth, forwardConfig?.maxDepth ?? 3)
          const result = await readForwardTranscript({
            session,
            messageId: input.messageId,
            maxDepth,
            maxEntries: forwardConfig?.maxEntries ?? 40,
            maxChars: forwardConfig?.maxChars ?? 4000,
            logger: deps.logger,
            cache: deps.cache,
          })
          if (!result.ok) {
            deps.logger.debug(`读取聊天记录未成功：${result.error}`)
            return result.error
          }
          deps.logger.info(`已读取聊天记录：${result.count ?? '缓存'} 条，${result.text.length} 字`)
          return result.text
        },
        {
          name: 'read_forward_msg',
          description: [
            '你能打开别人发来的「合并转发 / 聊天记录」——就是那种卷成一叠、点开才看到里面一条条消息的东西。',
            '',
            '当你想知道聊天记录里写了什么（"这叠里都说了啥""转发的记录里有没有提到我"）时使用。',
            '- messageId：聊天记录的 id，填消息里 <forward id="…"/> 的那个 id。',
            '- 如果消息里只看到 <forward/> 没有 id（chatluna 有时拿不到），就填 current：我会去读你当前这条消息里的聊天记录，包括它引用的那条。',
            '- maxDepth：里面套着的聊天记录再展开几层（默认按配置）。',
            '- 结果按"昵称 (QQ) 时间 + 正文"逐条列出；图片/语音/视频/文件会记成 [图]、[语音] 这样的占位，被引用与被转发的子记录会缩进显示。',
            '- 看不到就是真看不到（记录可能已被平台清理），别编造里面的内容。',
            `- ${PERCEPTION_NOTE}。`,
          ].join('\n'),
          schema: z.object({
            messageId: z
              .string()
              .optional()
              .describe('聊天记录 id（消息里的 <forward id="…"/>）；留空或填 current 表示当前消息/它引用的消息里的聊天记录'),
            maxDepth: z.number().int().min(1).max(8).optional().describe('嵌套聊天记录解析层数（默认按配置）'),
          }),
        },
      ),
  }),
}

/** message.content 可能是字符串也可能是 langchain 的 content 数组，两种都要能追加 */
function appendText(message: { content?: unknown }, text: string): void {
  const current = message.content
  if (typeof current === 'string' || current == null) {
    message.content = `${(current as string | undefined) ?? ''}${text}`
    return
  }
  if (Array.isArray(current)) {
    current.push({ type: 'text', text })
    return
  }
  message.content = `${String(current)}${text}`
}

/**
 * 注册「引用合并转发修复」钩子，返回 disposer。
 *
 * 钩子做两件事（都只对 onebot 会话、且只做本地字符串/元素操作，不调 API）：
 *  ① 把 OneBot 的 attrs.id 补成 chatluna 认的 message_id —— 这样 chatluna 自己打的
 *     <forward id="…"/> 标记才有值（直发聊天记录的场景）；
 *  ② 引用子转换（options.quote === true）里自己补 <forward id="…"/> 标记 —— chatluna
 *     只在最外层消息上读 forward 状态，引用里的 ID 会被丢掉，所以引用段落永远是空的。
 *
 * ⚠️ 异常必须全部吞掉：这个钩子跑在 chatluna 的 transform_chat_message 中间件里，
 * 抛出去会被 chatluna 捕获后**把报错原文发给用户**（chains/index.mjs 的 _handleMiddlewareError）。
 */
export function registerQuoteForwardFix(ctx: Context, deps: ToolDeps): () => void {
  const handled = new WeakSet<object>()
  return ctx.chatluna.messageTransformer.before(async (session, elements, message, _model, options) => {
    try {
      if (!session || session.platform !== 'onebot') return
      // ① 直发：补键名（chatluna 的拦截器稍后才会读 attrs，所以这里改一定生效）
      patchForwardElementAttrs(elements)
      // 引用元素也一起补：这样最外层算 quoteElementString 时与引用子转换看到的是同一份数据
      patchForwardElementAttrs(quoteElementsOf(session))

      // ② 只处理引用子转换：外层消息的标记由 chatluna 自己负责，重复补会多一个标记
      if (options?.quote !== true) return
      const fresh: string[] = []
      for (const element of (elements ?? []) as MinimalElement[]) {
        if (!isForwardElement(element) || handled.has(element as object)) continue
        handled.add(element as object)
        const id = forwardIdOf(element)
        if (id) fresh.push(id)
      }
      if (fresh.length === 0) return
      appendText(message, fresh.map((id) => `<forward id="${id}"/>`).join(''))
      deps.logger.info(`已为被引用的聊天记录补上 id 标记：${fresh.join('、')}`)
    } catch (e) {
      deps.logger.warn('聊天记录标记修复失败（已忽略，不影响本条消息）：', e)
    }
  })
}