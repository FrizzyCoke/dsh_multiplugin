# 2026-11-18 到线的视频她从不分享 + 清掉「不爱看二次元」误记

## 现象
主人：「为什么不给我发视频？明明过线了。」今天 BV13RT567EGQ 13 分、BV1k5MY6nEfo 12 分（门槛 12），
quota.json 里 `share:true` 记录**从来是 0 条**；dm-tick 没有任何 `dm.share-*` 拒绝 —— 她压根没试过。

## 根因
1. 提示第 5 步写的是「只对第一名**考虑**分享」，而前面的搭话写的是「额度**要花完**」——
   必做的挤掉了可选的，每趟到第 5 步就收工了。
2. 早上程序 bug 让主人私信里说了两次「不爱看二次元」，她记进 whale-log 的「偏好校准」并回「以后不硬推」，更不敢推。

## 修法
- `lib/scheduler.js` 新增 `shareDueLines(B)`：今天（scores.json 本地日期）有 ≥ 当前门槛、7 天内没分享过的 BV
  → 在第 5 步前点名「今天还欠他一条分享：BV…，这一趟就发给他」；第 5 步改成「第一名到线就分享给我」。
  沉默逛（SILENT）/ share.enabled=false 时不出。闸门（每天 3 条、7 天判重、主动私信 10 条/天）不变。
- 运行时数据（主人授权「clear the memory」）：whale-log.jsonl 删 2 条「不爱看/不喜欢二次元」、去掉 1 处「（非动漫）」、
  追加一条更正。备份：`harness/surfcore/backups/whale-log-before-anime-clear-*.jsonl`。

## 完整逻辑
- 链路：scheduler.js（DSH 插件进程）拼 whale 会话提示 → 她按 share.via=dm 跑 `dm --share --target BV…` → dm.mjs 查分/门槛/额度。
- 爆炸半径：只多一段提示；发不发仍过 dm.mjs 全部闸门，不会刷屏。
- 取舍：A 提示点名（选）；B 代码自动发（违背「她自己决定说的」，且文案要她写）——不选。
- 生效：重启 DSH（scheduler.js 在插件进程里）；whale-log 改动即时生效。
- 验证：`node plugins/surfcore/scripts/test-share-due.mjs`（3 条）；对真实数据渲染出 BV13RT567EGQ 那行。
- 回滚：revert 本提交；whale-log 从备份拷回。
- 残余：B站私信历史里那两句原话还在（删不掉）；更正条目让她以更正为准。
