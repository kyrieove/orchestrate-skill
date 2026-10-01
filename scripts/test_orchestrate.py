"""Contract checks using temporary repositories and local fake executors."""

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


def fake_agy(path, source):
    fake(path, "import io, os, sys\nfrom pathlib import Path\nif os.environ.get('ORCH_STAGE') == 'build':\n args=sys.argv\n prompt_arg=args[args.index('-p') + 1]\n assert prompt_arg.startswith('Read ') and prompt_arg.endswith(' and follow it exactly.')\n prompt=Path(prompt_arg[len('Read '):-len(' and follow it exactly.')]).read_text(encoding='utf-8')\n assert 'Implement this task card.' in prompt\n sys.stdin=io.StringIO('')\nelse:\n prompt=sys.stdin.read()\nsys.stdin=io.StringIO(prompt)\n" + source)


def execute(run, repo, codex, agy):
    env = os.environ.copy()
    env.update(ORCH_CODEX=str(codex), ORCH_AGY=str(agy))
    result = subprocess.run([sys.executable, str(SCRIPT), "run", str(run / "card.md")],
                            cwd=repo, env=env, text=True, capture_output=True)
    return result


def main():
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        for scenario in ("happy", "review", "check", "check_retry", "quota", "lock", "plan", "status", "timeout", "verdict"):
            repo = root / scenario
            run = setup(repo, tier="planned" if scenario == "plan" else "standard",
                        timeout_min="1" if scenario == "timeout" else "60")
            codex, agy = repo / "fake-codex.py", repo / "fake-agy.py"
            if scenario == "quota":
                fake(codex, "import os\nif os.environ.get('ORCH_STAGE') == 'build':\n print('RESOURCE_EXHAUSTED')\n raise SystemExit(1)\nprint('VERDICT: PASS')\n")
            elif scenario == "review":
                fake(codex, "from pathlib import Path\nPath('result.txt').write_text('ok')\n")
            elif scenario == "timeout":
                fake(codex, "import time\ntime.sleep(1.2)\nfrom pathlib import Path\nPath('result.txt').write_text('ok')\n")
            elif scenario == "check_retry":
                fake(codex, "import os, sys\nfrom pathlib import Path\nprompt=sys.stdin.read()\nif os.environ.get('ORCH_STAGE') == 'build':\n Path('result.txt').write_text('ok')\n if 'No review was produced' in prompt: Path('no-review-context').write_text('ok')\n")
            elif scenario == "verdict":
                fake(codex, "import os\nfrom pathlib import Path\nif os.environ.get('ORCH_STAGE') == 'build': Path('result.txt').write_text('ok')\nelse: print('VERDICT: PASS')\n")
            elif scenario == "plan":
                fake(codex, "import os\nfrom pathlib import Path\nPath(os.environ['ORCH_RUN'], 'plan.md').write_text('plan')\n")
            else:
                fake(codex, "from pathlib import Path\nPath('result.txt').write_text('ok')\n")
            if scenario == "review":
                fake_agy(agy, "import os, sys\nfrom pathlib import Path\nrun=Path(os.environ['ORCH_RUN'])\np=run/'review-count'\nn=int(p.read_text())+1 if p.exists() else 1\np.write_text(str(n))\nprint('VERDICT: FAIL' if n == 1 else 'VERDICT: PASS')\nprint('findings')\n")
            elif scenario == "verdict":
                fake_agy(agy, "import os\nfrom pathlib import Path\nrun=Path(os.environ['ORCH_RUN'])\np=run/'review-count'\nn=int(p.read_text())+1 if p.exists() else 1\np.write_text(str(n))\nif n > 2: print('VERDICT: PASS')\n")
            elif scenario == "happy":
                fake_agy(agy, "print('VERDICT: PASS')\n")
            else:
                fake_agy(agy, "from pathlib import Path\nPath('result.txt').write_text('ok')\nprint('VERDICT: PASS')\n")
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
                                        cwd=repo, text=True, capture_output=True)
                assert result.returncode == 0 and len(result.stdout.strip().splitlines()) == 1
            else:
                result = execute(run, repo, codex, agy)
                expected = 1 if scenario == "check" else 0
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
    print("All orchestrator checks passed.")


if __name__ == "__main__":
    main()
