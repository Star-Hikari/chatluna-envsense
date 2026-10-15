import { Schema } from 'koishi'
import type { AvatarDelivery } from './avatar'

// ─────────────────────────────────────────────
// 配置（分组卡片，模式取自 .memory/koishi-schema-config.md：
// 顶层 intersect 各切片并行 cast 同一份 data，缺失 key 走 .default() 补全）
// 注：曾有的顶层 enabled"总开关"已移除——与控制台的插件实例开关功能重复，
// 各组内的单项开关保留。
// ─────────────────────────────────────────────

/** 群聊感知各工具开关与参数 */
export interface GroupSenseConfig {
  /** group_overview */
  overview: boolean
  /** group_members */
  members: boolean
  /** group_members 单次输出成员行数上限 */
  memberLimit: number
  /** member_detail */
  memberDetail: boolean
  /** group_notices */
  notices: boolean
  /** group_notices 是否包含"发送给新成员"的公告 */
  noticesIncludeNewMember: boolean
  /** group_notices 单条公告最多取回几张图片 */
  noticeImageLimit: number
  /** group_honors */
  honors: boolean
  /** group_essence */
  essence: boolean
  /** group_signed */
  signed: boolean
  /** group_avatar */
  avatar: boolean
  /** group_activity（较重历史接口，默认关） */
  activity: boolean
  /** group_activity 默认拉取消息条数 */
  activityCount: number
}

export interface UserSenseConfig {
  /** user_profile */
  profile: boolean
  /** user_avatar */
  avatar: boolean
  /** profile_reaction_stats */
  reactionStats: boolean
}

export interface Config {
  /** 是否输出详细日志（工具调用明细、原始返回、取图过程、启动清单等） */
  debug: boolean
  /** NapCat 查询结果的内存缓存有效期（秒），0 = 不缓存 */
  cacheTtlSeconds: number
  /** 头像类工具把图片交给模型的方式 */
  avatarDelivery: AvatarDelivery
  /** 头像请求的尺寸档位（qlogo 只接受 0/40/100/140/640） */
  avatarSize: number
  /** base64 内联时允许的单图最大字节数（KB） */
  avatarMaxKb: number
  group: GroupSenseConfig
  user: UserSenseConfig
}

export const Config = Schema.intersect([
  Schema.object({
    debug: Schema.boolean().default(false)
      .description('输出详细日志（工具调用明细、NapCat 原始返回、取图过程、启动时的工具清单等）。关闭时只保留报错类提示与一行就绪信息'),
    cacheTtlSeconds: Schema.number().min(0).default(300)
      .description('群资料/成员列表等查询结果的内存缓存有效期（秒），0 为每次都实查'),
    avatarDelivery: Schema.union([
      Schema.const('inline').description('base64 内联进请求：不依赖任何外部抓取，最可靠（单图上限 1.5MB）'),
      Schema.const('storage').description('转存 chatluna_storage 后用其地址：需要该服务的 serverPath 是模型能访问到的公网地址'),
      Schema.const('link').description('只给直链：交给模型/供应商自行抓取（实测常常看不到图）'),
    ]).default('inline' as AvatarDelivery)
      .description('头像/图片工具的取图方式：inline=下载后 base64 直接内联（默认，最稳）；storage=借用 chatluna_storage 服务转存为临时文件再交给模型（仅当 serverPath 是公网可达地址时才有意义）；link=仅提供直链'),
    avatarSize: Schema.union([
      Schema.const(640).description('640（默认，头像最清晰）'),
      Schema.const(140).description('140（较小，省流量）'),
      Schema.const(100).description('100（更小）'),
      Schema.const(40).description('40（最小，仅够辨认）'),
      Schema.const(0).description('0（原图，体积最大）'),
    ]).default(640)
      .description('头像请求的尺寸档位。qlogo 只接受 0/40/100/140/640，其余值会返回 HTTP 400；插件会按 640→140→100→40→0 自动兜底，所以这里填错也不会瞎掉'),
    avatarMaxKb: Schema.number().min(64).max(2048).default(1536)
      .description('base64 内联时单张图片的字节上限（KB）：超过则放弃内联并告知模型取图失败'),
  }).description('通用'),

  // ── 群聊感知 ──
  Schema.object({
    group: Schema.object({
      overview: Schema.boolean().default(true).description('group_overview：群名称/人数/全员禁言 + 我在本群的名片与身份'),
      members: Schema.boolean().default(true).description('group_members：群成员列表（可按昵称/名片/QQ 过滤）'),
      memberLimit: Schema.number().min(10).max(200).default(50).description('成员列表单次最多输出行数（超出提示用关键词缩小）'),
      memberDetail: Schema.boolean().default(true).description('member_detail：某成员的群内详情（头衔/等级/入群时间/最后发言等）'),
      notices: Schema.boolean().default(true).description('group_notices：群公告列表（走网页协议，偶发失败会自动提示）'),
      noticesIncludeNewMember: Schema.boolean().default(true).description('群公告是否包含"发送给新成员"的那类公告（需要较新版本的 NapCat 才能读到）'),
      noticeImageLimit: Schema.number().min(0).max(6).default(3).description('查看某条公告详情时，最多取回几张公告图片交给模型（0 = 不取图，只说明有几张）'),
      honors: Schema.boolean().default(true).description('group_honors：群荣誉榜（龙王/群聊之火/快乐源泉等）'),
      essence: Schema.boolean().default(true).description('group_essence：群精华消息'),
      signed: Schema.boolean().default(true).description('group_signed：今日打卡（签到）榜'),
      avatar: Schema.boolean().default(true).description('group_avatar：让模型看见群头像（需主模型支持图片输入）'),
      activity: Schema.boolean().default(false).description('group_activity：近期发言活跃度统计（拉历史消息，较重，默认关闭）'),
      activityCount: Schema.number().min(50).max(500).default(200).description('活跃度统计默认拉取的消息条数'),
    })
      .default({} as GroupSenseConfig)
      .description('群聊环境感知工具'),
  }),

  // ── 用户感知 ──
  Schema.object({
    user: Schema.object({
      profile: Schema.boolean().default(true).description('user_profile：查询任意 QQ 的资料卡（昵称/签名/等级/注册时间/VIP 等，取决于对方公开程度）'),
      avatar: Schema.boolean().default(true).description('user_avatar：让模型看见某人的 QQ 头像（需主模型支持图片输入）'),
      reactionStats: Schema.boolean().default(true).description('profile_reaction_stats：查询自己或他人资料卡的互动数据（总计/今日新增/最近互动的人）'),
    })
      .default({} as UserSenseConfig)
      .description('用户/个人资料感知工具'),
  }),
]) as unknown as Schema<Config>
