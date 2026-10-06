# HANDOFF · orchestrate

仓库位置（2026-10-05 起）：`D:/2/dev/orch-runner/orchestrate`。`~/.claude/skills/orchestrate` 是指向它的 junction，
Claude Code 照常从那里加载 skill。在 D 盘这边编辑和提交（`.claude` 里面的路径每次编辑都要确认）。
旧副本备份在 `~/.claude/_archive/2026-10-05/orchestrate`。

## 2026-10-06（最新，新会话先读）

- 借鉴同类项目的 5 步改造全部完成（调研见 `D:/2/dev/orch-runner/research-similar-projects.md`）：
  1. 审查只走 codex，额度满 → `review_pending`；审查档位只升不降（`--reviewer luna` 降不了 sol）。wb 只做 agy 备选（`agy-fallback`，默认 auto）。
  2. `--commit` 门槛：outcome 与 Acceptance verdict 不一致就拒绝；`review_fail`/`check_failed` 要有 `- claude fix:` 行。
  3. 基线 Check：派发前先跑一次 Check，摘要 `baseline check:`；基线动了只读路径 → 不启动执行者。
  4. 结果过期：Check 后记录指纹，`--commit` 发现之后又改过 / 最近 Check 失败 → 拒绝；`--recheck --name` 重跑 Check 刷新。
  5. 高风险卡派发前 sol 只读计划审查：`PLAN: REVISE` → `plan_revise`，执行者不启动。
- 进度行规则：Y 30–50 字，只要看得出做到哪一步。
- 已知：sol 打回（review_fail）的卡不会自动生成 Acceptance 草稿，需手写。

## 2026-10-05 晚

- 新执行者 `wb`：CodeBuddy CLI（`npm i -g @tencent-ai/codebuddy-code`，已登录），`deepseek-v4.1-flash` + `--effort high`；
  `/wb` 命令；`/orch` 每次先问「写代码交给 agy 还是 wb」。用户规定 DeepSeek 一律用 flash。
- wb（DeepSeek flash）只做 agy 的备选，不再审查（2026-10-06 用户）。开关 `agy-fallback`：`auto`（默认）= 派发时 agy 额度满才走 wb；`on` 强制 wb，`off` 强制 agy。**现在是 `auto`**。审查只走 codex，额度满 → `review_pending`；`--reviewer luna` 不能把 sol 档降下来。旧的 `codex-fallback` 文件已不再读取。
- runner 新增：派活前 codex 额度预检（满了 exit 2）；`--fix` 大文件/忽略文件只记 size+mtime；wb 审查改动仓库 → `review_error`。
  测试 `node runner/test-run-card.mjs` → `28/28 passed`（假 codebuddy 覆盖 wb 执行和审查）。
- 下一步：codex 恢复后用 sol 整体复审 `674d8a2..HEAD`（今天的审查都由 wb 自己做）；
  `ledger.mjs` 读不出 CodeBuddy usage（wb 行显示 0k），用户说先不管。
- 坑：wb 做审查时容易跑去翻 `agent-live/`，审查卡要写「只读 diff 和点名文件」；Token Weather 源码在
  `D:/2/dev/token-weather-quotas`（不是 plugins/cache 那份）。

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
1. ✅ `--commit` 钩子失败已修（fe2048f，测试开头删掉继承的 `GIT_*`），卡 7 用 `--commit` 端到端提交成功（9b48db3）。
2. ✅ 修复轮默认 `--fresh`（SKILL.md）：卡 7 Fix 1 新会话 fresh 103k，卡 6 续会话 799k。再攒两三轮确认。
3. 若要继续缩：把参数校验 + 状态初始化挪到 `runner/setup.mjs`、摘要打印挪到 `runner/summary.mjs`。
4. ✅ 第二次 sol 整仓 audit（2026-10-05）：7 个 bug 全属实，已回填卡 1–4 的 K missed（bf55594）；卡 7 修了其中 3 个 + 6 处精简。
   没修（少见）：`git mv` 重命名丢源路径（snapshot.mjs:51）、不存在的只读路径不守卫（run-card.mjs:234）、非 git 快照跳过链接（snapshot.mjs:19）；
   不修（设计取舍）：已 dirty 文件的审查 diff 混入旧改动（review.mjs）。审查顺带报的老问题：执行者回复缺 STATUS 行被当成功（executor.mjs）。
   下次 audit：runner 再累积 4–5 张卡后。
5. 精简（2026-10-05）：执行者提示词加了 lean 一句（复用 > stdlib，不加抽象，回复只给 STATUS + 文件）；审查提示词加列臃肿项（不单独判 FAIL）。
   agy 全局规则去重：同一份 13KB 规则原有 5 份、加载 3 次，现只留 `~/.gemini/config/rules/GEMINI.md`（其余在 `~/.claude/_archive/2026-10-05/gemini-rules-dedup`；
   `codex-productivity-tools` 插件更新可能放回它那份）。不做：MCP 包装 runner（不省 token）、agy 自审轮（贵且同模型看不出）。
   效果还看不出：卡 7 是改动后第一张卡，第 1 轮 fresh 696k（卡 6 335k），但卡 7 步骤多一倍；sol 报 bloat: none。

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
