# 2026-11-18 专注模式（不弹东西、不配图）

**需求**：做个专注模式，不弹气泡 / 通知、不配图。

**做法**（`lib/focus-mode.js`，开关在桌宠右键菜单「专注模式：开/关」，也可 POST /dsh-surfcore/pet-api/focus）：
| 会冒出来的 | 专注时 |
|---|---|
| dsh-pet 碎碎念 + 配图、对话配图、工作状态气泡 | 改 dsh-pet main-config：`whisperEnabled` / `workStatusEnabled`（每只宠物）、`whisperImageEnabled` / `chatImageEnabled` → false；关专注原样恢复（原值存 state/focus-dshpet.json，第一次改前备份到 backups/） |
| SurfCore 主动搭话、看屏幕 | 原来就看专注开关（pet/focus.json） |
| 主动搭话镜像到 dsh-pet 的气泡 | `broadcast` 专注时不弹；你点菜单的确认（force）照弹 |
| 心情动画、B站 分享 / 评论时的桌宠反应 | 不播（专注期间的 B站 动作不在关专注后补） |
| 晚间回顾 | 先不说、不记「今天说过」 |
| B站 桌面通知 | notify.mjs 读 pet/focus.json，不弹（日志里说明） |
| **你主动找她**（桌宠对话、快捷对话、菜单） | 照常 |
- 直接改 dsh-pet 的配置文件而不是走它的保存接口：保存接口会重启桌宠窗口；它的碎碎念计时器每轮重读配置，所以不用重启。
- 启动对齐：专注开着但 dsh-pet 没改 → 补改；关着却留着原值 → 补恢复（防中途崩）。
- dsh-pet 配置读不到：SurfCore 这边照样进专注，返回 `focus.dshpet-config` + hint。

**测试**：`test-focus-mode.mjs` 9 条；`test-dsh-pet-menu.mjs` 按新菜单（专注在第一项）更新；插件 npm test、regressions 全过。
**回滚**：菜单关专注即恢复 dsh-pet 原值；或用 backups/dsh-pet-config-before-focus-*.jsonc。
