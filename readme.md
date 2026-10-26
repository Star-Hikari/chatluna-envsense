# koishi-plugin-chatluna-envsense

[![npm](https://img.shields.io/npm/v/koishi-plugin-chatluna-envsense?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-chatluna-envsense)

为 ChatLuna 的 Agent（plugin）模式提供一组**环境感知工具**：模型可以按需了解自己所在的群、群成员、群公告、群荣誉 / 精华 / 打卡、某个 QQ 的资料卡、头像与获赞情况，以及**打开别人发来的合并转发（聊天记录）**。

查询工具是**只读**的——平时**不注入任何提示词**，不看就不花 token，由模型自己决定什么时候去看。

另有一组**默认关闭的主动工具**（会改变 QQ 侧状态）：

- `group_checkin`：只能给**当前群**打卡，每个群每天一次；
- `profile_like`：只能给**当前发言人**（群里）或**当前私聊对象**点赞，不能点名别人，每人每天一次。

主动工具受「群白名单 + 每天一次 + 全局每日上限」约束，且**不注册给子代理**；开启前插件行为与之前完全一致。
群打卡还可以选择**每天自动执行**（与模型调用共享同一份"当天一次"状态）。

唯一的"读工具也会写消息"的例外是「**引用合并消息修复**」开关（默认开启）：它会在**被引用 / 被回复**的聊天记录位置补一个十来字节的 `<forward id="…"/>` 标记，让模型能把这段记录交给 `read_forward_msg` 去读——chatluna 自己只在**直发**聊天记录时补这个标记，引用那条永远是空的。不需要就关掉它，插件随即回到"完全不碰消息"的状态。

## 特点

- **群聊 + 用户 + 合并转发三类只读能力**，共 12 个工具，可逐项开关
- **两个可选主动工具**（默认关闭）：bot 以自己的身份在当前群打卡、给当前发言人/私聊对象点赞；不能指定别人，不能批量
- **主动工具受三层约束**：当前会话环境（群号/QQ 号从 session 取）、群白名单（可选，开启后空列表=全禁）、每人每天一次 + 全局每日上限
- **群打卡可自动执行**：每天固定时间（带随机延迟）只给**独立的自动打卡列表**里的群打卡，与模型调用共享"当天一次"状态；列表为空不执行，bot 掉线可在当天补跑
- **主动工具状态可持久化**：装了 database 就落库，重启不会重复；没装则内存，重启后可能重复一次
- **图片真的看得见**：头像与公告图片都先把字节取回来再交给模型（可选经 `chatluna-storage-service`
  转存，或 base64 直接内联），而不是把链接丢给模型让供应商自己抓
- **合并转发也真的能读**：`read_forward_msg` 为自研实现（**不依赖 chatluna-forward-msg**），支持嵌套记录、
  图片/语音/文件占位、条数与字数上限；配套的「引用修复」开关解决 chatluna 对**被引用的**聊天记录永远拿不到 ID 的问题
- **群公告两段式**：先给概览（含每条的 id），模型想细看再取完整正文与公告图片
- **说得像"自己看到的"**：工具描述参照
  [chatluna-livingmemory](https://www.npmjs.com/package/koishi-plugin-chatluna-livingmemory) 的写法——
  先说清"你能看到什么"、再说何时使用，并要求模型**用第一人称讲述、不要提及工具与接口**；
  失败时也说"我这会儿没看清"，而不是抛出错误码
- 查询结果带内存 TTL 缓存；失败信息统一成中文，不会中断对话

## 平台要求

| 项 | 要求 |
| --- | --- |
| 平台 | 仅 **NapCat(onebot11)**。 |
| ChatLuna | `^1.4.0`，需开启 Agent / plugin 模式 |
| NapCat | 建议 **≥ 4.18.38**；主动打卡需要 **PacketBackend**（NapCat ≥ 3.6.0，Windows amd64 内置） |
| 可选依赖 | [chatluna-storage-service](https://www.npmjs.com/package/koishi-plugin-chatluna-storage-service)（图片转存加速，未安装也能正常看图）、`database`（主动工具的"当天一次"状态持久化，未安装则用内存） |

## 安装

```
npm i koishi-plugin-chatluna-envsense
```

或在 Koishi 控制台的「插件市场」搜索 `chatluna-envsense` 安装并启用。

## 配置示例

```yaml
plugins:
  chatluna-envsense:
    debug: false          # 排查问题时临时打开，平时保持关闭
    cacheTtlSeconds: 300
    avatarDelivery: inline
    group:
      memberLimit: 100
      activity: false     # 要拉历史消息，较重，默认关闭
    forward:
      tool: true          # read_forward_msg：打开合并转发（聊天记录）
      quoteFix: true      # 修复 chatluna 对「引用合并消息」的处理
      maxChars: 4000      # 单次读取的输出字数上限
    action:               # 主动工具：会改变 QQ 侧状态，默认全部关闭
      common:             # 通用
        whitelistEnabled: false
        groups: []        # 开启白名单且为空 = 全禁
      like:               # 主动点赞
        enabled: false
        times: 10
        maxPerDay: 20
      checkin:            # 群打卡
        enabled: false
        verify: true      # 打卡后用今日打卡榜核对（QQ 不回执）
        auto:             # 自动群打卡
          enabled: false
          groups: []      # 只自动打这些群；留空 = 不自动打卡
          time: '00:05'
          jitterMinutes: 10
          catchUp: true
```

## 配置

### 通用

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `debug` | ❌ | 是否输出详细日志（工具调用明细、NapCat 原始返回、取图过程、启动时的工具清单）。关闭时只保留**报错类提示**与**一行就绪信息** |
| `cacheTtlSeconds` | `300` | 查询结果的内存缓存秒数，`0` 表示每次都实查 |
| `avatarDelivery` | `inline` | 图片交给模型的方式：`inline` = 取回字节后 base64 直接内联（最稳）；`storage` = 经 chatluna_storage 转存为临时文件后给地址；`link` = 只给直链 |
| `avatarMaxKb` | `1536` | base64 内联的单图字节上限（KB），超限则放弃并如实告知模型 |
| `avatarSize` | `640` | 头像尺寸档位。**qlogo 只接受 `0`/`40`/`100`/`140`/`640`**，其余值（200、600、800…）一律返回 HTTP 400；插件会按 640→140→100→40→0 自动兜底 |
| `forward.tool` | ✅ | 注册 `read_forward_msg`：打开合并转发（聊天记录）的工具 |
| `forward.quoteFix` | ✅ | 修复 chatluna 对**引用合并消息**的处理：给被引用/被回复的聊天记录补 `<forward id="…"/>` 标记（chatluna 自己只在直发时补）。开启后是插件唯一会改写消息内容的地方 |
| `forward.maxDepth` | `3` | 聊天记录里还套着聊天记录时最多展开几层（工具参数 `maxDepth` 可临时覆盖） |
| `forward.maxEntries` | `40` | 单次读取最多呈现多少条，超出会截断并注明 |
| `forward.maxChars` | `4000` | 单次读取输出字数上限（约等于 token 数，用于控制上下文开销） |

> 用 `storage` 模式时，`chatluna-storage-service` 的 `serverPath` 必须是**模型供应商访问得到的公网地址**
> （其默认值是 `http://127.0.0.1:5140`，远程 API 够不到）；否则保持默认的 `inline`。
>
> 实测各档位体积（同一个头像，仅供参考）：`640` ≈ 65–75 KB、`140` ≈ 7 KB、`100` ≈ 4.5 KB、
> `40` ≈ 1.6 KB、`0` = 原图（约 137–195 KB）。头像只是给模型辨认内容，`140` 通常就够用且更省。

### 群聊感知

| 配置项 | 默认值 | 对应工具 |
| --- | --- | --- |
| `group.overview` | ✅ | `group_overview` 群名称/人数/全员禁言 + 我在本群的名片与身份 |
| `group.members` | ✅ | `group_members` 群成员列表（可按昵称/名片/QQ 过滤） |
| `group.memberLimit` | `50` | 成员列表单次最多输出行数 |
| `group.memberDetail` | ✅ | `member_detail` 成员群内详情（头衔/等级/入群时间/最后发言） |
| `group.notices` | ✅ | `group_notices` 群公告（概览 + 按需取完整正文与图片） |
| `group.noticesIncludeNewMember` | ✅ | 群公告是否包含"发送给新成员"的那类公告 |
| `group.noticeImageLimit` | `3` | 看某条公告详情时最多取回几张公告图片（0 = 不取图） |
| `group.honors` | ✅ | `group_honors` 荣誉榜（龙王/群聊之火/快乐源泉等） |
| `group.essence` | ✅ | `group_essence` 群精华消息 |
| `group.signed` | ✅ | `group_signed` 今日打卡榜 |
| `group.avatar` | ✅ | `group_avatar` 看群头像（需模型支持图片输入） |
| `group.activity` | ❌ | `group_activity` 近期发言活跃度统计（拉历史消息较重，默认关闭） |
| `group.activityCount` | `200` | 活跃度统计默认拉取的消息条数 |

### 用户感知

| 配置项 | 默认值 | 对应工具 |
| --- | --- | --- |
| `user.profile` | ✅ | `user_profile` 任意 QQ 的资料卡（昵称/签名/等级/注册时间/VIP 等） |
| `user.avatar` | ✅ | `user_avatar` 看某人的 QQ 头像（需模型支持图片输入） |
| `user.reactionStats` | ✅ | `profile_reaction_stats` 资料卡获赞数据（只读） |

### 主动工具（默认关闭，会改变 QQ 侧状态）

#### 通用

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `action.common.whitelistEnabled` | ❌ | 是否启用群白名单。关闭 = 所有群都可用；开启 = 只有 `groups` 里的群可用，且**空列表 = 全部禁用** |
| `action.common.groups` | `[]` | 允许使用主动工具的群号（仅在白名单开启时生效） |

#### 主动点赞

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `action.like.enabled` | ❌ | 注册 `profile_like`：给**当前发言人**（群聊）或**当前私聊对象**点赞；不能指定别人 |
| `action.like.times` | `10` | 每次点赞点几个（1–20）。QQ 对普通账号的限制是每个好友每天 10 次，**SVIP 账号可到 20 次**；超过账号实际上限时以 QQ 侧为准 |
| `action.like.maxPerDay` | `20` | 每天最多给多少人点赞（全局上限，群聊 + 私聊合计；防止大量会话各要一次） |

#### 群打卡

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `action.checkin.enabled` | ❌ | 注册 `group_checkin`：bot 以自己在**当前群**的身份打卡。注意工具本身只是"可被调用"，不会自动执行 |
| `action.checkin.verify` | ✅ | 打卡后用 `get_group_signed_list`（今日打卡榜）核对 bot 是否真的签上了。NapCat 的 `send_group_sign` 是**发完不等待回执**的包，`retcode 0` 只代表请求被受理；核对到榜上没自己时会记为失败并允许冷却后重试，榜单取不到时按"请求已受理"处理（不会误判失败） |

##### 自动群打卡

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `action.checkin.auto.enabled` | ❌ | 每天自动打卡。与 `group_checkin` 工具共享"当天一次"状态，谁先做都算 |
| `action.checkin.auto.groups` | `[]` | **自动打卡只处理这些群**（与主动工具白名单是两套列表，白名单开启时还会取交集）；**留空 = 不自动打卡**，不会回退到全部群 |
| `action.checkin.auto.time` | `00:05` | 自动打卡时间（本地时区） |
| `action.checkin.auto.jitterMinutes` | `10` | 目标时间后随机延迟 0–N 分钟 |
| `action.checkin.auto.catchUp` | ✅ | 当天目标时间已过、但当时 bot 离线时，恢复后补跑一次 |
| `action.checkin.auto.intervalSeconds` | `3` | 群与群之间的间隔 |
| `action.checkin.auto.maxGroups` | `50` | 单次自动打卡最多处理多少个群（自动打卡列表超过它时只处理前 N 个） |

> 配置页层级：**主动工具 → 通用 / 主动点赞 / 群打卡 → 自动群打卡**。为保证「主动点赞」「群打卡」和「通用」是同级大标题，
> 这几块没有使用 `.collapse()`（折叠对象会被控制台渲染成"action.like 展开以编辑"的字段行）。

> 自动打卡的 `action.checkin.auto.groups` 与主动工具的 `action.common.groups` 是**两套列表**：
> 自动打卡只打前者；如果白名单开启，还要同时落在白名单里（取交集）。自动打卡列表为空时**不会**自动打卡，
> 也不会回退到"全部群"。

状态规则：

- 群打卡：每个群每天成功一次；模型调用（`group_checkin`）与自动打卡共用状态；
- 点赞：每个 QQ 每天成功一次（群聊/私聊合计），同时受 `action.like.maxPerDay` 限制；
- 群打卡拿不到 QQ 的服务端回执：`action.checkin.verify` 开启时插件会用今日打卡榜核对——榜上看到自己才算"打卡成功"；
  核对不到会记为失败并允许冷却后重试，榜单取不到时才退回"已发出打卡请求"的说法；
- 点赞对非好友可能静默失败（QQ 限制），插件无法区分，工具文案不会保证"对方一定收到"；
- QQ 普通账号每个好友每天最多 10 次点赞，**SVIP 账号可到 20 次**，所以 `action.like.times` 上限是 20；实际能否点满取决于账号等级与 QQ 侧限制；
- 状态默认放内存；装了 `database` 会落库并在重启后继续生效。

### 合并转发（聊天记录）

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `forward.tool` | ✅ | `read_forward_msg` 打开别人发来的聊天记录（自研实现，不依赖 chatluna-forward-msg） |
| `forward.quoteFix` | ✅ | 修复 chatluna 对引用合并消息的处理：引用段落补 `<forward id="…"/>`，让被引用/被回复的聊天记录也能被读到 |
| `forward.maxDepth` | `3` | 嵌套聊天记录展开层数 |
| `forward.maxEntries` | `40` | 单次最多呈现条数 |
| `forward.maxChars` | `4000` | 单次输出字数上限 |

## 工具

| 工具 | 说明 |
| --- | --- |
| `group_overview` | 群概况：群名、人数上限、全员禁言、机器人在本群的群名片与身份 |
| `group_members` | 群成员名单，支持 `keyword` / `role` / `limit`；大群会截断，找人请带 `keyword` |
| `member_detail` | 某位成员在本群的处境：头衔、群等级、入群时间、最后发言、禁言状态 |
| `group_notices` | 群公告。默认给**概览**（时间、发布者、置顶、「发给新成员」、已读数、图片数量、正文摘要、每条 id）；带上 `notice_id` 再看一次即得**完整正文 + 公告图片** |
| `group_honors` | 荣誉榜：当前龙王、群聊之火、快乐源泉等 |
| `group_essence` | 群精华消息（加精时间、发送者、操作人、内容摘要） |
| `group_signed` | 今日打卡（签到）榜 |
| `group_activity` | 按发送者聚合的近期发言活跃度 Top 榜 |
| `group_avatar` | 看群头像（多模态） |
| `user_profile` | QQ 资料卡：昵称、性别、年龄、签名、QQ 等级、注册时间、会员、生日、地区、大学等 |
| `user_avatar` | 看某人的 QQ 头像（多模态） |
| `profile_reaction_stats` | 获赞总数、今日获赞、点赞人数、最近点赞的人 |
| `read_forward_msg` | **打开合并转发（聊天记录）**：按「昵称 (QQ) 时间 + 正文」逐条列出，支持嵌套记录、图片/语音/视频/文件占位、条数与字数上限。`messageId` 留空或填 `current` 表示"当前这条消息（或它引用的那条）里的聊天记录" |
| `group_checkin` | **主动**：bot 以自己在当前群的身份打卡（群签到）。只能作用于当前群，每个群每天一次；需要 NapCat 开启 PacketBackend。默认打卡后会用今日打卡榜核对是否真的签上 |
| `profile_like` | **主动**：给当前发言人（群聊）或当前私聊对象点赞。不能指定别人，每人每天一次 |

`user_id` / `group_id` 一般留空即可：群号默认取当前会话所在群，QQ 号默认取当前消息发送者（私聊即对话对象）。

## 示例

- "这个群有多少人，我在群里是什么身份？"
- "群里有没有叫小明的，他是什么时候入群的？"
- "看看这个群最近谁最活跃 / 谁是龙王"
- "群里最近有什么精华消息？/ 群公告都写了什么？"
- "小屋须知那条公告的完整内容念给我听"（模型会用概览里的 id 再取一次完整正文）
- "把公告里的图片描述一下 / 评价一下我们群的新头像"（需要主模型支持图片输入）
- "我现在有多少赞？今天收到了几个？"
- "这叠聊天记录里都说了啥？/ 转发那条里有没有提到我？"
- "（引用一条聊天记录）你看看里面写了什么"（靠 `forward.quoteFix` 补上的标记才能读到）
- "帮我打个卡"（`group_checkin`，只在开启且当前群在白名单内时可用）
- "赞我 / 给我点个赞"（`profile_like`，只会给当前说话的人点赞）

## 并发与限流

- **只读查询**：所有 NapCat 查询共用一个并发闸门（最多 4 个在飞，排队上限 100）；
  同一份查询（同 key + 同 bot）并发时只发一次，其余等结果；排队满时直接返回"查询太多，稍后再试"。
- **缓存**：TTL 缓存最多 200 条，超出时先清过期、再按插入顺序淘汰；缓存对象只读，工具不会原地修改。
- **主动动作**：群打卡/点赞共用一个串行队列，叠加"当天一次"状态；并发调用同一群/同一用户时只会真正执行一次。
- **多进程提示**：状态持久化到 `database` 可以跨重启，但**不提供跨进程分布式锁**；不要多个 Koishi 实例同时对同一 QQ 账号开主动工具。
- **写操作超时**：NapCat 的写请求超时后无法确认是否已执行；当前按失败处理，60 秒后才允许重试。
  QQ 侧每好友每日点赞上限可以兜底，但仍建议不要频繁重试。
- 头像/公告图片的下载走 `ctx.http`，不占用 NapCat 查询闸门；图片较多时仍可能产生并发下载。

## 注意事项

- 资料卡的公开程度取决于对方隐私设置，缺失字段属于正常情况，不代表查询失败。
- 群公告、荣誉榜、精华等走 NapCat 网页协议，偶发失败稍后重试即可（**失败的查询不会被缓存**，重试就是实查）；
  其中荣誉榜当前有额外情况，见下一条。
  **「发给新成员」类公告需要 NapCat ≥ 4.18.38**（这类公告只在 `inst` 里，旧版不读 `inst`）；
  插件启动日志里带当前 NapCat 版本，便于对照。
- **荣誉榜的特别说明**：QQ 已把荣誉榜页面（`qun.qq.com/interactive/honorlist`）从服务端渲染改成 SPA，
  页面上不再有 NapCat 用来解析的 `window.__INITIAL_STATE__`，所以 NapCat 的
  `get_group_honor_info` 目前**四个类型都会失败**（它自己的日志里是「获取类型 N 的荣誉信息失败」），
  并且不报错、直接返回空数组。遇到这种全空结果时，本插件会自己带上 cookie 与 `bkn` 直连新版接口兜底，
  能取回**龙王、群聊之火、快乐源泉**（含连续天数）；「群聊炽热」在新的网页接口里没有找到对应数据，
  「冒尖小春笋」已被 QQ 下线，因此这两项通常是空的。等 NapCat 上游修好后，这段兜底会自动不再触发
  （它只在 NapCat 返回全空时才跑）。
- 公告图片在 NapCat 侧只有 `{id, 宽, 高}`、没有直链，插件会依次尝试「条目自带地址 → NapCat `get_image`
  → 公告图片通用地址」；全部失败时明确说"取不到"，不会编造图片内容。
- 图片类工具需要主模型具备图片输入能力，否则只能读到文字说明；取图失败时会如实说"没看清"。
- `profile_reaction_stats` 不含"今日排名"（接口不提供）；接口返回的时间戳若不可信（实测
  `favoriteInfo.last_time` 会给一个无意义的小数字，按秒解释就是 1970 年），插件会直接省略该行。
- `debug` 关闭时日志只有报错类提示与一行就绪信息（`chatluna-envsense 已就绪：…`）；
  需要排查工具调用细节时再打开它。
- 聊天记录里的图片以 `[图 链接]` 形式呈现（**不下载字节**），语音/视频/文件同理只给占位；想把图交给模型看，
  可以再把链接交给多模态相关工具。
- **直发**聊天记录时，chatluna 侧的 `<forward id="…"/>` 标记依赖它的 `attachForwardMsgIdToContext`
  （默认关闭，建议开启）；本插件的「引用修复」**不依赖**这一项。
- 与 `chatluna-forward-msg` 同时启用时，两者都注册 `read_forward_msg`，而 chatluna 的工具表是**按名字覆盖**的，
  最终生效的是后注册的那个（本方在 apply 期注册、对方在 ready 期注册）。想确定用本插件的实现，请停用对方的读取工具；
  插件会在启动日志里说明当前 `read_forward_msg` 由谁提供。
- **主动工具默认全部关闭**；开启后也只作用于当前会话环境（群号/QQ 号来自 session，工具参数里没有目标 ID），
  因此不能通过提示词让 bot 给"别人/别的群"打卡或点赞。群白名单关闭 = 所有群可用；开启且为空 = 全部禁用
  （自动打卡另有独立列表，不受这句话影响）。
- **群打卡依赖 NapCat PacketBackend**：不可用时工具会明确提示，不会静默失败。打卡接口不返回服务端结果，
  所以插件会在打包后用今日打卡榜核对（`action.checkin.verify`）：榜上看到自己才记为成功，看不到则记为失败并允许冷却后重试；
  只有榜单读不到时才退回"请求已受理"的说法。
- **自动打卡与模型调用共用状态**：同一天无论谁先触发，每个群只会成功一次；自动打卡只处理
  `action.checkin.auto.groups` 这个独立列表（空 = 不执行，不会回退到全部群），白名单开启时还要落在白名单内；
  默认 00:05，带 0–10 分钟随机延迟，支持当天掉线后补跑（`catchUp`）。
- **点赞对非好友可能无效**：QQ 对非好友/陌生账号的点赞可能没有报错但也不生效，插件无法区分；
  每人每天一次、全局 `action.like.maxPerDay` 上限是为了避免打扰和刷量。
- **主动工具状态**：默认在内存；装了 `database` 会持久化，重启后仍记得"今天做过"。
- 插件所有**查询**工具均为只读；会改变 QQ 侧状态的只有 `action.*` 两个主动工具（默认关）和
  `forward.quoteFix`（只写十来字节的 ID 标记，可关闭）。

## 更新日志

### 1.2.1

**修复**

- **`group_checkin` 调用被模型改名后直接失效**：实测模型（qwen3.8-flash + chatluna ReAct 链）会把工具名
  译成中文「群内打卡」再调用，chatluna 的解析器只归一空格/连字符、不认中文别名，于是这次调用被当作
  "没有这个工具"，插件代码一行都没执行，NapCat 也没收到打卡包。现在工具注册描述里带上精确工具名，
  工具描述里再强调一次「name 必须原样写 `group_checkin`」。
- **打卡"假成功"**：`send_group_sign` 在 NapCat 里是发完不等回执的 OIDB 包，`retcode 0` 只代表请求被受理。
  以前直接记成当天成功，一旦包被丢弃/群未开签到，当天就再也不会重试。新增 `action.checkin.verify`
  （默认开）：打卡后用今日打卡榜核对，榜上没自己就记失败并允许冷却后重试；榜单读不到时按"请求已受理"
  处理，不会误判失败。
- **兼容只注册了 `set_group_sign` 的协议端**：`send_group_sign` 返回"不支持的 API"类错误时自动回退到
  `set_group_sign`（与 `group-sign` 插件用的是同一个实现）。

### 1.2.0

**新增**

- **主动工具分组**（`meta.source=action`，默认全部关闭）：`group_checkin`（当前群打卡）与
  `profile_like`（给当前发言人/私聊对象点赞）。目标只来自当前会话，工具参数不暴露任何目标 ID。
- **自动群打卡**：每天固定时间（带随机延迟）只给 `action.checkin.auto.groups` 里的群打卡；
  与模型调用共享"当天一次"状态，列表为空不执行（不回退到全部群），支持当天 bot 掉线后补跑；需要 NapCat PacketBackend。
- **主动工具约束**：可选群白名单（开启且为空 = 全禁）、每人每天一次、全局每日点赞人数上限；
  `subAgent: false`；状态可选持久化到 `database`（未安装则内存）。

**说明**

- 主动工具只是"模型可调用的写操作"，不会自行定时执行；需要无人值守打卡请开 `action.checkin.auto.enabled`。
- 群打卡接口不返回服务端结果，工具只承诺"已发出打卡请求"；点赞对非好友可能静默失败。

### 1.1.1

**改进**

- 优化了配置项的描述文本（1.1.0改完忘记编译就上传了，悲）

### 1.1.0

**新增**

- **合并转发（聊天记录）**：`read_forward_msg` 为自研实现（不依赖 chatluna-forward-msg），支持嵌套记录、
  图片/语音/文件占位与条数、字数上限；新增 `forward.quoteFix`，给**被引用 / 被回复**的聊天记录补
  `<forward id="…"/>` 标记——chatluna 自己只在直发时补，引用那条永远是空的。
- **群荣誉榜直连兜底**：NapCat 取不到荣誉时，插件会自己带上 cookie 与 `bkn` 直连新版接口再试一次。

**修复**

- **群荣誉榜读不出来**：QQ 已把荣誉榜页面（`qun.qq.com/interactive/honorlist`）从服务端渲染改成 SPA，
  页面 HTML 里不再有 `window.__INITIAL_STATE__`，而 NapCat 仍按旧格式解析，于是四个类型全部失败、静默返回空数组。
  现在遇到这种情况，插件会直连新版接口取回**龙王、群聊之火、快乐源泉**（并带出连续天数）；
  等 NapCat 上游修好后，这段兜底会自动不再触发。
- **荣誉榜空结果不再进缓存**：此前 NapCat 的瞬时失败会被缓存一整个 TTL（默认 300 秒），期间怎么重试都还是空。
- 荣誉榜读不到时的说法改为如实描述（"这次没看到…"），不再说成"本群成员均未获得称号"。

**改进**

- 荣誉榜读不到时记录可诊断信息（`qun.qq.com` cookie 的关键项、直连接口的返回码），并在提示里点明根因，
  省得反复猜是 cookie、风控还是别的。
- 读不到荣誉榜、且启用了活跃度统计时，会提示可改用 `group_activity` 从最近消息统计谁最活跃。
- 直连兜底成功等过程细节归入 `debug` 级别，默认不输出。

### 1.0.1

- 修正依赖声明：`zod`（精确锁 `3.25.76`）与 `@langchain/core` 从 `peerDependencies` 移入 `dependencies`，
  与 chatluna 生态保持一致，解决插件市场误报"不兼容"的问题。

### 1.0.0

- 首个正式版。

## License

MIT
