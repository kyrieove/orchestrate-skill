# HANDOFF · orchestrate

仓库位置（2026-10-05 起）：`D:/2/dev/orch-runner/orchestrate`。`~/.claude/skills/orchestrate` 是指向它的 junction，
Claude Code 照常从那里加载 skill。在 D 盘这边编辑和提交（`.claude` 里面的路径每次编辑都要确认）。
旧副本备份在 `~/.claude/_archive/2026-10-05/orchestrate`。

## 进行中：orch-runner（脚本辅助 orchestrate，省 Claude token）

**目的**：orchestrate 仍是大脑（选执行者、定风险、写卡、验收）；runner 接管中间的机械步骤，
每张卡把 Claude 的唤醒从 3 次减到 2 次（派发、验收）。

**已定（2026-10-05）**
- **不做 mod，做普通 node 脚本** `runner/run-card.mjs`：Claude 用 Bash `run_in_background` 启动它，
  它顺序跑 执行者 → Check → Files 比对 → ledger → 审查，打印摘要后退出；后台完成通知唤醒 Claude 一次。
  这样没有热重载杀进程、会话认领的问题；Bash 命令里字面写出 `agent-live/<name>.jsonl`，token-weather 进度条照常显示
  （mod 用 `$.process.run` 起执行者反而不会被 token-weather 认领）。
- 风险、执行者作为参数传；Check 和 Files 从卡片 `## Check`、`## Files` 的反引号里读。
- **Check 归 runner**：执行者不跑 Check，runner 在执行者退出后跑一次并记录退出码（独立凭据）。
- 执行者回复首行 `STATUS: done|blocked|failed`；失败分 failed / blocked / interrupted（超时，`taskkill /T` 杀进程树），一律不重试、直接结束并报告。
- 修复轮（`## Fix N`）先不走 runner，照旧手动。
- 吸收了 `C:/dev/brain-plot/docs/orchestrate-recommendations-2026-10-05.md` 的 1–3 条：脏文件 before/after 用 `git hash-object`
  比内容（`git status` 看不出二次修改）；每张卡一个状态文件 `~/.claude/agent-live/orch-runner/<name>.json`；时间上限。4 已有（300k 换会话），5 以后。
- SKILL.md 保留手动派发模板作后备；runner 验证通过后再改 SKILL.md 的 Flow / Commands。

**进度**：runner 完成（卡 1–5，2177aee），SKILL.md 默认走 runner；retro（2026-10-05）已落地：共享工具代码用 sol 审、同模块 4–5 张卡后跑 sol 整仓 audit 并回填 K missed、v16 数字改为按轮、本地 pre-commit 钩子（`.git/hooks/pre-commit`，未入库：node --check + 测试）。

**卡 6 完成（2026-10-05，1a05333）**：run-card.mjs 拆成 card / snapshot / executor / review / acceptance / commit 六个模块；
run-card.mjs 仍有 677 行（目标 600），剩下是参数/状态初始化和摘要打印。新增 `--reviewer luna|sol`（54504dc）。

**下一步（新会话）**
1. ✅ 已修（2026-10-05）：钩子里 git 设的 `GIT_DIR`/`GIT_INDEX_FILE` 漏进测试子进程，临时仓库的 git 操作到外层仓库；`test-run-card.mjs` 开头删掉所有 `GIT_*`。
   还没用真卡跑一次 `run-card.mjs --commit` 端到端确认。
2. token 实测：卡 6 的 Fix 1 续 agy 会话，fresh 799k，比第 1 轮整卡（fresh 335k）还多，只是删 ~40 行。下一个修复轮用 `--fresh` 跑，对比后决定 SKILL.md 默认续会话还是新会话。
3. 若要继续缩：把参数校验 + 状态初始化挪到 `runner/setup.mjs`、摘要打印挪到 `runner/summary.mjs`。
4. 卡 6 算 runner 模块第 6 张卡：按 retro 规则该跑一次 sol 整仓 audit（`/rv` 整体），回填 K missed。
5. 精简（2026-10-05）：执行者提示词加了 lean 一句（复用 > stdlib，不加抽象，回复只给 STATUS + 文件）；审查提示词加列臃肿项（不单独判 FAIL）。
   agy 全局规则去重：同一份 13KB 规则原有 5 份、加载 3 次，现只留 `~/.gemini/config/rules/GEMINI.md`（其余在 `~/.claude/_archive/2026-10-05/gemini-rules-dedup`；
   `codex-productivity-tools` 插件更新可能放回它那份）。下一张卡对比 agy token 和 diff 行数看效果。不做：MCP 包装 runner（不省 token）、agy 自审轮（贵且同模型看不出）。

**后续卡（2026-10-05 定，run-card 验收后按顺序写卡派发）**
- 卡 2 · 跑之前/跑当中（改 `run-card.mjs`）：
  1. 卡片 lint：派发前检查 Goal/Risk/Files/Check/Steps(N)/Don't 齐全、Files 和 Check 有反引号、Don't 含三句必带句，缺了直接退出，不启动执行者。
  2. 审查首行没有 VERDICT → 自动重跑一次（SKILL.md 规则）。
  3. 越界文件里把垃圾（`__pycache__`、`*.log`、`tmp*`）单独列出，方便 Claude 一句话问用户。
  4. 只读数据目录守卫：`## Files` read-only 里的目录，before/after 比对文件列表 + 大小 + mtime，有任何变化就 fail。
  5. `--recon` 模式：只读侦察卡，没有 Check，任何文件改动都算越界，完整打印回复（≤ 40 行）。
- 卡 3 · 修复和验收（改 `run-card.mjs`）：
  1. `--fix N`：agy 用 state 里存的 `--conversation`，codex 开新会话执行「## Fix N」；跑前先把旧的 ledger 行存进 state；
     之后跑 Check 和越界检查，不再做一致性审查，摘要里直接附上修复的 diff；最多 2 轮。
  2. 自动起草 `## Acceptance`（结论、文件、check、`tokens:`、审查结论），Claude 只需要填 `review findings`。
  3. `--commit <name>`：只提交 `## Files` 里的文件 + card.md + review.md；项目有 `docs/review-log.md` 就追加一行。
- 卡 4 · 独立小脚本（另加：执行者提示里要求交付前做廉价的语法自检，如 `node --check` / `python -m py_compile`，卡 3 agy 交了一个连加载都失败的文件）：
  1. `runner/run-long.mjs`：长计算启动器（输出目录已存在就停、tee 到 `run-<name>.jsonl`、写 `.exit`）。
  2. 非 git 目录：snapshot 改成比对文件列表 + 大小 + mtime。
  3. `runner/stats.mjs`：汇总 `orch-runner/*.json`，按执行者 × 风险统计结果、修复轮数、耗时、token，供攒够 10–15 张卡后调整 Modes 表。
- 全部做完再改 SKILL.md 的 Flow / Commands，把 runner 写成默认派发方式。

**坑**
1. 这台机器的 `python3` 是 Windows 商店占位程序，用 `python`。
2. agy 的 `-p` 忽略 stdin；codex 必须 `< /dev/null`；agy 结果在 stream 最后一行 `"event":"result"`。
3. Bash 后台任务 2 h 被杀：runner 默认超时 100 min。
