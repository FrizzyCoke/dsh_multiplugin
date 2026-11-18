# 2026-11-18 存储上限 + ffmpeg 改为可选

## 现象
- 她报备「体检还是红的 缺ffmpeg 这趟只读没对外发」：ffmpeg 从没装过；体检把它当必需项，一红整趟只读。
- 用户担心占空间：DSH 附件里存了 63 张看屏幕的截图（59 MB，DSH 自己从不清理）；B站缓存只按天清、没总量上限；代码目录里混进 2 张视频封面。

## 根因 / 修法
| 问题 | 修法 |
|---|---|
| ffmpeg 只管「抽帧看画面」，却是必需项 | `deps`：ffmpeg 标可选（⚠，不拦对外发言，深读用 `--no-frames`）；唤醒提示只在 ✗ 时只读。装了 ffmpeg（winget Gyan.FFmpeg，665 MB）；`lib/ffmpeg.mjs` 增加 WinGet 安装目录兜底（winget 只改用户 PATH，DSH 可能沿用旧环境） |
| B站缓存无总量上限 | `shots { retentionDays: 1, maxMB: 100 }`（视频本身抽完帧立刻删，原本就这样） |
| DSH 附件里的截图永不清理 | `lib/attachment-gc.js`：pet-chat 每存一张图记 sha256 账本，只清账本里的；超过 2 天或总量超过 50 MB（从最旧）删；删前查 DSH 会话日志（zstd）和 dsh-pet 记录，提到的不删；会话读不了就整轮不删。启动 1 分钟后 + 每 6 小时一次。旧的 63 张逐张确认没被引用后收编，首轮清 15 张（9.2 MB） |
| 2 张封面在代码目录 | 早期一次深读写错了位置；移到 `harness/_quarantine/2026-11-18-stray-covers/`，不进提交 |

## 验证
- `node bili.mjs deps` → 全部可用（ffmpeg 9.0.2）。
- `scripts/test-attachment-gc.mjs` 5 条：只清自己的、过期删、总量上限从旧删、被引用不删、日志读不了不删。
- 核实：本机 DSH 会话里 attachmentId 引用 0 个；附件按内容 sha256 命名（与账本一致；若 DSH 将来改存储方式，账本对不上 → 什么都不删，安全失败）。

## 回滚
- `attachmentGc.enabled=false`；`shots` 改回 `{retentionDays:7,maxMB:0}`；卸载 ffmpeg：`winget uninstall Gyan.FFmpeg`。

## 追加：截图用完即删 + 所有产生的文件统一封顶（同日，用户要求「全部都能自动删或封顶，彻底检查」）

### 截图用完即删
- `pet-chat.complete()` 包一层：这次调用里存的截图（含 look_at_screen 工具返回的）在调用结束（成功或失败）立刻 `attachmentGc.release()` 删掉。
- 存之前先查：同一张图本来就在 DSH 附件里（别人的）→ 不记账、永不删。2 天 / 50MB 的定期清理只作兜底。

### 盘点（真实目录，按会不会一直长）
| 文件 | 以前 | 现在 |
|---|---|---|
| plugin.log | 2MB 轮换 | 不变 |
| 桌宠聊天记录 | 200 条 | 不变 |
| 记忆收件箱 | 轮换 | 不变 |
| scores / explore / mood / jokes / watched-together / feed-picks | 各自有上限 | 不变 |
| B站视频缓存 shots | 7 天、无总量 | 1 天 / 100MB |
| DSH 附件里的截图 | 永不清 | 用完即删 + 2 天 / 50MB |
| context-telemetry-plugin.jsonl、bridge-supervisor.log | 无上限 | 1MB → 留最后 3000 行 |
| bili/dm-tick-err.log（轻醒时每分钟写一行） | 无上限 | 256KB → 500 行 |
| bili/whale-log.jsonl、watch-history.jsonl、commented-videos.md | 无上限 | 1~2MB → 3000~4000 行 |
| 她每趟都读的两本日记 | 无上限（越长越费 token） | 超 48KB 把旧的挪进 `.archive.md`（档案 1MB 封顶），只留最近 32KB |
| 记忆全量档案 memory-card-full.jsonl | 无上限 | 20MB（很宽，按现在的量够用一年多） |
| 角色每日快照 snapshots/auto-* | 每天一个、永不删 | 留最新 7 个（手动快照不碰） |
| backups/ | 无上限 | 留最新 40 个 + 14 天内的 |
| pet/voice 语音 | 无上限 | 留最新 60 个 + 3 天内的 |
| 桌宠 / 快捷对话的 Electron 缓存（GPUCache 等） | Chromium 自己封顶 | 不变 |
- 统一实现：`lib/housekeeping.js`（规则表），启动 2 分钟后 + 每 6 小时；`GET /dsh-surfcore/pet-api/storage/status`、`POST …/storage/run`。
- 真实目录试跑：路径正确、0 错误、当前都在上限内。
- 测试：`test-housekeeping.mjs` 5 条（截尾留最新、日记挪档案不丢、目录只留最新且手动快照不碰、失败带 code、规则表覆盖清单）；`test-attachment-gc.mjs` +2 条（用完即删、别人的不删、调用失败也删）。
- 回滚：`housekeeping.enabled=false`、`attachmentGc.enabled=false`。
