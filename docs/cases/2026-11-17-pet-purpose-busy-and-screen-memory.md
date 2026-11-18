# 2026-11-17 · 桌宠主动搭话永远 busy + 看屏幕记忆写入（screen 平台）

## 现象

- 桌宠主动搭话（`purpose.carrier=pet`）从不自动出发，日志每 5 分钟一条 `[pet-purpose] 暂不出发：busy`；设置页「立即试一次」能弹。
- 新需求：独立「看屏幕/看游戏」会话（dsh-windows-mcp 截图）看到的事要能写进当前角色记忆卡，聊天时能回忆细节。

## 根因（busy）

- `plugins/surfcore/lib/pet-purpose.js`：`runOnce()` 先 `running = true`（:417），再把 `busy: running` 传给 `evaluatePurposeTick`（:437）→ 永远为 true →
  `src/purpose-engine.js:348` 返回 `wait 5min / busy`。重入保护在 :403 已经做过，决策函数不该再看自己。
- force 路径跳过决策，所以「试一次」正常、自动排程永远不出发。没有测试覆盖自动 tick 路径。

## 修法

1. `pet-purpose.js:437` `busy: running` → `busy: false`。
2. 新 `src/mcp-memory-write.js`（stdio MCP，工具 `memory_write(text,title?,detail?,tags?,scope?,importance?)`）：
   只 `appendMemoryInboxEvent` 到**当前角色** inbox，插件仍是记忆卡唯一写者。
3. `src/memory-card.js`：
   - `appendMemoryInboxEvent` 接受 `platform:'screen'`，保留 title/detail/tags/scope/importance；
   - `ingestInboxLines` 新分支 → `source:'screen-watch'` 记录（scope 默认 pet：QQ/桌宠可读、不进 B站）；
   - `memorySourceLabel` → 「看屏幕」；`recordLine` 对 screen-watch 渲染 detail（仅清楚/清晰档，模糊后细节先忘）。
4. `?rev=` 三处同步到 `20261117-screen-memory`（PITFALLS #68）。
5. 本机 profile `cordis.patch.yml`：新增 `mcp-memory-write` 行（带 `DSH_HOME` env，独立标记块，不在 setup-dsh 维护的块内）。

**扩展点**：别的感知来源（语音、游戏进程读数等）复用 `platform:'screen'` 或照抄这个分支加新 platform；
MCP 里加工具（如 `memory_search`）不需要动引擎。

## 完整逻辑

- **链路**：任意会话 → `mcp__memory-write__memory_write` → inbox.jsonl → 插件 10 分钟维护 → memory-card.json → `memory-card-prompt-qq.md` → 桌宠/QQ 注入。
- **爆炸半径**：只新增分支与新 platform；旧 qq/pet/bili 行走原分支（回归测试钉住）。不碰密钥。
- **生效**：改了 `src/memory-card.js` + 插件 lib → **重启 DSH**。

## 验证

- `npm run test:memory-card` 27/27；`test-core-rev-sync` 通过；插件 `npm test` 通过。
- E2E（隔离 DSH_HOME）：真 stdio MCP 调用 → inbox → 摄取 → 渲染：14/14 + 可见性 4/4
  （pet scope 进 QQ/桌宠提示词且带 detail，不进 B站；shared 进 B站；坏参数被 schema 拒绝且不写盘；重复摄取幂等）。
- `test:audit` 148/153：失败的 5 个在干净 v0.8.9 上同样失败（时区/环境假设），`test-update-apply-result` 偶发（3 次 2 过），均不涉及本次文件。

## 追加：dsh-pet 联动（同一大脑 + 同一记忆）

- 新 `plugins/surfcore/lib/dsh-pet-bridge.js`，只用 dsh-pet（0.4.9）公开扩展点：
  cordis 服务 `petApi7340.memory.register({ id:'surfcore', recall, capture })` +
  `POST /dsh-pet-7340/broadcast?pet=<id>&surface=any`（本机无鉴权，已实测 `{"ok":true}`）。
  - recall：system 换成 surfpet 同源的 `buildChatSystemPrompt`（人格卡+记忆卡+心事），追加 dsh-pet 自己的名字/时间段；
    动作/表情包指令在 recall 之后由 dsh-pet 拼，不受影响。1.5s 超时内（实测 5ms）。
  - capture：`rememberTurn` → 同一 inbox（platform=pet），和 surfpet 对话进同一张卡。
  - 主动搭话：pet-chat 新增 `addFrontend/frontendOnline`；`proactive()` 后扇出到 dsh-pet；
    pet-purpose 的两处在线判断改为「surfpet 在线 或 额外显示端在线」（dsh-pet display=none 不算）。
  - 每 30s `ensure()` 补注册（dsh-pet 热重载会清空它的 provider 槽）。
- 配置：合体层 `dshPetBridge`（默认 enabled=false；字段 brain/remember/mirrorProactive/petIds/bubbleMs）。
- 顺手修：桌宠规则「绝不要提你是 AI」与人格卡「被问就承认」冲突 → 改为「不主动提；被问按人格卡」。
- **人格文件坑**：`persona.mode=full` 时桌宠读 `persona.full.md`（`readPersonaLayerText('full')`），
  不是 `persona.md`。手改人格卡要改 full 那份（或两份同步），否则改了不生效。
- 验证：隔离环境集成测试 27/27（真 pet-chat 服务 + 按 dsh-pet 源码契约的替身 + 假 DSH HTTP），
  覆盖：关闭时零影响、注册、recall 内容与耗时、capture→摄取、主动搭话镜像、display=none、热重载补注册、
  失败可见（code）、关闭即注销、JSONC。插件 `npm test` 通过；audit 与之前同一批既有失败。
- 回滚：`dshPetBridge.enabled=false`（30s 内注销，dsh-pet 回原生大脑）；彻底移除删 bridge 文件 + index.js 三处接线。

## 追加：看屏幕（screen-watch）

- 新 `lib/screen-capture.js`：截图源接口 `capture()`；实现 = stdio 直连已装 Windows-MCP 的 `Snapshot`
  （图 + 前台窗口标题，暖调用 ~0.6s），内置 zlib 解 PNG 出 32×18 灰度缩略图做变化检测。
  **不要自写 PowerShell 截屏**：截屏 + 前台窗口 P/Invoke 被 Defender 判 `ScriptContainedMaliciousContent`，不应去绕。
- 新 `lib/screen-watch.js`：闸门（开关→专注→额度→正在聊→每小时看图上限→截图→窗口白/黑名单→画面没变→模型→发言冷却/上限），
  模型输出严格 JSON `{note,say,memory}`，解析失败=沉默；同一份人格+记忆 prompt（同一个大脑）。
  值得记的 → `platform:'screen'` 进记忆卡；发言 → `chat.proactive(remember:false)`（不让解说刷爆记忆卡）。
  最近看到的 note 通过 pet-chat `addContextSource` 进 surfpet/dsh-pet 对话 prompt；
  surfpet 聊天说「这是哪/看看屏幕」时 `addImageSource` 现截一张附图（失败自动退回纯文字）。
- 图片进模型：DSH `attachments.saveImages([{data,mediaType}])` → `{type:'image', attachment: ref}`（与 dsh-pet 同路）。
  注意：DSH 附件是内容寻址**持久保存**、暂无回收——变化检测 + 每小时上限同时也是在控盘。
- 接口：pet-api `GET /screen/status`、`POST /screen/look {deliver?}`（x-pet-token）。
- 配置 `screenWatch`（默认关）：intervalSec / chattiness / maxCommentsPerHour / commentCooldownSec / maxLooksPerHour /
  changeThreshold / watchApps / ignoreApps / onDemand / rememberNotable / minMemoryImportance / notesInPrompt / scale / effort。
- 验证：集成 29/29（真 pet-chat + 真 screen-watch，假 llm/attachments/截图源）；真 Windows-MCP 截图 + 真闸门：
  第二眼 diff=0.00002 跳过、零模型调用；回归全绿（audit 同一批既有失败）。
- **未验证（需重启 DSH 后实测）**：插件进程内 `ctx.get('attachments')` 可用、模型真实读图回复、`llm.stream` 的 `tools` 选项在真模型上可用。

### 改为由模型决定（用户要求：不要写死「什么时候看」）

- 删掉关键词正则（聊天里「这是哪」就截图）。pet-chat 新增通用工具循环：`addTool({name,description,parameters,run,enabled})`，
  `complete({useTools:true})` 把工具交给模型，模型发 `block-end/tool-call` 就执行、以 `role:'tool'` + 图片块回给模型，最多两轮；
  带工具失败自动退回不带工具。screen-watch 注册 `look_at_screen`（隐私窗口在前台时只告诉模型「没看」，不截图）。
- 后台不再固定间隔：每次看完模型给 `nextLookSec`，夹在 `minIntervalSec`~`maxIntervalSec`；配置只剩上下限与护栏。
- 仍是固定规则（护栏，不该让模型自己越过）：额度、每小时看图上限、隐私窗口黑/白名单、画面没变化不调模型、失败退避。
- 限制：dsh-pet 的聊天只能通过 recall 改文字（不能加工具/图片），所以在 dsh-pet 里按需看屏幕 = 它自带的 Ctrl+Shift+S 附图
  （大脑仍是 SurfCore）；平时靠后台「最近瞄到的屏幕」笔记。
- 失败：同一错误连续 3 次起指数退避（≤30 分钟），每种错误第一次弹一个气泡；截图恢复立刻清零。
- 测试进仓库：`plugins/surfcore/scripts/test-screen-watch.mjs`（38 项）、`test-dsh-pet-bridge.mjs`、`test-screen-memory-mcp.mjs`、
  `test-screen-memory-prompt.mjs`，已接入插件 `npm test`。
- 默认值：`dshPetBridge.enabled` 改为 **true**（没装 dsh-pet 时无操作）；`screenWatch.enabled` 默认 false。

## 追加：实测后修正（2026-11-18）

- **桌宠提示词 `[object Object]`（既有 bug）**：`buildChatSystemPrompt` 把 `ownerInfo()` 对象直接拼进字符串。已改为取 `.name`。
- **满屏「主人」压过人格卡**：身份行「你的主人是X」+ 记忆卡「主人（私聊）：」。只在桌宠链路（surfpet / dsh-pet / 看屏幕）
  里改成中性的「他/哥们」（`relabelOwner`），QQ / B站 提示词不变。
- **自我复读**：dsh-pet 自己的 10 轮历史 + 记忆卡里她旧的「我看不到你屏幕」回复，比人格卡更强地影响输出。
  备份后清掉 dsh-pet memory.json、`chatMemoryRounds` 10→4；记忆卡/inbox 里那 5 条旧回复备份后移除。
- **隐私**：新版微信窗口标题是 `Weixin`，原名单没拦住（一张微信截图发给了模型）。忽略名单加 Weixin/Telegram/WhatsApp/Signal。
  已知限制：只按前台窗口判断，弹在游戏上的微信通知仍可能被截进去。
- **dsh-pet 按需看屏幕**：recall 里后台调 `onUserMessage` → 小模型判断要不要看 → 带着问题现截一张 → 答案作为气泡补上并进记忆；
  dsh-pet 当场那句回复由提示词引导成「等下我看一眼」。实测：05:03:24 问 → 05:03:29 气泡「三角洲？刚进游戏 等加载完」。
  想一条消息出答案：dsh-pet 自带截图键（S / Ctrl+Shift+S）把图随问题一起发。
- **dsh-pet 右键菜单**（`lib/dsh-pet-menu.js`，用 dsh-pet 第三方菜单接口 `/menu/item|events`）：看屏幕 开/关、高/中/低频预设、现在看一眼；
  DSH 重启 → unknown-owner → 自动重注册；dshPetBridge 关 → 菜单撤掉。实测真 dsh-pet：注册/点击/读取/删除契约一致，中文标签无损。
- 可观测性：问题流每步写 plugin.log；新增 pet-api `GET /bridge/status`（含菜单状态）。
- 测试：新增 `test-dsh-pet-menu.mjs`（15 项）并入 `npm test`；插件测试全过；audit 仍是同一批既有失败。

## 回滚

- busy：`busy: false` 改回 `busy: running`。
- 记忆：删 profile 里 `surfcore memory-write MCP` 标记块 + 删 `src/mcp-memory-write.js`；`src/memory-card.js` 的 screen 分支无数据时不生效，可留可删（删则 rev 再 bump 一次）。

## 追加：系统级快捷对话 + 语音快捷键（不改 dsh-pet）

- **现象**：dsh-pet 的 Ctrl+Shift+L 是 DSH 窗口内的应用快捷键，只对网页版宠物生效；display=desktop 时按了没反应。
- **修法**：`lib/quick-chat.js` 用 DSH 自带的 `electron.exe` 起独立小进程 `quickchat/main.cjs`，注册系统级快捷键，弹置顶输入框。
  文字（可勾「附截图」）→ dsh-pet `POST /chat`（走联动 = SurfCore 大脑/记忆，回答在宠物上）；dsh-pet 不在就退回 surfpet。
  语音：16kHz 单声道 WAV（与 dsh-pet 自己一致）→ dsh-pet `POST /voice/hear`，识别器 deepseek → dsh 依次尝试。
- **配置**：`config.json` → `quickChat {enabled, chatHotkey, micHotkey, speechProvider, petId}`；改快捷键 10 秒内自动重启小进程，无需重启 DSH。
- **快捷键（用户 2026-11-17 定）**：Alt+N 打开对话框（globalShortcut）；**T 按住说话、松开发送，不弹窗**。全局热键收不到松开、而且会吞掉 T，所以语音键改用 `uiohook-napi`（MIT，N-API 预编译，装在 `quickchat/node_modules`，被 .gitignore 忽略 → 新机器/更新后需在 quickchat 目录 `npm install`，缺了会弹气泡说明）。它只旁听不吞键：T 照样打字、游戏里照样生效；按住 ≥0.25s 才开录，敲一下不录；没出声不发。录音在隐藏窗口里做，只有出错才弹窗显示原因。与 dsh-pet 的 Ctrl+Shift+L/M/S 不同；注册失败会弹气泡并写 `lastError`。
- **坑**：① Windows 上 Electron 主进程 stdin 一启动就 end，拿它当「父进程没了」会秒退（页面 ERR_FAILED -2）→ 只用父 PID 轮询；
  ② 子进程必须删掉 `ELECTRON_RUN_AS_NODE`；③ dsh-pet 附图上限 90 万 base64 字符，超了不附；④ 只有真附了图才跳过联动的「要不要看屏幕」判断。
- **验证**：`node plugins/surfcore/scripts/test-quick-chat.mjs`（14 条）；真机：helper 输出 `ready`（两键 ok）+ `window-loaded`，父进程退出后 `quitting parent-gone`。
- **回滚**：`quickChat.enabled=false`；或删 `lib/quick-chat.js`、`quickchat/`、index.js/pet-api.js 接线；配置备份在 `harness/surfcore/backups/config.before-quickchat-*.json`。

## 追加：全面检查后修的 5 处（2026-11-17 晚）

| 现象 | 根因 | 修法 | 钉住的测试 |
|---|---|---|---|
| 问「啥都没了」→ 她说「我瞅瞅」后再没下文（日志：没发出回答：模型没给 say） | effort=low 的思考算进 maxTokens=500，JSON 被截断 → say 为空 | maxTokens→1500；问题模式下没 say 时用纯文本回复或「没看清 你再说一遍」 | test-screen-watch F2 两条 |
| 截图失败/模型报错/上一眼没看完时同样只剩「我瞅瞅」 | onUserMessage 只记日志 | busy 时等 3 秒重试一次；仍没答 → 补「没看成 <原因> 你再问下」并写回 dsh-pet 历史 | test-screen-watch「没看成」 |
| 附截图在游戏里大概率附不上 | dsh-pet /chat 限 90 万 base64；桌面 20 万，游戏画面常超 | 超限改走 screen-watch 为问题而看（DSH 附件服务，无此上限），仍只回一句，并 rememberTurn | test-quick-chat「截图过大」 |
| 启动时按 PID 杀残留小助手可能误杀 | PID 复用；dsh-pet 的进程也叫 electron.exe | 删掉按 PID 杀；改单实例锁 + second-instance 让位；exit 只处理当前子进程 | 真机：A ready → B already-running → A replaced |
| 按住 Shift 跑 / Ctrl 蹲时按 T 不录 | 修饰键严格相等 | 只要求配置里写了的修饰键 | 代码审查 |

**残余**：附截图走 screen-watch 那条路时，对话框里的问题不进 dsh-pet 自己的历史（进 SurfCore 记忆）；真机按住 T 说话、游戏内附截图需 DSH 运行时实测。

### 发布交接块
- 范围：dsh-pet 联动 + 看屏幕 + 快捷对话（Alt+N）+ 按住 T 说话 + 记忆写入 MCP；未提交，等用户决定提交到 dev。
- 影响：仅本机；新依赖 `plugins/surfcore/quickchat` 下 `uiohook-napi@1.5.5`（需 `npm install`）。
- 验证：`cd plugins/surfcore && npm test`（全过）；`npm run test:regressions`（全过）；`npm run test:audit` 148/153（5 条为 v0.8.9 既有失败）。
- 回滚：config `quickChat.enabled=false` / `screenWatch.enabled=false` / `dshPetBridge.enabled=false`；配置备份在 `harness/surfcore/backups/`。

## 追加：B站生物钟从没按配置排程（2026-11-18 查出，上游既有 bug）

- **现象**：配置 `night.windows=[00:00–24:00 ×12]`，实际每天只醒 1 次，排程显示「20:00–24:00·保底」+「还有 11 个额外名额没有任何窗口容量可放」。
- **根因**：`whale-night.mjs` 先把窗口换算成分钟（`start:0,end:1440`）再交给 `buildNightSchedule`；`normalizeNightWindows` 又用只认 `"HH:MM"` 的 `parseClock` 校验 → 全部判非法 → 退回内置 20:00–24:00×1。任何自定义窗口都没生效过。
- **修法**：`tools/lib/night-schedule.mjs` 的 `normalizeNightWindows` 直接接受已是分钟的窗口；字符串窗口仍走原校验。
- **当天生效**：备份 `whale-night.json` 到 `backups/whale-night-before-window-fix-*.json`，把 date 标成前一天，插件下一 tick 重排 → 12 个 slot（00:57 … 23:32）。
- **测试**：`plugins/surfcore/scripts/test-night-windows-minutes.mjs`（4 条，已接入 npm test）。根目录 `test-night-schedule.mjs` 仍失败，原因是测试里写死 +08:00 时区，与本修复无关。
- **另记**：根目录 `npm run test:audit` 有脚本未设 DSH_HOME 就加载插件，会在 `~/.dsh/surfcore` 写影子目录（不影响真实运行）。

## 追加：像真人的作息 + B站多聊 + 分享=私信+评论（2026-11-18 用户定）

- **作息（每个窗口自己的性格，设置页「作息」每行可调）**：`night.windows[]` 新增可选 `skipChance`（这一段不看概率）/ `maxVideos`（每趟刷几条）/ `quietSkip`（掷到不看=真睡着：不叫醒、不写日记、不私信）。
  本机：07:30–12:00×4（0%/12 条）· 12:00–19:00×3（10%/10 条）· 19:00–24:00×3（0%/12 条）· 00:00–07:30×2（65%/4 条/睡着）；总数 12（沿用上限）。
- **以前没生效的**：唤醒提示写死「feed ≤5 条 / 深读 2–3 条」，`night.maxVideos` 从没传给她 → 现在 `feed --n <这一趟条数>`，深读 ≈ 条数/3（2–6）。
- **分享**：`share.via=dm` + 新 `share.alsoComment=true` → 先私信他（--share 占分享额度），再在视频下发一条普通评论（一条视频一条顶层评论照旧由代码拦）。
- **多聊**：新 `share.chatDaily`（0=关，本机 6）→ 提示里加「找我唠两句」，`dm --chat`；**代码硬上限**在任何网络请求前拦，失败带 code：`dm.chat-disabled` / `dm.chat-cap` / `dm.chat-and-share`。
- **改动文件**：tools/lib/night-schedule.mjs（windowExtras + 每窗概率）、tools/commands/whale-night.mjs、lib/scheduler.js（quietSkip 分支、videosOf/deepOf、提示）、tools/commands/dm.mjs、lib/store.js（保存保留字段 + share 两项）、lib/client.js（设置页控件）。
- **测试**：`scripts/test-night-windows-minutes.mjs` 9 条（每窗概率用固定随机数、设置页往返、dm 三条失败路径）；插件 npm test 全过；regressions 全过。
- **当天生效**：备份 `whale-night-before-human-schedule-*.json` 后标旧，重排得 12 趟。配置备份 `bili-config-before-human-schedule-*.json`。
- **清理**：测试留下的 `~/.dsh/surfcore`（含 host-token）和 Electron 测试 profile 移到 `harness/_quarantine/2026-11-18-stray-test-leftovers/`。注意根目录 `npm run test:audit` 会再生成它。
- **代价**：从每天约 1 趟变 10~12 趟、每趟 10~12 条，B站这边的 token 消耗会成倍上升。
- **回滚**：恢复上面两个备份；或在设置页把窗口改回、`share.via` 改回 dynamic、`chatDaily=0`。

## 追加：更像人（2026-11-18 凌晨，用户一次提的 8 件事）

| 事 | 做法 | 生效 / 设置 |
|---|---|---|
| 设备时间 | 排程本来就按本机时间；`plugin.log`/bridge 日志改成本机时间+时区（`localStamp()`，仍是合法 ISO）；`watch-history.mjs` 去掉写死的 +08:00 | 重启 DSH |
| 自动私信主人总上限 10 | 新 `limits.ownerDmDaily`（默认 10，1~100）；`dm.mjs` 主人通道在任何网络请求前拦（分享/闲聊/报备都算），`dm.owner-cap` | 设置页「额度」 |
| 不看概率 10/20/10/70 | 四个窗口的 skipChance；4000 天模拟测试每窗误差 <3% | 设置页「作息窗口」每行 |
| 分享门槛 13→11 | `share.minScore=11`；提示里的「13」改成读配置 | 设置页 |
| 动态按口味 | 打开 dynamics，只留 best（当天评分最高）、移到 21:00；game/anime/gaming 关；提示里这几步按开关出现（以前无条件） | 设置页「动态」 |
| 周末作息 | `night.weekend {enabled, windows}`，周六日排程时用；保存不丢、照样校验；设置页新「周末作息」 | 本机：09:30 起刷、夜里睡到 9:30 |
| 精力/心情 | `night.energy`；只按今天真刷过的趟算（扣 条数×1.5，每小时回 10）；轮到某趟时定一次（固定种子，重算不变）：累了额外不刷（最多 strength=50%，**安静不刷、不私信**）或少刷；心情进唤醒提示并叮嘱别说出来 | 设置页「作息」四项 |
| 按记忆换方向搜 | `feed --explore "词1,词2"`：她自己按日记/最近对胃口的定方向；代码只管 ≤2 个、和不爱看沾边拒、合计 ≤30% 权重、记战绩（explore-log.json + 评分 → 接着挖/换方向，写进下次唤醒提示） | 无开关（她不加就不逛） |
| 一天的回顾 | `lib/daily-recap.js`：本机时间到 22:30 后，读今天评分/收藏/逛过的方向，用人格卡说一句发桌宠（进桌宠记忆）；一天一次、没刷不说、先过额度；失败带 code/hint，`GET /recap/status`、`POST /recap/run` | 合体层 `dailyRecap {enabled, at}` |
| 说话像机器 | 人格卡加 13~17 条 + 黑名单（复读他的话、「我这边」、讲幕后、让他「说清楚/截图」、评论区「我抄走了」模板）+ 4 个真实例子 | 人格卡（已同步 persona.md） |

- **注意**：窗口里的不看概率是「精神好时」的；精力低时会更高（这是精力模型的本意）。精力可在设置页关掉或调 strength。
- **测试**：`test-night-windows-minutes.mjs` 18 条（含 4000 天概率、精力只掷一次、周末保存往返、私信上限 5 条失败路径）、`test-explore-recap.mjs` 8 条。根目录 `test-watch-history`/`test-night-schedule` 失败是测试数据写死 +08:00（与改动无关、改动前就失败）。
- **备份**：`backups/bili-config-before-{minscore-11,dynamics-best,weekend,energy,skip-10-20-10-70}-*.json`、`persona.full-before-anti-parrot-*.md`。

### 复核后补的 4 处（同一批）
- **探索战绩记不上**：中文短语（「狼叔整活」）很少原样出现在标题里，搜出来的全落进「无偏好」→ 永远「推了 0 条」，她会误判方向不行。修：从这个探索词搜出来的候选算命中它（`withExploreHits`）；测试同时钉住「不修就是 0 条」。另：dislike 的英文词按词边界比（「ai」不再误伤 aim/rain）。
- **回主人的私信被总上限卡住**：主人私信她、她回 `dm --msg` 也走主人通道 → 一天 10 条后连回都回不了。修：`dm --reply` 不占上限，但必须主人 30 分钟内真发过私信（插件私信监听写 `owner-last-dm.json`），否则 `dm.reply-no-recent`；提示里回主人改用 `--reply`。报备类本来走 notify（desktop 弹窗），不占私信。
- **精力默认值在真实作息上从不触发**（1.5/10 时全天 ≥74）：按今天 10 趟模拟调到 **2.2/10**：上午狂刷到午饭 ~40、下午缓过来、深夜又乏。
- **路径核对**：插件侧 `activePlatformStateDir(BILI_DIR)` 与工具侧 `biliState()` 都是 `characters/char-mwlapqya/bili`（回顾与战绩读的就是工具写的）。
- **DSH 未重启时的保护**：重排后 01:03 的夜间「睡着」由旧代码执行会走轻醒；在它触发前按新逻辑手动标记 skipped（备份 `whale-night-before-reroll-energy-*.json`），插件随后推进到 04:39。
- 测试：night 19 条、explore+recap 10 条；插件 npm test、regressions 全过（精力调参前跑的一次；调参后两个相关测试文件重跑通过）。

## 追加：桌宠关着就不看屏幕（2026-11-18，用户）
- **现象**：看屏幕的后台例行看没有「桌宠在不在」的判断 —— 知更鸟关了（dsh-pet display=none）也照样截图、调模型，没人看得见，白花 token。
- **修法**：`createScreenWatch({ petPresent })`、`createDailyRecap({ petPresent })`；判据 = surfpet 心跳在线 或 dsh-pet 有显示中的宠物（`petChat.online().online || petChat.frontendOnline()`）。没桌宠：看屏幕暂停（提示一次）、打开自动恢复；回顾不说也不记「今天说过」，当晚打开桌宠再说。桌宠里问她 / 快捷对话附截图这类他主动要的不受影响。
- **B站不受影响**：B站会话、私信监听、生物钟都在插件里跑，不依赖桌宠是否显示。
- **默认**：`screenWatch.enabled` 代码默认 false，本机配置也是 false（备份 `config-before-screen-off-*.json`）。
- **测试**：`test-explore-recap.mjs` 新增 2 条（关着 0 截图、只提示一次、打开恢复；回顾等桌宠）。

## 追加：心情 + 社交（2026-11-18，用户：除了 TTS 都做）

**心情（`tools/lib/mood.mjs`，唯一状态 `bili/mood.json`，-10~+10，半衰期 4h，一次 ±2、一小时累计 ±4）**
- 变化来源：她判断他私信的内容（`mood note`，模型定、代码夹）· 视频内容（`score` 高分 +1 / ≤4 分 -1）· 互动（他回了她主动发的 +1；她主动发的 3h 没回且他 24h 内找过她 -1，0~8 点发的不算，一天最多 -3）。
- 影响（只往少里调）：刷视频（不爽更容易不刷 / 少刷，开心多刷，和精力同一次掷骰）· 主动闲聊上限 `chatCapFor`（不爽一半/两成，开心也不超过 chatDaily）· 说话劲头（唤醒/私信提示，叮嘱不说出来、不许抱怨没人理；人格卡第 18 条）。
- 设置页「作息」：心情开关、半衰期、多久没回算不理。

**社交**
- 一起看：他私信里的 BV / b23.tv 短链（代码跟跳转）→ `debrief --no-frames` → `score` → `--reply` 回真实反应；`watched-together.json` 去重。
- 好笑的那一秒：分享私信 / 一起看时只用 debrief 弹幕热区或字幕给出的时间，链接带 `?t=秒`；没有就不编（省掉发图的 token）。
- 你们之间的梗：`joke add/list/use`；必须有出处（BV，或他 48h 内真私信过 = dm）；最多 30 个；一天最多翻一个旧梗、同一个 3 天内不重复。
- 关注 UP：`follow --suggest / --mid`；14 天里同一个 UP ≥3 条到分享线才够格，一天最多 2 个，不爱看的排除，B站拒绝就当天停。`score` 现在顺手记 UP 的 mid/名字（view 接口，失败不影响记分）。
- 周回顾：周日的晚间回顾换成「这周口味变化」（7 天最好/最烂/逛过的方向/收藏）。
- 桌宠挪位置（`lib/pet-move.js`）：dsh-pet 会删掉不认识的 [动作:…] 且插件拿不到，所以在 recall 里做一次很小的判断（无人格、输出一个词）→ /pose 读位置 → /position line 走过去；只对显示在桌面的宠物；`petMove.enabled` 可关（关了不花 token）。
- 已有、没新做：她自己评论下面有人回 → 会接着回（评论区倾听，每 5 分钟）。

**测试**：`scripts/test-mood-social.mjs` 16 条（回落/限速/上限只降不升/不冤枉的「不理」/心情进排程只掷一次/命令失败码/短链去重/提示里的禁止抱怨/周回顾/挪位置）。
**代价**：一起看要 debrief；挪位置每条桌宠消息多一次很小的模型调用；mood note 偶尔一次。
