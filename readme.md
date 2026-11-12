# koishi-plugin-chatluna-envsense

[![npm](https://img.shields.io/npm/v/koishi-plugin-chatluna-envsense?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-chatluna-envsense)

为 ChatLuna 的 Agent（plugin）模式提供一组**环境感知工具**，让模型按需了解自己所在的群、某个 QQ 的资料卡、当前会话最近的聊天记录、群文件与群相册、QQ 空间的动态与说说，以及打开别人发来的合并转发。

查询工具是**只读**的，平时**不注入提示词**——不看就不花 token。另有**默认关闭的主动工具**（当前群打卡、给当前发言人点赞），会改变 QQ 侧状态，受白名单与"每天一次"约束。

## 特点

- **六类只读能力、默认 21 个工具**：群聊、用户、聊天记录、好友、群文件/相册、QQ 空间，逐项可关
- **能看到没 @ 它的消息**：`recent_messages` 读群漫游/私聊历史，补上 chatluna 只记录"触发过回复"的缺口
- **图片真的看得见**：头像、公告图、相册图先把字节取回来再交给模型，而不是甩一个链接
- **空间动态带时效**：默认只看最近 14 天（`qzone.maxAgeDays`），列表带序号、详情只认编号，内部标识不用模型转述
- **合并转发真能读**：`read_forward_msg` 自研实现，不依赖 chatluna-forward-msg；配套「引用修复」解决 chatluna 对被引用的聊天记录拿不到 ID 的问题
- **说话像"自己看到的"**：工具描述要求第一人称讲述、不提工具与接口；失败时说"我这会儿没看清"，不抛错误码

## 平台要求

| 项 | 要求 |
| --- | --- |
| 平台 | 仅 **NapCat(onebot11)** |
| ChatLuna | `^1.4.0`，需开启 Agent / plugin 模式 |
| NapCat | 建议 **≥ 4.18.42**（QQ 空间工具需要；其余工具 4.18.38 即可）。主动打卡另需 **PacketBackend** |
| 可选 | `chatluna-storage-service`（图片转存）、`database`（主动工具"当天一次"状态持久化）、`chatluna-request-meter`（把请求体里的 base64 换成 `file_id`/公网 URL） |

## 安装

```
npm i koishi-plugin-chatluna-envsense
```

或在 Koishi 控制台的「插件市场」搜索 `chatluna-envsense` 安装并启用。

## 配置示例

```yaml
plugins:
  chatluna-envsense:
    debug: false            # 排查时临时打开
    avatarDelivery: inline  # inline 最稳；storage 需要公网 serverPath
    imageMaxSide: 1280      # 图片压缩长边
    group:
      tools:                # 勾选启用的群聊工具（复选框）
        - overview
        - members
        - memberDetail
        - notices
        - honors
        - essence
        - signed
        - avatar
        - files
        - albums
      memberOptions:
        limit: 100          # 成员列表单次最多输出行数
      fileOptions:
        listOnly: true      # 默认只列群文件，不开解析
        parse: false
    user:
      tools: [profile, avatar, reactionStats, friends]
      friendOptions:
        limit: 5
    qzone:
      tools: [feeds, posts, detail, profile]
      maxAgeDays: 14        # 只看最近两周的动态
      detailOptions:
        imageLimit: 0       # 0 = 只看图数，不下载
    forward:
      tool: true
      quoteFix: true
    action:                 # 主动工具，默认全关
      common:
        whitelistEnabled: false
        groups: []
      like:
        enabled: false
      checkin:
        enabled: false
        auto:
          enabled: false
          groups: []        # 留空 = 不自动打卡
```

## 配置

### 通用

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| `debug` | ❌ | 输出详细日志（调用明细、原始返回、取图过程）。关闭时只留报错与一行就绪信息 |
| `cacheTtlSeconds` | `300` | 查询结果的内存缓存秒数，`0` = 每次实查 |
| `avatarDelivery` | `inline` | `inline` = 取回字节后 base64 内联（默认，最稳）；`storage` = 转存 chatluna_storage 后给地址；`link` = 只给直链 |
| `avatarMaxKb` | `1536` | 头像单图内联上限（KB） |
| `avatarSize` | `640` | 头像档位。qlogo 只接受 `0/40/100/140/640`，其余返回 400；插件会自动兜底 |
| `imageMaxKb` | `512` | **内容图**（空间/相册/群文件/公告）单张内联上限（KB） |
| `imageMaxSide` | `1280` | 压缩长边。1280 对照片与截图都够用，看不清可调到 1600–2048 |
| `imageBudgetKb` | `2048` | **每会话**在时间窗内最多内联多少内容图（KB），超了只给文字与链接；`0` = 不限 |
| `imageWindowMinutes` | `30` | 上面那个预算的时间窗，从"最后一次看图"起算并累计 |
| `forward.tool` | ✅ | 注册 `read_forward_msg`（打开合并转发） |
| `forward.quoteFix` | ✅ | 给被引用/被回复的聊天记录补 `<forward id="…"/>` 标记，使其可被读取 |
| `forward.maxDepth` / `forward.maxEntries` / `forward.maxChars` | `3` / `40` / `4000` | 嵌套层数 / 单次条数 / 输出字数上限 |

> `storage` 模式的 `serverPath` 必须是**供应商访问得到的公网地址**（默认是 `127.0.0.1:5140`，远程 API 够不到）；否则保持 `inline`。

### 群聊感知

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| `group.tools` | 除 `activity` 外全选 | **复选框**：勾选启用的群聊工具（`overview` / `members` / `memberDetail` / `notices` / `honors` / `essence` / `signed` / `avatar` / `activity` / `files` / `albums`） |
| `group.memberOptions.limit` | `50` | `group_members` 单次最多输出行数（超出提示用关键词缩小） |
| `group.noticeOptions.includeNewMember` | ✅ | 是否包含"发给新成员"的公告（需 NapCat ≥ 4.18.38） |
| `group.noticeOptions.imageLimit` | `3` | 公告详情最多取几张图（`0` = 不取） |
| `group.activityOptions.count` | `200` | 活跃度统计默认拉取的消息条数 |
| `group.fileOptions.listOnly` | ✅ | 只列文件元数据。**这是读取的前提**；关掉后才启用解析 |
| `group.fileOptions.parse` | ❌ | 解析 txt/md/json/csv/docx/pptx/xlsx/图片交给模型（pdf 只给链接） |
| `group.fileOptions.maxKb` / `group.fileOptions.textLimit` | `8192` / `20000` | 单文件下载上限（KB）/ 单文件输出字数上限 |
| `group.albumOptions.imageLimit` / `group.albumOptions.cooldownSeconds` / `group.albumOptions.batchLimit` | `3` / `10` / `20` | 单次取图数 / 详情冷却（秒）/ 概览批次数 |

> 带 `Options` 的几项是**折叠子块**，只对相应工具生效；没勾选该工具时，它们的值不影响行为。

### 聊天上下文

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| `recent.enabled` | ✅ | `recent_messages` 当前会话最近的聊天记录（含没触发 bot 的消息） |
| `recent.count` / `recent.max` | `30` / `100` | 默认条数 / 单次上限 |

> 只看**当前会话**：群聊看当前群、私聊看当前对端，不接受任何目标 ID。

### 用户感知

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| `user.tools` | 全选 | **复选框**：`profile`（资料卡）、`avatar`（头像）、`reactionStats`（互动数据）、`friends`（好友概况与搜索） |
| `user.friendOptions.limit` | `10` | `friend_search` 一次最多列多少个匹配的好友 |

### QQ 空间感知（只读）

> 依赖 NapCat 4.18.42 新增的 `get_qzone_*` action，旧版本会提示"不支持的 API"。
> 空间走网页接口，风控风险高于群信息，所以缓存独立、且**不提供任何写操作**。

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| `qzone.tools` | 全选 | **复选框**：`feeds`（好友动态）/ `posts`（说说列表）/ `detail`（说说详情）/ `profile`（空间资料） |
| `qzone.count` / `qzone.max` | `8` / `20` | 列表默认条数 / 单次上限（接口上限：动态 50、说说 100） |
| `qzone.maxAgeDays` | `14` | **最多看多少天前**的动态/说说（`0` = 不限）。超期条目不再列出，也不再提供翻页入口 |
| `qzone.cacheTtlSeconds` | `180` | 空间结果缓存秒数，`0` = 每次实查 |
| `qzone.detailOptions.commentCount` | `20` | 详情默认取多少条评论（折叠块，`detail` 勾选后才有意义） |
| `qzone.detailOptions.imageLimit` | `0` | 详情默认取几张图（`0` = 只看图数，不下载；上限 4） |

> **编号机制**：列表工具把结果存进「本会话最近一次列表」，`qzone_post_detail` 只认其中的 `index`；
> 快照 10 分钟过期，过期后模型会被告知"记不得了"，重新看一遍即可。

### 主动工具（默认关闭）

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| `action.common.whitelistEnabled` / `action.common.groups` | ❌ / `[]` | 群白名单。开启且列表为空 = **全部禁用** |
| `action.like.enabled` | ❌ | `profile_like`：给**当前发言人**（群聊）或**当前私聊对象**点赞，不能指定别人 |
| `action.like.times` / `action.like.maxPerDay` | `10` / `20` | 每次点几个（QQ 普通号每好友每天 10 次、SVIP 20 次）/ 每天最多给多少人点 |
| `action.checkin.enabled` | ❌ | `group_checkin`：bot 以自己在**当前群**的身份打卡，每群每天一次 |
| `action.checkin.verify` | ✅ | 打卡后用今日打卡榜核对（`send_group_sign` 不回执，`retcode 0` 只代表已受理） |
| `action.checkin.auto.enabled` | ❌ | 每天自动打卡（与工具共享"当天一次"状态） |
| `action.checkin.auto.groups` | `[]` | **只打这些群**；留空 = 不自动打卡，不回退到全部群（与白名单取交集） |
| `action.checkin.auto.time` / `action.checkin.auto.jitterMinutes` | `00:05` / `10` | 时间（本地时区）/ 随机延迟分钟数 |
| `action.checkin.auto.catchUp` / `action.checkin.auto.intervalSeconds` / `action.checkin.auto.maxGroups` | ✅ / `3` / `50` | 掉线补跑 / 群间隔 / 单次最多处理几个群 |

> 配置页层级：**主动工具 → 通用 / 主动点赞 / 群打卡 → 自动群打卡**（这几块没用 `.collapse()`，否则会被渲染成字段行）。
>
> 状态：群打卡每群每天一次、点赞每人每天一次，模型调用与自动打卡共用同一份状态；装了 `database` 会落库，未装则存内存。

### 合并转发（聊天记录）

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| `forward.tool` | ✅ | `read_forward_msg` 打开别人发来的聊天记录（自研，不依赖 chatluna-forward-msg） |
| `forward.quoteFix` | ✅ | 引用段落补 `<forward id="…"/>`，让被引用的聊天记录也能读到 |
| `forward.maxDepth` / `maxEntries` / `maxChars` | `3` / `40` / `4000` | 嵌套层数 / 条数 / 字数上限 |

## 工具

| 工具 | 说明 |
| --- | --- |
| `group_overview` | 群概况：群名、人数上限、全员禁言、我在本群的名片与身份 |
| `group_members` | 群成员名单，支持 `keyword` / `role` / `limit`；大群会截断，找人请带 `keyword` |
| `member_detail` | 某成员的群内处境：头衔、群等级、入群时间、最后发言、禁言状态 |
| `group_notices` | 群公告。默认概览（含每条 `id`）；带 `notice_id` 再看一次得完整正文 + 图片 |
| `group_honors` / `group_essence` / `group_signed` | 荣誉榜 / 精华消息 / 今日打卡榜 |
| `group_activity` | 按发送者聚合的近期发言活跃度 Top 榜 |
| `group_files` | 不传 `file_id` 列目录；传 `file_id + file_name` 读内容（txt/md/json/csv/docx/pptx/xlsx/图片，pdf 只给链接） |
| `group_albums` | 不传 `album_id` 列相册；传 `album_id` 列上传批次；传 `album_id + batch` 看详情与图片（`offset` 分次看） |
| `recent_messages` | 当前会话最近的聊天记录，包括**没有触发 bot** 的消息；带 `before` 往前翻 |
| `group_avatar` / `user_avatar` | 看群头像 / 某人头像（多模态） |
| `user_profile` | QQ 资料卡：昵称、性别、年龄、签名、等级、注册时间、会员、地区等 |
| `profile_reaction_stats` | 获赞总数、今日获赞、点赞人数、最近点赞的人 |
| `friend_overview` / `friend_search` | 好友总数/分组/单向好友；按 QQ 或昵称/备注找人 |
| `qzone_feeds` | 朋友们的空间动态，带序号，`more` 往前翻 |
| `qzone_posts` | 某人的说说（`user_id`，或 `mine=true` 看自己），`offset` 往后翻 |
| `qzone_post_detail` | 按列表 `index` 打开全文与评论（含楼中楼）；`images` 指定这次看几张 |
| `qzone_profile` | 空间名称与说明 |
| `read_forward_msg` | 逐条列出合并转发内容，支持嵌套、图片/语音/文件占位；`messageId` 留空或填 `current` |
| `group_checkin` / `profile_like` | **主动**：当前群打卡 / 给当前发言人点赞（默认关闭） |

`user_id` / `group_id` 一般留空：群号默认取当前会话所在群，QQ 号默认取当前消息发送者（私聊即对话对象）。

## 图片与 chatluna-request-meter

图片的处理分两层，**互不依赖**：

| 环节 | 由谁负责 |
| --- | --- |
| 取图（QQ 侧 → 字节）、校验是不是真图片 | envsense |
| 压缩到 `imageMaxKb` / `imageMaxSide`、每会话预算 | envsense |
| 交给模型的格式 | **base64 data URI**（固定） |
| 发送前把 base64 换成 `file_id` / 公网 URL | **chatluna-request-meter** |

- **为什么固定交 base64**：ChatLuna 在请求层之前就会把 http(s) 图片下载成 base64，交链接既不省请求体，还会让每轮请求重新下载一次。
- **装了 request-meter**（`imageMode=files`）时保持默认即可；想要更高画质可把 `imageMaxKb` 调到 1024、`imageMaxSide` 调到 1600。
- **没装 request-meter** 也能正常工作（不依赖其服务）：压缩改为**逐级降档**（1280 → 900 → 640，必要时质量 60），细节极多的图也能落进 `imageMaxKb`。
- **张数叠加**：request-meter 的 `filesMaxPerRequest`（默认 8）是每请求的转换上限；历史里累计的图超过它时，多出来的仍以 base64 发送。可让 `imageBudgetKb` 保持在"约 8–10 张"附近。
- **残余风险**：历史里已内联的图会随每次请求重发，而 `imageBudgetKb` 只约束"新看图"的节奏。超长会话反复看图，建议直接上 request-meter。

## 示例

- "这个群有多少人，我在群里是什么身份？"
- "群里有没有叫小明的？他什么时候入群的？"
- "看看这个群最近谁最活跃 / 谁是龙王"
- "那条公告的完整内容念给我听"（模型用概览里的 id 再取一次）
- "把公告里的图片描述一下 / 评价一下我们群的新头像"（需模型支持图片输入）
- "这叠聊天记录里都说了啥？"（引用场景靠 `forward.quoteFix` 才读得到）
- "朋友们最近发了什么？" / "看看他的空间，最近两周的就行"
- "帮我打个卡" / "赞我"（主动工具，需开启且当前群在白名单内）

## 注意事项

- 资料卡、空间资料的公开程度取决于对方隐私设置，缺字段属正常，不代表查询失败。
- 群公告、荣誉榜、精华走 NapCat 网页协议，偶发失败稍后重试即可（**失败结果不进缓存**）。
- **荣誉榜**：QQ 已把页面改成 SPA，NapCat 按旧格式解析会四个类型全失败并静默返回空数组。插件发现全空时会自己带 cookie 直连新版接口，取回龙王/群聊之火/快乐源泉；「群聊炽热」「冒尖小春笋」暂无对应数据。NapCat 修好后这段兜底会自动不再触发。
- **公告图片**：NapCat 只给 `{id, 宽, 高}`，插件依次尝试「条目自带地址 → `get_image` → 通用地址」，全失败时明确说"取不到"，不编造内容。
- **内联图片会永久留在对话历史**（chatluna 不压缩历史）：靠 `imageMaxKb` 压缩 + `imageBudgetKb` 限制节奏。**已被撑爆的旧会话不会自愈**，需要新开会话或清理历史。
- `profile_reaction_stats` 不含"今日排名"；接口时间戳不可信时会直接省略该行，不打印 1970 年。
- 聊天记录里的图片以 `[图 链接]` 呈现（**不下载字节**），语音/视频/文件同理只给占位。
- **直发**聊天记录的 `<forward id>` 标记依赖 chatluna 的 `attachForwardMsgIdToContext`（默认关闭）；本插件的「引用修复」**不依赖**它。
- 与 `chatluna-forward-msg` 同开时两者都注册 `read_forward_msg`，chatluna 按名字覆盖，后注册者生效（本方在 apply 期、对方在 ready 期）。启动日志会说明当前由谁提供。
- **主动工具只作用于当前会话**：群号/QQ 号来自 session，工具参数没有目标 ID，无法通过提示词给"别人/别的群"打卡或点赞。点赞对非好友可能静默失败，插件无法区分。

## 更新日志
### 1.4.3

  - **配置页重构（旧配置会自动迁移）**：
  - 群聊 / 用户 / QQ 空间的工具开关从「每个工具一个开关」合并为**复选框列表**
    （`group.tools` / `user.tools` / `qzone.tools`），一屏看完、勾选即启用；
  - 每个工具的专属参数收进紧邻的**折叠子块**：`group.memberOptions` / `group.noticeOptions` /
    `group.activityOptions` / `group.fileOptions` / `group.albumOptions` / `user.friendOptions` /
    `qzone.detailOptions`。原来的扁平键（如 `group.memberLimit`、`group.fileParse`、
    `qzone.commentCount`）都搬进了对应子块；
  - **升级不需要手改配置**：插件启动时会识别旧键并自动换算——
    旧布尔开关折算进 `tools`（关掉的工具仍保持关闭），旧标量搬进对应子块，随后删掉旧键；
    迁移时打一条 warn 日志列出识别到的旧键，建议在控制台确认后保存一次，让配置文件只剩新键；
  - 如果 `tools` 已经不是默认值（说明你已手工迁移过），旧布尔只做清理，不会覆盖你的选择；
  - 子块默认折叠，展开才显示具体数值，配置页长度明显缩短。

### 1.4.2

**新增**

- **`qzone.maxAgeDays`（默认 14 天）**：空间动态与说说列表只列最近 N 天，`0` = 不限。
  列表按时间倒序，一旦本页出现超期条目就停止（后面的只会更早），也不再提供翻页入口；
  时间字段缺失/异常的条目保留（无法证明超期）。整页都超期时会如实说"最近 N 天没有新动态"。

**改进**

- **压缩长边可配** `imageMaxSide`（默认 **1280**，此前固定 900）：照片更清晰，公告/群文件的截图小字也更容易辨认。
- **压缩改为逐级降档**：1280 → 900 → 640，必要时再把 JPEG 质量降到 60。以前只压一档，细节极多的图压完仍超 `imageMaxKb` 就整张放弃（模型只能回"加载不出来"）；现在只要有一档塞得进就交付。
- **空间详情单次最多看 4 张图**（原 2 张）：压缩后单张通常 100–250KB，2 张的限制已无必要。

**说明**

- **不依赖 `chatluna-request-meter`**：没装时插件加载、工具注册、空间四个工具与图片交付均实测正常。
- 图片**始终以 base64 交给模型**（http 链接会在请求层之前被 ChatLuna 下载成 base64，交链接只会让每轮请求重复下载），想进一步减小请求体请配合 `chatluna-request-meter`。

### 1.4.1

**修复：看几张图之后开始 413（请求体超过供应商上限）**

- **根因**：base64 内联的图会永久写进对话历史，而 chatluna 不压缩历史。空间照片单张 350–840KB，模型一次并发看三张就多出约 2.4MB 字符；旧实现的取图上限是 `max(avatarMaxKb, 4MB)`，等于没有防线。
- **修法**：
  1. 超过 `imageMaxKb`（默认 512KB）的图先压到 900px / JPEG q72 再内联；
  2. 每会话图片预算 `imageBudgetKb`（默认 2MB）/ `imageWindowMinutes`（默认 30 分钟），超了只给文字与链接；
  3. 空间/相册/群文件/公告统一走同一条交付链，`qzone_post_detail` 单次最多 2 张图（1.4.2 起放宽到 4）。
- **依赖**：新增 `jimp`。未安装或格式无法解码时自动退化为"只给文字与链接"，不报错。
- **注意**：已被撑爆的旧会话不会自愈，需新开会话或清理历史。

<details>
<summary>更早版本（1.4.0 及以前）</summary>

### 1.4.0

**新增：QQ 空间感知（只读四件套）**

- `qzone_feeds`（好友动态）、`qzone_posts`（某人/自己的说说）、`qzone_post_detail`（全文与评论，含楼中楼）、`qzone_profile`（空间名称与说明）。
- 走 NapCat 4.18.42 新增的 `get_qzone_*` action。列表结果存进「本会话最近一次列表」，详情只认编号，`tid`/`feed_ref` 不用模型转述；快照 10 分钟过期。
- 默认工具数 17 → 21，四个工具默认开启、可逐项关闭。
- **需要 NapCat ≥ 4.18.42**；空间接口风控风险高于群信息，`qzone.cacheTtlSeconds` 默认 180 秒且独立于全局缓存，不提供任何写操作。

### 1.3.0

- **`recent_messages`**：群聊看当前群、私聊看当前对端，包括没有触发 bot 的消息；默认 30 条、最多 100 条，带 `before` 往前翻。
- **好友工具**：`friend_overview` 与 `friend_search`，只读，不含好友申请，也不输出手机号/邮箱/生日。
- **`group_files`**：先列元数据，再按 `file_id + file_name` 读内容（OOXML 用内置 zlib 解，不引第三方库）。
- **`group_albums`**：两段式，按上传批次看详情与图片，`offset` 分次看，详情有冷却。
- **微调**：所有只读工具的对模型文案改为第一人称"感知"口吻，不再出现管理员/开关/协议端/调用/冷却等机制词。

### 1.2.1

- 修复模型把工具名译成中文（如「群内打卡」）导致调用被判为"没有这个工具"：注册描述里带上精确工具名并要求原样写。
- 修复打卡"假成功"：`send_group_sign` 不回执，`retcode 0` 只代表已受理；新增 `action.checkin.verify` 用今日打卡榜核对。
- 兼容只注册了 `set_group_sign` 的协议端，遇到"不支持的 API"时自动回退。

### 1.2.0

- 新增主动工具 `group_checkin`（当前群打卡）与 `profile_like`（给当前发言人点赞），默认关闭，目标只来自当前会话。
- 新增自动群打卡：独立群列表、随机延迟、共享"当天一次"状态、支持掉线补跑；需要 NapCat PacketBackend。
- 约束：可选群白名单（开启且为空 = 全禁）、每人每天一次、全局每日点赞上限、不注册给子代理；状态可选持久化到 `database`。

### 1.1.1

- 优化配置项描述文本（1.1.0 改完忘记编译就上传了）。

### 1.1.0

- **合并转发**：`read_forward_msg` 自研实现（不依赖 chatluna-forward-msg），支持嵌套与条数/字数上限；`forward.quoteFix` 给被引用的聊天记录补 `<forward id="…"/>`。
- **群荣誉榜直连兜底**：NapCat 解析失效时自己带 cookie 直连新版接口；空结果不再进缓存。

### 1.0.1

- 修正依赖声明：`zod`（精确锁 `3.25.76`）与 `@langchain/core` 移入 `dependencies`，解决插件市场误报"不兼容"。

### 1.0.0

- 首个正式版。

</details>

## License

MIT