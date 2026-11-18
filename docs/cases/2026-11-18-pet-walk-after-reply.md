# 2026-11-18 桌宠「往左走」还在哼歌 + 老复述他的话

**现象**：他说「往左边点」，她回「行，往左」，播的却是 [动作:悠闲哼歌]，原地不动。
**根因**：
1. 走路靠她在回话末尾写 [动作:螃蟹走路]，但她照抄聊天历史里的「悠闲哼歌」，提示没用。
2. 回话前的转身（/anim 待机 + facing）会被她回话的动作盖掉。
3. dsh-pet 每次把最近几轮对话带给她，里面全是复述样本（「行，往左」「要不咱撤了？行啊」），她照着学。
4. 我们的规则拼在 dsh-pet 自己的说明前面，她最后读到的不是我们的规则。

**修法**：
- 走路不再靠她选：recall 时判断方向；dsh-pet 在 captureTurn（微任务）之后同步写她的动作，
  所以 capture 里发的 `/anim {name: 螃蟹走路|原地左转奔跑, facing}` 晚于她的动作，会把它盖掉，dsh-pet 自带的 tryMove 真走。
  提示里不再让她写走位动作（她自己写的话 dsh-pet 会朝旧方向先走，我们的就被 busy 拒）。
- 每句都加【说话】别复述规则，并把我们的规则放到 dsh-pet 说明之后。
- 清掉 dsh-pet memory.json 里 12 轮复述样本（先备份到 surfcore/backups/）。
- persona：第 13 条加「第一个词是他说过的就重来」，加 7 个接话示例（先备份）。

**测试**：test-mood-social 22 条（新增「回完话才走」）；插件 npm test、regressions 通过。
**残余**：根目录 audit 有 7 个脚本在今天之前的提交上就失败（night-schedule / watch-history / token-* / qq-fish-guard），与本次无关，另行处理。
**回滚**：git revert；persona / memory 从 backups/ 拷回。
