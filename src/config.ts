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

/** 合并转发（聊天记录）与 chatluna 引用修复 */
export interface ForwardSenseConfig {
  /** read_forward_msg：读取合并转发聊天记录的工具 */
  tool: boolean
  /** 修复 chatluna 对引用合并消息的处理（补 <forward id> 标记） */
  quoteFix: boolean
  /** 嵌套聊天记录解析层数 */
  maxDepth: number
  /** 单次读取最多渲染多少条 */
  maxEntries: number
  /** 单次读取输出文本的字数上限 */
  maxChars: number
}

/** 自动群打卡 */
export interface AutoCheckinConfig {
  /** 是否每天自动打卡 */
  enabled: boolean
  /** 自动打卡只处理这些群；留空 = 不自动打卡（与主动工具白名单是两套列表，白名单开启时取交集） */
  groups: string[]
  /** 每天触发时间（本地时区 HH:mm） */
  time: string
  /** 0..N 分钟随机延迟 */
  jitterMinutes: number
  /** 当天错过时，bot 恢复在线后是否补跑 */
  catchUp: boolean
  /** 群与群之间的间隔（秒） */
  intervalSeconds: number
  /** 单次最多处理多少个群（自动打卡列表超过它时只处理前 N 个） */
  maxGroups: number
}

/** 主动工具 · 通用 */
export interface ActionCommonConfig {
  /** 是否启用群白名单 */
  whitelistEnabled: boolean
  /** 白名单群号；开启白名单且为空 = 全禁 */
  groups: string[]
}

/** 主动工具 · 主动点赞 */
export interface ActionLikeConfig {
  /** profile_like：给当前发言人/私聊对象点赞 */
  enabled: boolean
  /** 每次点赞次数（普通账号 QQ 每好友每天 10 次，SVIP 可到 20 次） */
  times: number
  /** 每天最多给多少人点赞（全局，防止多私聊/多群刷） */
  maxPerDay: number
}

/** 主动工具 · 群打卡 */
export interface ActionCheckinConfig {
  /** group_checkin：bot 以自己在当前群的身份发起群打卡 */
  enabled: boolean
  /** 打卡后是否用「今日打卡榜」核对 bot 是否真的签上了 */
  verify: boolean
  /** 自动打卡 */
  auto: AutoCheckinConfig
}

/** 主动工具（会改变 QQ 侧状态） */
export interface ActionConfig {
  common: ActionCommonConfig
  like: ActionLikeConfig
  checkin: ActionCheckinConfig
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
  /** 合并转发（聊天记录）开关与参数 */
  forward: ForwardSenseConfig
  group: GroupSenseConfig
  user: UserSenseConfig
  /** 主动工具（群打卡 / 资料卡点赞），默认全部关闭 */
  action: ActionConfig
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
      .description('头像请求的尺寸档位。qlogo 只接受 0/40/100/140/640，其余值会返回 HTTP 400；插件会按 640→140→100→40→0 自动兜底'),
    avatarMaxKb: Schema.number().min(64).max(2048).default(1536)
      .description('base64 内联时单张图片的字节上限（KB）：超过则放弃内联并告知模型取图失败'),

    // ── 合并转发（聊天记录）──
    // 放在「通用」末尾：前两项是与 chatluna 行为相关的开关，后三项是读取时的限额。
    forward: Schema.object({
      tool: Schema.boolean().default(true)
        .description('read_forward_msg：注册"打开合并转发聊天记录"工具，让模型能读到那一叠里的每一条（自研实现，不依赖 chatluna-forward-msg）'),
      quoteFix: Schema.boolean().default(true)
        .description('修复 chatluna 对引用合并消息的处理：被引用/回复的聊天记录会补上 <forward id="…"> 标记，从而能被上面的工具读到（chatluna 自身只在直发时补标记，引用那条永远是空的）'),
      maxDepth: Schema.number().min(1).max(8).default(3)
        .description('聊天记录里还套着聊天记录时，最多展开几层'),
      maxEntries: Schema.number().min(1).max(200).default(40)
        .description('单次读取最多呈现多少条（超出会截断并注明）'),
      maxChars: Schema.number().min(200).max(20000).default(4000)
        .description('单次读取输出文本的字数上限（JP/CN 约 1 字 ≈ 1 token，用于控制上下文开销）'),
    })
      .default({} as ForwardSenseConfig)
      .description('合并转发（聊天记录）'),
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

  // ── 主动工具（默认全部关闭）──
  // 结构：主动工具 → 通用 / 主动点赞 / 群打卡 → 自动群打卡。
  // 注意：这里**不能**给 like/checkin/auto 加 .collapse()——控制台会把折叠对象渲染成
  // "action.like 展开以编辑"这样的字段行，而不是与「通用」同级的大标题。
  Schema.object({
    action: Schema.object({
      common: Schema.object({
        whitelistEnabled: Schema.boolean().default(false)
          .description('是否启用主动工具的群白名单：开启后只有列表里的群能使用主动工具；列表为空则全部禁用'),
        groups: Schema.array(Schema.string()).default([])
          .description('允许使用主动工具的群号；仅在"启用群白名单"时生效。留空且开启白名单 = 任何群都不能用'),
      })
        .default({} as ActionCommonConfig)
        .description('通用'),

      like: Schema.object({
        enabled: Schema.boolean().default(false)
          .description('profile_like：允许模型给当前发言人（私聊即对端）的资料卡点赞（不能指定别人，每人每天一次）'),
        times: Schema.number().min(1).max(20).default(10)
          .description('每次点赞点几个（1–20）。QQ 对普通账号的限制是每个好友每天 10 次，SVIP 账号可点 20 次；超过账号实际上限时以 QQ 侧为准'),
        maxPerDay: Schema.number().min(1).max(200).default(20)
          .description('每天最多给多少人点赞（全局上限，防止大量私聊/群聊各要一次；与每好友 10 次是两回事）'),
      })
        .default({} as ActionLikeConfig)
        .description('主动点赞'),

      checkin: Schema.object({
        enabled: Schema.boolean().default(false)
          .description('group_checkin：允许 bot 在当前群里以自己的身份发起群打卡（只作用于当前群，每个群每天一次；需要 NapCat 开启 PacketBackend）'),
        verify: Schema.boolean().default(true)
          .description('打卡后用「今日打卡榜」核对 bot 是否真的签上了：QQ 不返回打卡回执，只有榜单能证明。榜单读不到时按"请求已受理"处理，不会误判失败'),
        auto: Schema.object({
          enabled: Schema.boolean().default(false)
            .description('每天自动打卡（与模型调用共享"当天一次"状态；开启后不需要任何人说话）'),
          groups: Schema.array(Schema.string()).default([])
            .description('自动打卡只处理这些群（与主动工具白名单是两套列表；白名单开启时还会取交集）。留空 = 不自动打卡'),
          time: Schema.string().pattern(/^\d{1,2}:\d{2}$/).default('00:05')
            .description('每天自动打卡时间（本地时区 HH:mm，建议 00:05 之后）'),
          jitterMinutes: Schema.number().min(0).max(120).default(10)
            .description('在目标时间后随机延迟 0..N 分钟，避免所有群/所有 bot 同一秒打卡'),
          catchUp: Schema.boolean().default(true)
            .description('当天目标时间已过、但 bot 当时不在线时，恢复连接后补跑一次（仍只算当天一次）'),
          intervalSeconds: Schema.number().min(1).max(60).default(3)
            .description('自动打卡时群与群之间的间隔（秒）'),
          maxGroups: Schema.number().min(1).max(200).default(50)
            .description('单次自动打卡最多处理多少个群（自动打卡列表超过它时只处理前 N 个）'),
        })
          .default({} as AutoCheckinConfig)
          .description('自动群打卡'),
      })
        .default({} as ActionCheckinConfig)
        .description('群打卡'),
    }).default({} as ActionConfig),
  }).description('主动工具'),
]) as unknown as Schema<Config>
