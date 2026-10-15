import type { RunnableConfig } from '@langchain/core/runnables'
import type { Context, Session } from 'koishi'
import type { ChatLunaTool } from 'koishi-plugin-chatluna/llm-core/platform/types'
import { ModelCapabilities } from 'koishi-plugin-chatluna/llm-core/platform/types'
import type { Config } from './config'
import type { SenseLogger } from './log'
import { ApiResult, callApi, OneBotInternal, TtlCache } from './napi'
import { AvatarDelivery, loadAvatarImage, MinimalStorageService, unsupportedVisionText } from './avatar'

// ─────────────────────────────────────────────
// 工具层公共件（deps / 会话提取 / 注册描述符工厂 / 缓存包装 / 多模态判定）
// ─────────────────────────────────────────────

export interface ToolDeps {
  config: Config
  cache: TtlCache
  /** 受 debug 开关控制的日志门面：info/debug 静默，warn/error 始终输出 */
  logger: SenseLogger
  /** 取回图片用（走 koishi 的 http 服务，继承代理配置） */
  ctx: Context
  /** chatluna_storage（可选服务，未安装时 undefined，头像退化为 base64 内联） */
  storage?: MinimalStorageService
}

/** 从 langchain 运行配置取本次会话（chatluna 在 plugin 链里注入 configurable.session，见调研 §7.3） */
export function sessionFrom(runConfig?: RunnableConfig): Session | undefined {
  return (runConfig as any)?.configurable?.session as Session | undefined
}

/** 平台门：非 onebot（如官方 adapter-qq）会话下工具直接不进激活集 */
export const onebotAuthorization = (session: Session): boolean => session?.platform === 'onebot'

/**
 * 所有环境感知工具描述的统一收尾句。
 *
 * 目的：这些信息虽然是通过工具调用拿到的，但对模型而言应该像"自己感知到的"。
 * 参照 chatluna-livingmemory 的记忆工具描述（"在你的记忆库中搜索记忆。" +
 * "当你需要查找自己的记忆时使用此工具。"），此处明确要求模型**不要向用户复述调用过程**，
 * 否则模型很容易说出"我调用工具查了一下""接口返回…"这类破坏角色感的话。
 */
export const PERCEPTION_NOTE =
  '这些是你此刻直接感知到的内容：用第一人称自然地讲出来，不要提及工具、查询、接口，也不要说"我查了一下"'

/**
 * 统一的注册 meta（防被 chatluna-agent 权限 mask 挡掉，见 plugin-mode 笔记 §5）
 */
export function toolMeta(tags: string[]): ChatLunaTool['meta'] {
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

/**
 * 当前模型是否支持图片输入。
 * true=支持 / false=明确不支持 / undefined=无法判定（调用侧按乐观放行处理）。
 */
export function modelImageSupport(runConfig?: RunnableConfig): boolean | undefined {
  const model: any = (runConfig as any)?.configurable?.model
  const caps: ModelCapabilities[] | undefined = model?.modelInfo?.capabilities
  if (!Array.isArray(caps)) return undefined
  return caps.includes(ModelCapabilities.ImageInput)
}

/**
 * 头像 observation 构建器（group_avatar / user_avatar 共用）。
 *
 * 关键点：直接给模型一个外链，供应商未必抓得到（实测模型会答"看不到图"），
 * 所以这里统一走 avatar.ts 把字节取回来（storage 临时文件 → base64 内联兜底），
 * 并返回 `[image_url, text]` 多模态数组——该数组经 chatluna coerceToAgentObservation
 * 原样透传（llm-core/agent/index.mjs:316），最终由供应商转成 data URI 提交。
 *
 * 三态行为：
 * - 模型明确不支持视觉：返回文本 + 直链（不浪费一次下载）；
 * - 支持 / 无法判定：按候选地址依次尝试下载并交付图片，全失败时如实告知"我没看到"，绝不假装看到；
 * - delivery='link'：只给直链（给多模态描述服务之类的下游用）。
 *
 * 为什么要给一串候选地址：qlogo 只接受固定档位尺寸，填错就是 HTTP 400 + 空 body
 * （实测 /600、/200、spec=800 全部 400），所以按 640 → 140 → 100 → 40 → 0 依次兜底。
 */
export async function buildAvatarObservation(opts: {
  deps: ToolDeps
  runConfig?: RunnableConfig
  /** 图片候选地址，按优先级依次尝试 */
  urls: string[]
  /** 临时文件命名主体（不含扩展名） */
  baseName: string
  /** 这是什么图片，用于文案，如「群 216914030 的群头像」 */
  what: string
  delivery: AvatarDelivery
}): Promise<any> {
  const { deps, runConfig, urls, baseName, what, delivery } = opts
  const primary = urls[0] ?? ''
  if (modelImageSupport(runConfig) === false) return unsupportedVisionText(what, primary)

  const caption = `这是${what}。请描述或评价图片内容（这是我实际看到的图片，不是链接）。`
  const reasons: string[] = []
  for (const url of urls) {
    try {
      const loaded = await loadAvatarImage({
        ctx: deps.ctx,
        url,
        baseName,
        delivery,
        maxBytes: deps.config.avatarMaxKb * 1024,
        storage: deps.storage,
        logger: deps.logger,
      })
      deps.logger.info(
        `已获取${what}：${loaded.mime} ${Math.round(loaded.bytes / 1024)}KB，交付方式=${loaded.via}，来源=${url}`,
      )
      return [
        loaded.part,
        { type: 'text', text: `${caption}\n${loaded.note}` },
      ]
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      reasons.push(`${url} → ${reason}`)
      deps.logger.debug(`取${what}失败，换下一个候选地址：${url}（${reason}）`)
    }
  }

  deps.logger.warn(`获取${what}失败，已试过全部候选地址：${reasons.join('；')}`)
  return (
    `我这次没能看清${what}（${reasons.join('；')}），所以现在看不到它。` +
    '别假装看到了：直接跟用户说这次没看清、可以稍后再看，或者请用户把图片发到会话里。'
  )
}

/**
 * 带 TTL 缓存的统一 API 调用。
 * 注意：langchain tool 回调返回值类型标注是 string，多模态数组需 `as unknown as string` 绕过
 * （运行期 chatluna 侧按 AgentObservation 处理，无字符串约束）。
 */
export async function cachedCall<T>(opts: {
  deps: ToolDeps
  key: string
  label: string
  session: Session | undefined
  run: (internal: OneBotInternal) => Promise<T>
}): Promise<ApiResult<T>> {
  const hit = opts.deps.cache.get<T>(opts.key)
  if (hit !== undefined) return { ok: true, data: hit }
  const res = await callApi<T>({
    session: opts.session,
    label: opts.label,
    logger: opts.deps.logger,
    run: opts.run,
  })
  if (res.ok) opts.deps.cache.set(opts.key, res.data)
  return res
}

/** 工具名 + 注册描述符 + 启用开关 的三元组（index 按 enabled 过滤注册） */
export interface ToolDef {
  name: string
  enabled: boolean
  build: (deps: ToolDeps) => ChatLunaTool
}
