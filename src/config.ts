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
  /** 勾选启用的工具（复选框，见 GROUP_TOOL_KEYS） */
  tools: string[]
  /** group_members 的专属设置 */
  memberOptions: {
    /** 单次输出成员行数上限 */
    limit: number
  }
  /** group_notices 的专属设置 */
  noticeOptions: {
    /** 是否包含"发送给新成员"的公告 */
    includeNewMember: boolean
    /** 单条公告最多取回几张图片 */
    imageLimit: number
  }
  /** group_activity 的专属设置 */
  activityOptions: {
    /** 默认拉取消息条数 */
    count: number
  }
  /** group_files 的专属设置 */
  fileOptions: {
    /** 只显示文件列表（不下载内容）；关闭后 parse 才有意义 */
    listOnly: boolean
    /** 尝试解析文件内容交给模型（txt/md/json/csv/docx/pptx/xlsx/图片；pdf 只给链接） */
    parse: boolean
    /** 单文件下载上限（KB） */
    maxKb: number
    /** 单个文件最多输出多少字 */
    textLimit: number
  }
  /** group_albums 的专属设置 */
  albumOptions: {
    /** 一次最多取回几张相册图片 */
    imageLimit: number
    /** 相册详情调用的会话冷却（秒） */
    cooldownSeconds: number
    /** 相册概览一次最多列多少个上传批次 */
    batchLimit: number
  }
}

/** 聊天上下文（最近消息，群聊/私聊共用） */
export interface RecentConfig {
  /** recent_messages：查看当前会话最近的聊天记录 */
  enabled: boolean
  /** 默认返回多少条 */
  count: number
  /** 单次最多多少条 */
  max: number
}

export interface UserSenseConfig {
  /** 勾选启用的工具（复选框，见 USER_TOOL_KEYS） */
  tools: string[]
  /** friend_search 的专属设置 */
  friendOptions: {
    /** 一次最多列多少个匹配的好友 */
    limit: number
  }
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

/** QQ 空间感知（只读；这些 action 是 NapCat 4.18.42 才新增的） */
export interface QzoneSenseConfig {
  /** 勾选启用的工具（复选框，见 QZONE_TOOL_KEYS） */
  tools: string[]
  /** 列表默认返回多少条 */
  count: number
  /** 列表单次上限（好友动态受 50 限制、说说列表受 100 限制，插件会再夹一次） */
  max: number
  /** qzone_post_detail 的专属设置 */
  detailOptions: {
    /** 详情默认取多少条评论 */
    commentCount: number
    /** 详情默认取几张图（0 = 只看图数，不下载） */
    imageLimit: number
  }
  /** 空间查询缓存（秒）。空间走网页接口，TTL 比全局长以降低风控风险 */
  cacheTtlSeconds: number
  /**
   * 最多看多少天前的空间动态/说说（默认 14，0 = 不限制）。
   * 列表按时间倒序，超过这个天数的条目不再列出，也不再继续往后翻页。
   */
  maxAgeDays: number
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
  /** 内容图（空间/相册/群文件/公告）单张内联上限（KB）：超过会先压缩再内联 */
  imageMaxKb: number
  /** 每个会话在 imageWindowMinutes 内最多内联多少图片字节（KB），0 = 不限制 */
  imageBudgetKb: number
  /** 内联图片预算的时间窗（分钟） */
  imageWindowMinutes: number
  /** 压缩后的长边像素（默认 1280；公告/群文件截图可再调大） */
  imageMaxSide: number
  /** 合并转发（聊天记录）开关与参数 */
  forward: ForwardSenseConfig
  /** 最近聊天记录（群聊/私聊共用） */
  recent: RecentConfig
  group: GroupSenseConfig
  user: UserSenseConfig
  /** QQ 空间感知（只读；需要 NapCat 4.18.42+） */
  qzone: QzoneSenseConfig
  /** 主动工具（群打卡 / 资料卡点赞），默认全部关闭 */
  action: ActionConfig
}

// ─────────────────────────────────────────────
// 工具复选框的默认勾选值（取值 = 各 schema 里 Schema.const 的内部标识）
// 说明：工具选择用 `Schema.array(...).role('checkbox')`（对齐 livingmemory 的写法），
// 每个工具的专属参数放在紧邻的折叠子对象里（xxxOptions）。
// ─────────────────────────────────────────────

/** 群聊：默认勾选除 group_activity 外的全部（activity 要拉历史消息，较重） */
export const DEFAULT_GROUP_TOOLS = [
  'overview', 'members', 'memberDetail', 'notices', 'honors', 'essence', 'signed', 'avatar', 'files', 'albums',
] as const
/** 用户：四个只读工具默认全开 */
export const DEFAULT_USER_TOOLS = ['profile', 'avatar', 'reactionStats', 'friends'] as const
/** 空间：四个只读工具默认全开 */
export const DEFAULT_QZONE_TOOLS = ['feeds', 'posts', 'detail', 'profile'] as const

// 复选框字段显式声明为 Schema<string[]>：schema 默认会推成字面量联合类型，与 Config 接口里的 string[] 不兼容。
const groupToolsSchema = Schema.array(Schema.union([
  Schema.const('overview').description('group_overview：群名称 / 人数 / 全员禁言 + 我在本群的身份'),
  Schema.const('members').description('group_members：群成员列表（可按昵称 / 名片 / QQ 过滤）'),
  Schema.const('memberDetail').description('member_detail：某成员的群内详情（头衔 / 等级 / 入群时间 / 最后发言）'),
  Schema.const('notices').description('group_notices：群公告（概览 + 按需取完整正文与图片）'),
  Schema.const('honors').description('group_honors：群荣誉榜（龙王 / 群聊之火 / 快乐源泉等）'),
  Schema.const('essence').description('group_essence：群精华消息'),
  Schema.const('signed').description('group_signed：今日打卡（签到）榜'),
  Schema.const('avatar').description('group_avatar：看群头像（需模型支持图片输入）'),
  Schema.const('activity').description('group_activity：近期发言活跃度统计（拉历史消息，较重）'),
  Schema.const('files').description('group_files：群文件列表与（可选）文件内容读取'),
  Schema.const('albums').description('group_albums：群相册列表与上传批次详情'),
]))
  .role('checkbox')
  .default([...DEFAULT_GROUP_TOOLS])
  .description('勾选要启用的群聊感知工具') as unknown as Schema<string[]>

const userToolsSchema = Schema.array(Schema.union([
  Schema.const('profile').description('user_profile：任意 QQ 的资料卡（昵称 / 签名 / 等级 / 注册时间 / VIP 等）'),
  Schema.const('avatar').description('user_avatar：看某人的 QQ 头像（需模型支持图片输入）'),
  Schema.const('reactionStats').description('profile_reaction_stats：资料卡的互动数据（总计 / 今日新增 / 最近互动的人）'),
  Schema.const('friends').description('friend_overview / friend_search：好友总数、分组、单向好友与好友搜索'),
]))
  .role('checkbox')
  .default([...DEFAULT_USER_TOOLS])
  .description('勾选要启用的用户 / 资料感知工具') as unknown as Schema<string[]>

const qzoneToolsSchema = Schema.array(Schema.union([
  Schema.const('feeds').description('qzone_feeds：朋友们的空间动态（带序号，可往前翻）'),
  Schema.const('posts').description('qzone_posts：某人（或自己）的说说列表（带序号，可往后翻）'),
  Schema.const('detail').description('qzone_post_detail：单条说说的全文与评论（含楼中楼）'),
  Schema.const('profile').description('qzone_profile：空间名称与说明'),
]))
  .role('checkbox')
  .default([...DEFAULT_QZONE_TOOLS])
  .description('勾选要启用的 QQ 空间工具（需要 NapCat 4.18.42+）') as unknown as Schema<string[]>

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
    imageMaxKb: Schema.number().min(64).max(4096).default(512)
      .description('空间/相册/群文件/公告里的内容图，单张内联上限（KB）。超过上限会先压到 imageMaxSide、JPEG 质量 72 再内联；压完仍超限就只给文字与链接。装了 chatluna-request-meter 后请求体由它在发送前改写，这里主要影响对话历史体积与画质'),
    imageBudgetKb: Schema.number().min(0).max(16384).default(2048)
      .description('每个会话在一个时间窗内最多内联多少内容图（KB）。超了就只给文字与链接，等窗口滑过去再恢复。0 = 不限制（不建议）'),
    imageWindowMinutes: Schema.number().min(1).max(1440).default(30)
      .description('上面那个图片预算的时间窗（分钟）'),
    imageMaxSide: Schema.number().min(512).max(2048).default(1280)
      .description('压缩时的长边像素。默认 1280：照片够清晰，公告/群文件里的截图小字也基本能看清；看不清可以调到 1600–2048（单张体积会相应变大）'),

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
      tools: groupToolsSchema,


      memberOptions: Schema.object({
        limit: Schema.number().min(10).max(200).default(50)
          .description('成员列表单次最多输出行数（超出时提示用关键词缩小）'),
      })
        .default({} as GroupSenseConfig['memberOptions'])
        .description('成员列表（group_members）')
        .collapse(),

      noticeOptions: Schema.object({
        includeNewMember: Schema.boolean().default(true)
          .description('是否包含"发送给新成员"的那类公告（需要较新版本的 NapCat 才能读到）'),
        imageLimit: Schema.number().min(0).max(6).default(3)
          .description('查看某条公告详情时，最多取回几张公告图片交给模型（0 = 不取图，只说明有几张）'),
      })
        .default({} as GroupSenseConfig['noticeOptions'])
        .description('群公告（group_notices）')
        .collapse(),

      activityOptions: Schema.object({
        count: Schema.number().min(50).max(500).default(200)
          .description('活跃度统计默认拉取的消息条数'),
      })
        .default({} as GroupSenseConfig['activityOptions'])
        .description('活跃度统计（group_activity）')
        .collapse(),

      fileOptions: Schema.object({
        listOnly: Schema.boolean().default(true)
          .description('只显示文件列表（文件名 / 大小 / 上传者 / 时间），不下载内容。关闭它才会启用下面的「尝试解析文件」'),
        parse: Schema.boolean().default(false)
          .description('尝试解析可获取的文件内容交给模型（txt/md/json/csv/docx/pptx/xlsx/图片；pdf 只给下载链接）。仅在关闭「只显示文件列表」后生效'),
        maxKb: Schema.number().min(64).max(51200).default(8192)
          .description('单个群文件允许下载的最大体积（KB），超过只给元数据与下载链接'),
        textLimit: Schema.number().min(500).max(100000).default(20000)
          .description('单个文件最多交给模型多少字（超出截断并注明）'),
      })
        .default({} as GroupSenseConfig['fileOptions'])
        .description('群文件（group_files）')
        .collapse(),

      albumOptions: Schema.object({
        imageLimit: Schema.number().min(0).max(9).default(3)
          .description('查看某次上传详情时，一次最多取回几张图片交给模型（0 = 只看文字说明）'),
        cooldownSeconds: Schema.number().min(0).max(300).default(10)
          .description('相册详情两次调用之间的会话冷却（秒），防止模型连着刷图'),
        batchLimit: Schema.number().min(1).max(100).default(20)
          .description('相册概览一次最多列多少个上传批次'),
      })
        .default({} as GroupSenseConfig['albumOptions'])
        .description('群相册（group_albums）')
        .collapse(),
    })
      .default({} as GroupSenseConfig)
      .description('群聊环境感知工具'),
  }),

  // ── 聊天上下文（最近消息，群聊/私聊共用）──
  Schema.object({
    recent: Schema.object({
      enabled: Schema.boolean().default(true)
        .description('recent_messages：查看当前会话最近的聊天记录（群聊看当前群、私聊看当前对端；包括没有触发 bot 的消息）'),
      count: Schema.number().min(1).max(100).default(30)
        .description('默认返回多少条'),
      max: Schema.number().min(1).max(100).default(100)
        .description('单次最多多少条（模型可以要求更少，但不能超过这个数）'),
    })
      .default({} as RecentConfig)
      .description('聊天上下文'),
  }),

  // ── 用户感知 ──
  Schema.object({
    user: Schema.object({
      tools: userToolsSchema,

      friendOptions: Schema.object({
        limit: Schema.number().min(1).max(100).default(10)
          .description('friend_search 一次最多列多少个匹配的好友'),
      })
        .default({} as UserSenseConfig['friendOptions'])
        .description('好友搜索（friend_search）')
        .collapse(),
    })
      .default({} as UserSenseConfig)
      .description('用户/个人资料感知工具'),
  }),

  // ── QQ 空间感知（只读；需要 NapCat ≥ 4.18.42）──
  // 这些 action（get_qzone_*）是 NapCat 4.18.42 才新增的，旧版本会返回"不支持的 API"。
  // 走的都是空间网页接口：只读、不落库、缓存 TTL 比全局长。
  Schema.object({
    qzone: Schema.object({
      tools: qzoneToolsSchema,

      count: Schema.number().min(1).max(50).default(8)
        .description('列表工具默认返回多少条'),
      max: Schema.number().min(1).max(100).default(20)
        .description('列表工具单次最多返回多少条（好友动态实际最多 50、说说列表最多 100，插件会再夹一次）'),
      maxAgeDays: Schema.number().min(0).max(3650).default(14)
        .description('最多看多少天前的空间动态/说说（默认 14 天，0 = 不限制）。好友动态和说说列表都按时间倒序，超过这个天数的条目不再列出，也不再继续往后翻页'),
      cacheTtlSeconds: Schema.number().min(0).max(3600).default(180)
        .description('空间查询结果的缓存时间（秒）。空间走网页接口，缓存长一点能明显减少被风控的机会；0 = 每次都实查'),

      detailOptions: Schema.object({
        commentCount: Schema.number().min(1).max(50).default(20)
          .description('打开说说详情时默认取多少条评论'),
        imageLimit: Schema.number().min(0).max(4).default(0)
          .description('打开说说详情时默认取几张图（0 = 只看图数、不下载；非 0 需要主模型支持图片输入）'),
      })
        .default({} as QzoneSenseConfig['detailOptions'])
        .description('说说详情（qzone_post_detail）')
        .collapse(),
    })
      .default({} as QzoneSenseConfig)
      .description('QQ 空间感知工具（需要 NapCat 4.18.42 及以上）'),
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
