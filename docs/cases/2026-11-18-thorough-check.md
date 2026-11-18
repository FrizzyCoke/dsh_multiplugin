# 2026-11-18 全面体检（运行时 + 代码）

**查了什么**：今天 plugin.log 的错误分类、每个后台任务的状态文件、存储占用、B站 依赖体检（deps）、DSH 护栏补丁、生物钟排程里同类「旧状态带过来」的问题、全部测试。

| 发现 | 处理 |
|---|---|
| 向量记忆每 10 分钟刷一条同样的 `vector.service-missing`（一天 58 条；记忆模式是 narrative，本机没装 Embedding 运行时），把真错误淹了 | `createFailLogGate`：同一错误只记一次，换错误 / 恢复时再记；状态页 lastError 照常显示 |
| B站 监听偶发 `TypeError: fetch failed`，看不出是网络还是程序错 | `formatListenError` 把 `error.cause` 的 code / 主机放最前面 |
| `guard:check` 写死 `D:\deepseek\...`（别的机器）→ 本机 ENOENT，从没真正检查过 | 自动找：`DSH_ASAR` > `%LOCALAPPDATA%\Programs\DSH Desktop` > `%ProgramFiles%` > 旧默认 |
| 用真实路径检查：`missing-target`（这版 DSH 里找不到补丁的目标代码） | **没动**：改 app.asar 要用户拍板；记在这里 |
| focus-mode 注释 / case 写的原值路径是 `state/`，实际是 `surfcore/` | 改正（原值内容已核对：与备份一致，关专注能正确恢复） |
| 生物钟其它字段会不会也被 `...state` 带坏 | 查了 wokeAt / late / missedAt / tired / sulky：都安全（wokeAt 只在 fired=true 时读） |

**正常的**：B站 deps 全 ✓（cookie 登录、ffmpeg、Node、目录可写）；专注模式状态正确；存储 38MB（34MB 是 surfpet 程序本体）；
15:00 那趟真在干活（看 5 条、评 4 条、心情 3.2），修复后的第二次叫醒生效；模型超时集中在 14:16 / 14:48 两次，像网络抖动。

**测试**：新 `test-log-noise.mjs` 2 条；插件 npm test、regressions、audit 153/153。
**回滚**：git revert。
