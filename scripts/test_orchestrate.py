"""Contract checks using temporary repositories and local fake executors."""

import json
import os
import subprocess
import sys
import tempfile
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
    (repo / ".gitignore").write_text(".orchestrate/\n", encoding="utf-8")
    git(repo, "add", "check.py", ".gitignore")
    git(repo, "commit", "-m", "base")
    return run


def fake(path, source):
    path.write_text("#!/usr/bin/env python3\n" + source, encoding="utf-8")
    if os.name != "nt":
        path.chmod(0o755)


def fake_codex(path, source):
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


def fake_agy(path, source):
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
        for scenario in ("happy", "review", "check", "check_retry", "quota", "lock", "plan", "status", "timeout", "verdict", "agy_resume", "resume_failed", "agents_present", "utf8", "unexpected_error"):
            repo = root / scenario
            builder = "agy" if scenario in ("agy_resume", "agents_present", "utf8") else "codex"
            reviewer = "codex" if scenario in ("agy_resume", "utf8") else "agy"
            run = setup(repo, builder=builder, reviewer=reviewer,
                        tier="planned" if scenario == "plan" else "standard",
                        timeout_min="1" if scenario == "timeout" else "60")
            codex, agy = repo / "fake-codex.py", repo / "fake-agy.py"
            if scenario == "quota":
                fake_codex(codex, "import os\nif os.environ.get('ORCH_STAGE') == 'build':\n print('RESOURCE_EXHAUSTED')\n raise SystemExit(1)\nprint('VERDICT: PASS')\n")
            elif scenario == "review":
                fake_codex(codex, "from pathlib import Path\nPath('result.txt').write_text('ok')\n")
            elif scenario == "timeout":
                fake_codex(codex, "import time\ntime.sleep(1.2)\nfrom pathlib import Path\nPath('result.txt').write_text('ok')\n")
            elif scenario == "check_retry":
                fake_codex(codex, "import os, sys\nfrom pathlib import Path\nprompt=sys.stdin.read()\nif os.environ.get('ORCH_STAGE') == 'build':\n Path('result.txt').write_text('ok')\n if 'No review was produced' in prompt: Path('no-review-context').write_text('ok')\n")
            elif scenario == "verdict":
                fake_codex(codex, "import os\nfrom pathlib import Path\nif os.environ.get('ORCH_STAGE') == 'build': Path('result.txt').write_text('ok')\nelse: print('VERDICT: PASS')\n")
            elif scenario == "plan":
                fake_codex(codex, "import os\nfrom pathlib import Path\nPath(os.environ['ORCH_RUN'], 'plan.md').write_text('plan')\n")
            elif scenario == "agy_resume":
                fake_codex(codex, "import os\nfrom pathlib import Path\nrun=Path(os.environ['ORCH_RUN'])\np=run/'rev-count'\nn=int(p.read_text())+1 if p.exists() else 1\np.write_text(str(n))\nprint('VERDICT: FAIL' if n == 1 else 'VERDICT: PASS')\n")
            elif scenario == "resume_failed":
                fake_codex(codex, "import os, sys\nfrom pathlib import Path\nargs=sys.argv\nif 'resume' in args and not Path('failed-once').exists():\n Path('failed-once').write_text('1')\n print('session died')\n raise SystemExit(1)\nPath('result.txt').write_text('ok')\n")
            elif scenario == "utf8":
                fake_codex(codex, "print('VERDICT: PASS\\n· review verified 🤖 👍')\n")
            elif scenario == "unexpected_error":
                fake_codex(codex, "import sys\nprint('unhandled error')\nsys.exit(1)\n")
            else:
                fake_codex(codex, "from pathlib import Path\nPath('result.txt').write_text('ok')\nprint('VERDICT: PASS')\n")

            if scenario == "review":
                fake_agy(agy, "import os, sys\nfrom pathlib import Path\nrun=Path(os.environ['ORCH_RUN'])\np=run/'review-count'\nn=int(p.read_text())+1 if p.exists() else 1\np.write_text(str(n))\nprint('VERDICT: FAIL' if n == 1 else 'VERDICT: PASS')\nprint('findings')\n")
            elif scenario == "verdict":
                fake_agy(agy, "import os\nfrom pathlib import Path\nrun=Path(os.environ['ORCH_RUN'])\np=run/'review-count'\nn=int(p.read_text())+1 if p.exists() else 1\np.write_text(str(n))\nif n > 2: print('VERDICT: PASS')\n")
            elif scenario == "resume_failed":
                fake_agy(agy, "import os\nfrom pathlib import Path\nrun=Path(os.environ['ORCH_RUN'])\np=run/'review-count'\nn=int(p.read_text())+1 if p.exists() else 1\np.write_text(str(n))\nprint('VERDICT: FAIL' if n == 1 else 'VERDICT: PASS')\n")
            elif scenario == "happy":
                fake_agy(agy, "print('VERDICT: PASS')\n")
            elif scenario == "utf8":
                fake_agy(agy, "from pathlib import Path\nPath('result.txt').write_text('ok')\nprint('· build complete 🚀 🤖 ✨')\n")
            else:
                fake_agy(agy, "from pathlib import Path\nPath('result.txt').write_text('ok')\nprint('VERDICT: PASS')\n")

            if scenario == "agents_present":
                (repo / "AGENTS.md").write_text("# Project rules\n" + "rule\n" * 50, encoding="utf-8")

            if scenario == "check":
                (repo / "check.py").write_text("raise SystemExit(1)\n", encoding="utf-8")
            if scenario == "check_retry":
                (repo / "check.py").write_text(
                    "from pathlib import Path\np=Path('check-count')\nn=int(p.read_text())+1 if p.exists() else 1\np.write_text(str(n))\nraise SystemExit(1 if n == 1 else 0)\n",
                    encoding="utf-8")
            if scenario == "lock":
                (repo / ".orchestrate" / "LOCK").write_text(f"{os.getpid()} case\n", encoding="utf-8")
                result = execute(run, repo, codex, agy)
                assert result.returncode == 2 and "lock" in result.stderr.lower()
            elif scenario == "plan":
                result = execute(run, repo, codex, agy)
                assert result.returncode == 2 and (run / "plan.md").exists()
            elif scenario == "status":
                result = subprocess.run([sys.executable, str(SCRIPT), "status", str(run / "card.md")],
                                        cwd=repo, encoding="utf-8", errors="replace", capture_output=True)
                assert result.returncode == 0 and len(result.stdout.strip().splitlines()) == 1
            else:
                result = execute(run, repo, codex, agy)
                expected = 2 if scenario == "unexpected_error" else (1 if scenario == "check" else 0)
                assert result.returncode == expected, (scenario, result.returncode, result.stdout, result.stderr)
                if scenario == "review":
                    assert "ROUNDS: 1" in (run / "summary.md").read_text(encoding="utf-8")
                if scenario == "quota":
                    summary = (run / "summary.md").read_text(encoding="utf-8")
                    assert "same-source" in summary and "FALLBACK:" in summary
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
    print("All orchestrator checks passed.")


if __name__ == "__main__":
    main()
