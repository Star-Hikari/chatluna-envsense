# chatluna-envsense 设计文档 v0.1

> **后续修订（本文档为开发前拍板稿，只记录当时的决策，不再随实现回改）**：
> - 用户感知中的互动写操作工具 `profile_like`、对应配置 `user.like.*` 与 napi 的 `sendLike`
>   声明已整体下线，插件现为纯只读形态；
> - 原 `profile_like_status` 已更名为 `profile_reaction_stats`（配置键 `user.reactionStats`），
>   输出措辞改为中性的"资料卡互动数据"。
> 下文 §4.3 / §5.5 / §8 保留原始设计记录，仅作对照，不代表当前实现。

> 目标：为 ChatLuna 的 Agent 模式（plugin chatMode）注册一组**环境感知工具**，让 bot 能按需查询
> "我在群里知道什么"与"关于某个 QQ 用户我能知道什么"。纯按需工具形态（不做 prompt 注入），
> 零侵入、零常态 token 成本。
>
> 依据（三份一手调研，均在 `.memory/`）：
> - `chatluna-plugin-mode-and-tools.md` —— plugin 模式运行机制与工具注册规范
> - `napcat-group-info-survey.md` —— 群聊侧可用接口与字段
> - `napcat-user-info-survey.md` —— 用户资料/头像可用接口与字段
>
> 本文档为开发前拍板稿：工具范围、参数、返回、配置、风险面。本期覆盖**群聊感知**与**用户感知**两大类；
> QQ 空间动态类能力本期不涉及。

## 1. 命名与包结构

- 包名 `koishi-plugin-chatluna-envsense`，插件 `name = 'chatluna-envsense'`，目录 `external/chatluna-envsense/`。
  （备选名供参考：chatluna-airsight / chatluna-aware；envsense 语义最贴"环境感知"且为动态扩展留了口子，建议保留。）
- 结构与工程约定沿用 chatluna-guard / `chatluna-dev-guide.md`：
  - TS 单包，`src/` → `lib/`，`main: lib/index.js`；chatluna/koishi 只进 peerDependencies；
  - `inject = { required: ['chatluna'] }`（不需要 database——缓存全内存）；
  - 命名链：`export name='chatluna-envsense'` ↔ `new ChatLunaPlugin(ctx, config, 'envsense', false)` ↔ `createLogger(ctx, 'chatluna-envsense')`。

```
external/chatluna-envsense/
├── src/
│   ├── index.ts        # apply：配置分组、ready 时注册工具
│   ├── config.ts       # Config 接口 + Schema
│   ├── napi.ts         # NapCat API 访问层（bot.internal 结构化调用 + _get 兜底 + TTL 缓存）
│   ├── format.ts       # observation 文本格式化（成员表/资料卡/相对时间等）
│   ├── tools-group.ts  # 群域工具
│   └── tools-user.ts   # 用户域工具
├── package.json / tsconfig.json
```

## 2. 平台与依赖约束

| 约束 | 处理方式 |
| --- | --- |
| 仅 NapCat(onebot11) 有全部接口；官方 adapter-qq 没有 | 工具 `authorization: (session) => session.platform === 'onebot'`（非 onebot 会话工具直接不进激活集）+ `_call` 内二重 fail-soft 返回提示文本 |
| 装了 chatluna-agent 时工具可见性受权限 mask 约束 | 所有工具 `meta.defaultAvailability = { enabled:true, main:true, subAgent:true, chatluna:true, characterScope:'all' }` |
| `get_profile_like`/个别 action adapter 未包装 | napi.ts 内 `(bot as any).internal._get(action, params)` 直发；`retcode!=0` 抛 SenderError → catch 成 observation 文本 |
| WebApi 类接口（公告/荣誉/精华/资料卡互动数据）偶发失败 | 错误文案区分"接口失败（稍后可重试一次）"与"无数据"；工具描述不承诺实时性 |

## 3. 工具清单 —— 群域（group.*）

通用约定：工具名 snake_case；入参 `group_id` 一律可选（缺省取 `configurable.session.guildId/channelId`，且校验 bot 在该群），
显式传他群号也允许（bot 不在的群由 API 报错兜底）；输出为**紧凑中文文本**（observation 直接回喂模型）。

### 3.1 `group_overview` —— 群概况（默认开）
- 数据源：`getGroupInfo(groupId)` + `getGroupMemberInfo(groupId, bot.selfId)`
- 参数：无（或可选 group_id）
- 返回：群名、成员数/上限、全员禁言状态、我给群的备注、**我在本群的名片/身份(owner/admin/member)/头衔**
- 场景：bot 回答"这是个什么群/我在群里是什么身份"

### 3.2 `group_members` —— 成员查询（默认开，核心）
- 数据源：`getGroupMemberList(groupId)`（NapCat 有成员缓存；本插件再加 TTL 缓存默认 300s）
- 参数：`keyword?`（昵称/名片/QQ 号子串过滤，大小写不敏感）、`role?`（'owner'|'admin'|'member' 过滤）、`limit?`（默认 50，硬顶 200）
- 返回：总数 + 过滤计数说明 + 行式列表：`名片(昵称) QQ号 身份 入群时间 最后发言(相对)`
- 截断纪律：超 limit 只回前 N 行并明示"可用 keyword 缩小范围"——防大群输出爆炸

### 3.3 `member_detail` —— 群内单人详情（默认开）
- 数据源：`getGroupMemberInfo(groupId, userId)`
- 参数：`user_id?`（缺省=当前消息发送者；支持 @提取的 QQ 号）
- 返回：群名片/昵称/身份/专属头衔/群聊等级/QQ等级/入群时间/**最后发言相对时间**/是否机器人/禁言截止时间
- 与 `user_profile`（§4.1）区分：本工具是"群内表现"，user_profile 是"资料卡"；描述里写清

### 3.4 `group_notices` —— 群公告（默认开）
- 数据源：`getGroupNotice(groupId)`（WebApi）
- 参数：`limit?`（默认 5，硬顶 10）
- 返回：每条 `发布时间 发布者QQ [置顶] 已读n 正文(≤100字截断)`
- 已知坑：仅对"发给新成员"的公告字段有版本差异；失败按 §2 WebApi 文案

### 3.5 `group_honors` —— 群荣誉榜（默认开）
- 数据源：`getGroupHonorInfo(groupId, 'all')`（WebApi）
- 参数：无
- 返回：当前龙王 + 各榜前 5：`龙王/群聊之火/群聊炽热/快乐源泉/冒尖小春笋 → 昵称(QQ)`
- 场景："群里谁最活跃"的第一手答案（比 group_activity 便宜得多）

### 3.6 `group_activity` —— 发言活跃度统计（**默认关**）
- 数据源：`getGroupMsgHistory(groupId, count=200)` → 按发送者聚合条数、时间跨度
- 参数：`count?`（默认 200，硬顶 500）
- 返回：Top10 `昵称(QQ): n条 (x%)` + 总消息数/时间范围
- 默认关原因：NT 拉历史成本与失败率均高于其他项；配置开关系"活跃度统计（较重的历史接口）"

### 3.7 `group_essence` —— 精华消息（默认开）
- 数据源：`getEssenceMsgList(groupId)`（WebApi）
- 参数：`limit?`（默认 10，硬顶 30）
- 返回：每条 `加精时间 发送者昵称(QQ) 操作人昵称 内容(≤100字截断，图片记为[图])`
- 场景："这群有什么经典发言/群文化"

### 3.8 `group_signed` —— 今日打卡榜（默认开）
- 数据源：`getGroupSignedList(groupId)`（WebApi）
- 参数：无
- 返回：`打卡人数 + 前 10 行 排名. 昵称(QQ) 时间`；群未开启签到时接口报错 → 归一化为"该群未开启打卡/接口失败"文本
- 场景：与 honors 配套回答"谁坚持打卡"

### 3.9 `group_avatar` —— 让模型"看见"群头像（默认开，**多模态**）
- 数据源：无 API——群头像直链 `https://p.qlogo.cn/gh/{group_id}/{group_id}/600`
- 参数：无（或可选 group_id）
- 返回：**多模态 observation**（见 §5.7）：`[{type:'image_url', image_url:{url}}, {type:'text', text:'这是本群的群头像'}]`
- ⚠️ 备注：**要求主模型支持图片输入（capabilities 含 `image_input`）**；不支持时的降级行为见 §5.7
- 场景：bot 评价/玩梗群头像内容

本期不做（范围外，不排期）：群文件、@全体余量、禁言名单、群列表。

## 4. 工具清单 —— 用户域（user.*）

### 4.1 `user_profile` —— QQ 资料卡查询（默认开，核心）
- 数据源：`getStrangerInfo(qq)`（NapCat 实现统一走资料详情，好友/群友/陌生人都可查）
- 参数：`user_id?`（缺省=当前会话对象：群聊取发送者，私聊取对端）
- 返回（**过滤空值/隐私字段后**按行输出）：昵称、性别、年龄、**个性签名**、QQ等级(皇冠太阳星星数)、注册时间、
  VIP（是否/等级/年费）、生日（若公开）、家乡/省市区/大学/兴趣标签（若公开）、我对他的备注、在线状态（状态码→中文枚举）
- 明确不返回：login_days（源码恒 0）、邮箱/手机号（恒空，隐私）
- 描述强调：对方公开多少取决于隐私设置，缺项不是错误

### 4.2 `user_avatar` —— 让模型"看见"对方头像（默认开，**多模态**）
- 数据源：无 API——`https://q.qlogo.cn/headimg_dl?dst_uin={qq}&spec=640` 直链（640px 大图，任意 QQ 可用）
- 参数：`user_id?`（缺省规则同 4.1：群聊取发送者/被@者，私聊取对端）
- 返回：**多模态 observation**（见 §5.7）：`[{type:'image_url', image_url:{url}}, {type:'text', text:'这是 {昵称} 的 QQ 头像'}]`
- 定位：图片**给模型看**（评价头像、找茬、玩梗），不是发送到聊天窗口；若用户想让 bot"发头像图到群里"，那是模型拿到图片描述后的正常回复行为，不在本工具职责
- ⚠️ 备注：**要求主模型支持图片输入（capabilities 含 `image_input`）**；不支持时的降级行为见 §5.7

### 4.3 `profile_reaction_stats`（原设计名 `profile_like_status`）—— 查询资料卡互动数据（默认开）
- 数据源：`internal._get('get_profile_like', { user_id?, start:0, count:10 })`（adapter 未包装；传他人查他人 type=1，不传查自己 type=2）
- 参数：`user_id?`（缺省=bot 自己）、`top?`（最近互动人列表条数，默认 5）
- 返回：`总计 / 今日新增 / 最近互动的人列表(昵称+时间)`
- 场景："我的资料卡有多少人互动过"“看看 ta 受欢迎程度”
- WebApi 失败率高：错误文案 §2

本期不做：好友关系/备注查询独立工具（user_profile 已带 remark；friend 列表成本高）、私聊历史统计、在线设备列表（packet 依赖待真机验证）。

## 5. 通用实现规范

1. **注册**：`ctx.chatluna.platform.registerTool(name, def)` 返回 disposer；apply 里统一收集、由顶层
   `ctx.effect(() => () => 逐一 dispose())` 在 scope 销毁（停服/HMR）时注销
   （未用 `ChatLunaPlugin` 基类——本插件无平台客户端，不需要基类的 config pool/proxy 配置面，与 chatluna-guard 先例一致）。
   `selector: () => true`；`authorization: 平台门 + 写工具白名单`。工具实例用 `tool(fn, {name, description, schema: z.object(...)})` 函数式。
2. **运行期上下文**：一律从 `_call(input, _, runConfig)` 的 `runConfig.configurable.session` 取
   （群号/对端 QQ/selfId/bot 实例都从 session 出发；无 session 场景 = 子代理 invoke 带 routing 时 session 仍存在（buildVirtualSession），拿不到时返回提示文本）。
3. **napi.ts 访问层**：统一签名 `fetchGroupInfo(internal, groupId, ttlCache, logger)`；
   每条 API：超时（默认 10s，AbortSignal 透传 chain 的 signal 不易——用 Promise.race）→ 归一化错误 `{ ok:false, error:string }`；
   TTL Map（key=`action:group`）；`retcode!=0`(SenderError) catch 成中文短语。
4. **格式化**：所有时间→`YYYY-MM-DD HH:mm` + 相对时间括注；昵称优先 `card || nickname`；文本行式输出避免 JSON 噪音（模型读行式更稳）。
5. **配置 Schema**（中文描述，顶层 intersect 分卡片；原总开关已删，与控制台实例开关重复）：
   ```
   通用: cacheTtlSeconds(默认300) · groupIdHint? 无
   群聊感知: group.overview / members(成员数上限) / memberDetail / notices / honors / essence / signed / avatar / activity(默认false)
   用户感知: profile / avatar / reactionStats
   ```
6. **locale**：暂只内置中文文案（工具 description/observation），不接 i18n 资源（本项目场景固定中文；发布市场前再补 en-US）。
7. **多模态 observation（3.9 / 4.2 两个头像工具专用）**：
   - 返回 langchain content-part 数组 `[{type:'image_url',image_url:{url}}, {type:'text',text:…}]`——
     chatluna agent 循环的 `coerceToAgentObservation` 对全 complex content 数组**原样透传为多模态观察**（调研：agent/index.mjs:316），模型即可"看见"图片，无需任何适配。
   - 能力判定：`_call` 里直接读 `runConfig.configurable.model`（ChatLunaChatModel）的
     `.modelInfo.capabilities.includes(ModelCapabilities.ImageInput)`（模型实例自带 ModelInfo，无需 findModel 反查）；
     判定链路失败时**乐观放行**（直接传图）。
   - 不支持图片输入的模型：返回文本 observation
     `当前模型不支持图片输入，无法查看头像（直链 {url}）；请告知用户换用支持视觉的模型。`
   - 子代理（task 工具派生）调起时以子代理实际使用的 model 判定，两者可能不同，属预期。

## 6. 与 chatluna 生态的注意点（调研结论直译）

- 工具注册/变更触发 `chatluna/tool-updated` → plugin/browsing 会话缓存自动清理，热重载安全；
- 不写 dependencies 只写 peer（防双副本枚举失效，dev-guide §1）；
- 子代理（chatluna-agent task）默认可见（main+subAgent 均 true）；若要求"某写操作工具仅主代理"，改 subAgent:false 即可；
- 观测调用：调试期可给 `invoke` 传 `ChatEvents['llm-call-tool']` 或看 debug 日志 `Tool end:`；
- react 降级模式（模型无 tool_call 能力时 plugin 模式走 ReAct 文本协议）同样吃这套注册，无需适配。

## 7. 测试与验证（沿用 guard 方法论）

1. **离线引导**：CJS 脚本 `new Context({data:{}})` + 手动 plugin（chatluna + envsense）+ `app.start()`，
   断言：工具全部进 `platform.getToolRegistry()`；authorization 平台门；截断/过滤纯函数单测（keyword 过滤、时间格式化、空字段过滤）。
2. **API 仿真**：伪造 `session.bot.internal`（返回样本 JSON，含公告 inst 条目/荣誉空榜/1400 错误）验证 observation 文案与错误分支。
3. **真机矩阵**（NapCat，selfId 3657588917）：每个工具 ≥2 条引导话术（正常+边界：非群聊调用/大群截断/隐私空字段/接口频控）；
   验证 chatluna-agent 权限 mask 不挡 defaultAvailability；确认 adapter `_get('get_profile_like')` 在真机版本可用。
4. **多模态专项**（3.9 / 4.2）：视觉模型（qwen3.8-flash sticker 同款）下"评价一下这个头像/群头像"应能描述图片内容；
   切纯文本模型验证降级文案；URL 可达性（qlogo/p.qlogo 直链在服务器网络环境可访问，不行则改 `ctx.http.get` 拉 bytes 转 data URI）。
5. 回归关注：HMR 重载后无重复注册（registerTool 覆盖语义 + dispose）。

## 8. 风险与免责

- **封号/风控面**：当前版本**全部为只读查询**（原互动写操作已下线），头像工具只拉公开直链图片、
  不调任何写接口，风控面最小。
- **隐私**：资料卡只回"QQ 本来就公开"的字段；不返回 email/phone 键位；群成员数据仅在 bot 所在群可见（NapCat 侧硬约束）。
- **协议依赖**：NapCat 版本行为差异（公告 inst、packet 类接口）——napi.ts 全量错误归一化保证不炸会话。
