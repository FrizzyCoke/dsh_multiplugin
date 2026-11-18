# 2026-11-18 桌宠的生活 + 懂他（用户选 1~6）

## 做了什么
| # | 功能 | 实现 | 花不花 token |
|---|---|---|---|
| 1 | 心情上脸 | `lib/pet-life.js`：心情 ≥5 隔 25~45 分钟播开心动画（跳舞/吐泡泡…），≤-4 播打哈欠/叹气；中间不播 | 不花 |
| 2 | 跟着作息睡 | 作息里 `quietSkip` 的时段 → dsh-pet 自己的 `/sleep`（入睡→循环→起来、梦话）；时段结束 / 她半夜醒来刷 B站（40 分钟内）/ 你 10 分钟内找过它 → `/wake`；每 30 分钟补一次（dsh-pet 重启后） | 不花 |
| 3 | B站 反应 | 读 `quota.json` 的 log：她刚评论 → 记笔记小动作；刚私信分享 → 雀跃庆祝 + 气泡「刚给你发了个视频 去B站看」 | 不花 |
| 4 | 他自己在看什么 | `tools/lib/owner-taste.mjs`：用他扫码登录的 owner-credentials **只读**拉观看历史（2 页、2 小时缓存、最多 120 条）→ feed 排除他看过的；唤醒提示给 5 条「他最近在看」+ 口味标签 | 提示里多几行 |
| 5 | 跟着他的反应学 | 她私信分享的记 target；他回了 / 没理（mood pending）→ 近 14 天 ≥4 条样本时分享门槛 ±1~2（回得多降、老不理升）；**`dm --share` 现在在代码里查分**（没评分 `dm.share-unscored`、不够 `dm.share-score`），`comment --share` 同一门槛；提示里列他回过 / 没理的 | 不花 |
| 6 | 记住日子 | `dates add/list/del`（只记他 48 小时内真私信过的 `dates.no-source`；一次性或每年）；今天 / 明天到期 → B站唤醒提示 + 桌宠 system prompt（同一份） | 提示里多几行 |

## 安全 / 边界
- 他的数据只读，不替他做任何操作；没登录整段跳过。
- 桌宠只对显示在桌面上的宠物动作；你刚说过话不打扰。
- 新文件都自带上限：owner-history 120 条、dates 50 条、mood pending 60 条 / 14 天。

## 验证
- `scripts/test-know-you.mjs` 13 条（睡觉时段含周末、半夜醒来算醒、心情→动画、B站 新动作去重、/sleep /wake 时机、没在桌面不动、心情动画间隔、观看历史解析去重 + 缓存 + 没登录带 code、门槛 ±2、日子到期、dates 失败码、私信分享查分）。
- 真机只读：主人观看历史拉到 56 条，口味标签 网络游戏 / MAD·AMV / 计算机技术 / 电子竞技 …
- 插件 npm test、regressions 全过。
- 未在真机验证：桌宠睡觉 / 动画（当时 dsh-pet 显示为 none）—— 重启 DSH、桌宠显示在桌面后看 `[pet-life]` 日志。

## 回滚
`petLife.enabled=false`；分享门槛回到固定值：删 `bili/mood.json` 里的 pending 或改代码 `effectiveMinScore` 返回 base。
