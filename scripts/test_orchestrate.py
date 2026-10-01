"""Contract checks using temporary repositories and local fake executors."""

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path


SCRIPT = Path(__file__).with_name("orchestrate.py")


def git(repo, *args):
    subprocess.run(["git", *args], cwd=repo, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def setup(repo, builder="codex", reviewer="agy", check="python check.py", tier="standard", timeout_min="60"):
    repo.mkdir()
    git(repo, "init", "-b", "main")
    git(repo, "config", "user.email", "test@example.com")
    git(repo, "config", "user.name", "Test")
    (repo / "check.py").write_text("raise SystemExit(0)\n", encoding="utf-8")
    (repo / ".orchestrate" / "case").mkdir(parents=True)
    run = repo / ".orchestrate" / "case"
    (run / "card.md").write_text(
        f"---\nname: case\nbuilder: {builder}\nreviewer: {reviewer}\ncheck: {check}\ntier: {tier}\ntimeout_min: {timeout_min}\n---\nGoal: exercise workflow\nMay change: result.txt\n",
        encoding="utf-8")
    (repo / ".gitignore").write_text(".orchestrate/\nfake-*.py\n", encoding="utf-8")
    git(repo, "add", "check.py", ".gitignore")
    git(repo, "commit", "-m", "base")
    return run


def fake(path, source):
    path.write_text("#!/usr/bin/env python3\n" + source, encoding="utf-8")
    if os.name != "nt":
        path.chmod(0o755)


def fake_codex(path, source, write_report=True):
    report_code = (
        "    if os.environ.get('ORCH_STAGE') == 'build':\n"
        "        _rep = Path(os.environ['ORCH_RUN']) / 'report.md'\n"
        "        if not _rep.exists():\n"
        "            _rep.write_text('STATUS: done\\nFILES: result.txt\\nCHECK: ok\\nOPEN: none\\n', encoding='utf-8')\n"
    ) if write_report else ""
    preamble = (
        "import io, json, os, sys\n"
        "from pathlib import Path\n"
        "sys.stdout.reconfigure(encoding='utf-8')\n"
        "sys.stderr.reconfigure(encoding='utf-8')\n"
        "args = sys.argv\n"
        "is_resume = 'resume' in args\n"
        "if is_resume:\n"
        "    session_id = args[args.index('resume') + 1]\n"
        "    assert '-C' not in args and '-s' not in args and '--approve-for-me' not in args\n"
        "    assert '-c' in args and any('model_reasoning_effort=' in a for a in args)\n"
        "    assert '-m' in args\n"
        "    if os.environ.get('ORCH_STAGE') == 'build':\n"
        "        prompt = sys.stdin.read()\n"
        "        assert 'fix them, rewrite report.md' in prompt.lower()\n"
        "        assert 'implement this task card' not in prompt.lower()\n"
        "        sys.stdin = io.StringIO(prompt)\n"
        "else:\n"
        "    session_id = 'codex-thread-1'\n"
        "    assert '--json' in args\n"
        "out_file = Path(args[args.index('-o') + 1]) if '-o' in args else None\n"
        "old_stdout = sys.stdout\n"
        "captured = io.StringIO()\n"
        "sys.stdout = captured\n"
        "try:\n"
        + report_code +
        "    exec(" + repr(source) + ")\n"
        "except SystemExit as exc:\n"
        "    sys.stdout = old_stdout\n"
        "    if captured.getvalue():\n"
        "        print(captured.getvalue().strip())\n"
        "    raise\n"
        "finally:\n"
        "    sys.stdout = old_stdout\n"
        "out_text = captured.getvalue().strip()\n"
        "if out_file:\n"
        "    out_file.write_text(out_text, encoding='utf-8')\n"
        "if not is_resume:\n"
        "    print(json.dumps({'type': 'thread.started', 'thread_id': session_id}))\n"
        "    if out_text:\n"
        "        print(json.dumps({'type': 'message', 'content': out_text}, ensure_ascii=False))\n"
        "        if 'RESOURCE_EXHAUSTED' in out_text or '429' in out_text:\n"
        "            print(out_text)\n"
        "else:\n"
        "    if out_text:\n"
        "        print(out_text)\n"
    )
    fake(path, preamble)


def fake_agy(path, source, write_report=True):
    report_code = (
        "    if os.environ.get('ORCH_STAGE') == 'build':\n"
        "        _rep = Path(os.environ['ORCH_RUN']) / 'report.md'\n"
        "        if not _rep.exists():\n"
        "            _rep.write_text('STATUS: done\\nFILES: result.txt\\nCHECK: ok\\nOPEN: none\\n', encoding='utf-8')\n"
    ) if write_report else ""
    preamble = (
        "import io, json, os, sys\n"
        "from pathlib import Path\n"
        "sys.stdout.reconfigure(encoding='utf-8')\n"
        "sys.stderr.reconfigure(encoding='utf-8')\n"
        "args = sys.argv\n"
        "assert '--output-format' in args and args[args.index('--output-format') + 1] == 'json'\n"
        "session_id = args[args.index('--conversation') + 1] if '--conversation' in args else 'agy-conv-1'\n"
        "repo = Path(os.environ['ORCH_REPO'])\n"
        "if os.environ.get('ORCH_STAGE') == 'build':\n"
        "    prompt_arg = args[args.index('-p') + 1]\n"
        "    assert prompt_arg.startswith('Read ') and prompt_arg.endswith(' and follow it exactly.')\n"
        "    prompt = Path(prompt_arg[len('Read '):-len(' and follow it exactly.')]).read_text(encoding='utf-8')\n"
        "    if (repo / 'AGENTS.md').exists():\n"
        "        assert prompt.startswith('First read ')\n"
        "    if '--conversation' in args:\n"
        "        assert 'fix them, rewrite report.md' in prompt.lower()\n"
        "        assert 'implement this task card' not in prompt.lower()\n"
        "    else:\n"
        "        assert 'Implement this task card.' in prompt\n"
        "    sys.stdin = io.StringIO('')\n"
        "else:\n"
        "    prompt = sys.stdin.read()\n"
        "    if (repo / 'AGENTS.md').exists():\n"
        "        assert 'AGENTS.md:' in prompt\n"
        "    sys.stdin = io.StringIO(prompt)\n"
        "old_stdout = sys.stdout\n"
        "captured = io.StringIO()\n"
        "sys.stdout = captured\n"
        "try:\n"
        + report_code +
        "    exec(" + repr(source) + ")\n"
        "except SystemExit as exc:\n"
        "    sys.stdout = old_stdout\n"
        "    if captured.getvalue():\n"
        "        print(captured.getvalue().strip())\n"
        "    raise\n"
        "finally:\n"
        "    sys.stdout = old_stdout\n"
        "out_text = captured.getvalue().strip()\n"
        "print(json.dumps({'conversation_id': session_id, 'response': out_text, 'status': 'completed'}, ensure_ascii=False))\n"
    )
    fake(path, preamble)


def execute(run, repo, codex, agy):
    env = os.environ.copy()
    env.update(ORCH_CODEX=str(codex), ORCH_AGY=str(agy))
    result = subprocess.run([sys.executable, str(SCRIPT), "run", str(run / "card.md")],
                            cwd=repo, env=env, encoding="utf-8", errors="replace", capture_output=True)
    return result


def main():
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        for scenario in (
            "happy", "review", "check", "check_retry", "quota", "lock", "plan", "plan_auto", "status", "timeout",
            "verdict", "agy_resume", "resume_failed", "agents_present", "utf8", "unexpected_error",
            "may_change_disallowed", "untracked_in_review", "dirty_worktree", "branch_not_resume",
            "exit_updates_summary", "report_blocked", "report_missing", "quick_review_skipped",
            "codex_review_effort", "same_card_resume_with_changes", "no_allowlist", "diff_failure",
            "reviewer_mutation", "other_run_disallowed"
        ):
            repo = root / scenario
            builder = "agy" if scenario in ("agy_resume", "agents_present", "utf8", "codex_review_effort") else "codex"
            reviewer = "codex" if scenario in ("agy_resume", "utf8", "codex_review_effort") else "agy"
            tier = "planned" if scenario in ("plan", "plan_auto") else ("quick" if scenario == "quick_review_skipped" else "standard")
            run = setup(repo, builder=builder, reviewer=reviewer,
                        tier=tier,
                        timeout_min="0.02" if scenario == "timeout" else "60")
            codex, agy = repo / "fake-codex.py", repo / "fake-agy.py"
            if scenario == "quota":
                fake_codex(codex, "import os\nif os.environ.get('ORCH_STAGE') == 'build':\n print('RESOURCE_EXHAUSTED')\n raise SystemExit(1)\nif os.environ.get('ORCH_STAGE') == 'review':\n raise RuntimeError('codex called after quota exhaustion!')\nprint('VERDICT: PASS')\n")
            elif scenario == "review":
                fake_codex(codex, "from pathlib import Path\nPath('result.txt').write_text('ok')\n")
            elif scenario == "timeout":
                fake_codex(codex, "import time\ntime.sleep(2.0)\nfrom pathlib import Path\nPath('result.txt').write_text('ok')\n")
            elif scenario == "check_retry":
                fake_codex(codex, "import os, sys\nfrom pathlib import Path\nprompt=sys.stdin.read()\nif os.environ.get('ORCH_STAGE') == 'build':\n Path('result.txt').write_text('ok')\n if 'No review was produced' in prompt: Path('no-review-context').write_text('ok')\n")
            elif scenario == "verdict":
                fake_codex(codex, "import os\nfrom pathlib import Path\nif os.environ.get('ORCH_STAGE') == 'build': Path('result.txt').write_text('ok')\nelse: print('VERDICT: PASS')\n")
            elif scenario in ("plan", "plan_auto"):
                fake_codex(codex, "import os\nfrom pathlib import Path\nPath(os.environ['ORCH_RUN'], 'plan.md').write_text('plan')\nPath('result.txt').write_text('ok')\n")
            elif scenario == "agy_resume":
                fake_codex(codex, "import os\nfrom pathlib import Path\nrun=Path(os.environ['ORCH_RUN'])\np=run/'rev-count'\nn=int(p.read_text())+1 if p.exists() else 1\np.write_text(str(n))\nprint('VERDICT: FAIL' if n == 1 else 'VERDICT: PASS')\n")
            elif scenario == "resume_failed":
                fake_codex(codex, "import os, sys\nfrom pathlib import Path\nargs=sys.argv\nif 'resume' in args and not Path('failed-once').exists():\n Path('failed-once').write_text('1')\n print('session died')\n raise SystemExit(1)\nPath('result.txt').write_text('ok')\n")
            elif scenario == "utf8":
                fake_codex(codex, "print('VERDICT: PASS\\n· review verified 🤖 👍')\n")
            elif scenario == "unexpected_error":
                fake_codex(codex, "import sys\nprint('unhandled error')\nsys.exit(1)\n")
            elif scenario == "may_change_disallowed":
                fake_codex(codex, "from pathlib import Path\nPath('result.txt').write_text('ok')\nPath('unauthorized.txt').write_text('bad')\nprint('VERDICT: PASS')\n")
            elif scenario == "untracked_in_review":
                fake_codex(codex, "from pathlib import Path\nPath('result.txt').write_text('ok untracked')\n")
            elif scenario == "exit_updates_summary":
                (run / "summary.md").write_text("RESULT: PASS\nOLD PASS SUMMARY\n", encoding="utf-8")
                fake_codex(codex, "import sys\nprint('fatal quota error')\nraise SystemExit(1)\n")
            elif scenario == "report_blocked":
                fake_codex(codex, "from pathlib import Path, os\nPath('result.txt').write_text('ok')\nPath(os.environ['ORCH_RUN'], 'report.md').write_text('STATUS: blocked\\nFILES: result.txt\\nCHECK: passed\\nOPEN: waiting on api key\\n', encoding='utf-8')\nprint('VERDICT: PASS')\n")
            elif scenario == "report_missing":
                fake_codex(codex, "from pathlib import Path\nPath('result.txt').write_text('ok')\nprint('VERDICT: PASS')\n", write_report=False)
            elif scenario == "quick_review_skipped":
                fake_codex(codex, "from pathlib import Path\nPath('result.txt').write_text('ok')\n")
            elif scenario == "codex_review_effort":
                (run / "card.md").write_text((run / "card.md").read_text(encoding="utf-8").replace("tier: standard", "tier: standard\nreview_effort: low"), encoding="utf-8")
                fake_codex(codex, "import sys, os\nif os.environ.get('ORCH_STAGE') == 'review':\n assert any('model_reasoning_effort=low' in a for a in sys.argv), 'missing model_reasoning_effort=low in args: ' + str(sys.argv)\nprint('VERDICT: PASS')\n")
            elif scenario == "no_allowlist":
                card_text = (run / "card.md").read_text(encoding="utf-8")
                card_text = card_text.replace("May change: result.txt\n", "")
                card_text = card_text.replace("May change: result.txt", "")
                (run / "card.md").write_text(card_text, encoding="utf-8")
                fake_codex(codex, "from pathlib import Path\nPath('result.txt').write_text('ok')\nprint('VERDICT: PASS')\n")
            elif scenario == "same_card_resume_with_changes":
                base_sha = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True).stdout.strip()
                git(repo, "checkout", "-b", "orch/case", base_sha)
                card_bytes = (run / "card.md").read_bytes()
                card_hash = hashlib.sha256(card_bytes).hexdigest()
                (run / "state.json").write_text(json.dumps({
                    "card_hash": card_hash,
                    "base": base_sha,
                    "created_at": 1000.0,
                    "run_id": "prior-run-id"
                }, indent=2) + "\n", encoding="utf-8")
                (repo / "result.txt").write_text("prior run uncommitted source change\n", encoding="utf-8")
                fake_codex(codex, "from pathlib import Path\nPath('result.txt').write_text('ok')\nprint('VERDICT: PASS')\n")
            elif scenario == "diff_failure":
                base_sha = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True).stdout.strip()
                git(repo, "checkout", "-b", "orch/case", base_sha)
                card_bytes = (run / "card.md").read_bytes()
                card_hash = hashlib.sha256(card_bytes).hexdigest()
                (run / "state.json").write_text(json.dumps({
                    "card_hash": card_hash,
                    "base": "0000000000000000000000000000000000000000",
                    "created_at": 1000.0,
                    "run_id": "prior-run-id"
                }, indent=2) + "\n", encoding="utf-8")
                fake_codex(codex, "from pathlib import Path\nPath('result.txt').write_text('ok')\nprint('VERDICT: PASS')\n")
            elif scenario == "reviewer_mutation":
                fake_codex(codex, "from pathlib import Path\nPath('result.txt').write_text('ok')\n")
            elif scenario == "other_run_disallowed":
                (repo / ".gitignore").write_text("fake-*.py\n", encoding="utf-8")
                git(repo, "commit", "-am", "unignore orchestrate")
                fake_codex(codex, "from pathlib import Path\nPath('result.txt').write_text('ok')\np = Path('.orchestrate', 'other_run', 'stolen.txt')\np.parent.mkdir(parents=True, exist_ok=True)\np.write_text('bad')\n")
            else:
                fake_codex(codex, "from pathlib import Path\nPath('result.txt').write_text('ok')\nprint('VERDICT: PASS')\n")

            if scenario == "plan":
                fake_agy(agy, "import os\nif os.environ.get('ORCH_STAGE') == 'plan_review':\n print('VERDICT: NEEDS_INPUT\\nNeed user input')\nelse:\n print('VERDICT: PASS')\n")
            elif scenario == "review":
                fake_agy(agy, "import os, sys\nfrom pathlib import Path\nrun=Path(os.environ['ORCH_RUN'])\np=run/'review-count'\nn=int(p.read_text())+1 if p.exists() else 1\np.write_text(str(n))\nprint('VERDICT: FAIL' if n == 1 else 'VERDICT: PASS')\nprint('findings')\n")
            elif scenario == "reviewer_mutation":
                fake_agy(agy, "from pathlib import Path\nPath('unauthorized.txt').write_text('bad reviewer mutation')\nprint('VERDICT: PASS')\n")
            elif scenario == "verdict":
                fake_agy(agy, "import os\nfrom pathlib import Path\nrun=Path(os.environ['ORCH_RUN'])\np=run/'review-count'\nn=int(p.read_text())+1 if p.exists() else 1\np.write_text(str(n))\nif n > 2: print('VERDICT: PASS')\n")
            elif scenario == "resume_failed":
                fake_agy(agy, "import os\nfrom pathlib import Path\nrun=Path(os.environ['ORCH_RUN'])\np=run/'review-count'\nn=int(p.read_text())+1 if p.exists() else 1\np.write_text(str(n))\nprint('VERDICT: FAIL' if n == 1 else 'VERDICT: PASS')\n")
            elif scenario == "happy":
                fake_agy(agy, "print('VERDICT: PASS')\n")
            elif scenario == "utf8":
                fake_agy(agy, "from pathlib import Path\nPath('result.txt').write_text('ok')\nprint('· build complete 🚀 🤖 ✨')\n")
            elif scenario == "untracked_in_review":
                fake_agy(agy, "import sys\nprompt = sys.stdin.read()\nassert 'result.txt' in prompt, 'result.txt missing from review prompt'\nprint('VERDICT: PASS')\n")
            elif scenario == "quick_review_skipped":
                fake_agy(agy, "import sys\nsys.exit(99)\n")
            elif scenario == "codex_review_effort":
                fake_agy(agy, "from pathlib import Path\nPath('result.txt').write_text('ok')\n")
            elif scenario == "exit_updates_summary":
                fake_agy(agy, "import sys\nprint('fatal quota error')\nraise SystemExit(1)\n")
            else:
                fake_agy(agy, "from pathlib import Path\nPath('result.txt').write_text('ok')\nprint('VERDICT: PASS')\n")

            if scenario == "agents_present":
                (repo / "AGENTS.md").write_text("# Project rules\n" + "rule\n" * 50, encoding="utf-8")
                git(repo, "add", "AGENTS.md")
                git(repo, "commit", "-m", "agents")

            if scenario == "check":
                (repo / "check.py").write_text("raise SystemExit(1)\n", encoding="utf-8")
                git(repo, "commit", "-am", "fail check")
            if scenario == "check_retry":
                (repo / "check.py").write_text(
                    "from pathlib import Path\np=Path('check-count')\nn=int(p.read_text())+1 if p.exists() else 1\np.write_text(str(n))\nraise SystemExit(1 if n == 1 else 0)\n",
                    encoding="utf-8")
                git(repo, "commit", "-am", "retry check")
                (run / "card.md").write_text((run / "card.md").read_text(encoding="utf-8").replace("May change: result.txt", "May change: result.txt, check-count, no-review-context"), encoding="utf-8")
            if scenario == "resume_failed":
                (run / "card.md").write_text((run / "card.md").read_text(encoding="utf-8").replace("May change: result.txt", "May change: result.txt, failed-once"), encoding="utf-8")
            if scenario == "dirty_worktree":
                (repo / "dirty.txt").write_text("tracked base content\n", encoding="utf-8")
                git(repo, "add", "dirty.txt")
                git(repo, "commit", "-m", "add dirty.txt")
                (repo / "dirty.txt").write_text("uncommitted tracked modification\n", encoding="utf-8")
            if scenario == "branch_not_resume":
                git(repo, "branch", "orch/case")

            if scenario == "lock":
                (run / "summary.md").write_text("RESULT: PASS\nOLD LOCK SUMMARY\nRUN_ID: old-lock-id\n", encoding="utf-8")
                sys.path.insert(0, str(SCRIPT.parent))
                from orchestrate import take_lock, release_lock
                holder = take_lock(repo, "case")
                try:
                    result = execute(run, repo, codex, agy)
                    assert result.returncode == 2 and "lock" in result.stderr.lower()
                    assert (run / "summary.md").exists()
                    lock_sum = (run / "summary.md").read_text(encoding="utf-8")
                    assert "OLD LOCK SUMMARY" not in lock_sum
                    assert "RESULT: ERROR" in lock_sum
                    assert "RUN_ID:" in lock_sum and "old-lock-id" not in lock_sum
                    assert "lock" in lock_sum.lower()
                finally:
                    release_lock(holder)
            elif scenario == "plan":
                result = execute(run, repo, codex, agy)
                assert result.returncode == 2 and (run / "plan.md").exists()
                assert "NEEDS_INPUT" in (run / "summary.md").read_text(encoding="utf-8")
                assert "plan needs input" in (run / "status").read_text(encoding="utf-8")
            elif scenario == "status":
                result = subprocess.run([sys.executable, str(SCRIPT), "status", str(run / "card.md")],
                                        cwd=repo, encoding="utf-8", errors="replace", capture_output=True)
                assert result.returncode == 0 and len(result.stdout.strip().splitlines()) == 1
            else:
                result = execute(run, repo, codex, agy)
                expected = 2 if scenario in ("unexpected_error", "dirty_worktree", "branch_not_resume", "exit_updates_summary", "report_blocked", "diff_failure", "timeout") else (
                    1 if scenario in ("check", "may_change_disallowed", "report_missing", "no_allowlist", "reviewer_mutation", "other_run_disallowed") else 0
                )
                assert result.returncode == expected, (scenario, result.returncode, result.stdout, result.stderr)
                if scenario == "review":
                    assert "ROUNDS: 1" in (run / "summary.md").read_text(encoding="utf-8")
                if scenario == "quota":
                    summary = (run / "summary.md").read_text(encoding="utf-8")
                    assert "same-source" in summary and "FALLBACK:" in summary
                    assert "REVIEWER: agy (gemini-3.8-flash-high, same-source)" in summary
                if scenario == "plan_auto":
                    assert (run / "plan.md").exists()
                    assert (repo / "result.txt").exists()
                    assert "RESULT: PASS" in (run / "summary.md").read_text(encoding="utf-8")
                if scenario == "timeout":
                    summary = (run / "summary.md").read_text(encoding="utf-8")
                    assert "RESULT: TIMEOUT" in summary
                    assert "timeout" in (run / "status").read_text(encoding="utf-8")
                if scenario == "check":
                    assert "ROUNDS: 2" in (run / "summary.md").read_text(encoding="utf-8")
                if scenario == "check_retry":
                    assert "ROUNDS: 1" in (run / "summary.md").read_text(encoding="utf-8")
                    assert (repo / "no-review-context").exists()
                if scenario == "verdict":
                    summary = (run / "summary.md").read_text(encoding="utf-8")
                    assert "ROUNDS: 0" in summary and "invalid verdict" in summary
                if scenario == "happy":
                    assert len((run / "summary.md").read_text(encoding="utf-8").splitlines()) <= 10
                    assert "OPEN: no AGENTS.md" in (run / "summary.md").read_text(encoding="utf-8")
                    assert not (repo / "AGENTS.md").exists()
                    assert (run / "sessions.json").exists()
                if scenario == "agy_resume":
                    assert "ROUNDS: 1" in (run / "summary.md").read_text(encoding="utf-8")
                    sessions = json.loads((run / "sessions.json").read_text(encoding="utf-8"))
                    assert sessions["builder:agy"] == "agy-conv-1"
                    assert sessions["reviewer:codex"] == "codex-thread-1"
                if scenario == "resume_failed":
                    summary = (run / "summary.md").read_text(encoding="utf-8")
                    assert "ROUNDS: 1" in summary
                    assert "resume failed" in summary
                if scenario == "agents_present":
                    summary = (run / "summary.md").read_text(encoding="utf-8")
                    assert "OPEN: none" in summary
                    assert "no AGENTS.md" not in summary
                if scenario == "utf8":
                    summary = (run / "summary.md").read_text(encoding="utf-8")
                    assert "RESULT: PASS" in summary
                    assert "ROUNDS: 0" in summary
                    build_log = (run / "build.log").read_text(encoding="utf-8")
                    assert "🤖" in build_log and "·" in build_log
                    review_log = (run / "review.log").read_text(encoding="utf-8")
                    assert "🤖" in review_log
                if scenario == "unexpected_error":
                    status_text = (run / "status").read_text(encoding="utf-8")
                    assert "error" in status_text
                    summary = (run / "summary.md").read_text(encoding="utf-8")
                    assert "RESULT: ERROR" in summary
                    assert "builder failed" in summary
                if scenario == "may_change_disallowed":
                    summary = (run / "summary.md").read_text(encoding="utf-8")
                    assert "RESULT: FAIL" in summary
                    assert "unauthorized.txt" in summary
                if scenario == "untracked_in_review":
                    summary = (run / "summary.md").read_text(encoding="utf-8")
                    assert "RESULT: PASS" in summary
                    assert "DIFF: result.txt" in summary
                    assert "no changes" not in summary
                if scenario == "dirty_worktree":
                    summary = (run / "summary.md").read_text(encoding="utf-8")
                    assert "RESULT: ERROR" in summary
                    assert "dirty worktree" in summary
                    assert "dirty.txt" in summary
                if scenario == "branch_not_resume":
                    summary = (run / "summary.md").read_text(encoding="utf-8")
                    assert "RESULT: ERROR" in summary
                    assert "already exists" in summary
                if scenario == "exit_updates_summary":
                    summary = (run / "summary.md").read_text(encoding="utf-8")
                    assert "OLD PASS SUMMARY" not in summary
                    assert "OLD PASS SUMMARY" not in result.stdout
                    assert "RUN_ID:" in summary
                if scenario == "report_blocked":
                    summary = (run / "summary.md").read_text(encoding="utf-8")
                    assert "RESULT: BLOCKED" in summary
                    assert "RESULT: PASS" not in summary
                if scenario == "report_missing":
                    summary = (run / "summary.md").read_text(encoding="utf-8")
                    assert "RESULT: FAIL" in summary
                    assert "report.md" in summary
                if scenario == "quick_review_skipped":
                    summary = (run / "summary.md").read_text(encoding="utf-8")
                    assert "RESULT: PASS" in summary
                    assert "review: skipped" in summary.lower()
                if scenario == "codex_review_effort":
                    summary = (run / "summary.md").read_text(encoding="utf-8")
                    assert "RESULT: PASS" in summary
                if scenario == "same_card_resume_with_changes":
                    summary = (run / "summary.md").read_text(encoding="utf-8")
                    assert "RESULT: PASS" in summary
                    assert "dirty worktree" not in summary
                    assert "already exists" not in summary
                    state = json.loads((run / "state.json").read_text(encoding="utf-8"))
                    assert state.get("run_id") != "prior-run-id"
                if scenario == "no_allowlist":
                    summary = (run / "summary.md").read_text(encoding="utf-8")
                    assert "RESULT: FAIL" in summary
                    assert "disallowed files changed: result.txt" in summary
                    assert "result.txt" in summary
                if scenario == "diff_failure":
                    summary = (run / "summary.md").read_text(encoding="utf-8")
                    assert "RESULT: ERROR" in summary
                    assert "git diff failed" in summary
                if scenario == "reviewer_mutation":
                    summary = (run / "summary.md").read_text(encoding="utf-8")
                    assert "RESULT: FAIL" in summary
                    assert "disallowed files changed: unauthorized.txt" in summary
                    assert "unauthorized.txt" in summary
                    assert "RESULT: PASS" not in summary
                if scenario == "other_run_disallowed":
                    summary = (run / "summary.md").read_text(encoding="utf-8")
                    assert "RESULT: FAIL" in summary
                    assert ".orchestrate/other_run/stolen.txt" in summary
                    assert "disallowed files changed" in summary
                    assert "RESULT: PASS" not in summary
    test_get_disallowed_files_direct()
    print("All orchestrator checks passed.")


def test_get_disallowed_files_direct():
    with tempfile.TemporaryDirectory() as temp:
        repo = Path(temp) / "repo"
        repo.mkdir()
        git(repo, "init", "-b", "main")
        git(repo, "config", "user.email", "test@example.com")
        git(repo, "config", "user.name", "Test")
        (repo / "check.py").write_text("ok\n", encoding="utf-8")
        git(repo, "add", "check.py")
        git(repo, "commit", "-m", "init")
        base = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True).stdout.strip()
        run = repo / ".orchestrate" / "case"
        run.mkdir(parents=True)

        sys.path.insert(0, str(SCRIPT.parent))
        from orchestrate import get_disallowed_files

        # 1. No files changed with empty allowlist -> disallowed is []
        assert get_disallowed_files(repo, base, [], run) == []

        # 2. File changed with empty allowlist -> disallowed contains result.txt
        (repo / "result.txt").write_text("mod\n", encoding="utf-8")
        assert get_disallowed_files(repo, base, [], run) == ["result.txt"]

        # 3. File changed with matching allowlist -> allowed ([])
        assert get_disallowed_files(repo, base, ["result.txt"], run) == []

        # 4. File changed with non-matching allowlist -> disallowed (["result.txt"])
        assert get_disallowed_files(repo, base, ["other.txt"], run) == ["result.txt"]

        # 5. Untracked file with empty allowlist -> disallowed
        (repo / "untracked.txt").write_text("new\n", encoding="utf-8")
        assert set(get_disallowed_files(repo, base, [], run)) == {"result.txt", "untracked.txt"}

        # 6. Diff failure raises RuntimeError
        try:
            get_disallowed_files(repo, "0000000000000000000000000000000000000000", ["*"], run)
            assert False, "expected RuntimeError on diff failure"
        except RuntimeError as exc:
            assert "git diff failed" in str(exc)

        # 7. Another run directory under .orchestrate/ is NOT exempted
        (repo / ".orchestrate" / "other_run").mkdir(parents=True, exist_ok=True)
        (repo / ".orchestrate" / "other_run" / "stolen.txt").write_text("other\n", encoding="utf-8")
        assert ".orchestrate/other_run/stolen.txt" in get_disallowed_files(repo, base, ["result.txt"], run)

        # 8. Files inside current run directory ARE exempted
        (run / "local_run_file.txt").write_text("in run\n", encoding="utf-8")
        assert ".orchestrate/case/local_run_file.txt" not in get_disallowed_files(repo, base, ["result.txt"], run)

        # 9. Pre-existing untracked file in untracked_base unchanged -> not in disallowed
        from orchestrate import file_sha256
        (repo / "junk.txt").write_text("junk\n", encoding="utf-8")
        junk_hash = file_sha256(repo / "junk.txt")
        assert "junk.txt" not in get_disallowed_files(repo, base, ["result.txt"], run, untracked_base={"junk.txt": junk_hash})

        # 10. Pre-existing untracked file in untracked_base modified and not in allowlist -> disallowed
        (repo / "junk.txt").write_text("junk modified\n", encoding="utf-8")
        assert "junk.txt" in get_disallowed_files(repo, base, ["result.txt"], run, untracked_base={"junk.txt": junk_hash})

        # 11. Pre-existing untracked file in untracked_base modified and in allowlist -> allowed
        assert "junk.txt" not in get_disallowed_files(repo, base, ["result.txt", "junk.txt"], run, untracked_base={"junk.txt": junk_hash})

        # 12. Pre-existing untracked file restored back to original content -> unstaged, not in disallowed
        (repo / "junk.txt").write_text("junk\n", encoding="utf-8")
        assert "junk.txt" not in get_disallowed_files(repo, base, ["result.txt"], run, untracked_base={"junk.txt": junk_hash})

        # 13. Pre-existing untracked file deleted and not in allowlist -> disallowed
        (repo / "junk.txt").unlink()
        assert "junk.txt" in get_disallowed_files(repo, base, ["result.txt"], run, untracked_base={"junk.txt": junk_hash})

        # 14. Pre-existing untracked file deleted and in allowlist -> allowed
        assert "junk.txt" not in get_disallowed_files(repo, base, ["result.txt", "junk.txt"], run, untracked_base={"junk.txt": junk_hash})


def test_leftover_git_status_and_add_failures():
    sys.path.insert(0, str(SCRIPT.parent))
    from orchestrate import get_status_files, sync_untracked

    # 1. git status failure: corrupt index -> get_status_files raises RuntimeError
    with tempfile.TemporaryDirectory() as temp:
        repo = Path(temp) / "repo"
        repo.mkdir()
        git(repo, "init", "-b", "main")
        git(repo, "config", "user.email", "test@example.com")
        git(repo, "config", "user.name", "Test")
        (repo / "f.txt").write_text("hello", encoding="utf-8")
        git(repo, "add", "f.txt")
        git(repo, "commit", "-m", "init")

        (repo / ".git" / "index").write_bytes(b"corrupt")
        try:
            get_status_files(repo)
            assert False, "expected RuntimeError when git status fails"
        except RuntimeError as exc:
            assert "git status failed" in str(exc)

    # 2. git add -N failure: index.lock exists -> sync_untracked raises RuntimeError
    with tempfile.TemporaryDirectory() as temp:
        repo = Path(temp) / "repo"
        repo.mkdir()
        git(repo, "init", "-b", "main")
        git(repo, "config", "user.email", "test@example.com")
        git(repo, "config", "user.name", "Test")
        (repo / "f.txt").write_text("hello", encoding="utf-8")
        git(repo, "add", "f.txt")
        git(repo, "commit", "-m", "init")
        (repo / "untracked.txt").write_text("untracked", encoding="utf-8")

        (repo / ".git" / "index.lock").write_bytes(b"locked")
        try:
            sync_untracked(repo)
            assert False, "expected RuntimeError when git add -N fails"
        except RuntimeError as exc:
            assert "git add -N failed" in str(exc)


def test_finding_2_windows_locking():
    sys.path.insert(0, str(SCRIPT.parent))
    from orchestrate import take_lock, release_lock

    with tempfile.TemporaryDirectory() as temp:
        repo = Path(temp) / "repo"
        repo.mkdir()

        # 1. Lock acquisition and concurrent conflict
        lock1 = take_lock(repo, "test1")
        try:
            take_lock(repo, "test2")
            assert False, "expected RuntimeError when lock already held"
        except RuntimeError as exc:
            assert "another orchestrate run holds the repository lock" in str(exc)
        finally:
            release_lock(lock1)

        # 2. After release, lock can be acquired again
        lock2 = take_lock(repo, "test2")
        release_lock(lock2)

        # 3. Simulate process crash: child process acquires lock and exits without releasing
        script_dir = str(SCRIPT.parent).replace('\\', '/')
        repo_str = str(repo).replace('\\', '/')
        res = subprocess.run([
            sys.executable, "-c",
            f"import sys; sys.path.insert(0, '{script_dir}'); from orchestrate import take_lock; from pathlib import Path; f = take_lock(Path('{repo_str}'), 'crasher'); sys.exit(0)"
        ], capture_output=True, text=True)
        assert res.returncode == 0

        # OS must have released lock automatically; take_lock must succeed immediately without unlinking or PID check
        lock3 = take_lock(repo, "test3")
        assert (repo / ".orchestrate" / "LOCK").exists()
        release_lock(lock3)


def test_finding_3_check_timeout():
    with tempfile.TemporaryDirectory() as temp:
        repo = Path(temp) / "repo"
        run = setup(repo, builder="codex", reviewer="agy",
                    check=f"{sys.executable} -c \"import time; time.sleep(2.0)\"",
                    timeout_min="0.02")
        codex, agy = repo / "fake-codex.py", repo / "fake-agy.py"
        fake_codex(codex, "from pathlib import Path\nPath('result.txt').write_text('ok')\n")
        fake_agy(agy, "print('VERDICT: PASS')\n")

        result = execute(run, repo, codex, agy)
        assert result.returncode == 2, (result.returncode, result.stdout, result.stderr)
        summary = (run / "summary.md").read_text(encoding="utf-8")
        assert "RESULT: TIMEOUT" in summary
        assert "check timed out" in summary
        assert "TIMEOUT" in (run / "check.log").read_text(encoding="utf-8")


def test_finding_8_quota_detection_and_tracking():
    sys.path.insert(0, str(SCRIPT.parent))
    from orchestrate import is_quota_error

    # 1. returncode 0 is never a quota error even if text contains quota keywords
    assert not is_quota_error(0, "429 Too Many Requests")
    assert not is_quota_error(0, "RESOURCE_EXHAUSTED")

    # 2. returncode != 0 with keyword in last 40 lines is a quota error
    assert is_quota_error(1, "Error: RESOURCE_EXHAUSTED")
    assert is_quota_error(1, "HTTP 429 rate limit exceeded")
    assert is_quota_error(1, "\n".join(["normal line"] * 10 + ["usage limit reached"]))

    # 3. returncode != 0 but keyword is outside last 40 lines is NOT a quota error
    long_output = "Error: 429 quota exhausted\n" + "\n".join([f"line {i}" for i in range(50)])
    assert not is_quota_error(1, long_output)

    # 4. Both providers exhausted in a run -> exit 2 with RESULT: QUOTA
    with tempfile.TemporaryDirectory() as temp:
        repo = Path(temp) / "repo"
        run = setup(repo, builder="codex", reviewer="agy")
        codex, agy = repo / "fake-codex.py", repo / "fake-agy.py"
        fake_codex(codex, "import os\nif os.environ.get('ORCH_STAGE') == 'build':\n print('RESOURCE_EXHAUSTED')\n raise SystemExit(1)\n")
        fake_agy(agy, "import os\nif os.environ.get('ORCH_STAGE') == 'build':\n print('429 rate limit exceeded')\n raise SystemExit(1)\n")
        result = execute(run, repo, codex, agy)
        assert result.returncode == 2
        summary = (run / "summary.md").read_text(encoding="utf-8")
        assert "RESULT: QUOTA" in summary
        assert "quota exhausted" in summary

    # 5. 401 Unauthorized is NOT a quota error
    assert not is_quota_error(1, "401 Unauthorized")
    assert not is_quota_error(1, "HTTP/1.1 401 Unauthorized\nInvalid authentication token")
    assert not is_quota_error(1, "\n".join(["normal line"] * 10 + ["status code 401"]))


def test_finding_13_no_tools_review_material():
    sys.path.insert(0, str(SCRIPT.parent))
    from orchestrate import make_review_material

    with tempfile.TemporaryDirectory() as temp:
        repo = Path(temp) / "repo"
        repo.mkdir()
        run = repo / ".orchestrate" / "case"
        run.mkdir(parents=True)
        card_file = run / "card.md"
        card_file.write_text("---\nname: case\n---\nGoal: test\n", encoding="utf-8")
        card = {"path": card_file}
        diff = "diff --git a/f.txt b/f.txt\n"
        report = run / "report.md"
        report.write_text("STATUS: done\n", encoding="utf-8")
        (run / "check.log").write_text("check ok\n", encoding="utf-8")

        # agy review must include no-tools instruction
        agy_mat = make_review_material(card, run, repo, diff, report, "agy")
        assert "Do NOT use any tools or run commands; everything is in this message." in agy_mat

        # codex review must NOT include no-tools instruction, and state read-only file inspection allowed
        codex_mat = make_review_material(card, run, repo, diff, report, "codex")
        assert "Do NOT use any tools or run commands" not in codex_mat
        assert "You run read-only and may inspect files in the repository." in codex_mat


def test_diffstat_failure_fails_closed():
    sys.path.insert(0, str(SCRIPT.parent))
    import orchestrate

    with tempfile.TemporaryDirectory() as temp:
        repo = Path(temp) / "repo"
        run = setup(repo, builder="codex", reviewer="agy")
        codex, agy = repo / "fake-codex.py", repo / "fake-agy.py"
        fake_codex(codex, "from pathlib import Path\nPath('result.txt').write_text('ok')\n")
        fake_agy(agy, "print('VERDICT: PASS')\n")

        orig_git = orchestrate.git
        def flaky_git(r, *args, **kwargs):
            if "diff" in args and "--stat" in args:
                raise RuntimeError("simulated git diff --stat failure")
            return orig_git(r, *args, **kwargs)

        orchestrate.git = flaky_git
        try:
            card = orchestrate.parse_card(run / "card.md")
            os.environ["ORCH_CODEX"] = str(codex)
            os.environ["ORCH_AGY"] = str(agy)
            ret = orchestrate.run_card(card)
            assert ret == 2, f"expected fail-closed returncode 2, got {ret}"
            summary = (run / "summary.md").read_text(encoding="utf-8")
            assert "RESULT: ERROR" in summary
            assert "simulated git diff --stat failure" in summary
            status = (run / "status").read_text(encoding="utf-8")
            assert "error" in status
            assert "complete" not in status
        finally:
            orchestrate.git = orig_git
            os.environ.pop("ORCH_CODEX", None)
            os.environ.pop("ORCH_AGY", None)


def test_planned_tier_resumes_with_existing_plan():
    with tempfile.TemporaryDirectory() as temp:
        repo = Path(temp) / "repo"
        run = setup(repo, builder="codex", reviewer="agy", tier="planned")
        codex, agy = repo / "fake-codex.py", repo / "fake-agy.py"
        fake_codex(codex, "from pathlib import Path\nPath('result.txt').write_text('ok')\n")

        # 1. Pre-seed plan.md without plan_review.md (e.g. resume or pre-existing plan)
        plan_file = run / "plan.md"
        plan_file.write_text("pre-existing implementation plan\n", encoding="utf-8")
        assert not (run / "plan_review.md").exists()

        # Reviewer must be called for plan_review and can request input
        fake_agy(agy, "import os\nif os.environ.get('ORCH_STAGE') == 'plan_review':\n print('VERDICT: NEEDS_INPUT\\nClarification needed on step 2')\nelse:\n print('VERDICT: PASS')\n")
        result = execute(run, repo, codex, agy)
        assert result.returncode == 2, f"expected returncode 2, got {result.returncode}"
        assert (run / "plan_review.md").exists()
        summary = (run / "summary.md").read_text(encoding="utf-8")
        assert "RESULT: NEEDS_INPUT" in summary
        assert "plan review requested input" in summary
        status = (run / "status").read_text(encoding="utf-8")
        assert "plan needs input" in status

        # 2. Plan is updated and resumed: reviewer approves plan -> proceeds to build and passes
        time.sleep(0.01)
        plan_file.write_text("pre-existing implementation plan - updated with clarification\n", encoding="utf-8")
        fake_agy(agy, "import os\nif os.environ.get('ORCH_STAGE') == 'plan_review':\n print('VERDICT: PASS\\nPlan approved')\nelse:\n print('VERDICT: PASS')\n")
        result2 = execute(run, repo, codex, agy)
        assert result2.returncode == 0, f"expected returncode 0 on resume approval, got {result2.returncode}"
        summary2 = (run / "summary.md").read_text(encoding="utf-8")
        assert "RESULT: PASS" in summary2
        assert (repo / "result.txt").exists()
        status2 = (run / "status").read_text(encoding="utf-8")
        assert "complete" in status2


def test_emit_summary_deadline_expired_skips_git():
    sys.path.insert(0, str(SCRIPT.parent))
    import orchestrate

    with tempfile.TemporaryDirectory() as temp:
        repo = Path(temp) / "repo"
        run = setup(repo, builder="codex", reviewer="agy", timeout_min="0.001")
        codex, agy = repo / "fake-codex.py", repo / "fake-agy.py"
        fake_codex(codex, "import time\ntime.sleep(0.1)\n")
        fake_agy(agy, "print('VERDICT: PASS')\n")

        calls = []
        orig_git = orchestrate.git
        def tracking_git(r, *args, **kwargs):
            calls.append((args, kwargs.get("timeout")))
            return orig_git(r, *args, **kwargs)

        orchestrate.git = tracking_git
        try:
            card = orchestrate.parse_card(run / "card.md")
            os.environ["ORCH_CODEX"] = str(codex)
            os.environ["ORCH_AGY"] = str(agy)
            ret = orchestrate.run_card(card)
            assert ret == 2
            # After deadline expired, git must NOT be called for diff --stat during summary
            diff_stat_calls = [c for c in calls if len(c[0]) > 0 and c[0][0] == "diff" and "--stat" in c[0]]
            assert len(diff_stat_calls) == 0, f"Git diff --stat should have been skipped after deadline expiry, got: {diff_stat_calls}"
            summary = (run / "summary.md").read_text(encoding="utf-8")
            assert "RESULT: TIMEOUT" in summary
        finally:
            orchestrate.git = orig_git
            os.environ.pop("ORCH_CODEX", None)
            os.environ.pop("ORCH_AGY", None)


def test_quota_fallback_skips_exhausted_providers():
    # 1. Build stage: both fake executors report quota -> exit 2, each called at most once per stage
    with tempfile.TemporaryDirectory() as temp:
        repo = Path(temp) / "repo"
        run = setup(repo, builder="codex", reviewer="agy")
        codex, agy = repo / "fake-codex.py", repo / "fake-agy.py"
        fake_codex(codex, (
            "import os\n"
            "with open('codex_calls.log', 'a', encoding='utf-8') as f:\n"
            "    f.write(os.environ.get('ORCH_STAGE', '') + '\\n')\n"
            "print('RESOURCE_EXHAUSTED 429')\n"
            "raise SystemExit(1)\n"
        ))
        fake_agy(agy, (
            "import os\n"
            "with open('agy_calls.log', 'a', encoding='utf-8') as f:\n"
            "    f.write(os.environ.get('ORCH_STAGE', '') + '\\n')\n"
            "print('RESOURCE_EXHAUSTED 429')\n"
            "raise SystemExit(1)\n"
        ))
        result = execute(run, repo, codex, agy)
        assert result.returncode == 2, f"expected returncode 2, got {result.returncode}"
        summary = (run / "summary.md").read_text(encoding="utf-8")
        assert "RESULT: QUOTA" in summary
        assert "both providers out of quota" in summary
        codex_calls = (repo / "codex_calls.log").read_text(encoding="utf-8").splitlines()
        agy_calls = (repo / "agy_calls.log").read_text(encoding="utf-8").splitlines()
        assert codex_calls == ["build"], f"codex should be called exactly once for build, got: {codex_calls}"
        assert agy_calls == ["build"], f"agy should be called exactly once for build, got: {agy_calls}"

    # 2. Plan review stage: builder exhausts in plan, swapped builder succeeds; reviewer exhausts in plan review -> alternate (exhausted builder) is skipped -> exit 2
    with tempfile.TemporaryDirectory() as temp:
        repo = Path(temp) / "repo"
        run = setup(repo, builder="codex", reviewer="agy", tier="planned")
        codex, agy = repo / "fake-codex.py", repo / "fake-agy.py"
        fake_codex(codex, (
            "import os\n"
            "with open('codex_calls.log', 'a', encoding='utf-8') as f:\n"
            "    f.write(os.environ.get('ORCH_STAGE', '') + '\\n')\n"
            "print('RESOURCE_EXHAUSTED 429')\n"
            "raise SystemExit(1)\n"
        ))
        fake_agy(agy, (
            "import os\n"
            "from pathlib import Path\n"
            "stage = os.environ.get('ORCH_STAGE', '')\n"
            "with open('agy_calls.log', 'a', encoding='utf-8') as f:\n"
            "    f.write(stage + '\\n')\n"
            "if stage == 'plan':\n"
            "    Path(os.environ['ORCH_RUN'], 'plan.md').write_text('plan content\\n', encoding='utf-8')\n"
            "    print('plan ok')\n"
            "else:\n"
            "    print('RESOURCE_EXHAUSTED 429')\n"
            "    raise SystemExit(1)\n"
        ))
        result = execute(run, repo, codex, agy)
        assert result.returncode == 2, f"expected returncode 2, got {result.returncode}"
        summary = (run / "summary.md").read_text(encoding="utf-8")
        assert "RESULT: QUOTA" in summary
        assert "both providers out of quota" in summary
        codex_calls = (repo / "codex_calls.log").read_text(encoding="utf-8").splitlines()
        agy_calls = (repo / "agy_calls.log").read_text(encoding="utf-8").splitlines()
        assert codex_calls == ["plan"], f"codex should be called at most once in plan and never in plan_review, got: {codex_calls}"
        assert agy_calls == ["plan", "plan_review"], f"agy should be called at most once per stage, got: {agy_calls}"


def test_untracked_base_regression():
    # 1. Pre-existing untracked junk: run starts and PASSes, junk not in diff/review/summary
    with tempfile.TemporaryDirectory() as temp:
        repo = Path(temp) / "repo"
        run = setup(repo, builder="codex", reviewer="agy")
        codex, agy = repo / "fake-codex.py", repo / "fake-agy.py"

        (repo / "junk.txt").write_text("pre-existing junk\n", encoding="utf-8")
        (repo / "sub").mkdir(parents=True, exist_ok=True)
        (repo / "sub" / "junk2.txt").write_text("nested junk\n", encoding="utf-8")

        fake_codex(codex, "from pathlib import Path\nPath('result.txt').write_text('ok')\n")
        fake_agy(agy, (
            "import sys\n"
            "prompt = sys.stdin.read()\n"
            "assert 'junk.txt' not in prompt, 'junk.txt leaked into review prompt'\n"
            "assert 'junk2.txt' not in prompt, 'junk2.txt leaked into review prompt'\n"
            "assert 'result.txt' in prompt, 'result.txt missing from review prompt'\n"
            "print('VERDICT: PASS')\n"
        ))

        result = execute(run, repo, codex, agy)
        assert result.returncode == 0, f"expected PASS (0), got {result.returncode}: {result.stderr}"
        summary = (run / "summary.md").read_text(encoding="utf-8")
        assert "RESULT: PASS" in summary
        assert "junk" not in summary
        assert "DIFF: result.txt" in summary

        diff_patch = (run / "diff.patch").read_text(encoding="utf-8")
        assert "junk" not in diff_patch
        assert "result.txt" in diff_patch

        state = json.loads((run / "state.json").read_text(encoding="utf-8"))
        assert "junk.txt" in state.get("untracked_base", {})
        assert "sub/junk2.txt" in state.get("untracked_base", {})

    # 2. Pre-existing untracked file modified by builder -> counted
    with tempfile.TemporaryDirectory() as temp:
        repo = Path(temp) / "repo"
        run = setup(repo, builder="codex", reviewer="agy")
        codex, agy = repo / "fake-codex.py", repo / "fake-agy.py"

        (repo / "pre_mod.txt").write_text("pre-existing base content\n", encoding="utf-8")
        (run / "card.md").write_text(
            (run / "card.md").read_text(encoding="utf-8").replace("May change: result.txt", "May change: result.txt, pre_mod.txt"),
            encoding="utf-8"
        )

        fake_codex(codex, (
            "from pathlib import Path\n"
            "Path('result.txt').write_text('ok')\n"
            "Path('pre_mod.txt').write_text('modified by builder\\n')\n"
        ))
        fake_agy(agy, (
            "import sys\n"
            "prompt = sys.stdin.read()\n"
            "assert 'pre_mod.txt' in prompt, 'pre_mod.txt should be in review prompt'\n"
            "assert 'result.txt' in prompt, 'result.txt should be in review prompt'\n"
            "print('VERDICT: PASS')\n"
        ))

        result = execute(run, repo, codex, agy)
        assert result.returncode == 0, f"expected PASS (0), got {result.returncode}: {result.stderr}"
        summary = (run / "summary.md").read_text(encoding="utf-8")
        assert "RESULT: PASS" in summary
        assert "pre_mod.txt" in summary
        diff_patch = (run / "diff.patch").read_text(encoding="utf-8")
        assert "pre_mod.txt" in diff_patch

    # 2b. Pre-existing untracked file modified by builder but not in May change -> counted & disallowed
    with tempfile.TemporaryDirectory() as temp:
        repo = Path(temp) / "repo"
        run = setup(repo, builder="codex", reviewer="agy")
        codex, agy = repo / "fake-codex.py", repo / "fake-agy.py"

        (repo / "unauth_untracked.txt").write_text("pre-existing untracked\n", encoding="utf-8")
        fake_codex(codex, (
            "from pathlib import Path\n"
            "Path('result.txt').write_text('ok')\n"
            "Path('unauth_untracked.txt').write_text('modified unauthorized\\n')\n"
        ))
        fake_agy(agy, "print('VERDICT: PASS')\n")

        result = execute(run, repo, codex, agy)
        assert result.returncode == 1, f"expected FAIL (1), got {result.returncode}"
        summary = (run / "summary.md").read_text(encoding="utf-8")
        assert "RESULT: FAIL" in summary
        assert "disallowed files changed: unauth_untracked.txt" in summary

    # 2c. Pre-existing untracked file deleted by builder -> counted & in review diff/summary
    with tempfile.TemporaryDirectory() as temp:
        repo = Path(temp) / "repo"
        run = setup(repo, builder="codex", reviewer="agy")
        codex, agy = repo / "fake-codex.py", repo / "fake-agy.py"

        (repo / "pre_del.txt").write_text("pre-existing untracked to be deleted\n", encoding="utf-8")
        (run / "card.md").write_text(
            (run / "card.md").read_text(encoding="utf-8").replace("May change: result.txt", "May change: result.txt, pre_del.txt"),
            encoding="utf-8"
        )

        fake_codex(codex, (
            "from pathlib import Path\n"
            "Path('result.txt').write_text('ok')\n"
            "Path('pre_del.txt').unlink()\n"
        ))
        fake_agy(agy, (
            "import sys\n"
            "prompt = sys.stdin.read()\n"
            "assert 'pre_del.txt' in prompt, 'pre_del.txt should be in review prompt'\n"
            "assert 'result.txt' in prompt, 'result.txt should be in review prompt'\n"
            "print('VERDICT: PASS')\n"
        ))

        result = execute(run, repo, codex, agy)
        assert result.returncode == 0, f"expected PASS (0), got {result.returncode}: {result.stderr}"
        summary = (run / "summary.md").read_text(encoding="utf-8")
        assert "RESULT: PASS" in summary
        assert "pre_del.txt" in summary
        diff_patch = (run / "diff.patch").read_text(encoding="utf-8")
        assert "pre_del.txt" in diff_patch

    # 2d. Pre-existing untracked file deleted by builder but not in May change -> disallowed
    with tempfile.TemporaryDirectory() as temp:
        repo = Path(temp) / "repo"
        run = setup(repo, builder="codex", reviewer="agy")
        codex, agy = repo / "fake-codex.py", repo / "fake-agy.py"

        (repo / "pre_del_unauth.txt").write_text("unauthorized deletion target\n", encoding="utf-8")
        fake_codex(codex, (
            "from pathlib import Path\n"
            "Path('result.txt').write_text('ok')\n"
            "p = Path('pre_del_unauth.txt')\n"
            "if p.exists(): p.unlink()\n"
        ))
        fake_agy(agy, "print('VERDICT: PASS')\n")

        result = execute(run, repo, codex, agy)
        assert result.returncode == 1, f"expected FAIL (1), got {result.returncode}"
        summary = (run / "summary.md").read_text(encoding="utf-8")
        assert "RESULT: FAIL" in summary
        assert "disallowed files changed: pre_del_unauth.txt" in summary

    # 3. Tracked modification at start -> refused
    with tempfile.TemporaryDirectory() as temp:
        repo = Path(temp) / "repo"
        run = setup(repo, builder="codex", reviewer="agy")
        codex, agy = repo / "fake-codex.py", repo / "fake-agy.py"
        fake_codex(codex, "from pathlib import Path\nPath('result.txt').write_text('ok')\n")
        fake_agy(agy, "print('VERDICT: PASS')\n")

        # 3a. Unstaged tracked modification
        (repo / "check.py").write_text("# unstaged tracked modification\n", encoding="utf-8")
        result = execute(run, repo, codex, agy)
        assert result.returncode == 2, f"expected ERROR (2), got {result.returncode}"
        summary = (run / "summary.md").read_text(encoding="utf-8")
        assert "RESULT: ERROR" in summary
        assert "dirty worktree" in summary
        assert "check.py" in summary

    with tempfile.TemporaryDirectory() as temp:
        repo = Path(temp) / "repo"
        run = setup(repo, builder="codex", reviewer="agy")
        codex, agy = repo / "fake-codex.py", repo / "fake-agy.py"
        fake_codex(codex, "from pathlib import Path\nPath('result.txt').write_text('ok')\n")
        fake_agy(agy, "print('VERDICT: PASS')\n")

        # 3b. Staged modification at start
        (repo / "staged.txt").write_text("staged file\n", encoding="utf-8")
        git(repo, "add", "staged.txt")
        result = execute(run, repo, codex, agy)
        assert result.returncode == 2, f"expected ERROR (2), got {result.returncode}"
        summary = (run / "summary.md").read_text(encoding="utf-8")
        assert "RESULT: ERROR" in summary
        assert "dirty worktree" in summary
        assert "staged.txt" in summary


if __name__ == "__main__":
    main()
    test_leftover_git_status_and_add_failures()
    test_finding_2_windows_locking()
    test_finding_3_check_timeout()
    test_finding_8_quota_detection_and_tracking()
    test_finding_13_no_tools_review_material()
    test_diffstat_failure_fails_closed()
    test_planned_tier_resumes_with_existing_plan()
    test_emit_summary_deadline_expired_skips_git()
    test_quota_fallback_skips_exhausted_providers()
    test_untracked_base_regression()

