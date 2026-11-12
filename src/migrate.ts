import { Schema } from 'koishi'
import { Config, DEFAULT_GROUP_TOOLS, DEFAULT_QZONE_TOOLS, DEFAULT_USER_TOOLS } from './config'

// ─────────────────────────────────────────────
// 旧版配置自动迁移（1.4.2 配置结构重构）
//
// 背景：1.4.2 把「每个工具一个布尔开关」合并成复选框 `*.tools`，并把各工具的专属参数
// 挪进了 `*.xxxOptions` 子对象。schemastery 不认识旧键，**会静默丢弃**——用户升级后
// 之前关掉的工具会被默认值重新打开、改过的限额会悄悄回到默认，这是很难自己发现的坑。
//
// 做法：schemastery 的 object 会把未知键原样透传（实测），所以 `apply` 拿到的 config 里
// 仍然带着旧键。这里在插件启动时：
//   1. 读旧键 → 换算成新结构（旧值优先，因为它一定是用户手写的）；
//   2. 删掉旧键，避免它们一直留在配置里、以后覆盖用户在控制台里的修改；
//   3. 重新过一遍 Config，把值交给 schema 校验（范围/类型都按新规则收敛）。
// 迁移结果会打一条 warn，提示用户去控制台确认并保存一次。
// ─────────────────────────────────────────────

type AnyRec = Record<string, any>

/** 群聊工具的旧布尔键（值 = 新 `tools` 数组里的取值） */
const GROUP_TOOL_KEYS = [
  'overview', 'members', 'memberDetail', 'notices', 'honors',
  'essence', 'signed', 'avatar', 'activity', 'files', 'albums',
] as const
const USER_TOOL_KEYS = ['profile', 'avatar', 'reactionStats', 'friends'] as const
const QZONE_TOOL_KEYS = ['feeds', 'posts', 'detail', 'profile'] as const

function sameSet(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((x) => set.has(x))
}

/**
 * 把旧布尔开关折算成新的 tools 数组。
 * 只有当 `tools` 还处于默认状态（或压根没有）时才折算——否则说明用户已经手工迁移过，
 * 以 `tools` 为准，旧键只做清理。
 */
function foldToolSwitches(
  parent: AnyRec,
  legacyKeys: readonly string[],
  defaultTools: readonly string[],
  found: string[],
  prefix: string,
): void {
  const present = legacyKeys.filter((k) => typeof parent[k] === 'boolean')
  if (present.length === 0) return

  const tools = Array.isArray(parent.tools) ? parent.tools : []
  const looksDefault = tools.length === 0 || sameSet(tools, defaultTools)

  if (looksDefault) {
    const next = new Set<string>(defaultTools)
    for (const key of present) {
      if (parent[key]) next.add(key)
      else next.delete(key)
    }
    parent.tools = [...next]
  }

  for (const key of present) {
    found.push(`${prefix}.${key}`)
    delete parent[key]
  }
}

/** 旧标量键 → 新的子对象键 */
function moveScalar(
  parent: AnyRec,
  legacyKey: string,
  optionKey: string,
  newKey: string,
  found: string[],
  prefix: string,
): void {
  if (parent[legacyKey] === undefined) return
  const option = parent[optionKey] && typeof parent[optionKey] === 'object' ? parent[optionKey] : {}
  option[newKey] = parent[legacyKey]
  parent[optionKey] = option
  found.push(`${prefix}.${legacyKey}`)
  delete parent[legacyKey]
}

export interface LegacyMigrationResult {
  config: Config
  /** 检测并迁移掉的旧键，如 `group.memberLimit`；为空表示没有旧配置 */
  found: string[]
}

/**
 * 迁移旧版配置。没有旧键时返回原对象（不复制、不重算），保持零开销。
 * 传入的 config 会被就地清理（删掉旧键）。
 */
export function migrateLegacyConfig(input: Config): LegacyMigrationResult {
  const config = input as unknown as AnyRec
  const found: string[] = []

  const group = config.group as AnyRec | undefined
  if (group && typeof group === 'object') {
    foldToolSwitches(group, GROUP_TOOL_KEYS, DEFAULT_GROUP_TOOLS, found, 'group')
    moveScalar(group, 'memberLimit', 'memberOptions', 'limit', found, 'group')
    moveScalar(group, 'noticesIncludeNewMember', 'noticeOptions', 'includeNewMember', found, 'group')
    moveScalar(group, 'noticeImageLimit', 'noticeOptions', 'imageLimit', found, 'group')
    moveScalar(group, 'activityCount', 'activityOptions', 'count', found, 'group')
    moveScalar(group, 'fileListOnly', 'fileOptions', 'listOnly', found, 'group')
    moveScalar(group, 'fileParse', 'fileOptions', 'parse', found, 'group')
    moveScalar(group, 'fileMaxKb', 'fileOptions', 'maxKb', found, 'group')
    moveScalar(group, 'fileTextLimit', 'fileOptions', 'textLimit', found, 'group')
    moveScalar(group, 'albumImageLimit', 'albumOptions', 'imageLimit', found, 'group')
    moveScalar(group, 'albumCooldownSeconds', 'albumOptions', 'cooldownSeconds', found, 'group')
    moveScalar(group, 'albumBatchLimit', 'albumOptions', 'batchLimit', found, 'group')
  }

  const user = config.user as AnyRec | undefined
  if (user && typeof user === 'object') {
    foldToolSwitches(user, USER_TOOL_KEYS, DEFAULT_USER_TOOLS, found, 'user')
    moveScalar(user, 'friendLimit', 'friendOptions', 'limit', found, 'user')
  }

  const qzone = config.qzone as AnyRec | undefined
  if (qzone && typeof qzone === 'object') {
    foldToolSwitches(qzone, QZONE_TOOL_KEYS, DEFAULT_QZONE_TOOLS, found, 'qzone')
    moveScalar(qzone, 'commentCount', 'detailOptions', 'commentCount', found, 'qzone')
    moveScalar(qzone, 'imageLimit', 'detailOptions', 'imageLimit', found, 'qzone')
  }

  if (found.length === 0) return { config: input, found }

  // 迁移后的值再交给 schema 校验一遍（范围/类型按新规则收敛），避免手写脏值绕过限制
  const cleaned = Schema.resolve(config, Config, { path: [] }, false)[0] as Config
  return { config: cleaned, found }
}