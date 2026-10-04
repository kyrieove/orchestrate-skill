# HANDOFF · orchestrate

仓库位置（2026-10-05 起）：`D:/2/dev/orch-runner/orchestrate`。`~/.claude/skills/orchestrate` 是指向它的 junction，
Claude Code 照常从那里加载 skill。在 D 盘这边编辑和提交（`.claude` 里面的路径每次编辑都要确认）。
旧副本备份在 `~/.claude/_archive/2026-10-05/orchestrate`。

## 待办：orch-runner（mod 辅助 orchestrate，省 Claude token）—— 2026-10-05 定方案，下一步开工

**目的**：orchestrate 仍是大脑（选执行者、定风险、写卡、验收）；runner 是 0 token 的 mod，接管中间的机械步骤，
每张卡把 Claude 的唤醒从 3 次减到 2 次（派发、验收）。

**已定**
- 位置：本仓库 `runner/` 子目录，作为独立插件安装（`runner/.claude-plugin/plugin.json` + `runner/hooks/orch-runner.mjs`）。
  skill 不搬家，`/orch /agy /luna /sol` 不变。同一仓库保证规则和代码一起改。
- SKILL.md 保留手动派发的命令模板作后备：runner 没装或出错时照旧手动走。
- token-weather 不改：runner 写同样的 `~/.claude/agent-live/<name>.{jsonl,progress,exit}`，进度条照常显示。
- 先做 MVP，用卡片 Acceptance 的 `tokens:` 行对比省了多少，再扩展。

**MVP 范围**
1. 注册工具 `orch_run(card, executor, risk, name)`，立即返回。
2. 拍 before 快照（`git status --short`），按 SKILL.md 的模板拼执行命令并**脱离启动**（见坑 1），写 agent-live 文件。
3. 轮询看到执行者 `.exit` → after 快照，比对卡片 `## Files`（越界就停、唤醒 Claude）→ 跑 `ledger.mjs <name>` →
   按风险派审查（low 跳过；luna/sol 执行 → sol；否则 medium → luna、high → sol）。
4. 看到审查 `.exit` → `$.prompt.submit` 一条摘要唤醒 Claude：VERDICT、`git diff --stat`、review 的 file:line、ledger 行。

**待定（开工前问用户）**
- 风险和执行者：由 Claude 作为 `orch_run` 参数传，还是 runner 从卡片 `## Risk` 读。
- 执行者失败（429、崩溃、非 0 退出）时：直接唤醒 Claude，还是先重试一次。
- 修复轮（`## Fix N`）是否也走 runner。

**API 事实（已核对 `token-weather-quotas/.claude-plugin/types/claude-code/index.d.ts`）**
- `$.process.run`：一次性，默认 30 s，最长 10 min，读完整输出——不能用来跑执行者。
- `$.process.spawn`：流式，**模块卸载（热重载）会杀掉子进程**。
- `$.tool.register` 注册工具；`$.prompt.submit` 可提交一条消息唤醒 Claude（拒绝以 `/` 开头的文本）；
  `$.clock.every` 定时轮询；`$.fs.read` 超 4 MiB 拒绝。

**坑**
1. 执行者必须脱离 mod 进程启动：用 `$.process.run` 跑一条立即返回的启动命令（如 Git Bash `nohup … &` 或
   PowerShell `Start-Process`），之后只靠读文件跟踪；否则改 mod 触发热重载会杀掉正在跑的 agy。
2. 这台机器的 `python3` 是 Windows 商店占位程序，用 `python`。
3. 认领要按会话持久化、`/clear` 会换 session id：照抄 token-weather 的 `syncSession` / `loadClaims` 做法。
4. agy 的 `-p` 忽略 stdin；codex 必须 `< /dev/null`；agy 结果在 stream 最后一行 `"event":"result"`。

**开工方式**：按 orchestrate 自己写卡（risk=medium，执行者 agy，审查 sol），卡片放 `docs/orch/<日期>-orch-runner/`。
