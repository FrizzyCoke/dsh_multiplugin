# 2026-11-18 一天只醒第一次：下一趟被每分钟往后推

**现象**：14:47 那趟一直变成 14:49、14:55…，从 04:39 之后没再醒过；日志里每天都只有「第 1 次」。主动私信因此很少。
**根因**：`tools/commands/whale-night.mjs` 的 `planFromSlot` 用 `...state` 复制上一趟的状态，带上了 `woke: true`。
`lib/scheduler.js` 的 tick 看到 `woke === true` 就当「已醒、该重算」→ 每分钟重跑 plan → `nextPendingSlot` 把过点的这趟改成「现在 +1 分钟」→ 永远到不了。
（这行复制从 0.1.0 就在；一天排多趟以后才暴露。）
**修法**：`planFromSlot` 明确写 `woke: false`（新的一趟从「没醒」开始）。
**生效**：plan 是每次 tick 新起的子进程 → 不用重启 DSH，下一次 tick 就重算成正常计划。
**测试**：`test-night-windows-minutes.mjs` 加一条：临时 DSH_HOME、上一趟 woke:true → 跑真的 `whale-night.mjs plan` → woke=false、slotId=s2。去掉修复该条失败。
**回滚**：git revert。
