# 2026-11-18 audit 7 个失败 + 删掉没用的走路代码

**现象**：`npm run test:audit` 146/153。
**根因**：
1. 5 个（night-schedule / watch-history / token-budget / token-guard / qq-fish-guard）：样例时间写死北京时间（+08:00），
   断言「今天 / 时段」按本地时区算；运行时代码按设备本地时间（用户要求），本机是太平洋时间 → 错天。代码没错，测试假设了时区。
   验证：同样的测试在进程内设 TZ=Asia/Shanghai 全过。（Windows 上从 shell 传 TZ 不生效，只能进程内设。）
2. release-manifest / update-apply-result：dsh 分支的提交没重新生成 `release/install-manifest.json`，清单与 HEAD 不符。
**修法**：
- `scripts/_pin-tz.mjs`（进程内设 TZ=Asia/Shanghai），作为这 5 个测试的第一个 import（ESM 按顺序求值）。
- 从 HEAD 重新生成清单（`node scripts/release-manifest.mjs`，取 git blob，不受 CRLF 影响），单独提交。
- 删 `lib/pet-move.js` 里被用户否掉的插件驱动走路：`move()` / `settle()` / `IDLE_ANIM` / `WALK_LEAD_MS` / `onUserMessage` 及其测试（168 → 95 行）。
**验证**：audit 153/153（清单提交后）；插件 npm test、regressions 通过。
**回滚**：git revert。

## 追加：test-update-apply-result 时好时坏 → 更新助手真 bug
- **现象**：约一半次数 `助手：版本一致时成功退出` 得 exit 4（verify.version-mismatch：期望 9.9.9 实际 0.7.0）。
- **根因**：`scripts/apply-update.mjs` 的 robocopy 默认跳过「大小 + 修改时间都相同」的文件。测试里 0.7.0 / 9.9.9 同长度、同一时刻写入 → package.json 被跳过。
  真实更新里内容变了但长度不变、时间撞上的文件同样会被静默跳过。
- **修法**：robocopy 加 `/IS /IT`（相同 / 微调过的文件也覆盖），一律覆盖，不靠比较。代价：每次更新全量复制约 800 个小文件。
- **验证**：独立复现脚本 12/12 通过（修前第 1 次就失败）；该测试连跑 6 次全 0。
