#!/usr/bin/env python3
"""Run a task card through its configured builder, check, and reviewer."""

import fnmatch
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path


QUOTA = re.compile(r"429|RESOURCE_EXHAUSTED|quota|rate.?limit|usage limit|401", re.I)


def git(repo, *args, check=True):
    result = subprocess.run(["git", *args], cwd=repo, encoding="utf-8", errors="replace", capture_output=True)
    if check and result.returncode:
        raise RuntimeError(result.stderr.strip() or "git command failed")
    return result


def parse_card(path):
    lines = path.read_text(encoding="utf-8").splitlines()
    if not lines or lines[0].strip() != "---":
        raise ValueError("card must start with YAML front matter")
    try:
        end = lines.index("---", 1)
    except ValueError:
        raise ValueError("card front matter is not closed")
    values = {"tier": "standard", "timeout_min": "60"}
    for line in lines[1:end]:
        line = line.split("#", 1)[0].strip()
        if ":" in line:
            key, value = line.split(":", 1)
            values[key.strip()] = value.strip().strip("'\"")
    values["body"] = "\n".join(lines[end + 1:]).strip()
    values["path"] = path.resolve()
    values["run"] = path.resolve().parent
    may_change = []
    for line in values["body"].splitlines():
        line = line.strip()
        m = re.match(r"^May change:\s*(.*)$", line, re.IGNORECASE)
        if m:
            for item in m.group(1).split(","):
                item = item.strip()
                if item:
                    may_change.append(item)
    values["may_change"] = may_change
    for key in ("name", "builder", "reviewer", "check"):
        if not values.get(key):
            raise ValueError("card is missing " + key)
    if values["builder"] not in ("codex", "agy") or values["reviewer"] not in ("codex", "agy"):
        raise ValueError("builder and reviewer must be codex or agy")
    return values


def alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except (ValueError, ProcessLookupError):
        return False
    except PermissionError:
        return True
    except OSError:
        return False


def take_lock(repo, name):
    lock = repo / ".orchestrate" / "LOCK"
    lock.parent.mkdir(parents=True, exist_ok=True)
    for _ in range(2):
        try:
            with lock.open("x", encoding="utf-8") as f:
                f.write(f"{os.getpid()} {name}\n")
            return lock
        except FileExistsError:
            try:
                parts = lock.read_text(encoding="utf-8").split(maxsplit=1)
                pid = parts[0]
            except (OSError, IndexError):
                pid = ""
            if alive(pid):
                raise RuntimeError("another orchestrate run holds the repository lock")
            try:
                lock.unlink()
            except FileNotFoundError:
                pass
    raise RuntimeError("could not acquire repository lock")


def status_write(card, started, stage, round_no, executor):
    mins = int((time.time() - started) // 60)
    (card["run"] / "status").write_text(f"{card['name']} · {stage} r{round_no} · {executor} · {mins} min\n", encoding="utf-8")


def load_sessions(run):
    path = run / "sessions.json"
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def get_session(run, role, executor):
    return load_sessions(run).get(f"{role}:{executor}")


def save_session(run, role, executor, session_id):
    if not session_id:
        return
    sessions = load_sessions(run)
    sessions[f"{role}:{executor}"] = session_id
    (run / "sessions.json").write_text(json.dumps(sessions, indent=2) + "\n", encoding="utf-8")


def clear_session(run, role, executor):
    sessions = load_sessions(run)
    if sessions.pop(f"{role}:{executor}", None) is not None:
        (run / "sessions.json").write_text(json.dumps(sessions, indent=2) + "\n", encoding="utf-8")


def get_open_items(run, repo):
    items = "none"
    report_file = run / "report.md"
    if report_file.exists():
        for line in report_file.read_text(encoding="utf-8").splitlines():
            if line.startswith("OPEN:"):
                items = line.partition(":")[2].strip()
    if not (repo / "AGENTS.md").exists():
        if not items or items == "none":
            return "no AGENTS.md"
        if "no AGENTS.md" not in items:
            return f"no AGENTS.md; {items}"
        return items
    return items or "none"


def get_status_files(repo):
    res = git(repo, "status", "--porcelain", "-uall", "-z", check=False)
    if res.returncode != 0:
        return []
    raw = res.stdout
    entries = raw.split("\0")
    items = []
    i = 0
    while i < len(entries):
        entry = entries[i]
        if not entry:
            i += 1
            continue
        status = entry[:2]
        path = entry[3:]
        if status[0] in ("R", "C") or status[1] in ("R", "C"):
            if i + 1 < len(entries):
                path = entries[i + 1]
                i += 2
                items.append((status, path))
                continue
        items.append((status, path))
        i += 1
    return items


def is_orchestrate_path(path):
    p = path.replace("\\", "/")
    return p == ".orchestrate" or p.startswith(".orchestrate/")


def sync_untracked(repo, run_dir=None):
    run_rel = os.path.relpath(run_dir, repo).replace("\\", "/") if run_dir else None
    for status, path in get_status_files(repo):
        p = path.replace("\\", "/")
        if status == "??":
            if p == ".orchestrate" or p == ".orchestrate/LOCK":
                continue
            if run_rel and (p == run_rel or p.startswith(run_rel + "/")):
                continue
            git(repo, "add", "-N", "--", path, check=False)


def file_matches_any(path_str, patterns):
    p = Path(path_str)
    for pat in patterns:
        pat_clean = pat.replace("\\", "/").strip()
        if not pat_clean:
            continue
        if path_str == pat_clean:
            return True
        if fnmatch.fnmatch(path_str, pat_clean):
            return True
        try:
            if p.match(pat_clean):
                return True
        except Exception:
            pass
    return False


def get_disallowed_files(repo, base, may_change_globs, run_dir):
    sync_untracked(repo, run_dir)
    res = git(repo, "diff", "--name-only", base, check=False)
    if res.returncode != 0:
        raise RuntimeError("git diff failed: " + (res.stderr.strip() or "exit code " + str(res.returncode)))
    changed = [line.strip().replace("\\", "/") for line in res.stdout.splitlines() if line.strip()]
    run_rel = os.path.relpath(run_dir, repo).replace("\\", "/")
    disallowed = []
    for f in changed:
        if f == run_rel or f.startswith(run_rel + "/"):
            continue
        if f == ".orchestrate" or f == ".orchestrate/LOCK":
            continue
        if not file_matches_any(f, may_change_globs):
            disallowed.append(f)
    return disallowed


def get_report_status(run):
    report_file = run / "report.md"
    if not report_file.exists():
        return None
    for line in report_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.upper().startswith("STATUS:"):
            return line.split(":", 1)[1].strip().lower()
    return None


def executor_path(kind):
    override = os.environ.get("ORCH_CODEX" if kind == "codex" else "ORCH_AGY")
    if override:
        return override
    if kind == "agy":
        return r"C:/Users/ASUS/AppData/Local/agy/bin/agy.exe"
    return shutil.which("codex") or "codex"


def call(kind, stage, prompt, repo, run, output_file=None, model=None, timeout=60, session_id=None, role=None, effort=None):
    exe = executor_path(kind)
    command = [sys.executable, exe] if exe.lower().endswith(".py") else [exe]
    env = os.environ.copy()
    env["ORCH_STAGE"] = stage
    env["ORCH_REPO"] = str(repo)
    env["ORCH_RUN"] = str(run)
    if kind == "codex":
        reasoning_effort = effort or ("high" if stage == "build" else "medium")
        if session_id:
            argv = command + ["exec", "resume", session_id, "-c", f"model_reasoning_effort={reasoning_effort}", "-m", model or "gpt-6-luna"]
            if output_file:
                argv += ["-o", str(output_file)]
            argv += ["-"]
        else:
            argv = command + ["exec", "--json"]
            if stage == "build":
                argv += ["--approve-for-me", "-m", model or "gpt-6-luna", "-c", f"model_reasoning_effort={reasoning_effort}"]
            else:
                argv += ["-s", "read-only", "-m", model or "gpt-6-luna", "-c", f"model_reasoning_effort={reasoning_effort}"]
            argv += ["-C", str(repo)]
            if output_file:
                argv += ["-o", str(output_file)]
            argv += ["-"]
        if os.name == "nt" and exe.lower().endswith((".cmd", ".bat")):
            argv = [os.environ.get("COMSPEC", "cmd.exe"), "/c", *argv]
    elif stage == "build":
        prompt_file = run / "prompt_build.md"
        agents_file = repo / "AGENTS.md"
        if agents_file.exists():
            prefix = f"First read {agents_file.resolve()}\n\n"
            if not prompt.startswith("First read "):
                prompt = prefix + prompt
        prompt_file.write_text(prompt, encoding="utf-8")
        argv = command
        if session_id:
            argv = argv + ["--conversation", session_id]
        argv = argv + ["-p", f"Read {prompt_file.resolve()} and follow it exactly.", "--model", "gemini-3.8-flash-high", "--dangerously-skip-permissions", "--output-format", "json"]
    else:
        argv = command
        if session_id:
            argv = argv + ["--conversation", session_id]
        argv = argv + ["--model", "gemini-3.8-flash-high", "--output-format", "json"]
    try:
        result = subprocess.run(argv, cwd=repo, input=None if kind == "agy" and stage == "build" else prompt,
                                encoding="utf-8", errors="replace", capture_output=True,
                                timeout=timeout, env=env, shell=False)
        with (run / (stage + ".log")).open("a", encoding="utf-8") as log:
            log.write((result.stdout or "") + (result.stderr or ""))

        new_session_id = session_id
        effective_output = ""
        if kind == "agy":
            try:
                data = json.loads(result.stdout)
                if isinstance(data, dict):
                    new_session_id = data.get("conversation_id") or new_session_id
                    effective_output = data.get("response", "")
            except Exception:
                m = re.search(r'"conversation_id"\s*:\s*"([^"]+)"', result.stdout)
                if m:
                    new_session_id = m.group(1)
                m_resp = re.search(r'"response"\s*:\s*"((?:[^"\\]|\\.)*)"', result.stdout)
                if m_resp:
                    try:
                        effective_output = json.loads(f'"{m_resp.group(1)}"')
                    except Exception:
                        effective_output = m_resp.group(1)
            if not effective_output or result.returncode != 0:
                if not effective_output:
                    effective_output = result.stdout
            if output_file and result.returncode == 0:
                output_file.write_text(effective_output, encoding="utf-8")
        elif kind == "codex":
            if not session_id:
                for line in result.stdout.splitlines():
                    try:
                        data = json.loads(line.strip())
                        if isinstance(data, dict) and "thread_id" in data:
                            new_session_id = data["thread_id"]
                            break
                    except Exception:
                        pass
                if not new_session_id:
                    m = re.search(r'"thread_id"\s*:\s*"([^"]+)"', result.stdout)
                    if m:
                        new_session_id = m.group(1)
            if output_file and output_file.exists():
                effective_output = output_file.read_text(encoding="utf-8")
            else:
                effective_output = result.stdout
                if output_file and result.returncode == 0:
                    output_file.write_text(effective_output, encoding="utf-8")
        else:
            effective_output = result.stdout
            if output_file and not output_file.exists():
                output_file.write_text(effective_output, encoding="utf-8")

        if role and new_session_id and result.returncode == 0:
            save_session(run, role, kind, new_session_id)

        output_text = effective_output
        if result.returncode != 0:
            if result.stdout and result.stdout not in output_text:
                output_text += "\n" + result.stdout
            if result.stderr:
                output_text += "\n" + result.stderr
        elif result.stderr:
            output_text += "\n" + result.stderr

        return result.returncode, output_text
    except subprocess.TimeoutExpired as exc:
        with (run / (stage + ".log")).open("a", encoding="utf-8") as log:
            log.write("\nTIMEOUT\n")
        raise TimeoutError(stage + " timed out") from exc


def summary(run, result, builder, reviewer, rounds, diffstat, check_result, open_items, fallback, run_id=None, quick=False):
    diff_lines = diffstat.strip().splitlines()
    diff_summary = " | ".join(diff_lines[:3]) if diff_lines else "no changes"
    reviewer_val = "skipped" if quick else (reviewer + (" (same-source)" if builder == reviewer else ""))
    lines = [
        "RESULT: " + result,
        "BUILDER: " + builder,
        "REVIEWER: " + reviewer_val,
    ]
    if quick:
        lines.append("REVIEW: skipped")
    lines.extend([
        "ROUNDS: " + str(rounds),
        "DIFF: " + diff_summary,
        "CHECK: " + check_result,
        "OPEN: " + (open_items or "none"),
    ])
    if run_id:
        lines.append("RUN_ID: " + str(run_id))
    if fallback:
        lines.append("FALLBACK: " + "; ".join(fallback))
    content = "\n".join(lines) + "\n"
    (run / "summary.md").write_text(content, encoding="utf-8")
    return content


def valid_verdict(run):
    path = run / "review.md"
    if not path.exists():
        return False
    lines = path.read_text(encoding="utf-8").splitlines()
    return bool(lines and lines[0] in ("VERDICT: PASS", "VERDICT: FAIL"))


def make_review_material(card, run, repo, diff, report, actual_reviewer):
    material_parts = [
        "Do NOT use any tools or run commands; everything is in this message.",
        "Card content:",
        card["path"].read_text(encoding="utf-8"),
    ]
    if actual_reviewer == "agy" and (repo / "AGENTS.md").exists():
        agents_200 = "\n".join((repo / "AGENTS.md").read_text(encoding="utf-8").splitlines()[:200])
        material_parts += ["AGENTS.md:", agents_200]
    material_parts += [
        f"Diff:\n{diff}",
        "Check log tail:",
        "\n".join((run / "check.log").read_text(encoding="utf-8").splitlines()[-40:]),
        "Report:",
        report.read_text(encoding="utf-8") if report.exists() else "missing",
        "Write review.md. First line must be exactly VERDICT: PASS or VERDICT: FAIL, then findings."
    ]
    return "\n".join(material_parts)


def swap_executor(stage, executor, other, prompt, repo, run, fallback, reason, same_source=False, timeout=60, effort=None):
    fallback.append(f"{executor} {stage} {reason}; switched to {other}")
    actual = "codex" if stage == "review" and same_source else other
    model = "gpt-6-astra" if stage == "review" and same_source else None
    output_file = run / "codex_last.txt" if stage == "build" and actual == "codex" else None
    if stage == "review" and actual == "codex":
        output_file = run / "review.md"
    role = "builder" if stage == "build" else "reviewer"
    clear_session(run, role, actual)
    code, output = call(actual, stage, prompt, repo, run, output_file, model=model, timeout=timeout, session_id=None, role=role, effort=effort)
    return actual, code, output, same_source


def run_card(card, quick=False):
    run = card["run"]
    started = time.time()
    run_id = f"{int(started)}-{os.getpid()}"
    if (run / "summary.md").exists():
        (run / "summary.md").unlink()

    builder, reviewer = card["builder"], card["reviewer"]
    rounds = 0
    fallback = []
    check_result = "not run"
    base = ""
    is_quick = bool(quick or card.get("tier") == "quick")
    review_effort = card.get("review_effort") or "medium"
    repo = None
    lock = None

    def emit_summary(result_str, extra_fallback=None):
        stat = ""
        if repo and base:
            try:
                sync_untracked(repo, run)
                stat = git(repo, "diff", "--stat", base, check=False).stdout
            except Exception:
                pass
        items = get_open_items(run, repo) if repo else "none"
        fb = list(fallback)
        if extra_fallback:
            fb.append(extra_fallback)
        return summary(run, result_str, builder, reviewer, rounds, stat, check_result, items, fb,
                       run_id=run_id, quick=is_quick)

    try:
        repo_result = git(run, "rev-parse", "--show-toplevel", check=False)
        if repo_result.returncode:
            raise RuntimeError("task card is not inside a git repository")
        repo = Path(repo_result.stdout.strip())
        try:
            lock = take_lock(repo, card["name"])
        except Exception as exc:
            print(str(exc), file=sys.stderr)
            emit_summary("ERROR", f"error: {exc}")
            return 2

        (run / "started").write_text(str(started), encoding="utf-8")

        head_sha = git(repo, "rev-parse", "HEAD").stdout.strip()
        branch = "orch/" + card["name"]
        card_bytes = card["path"].read_bytes()
        card_hash = hashlib.sha256(card_bytes).hexdigest()
        state_file = run / "state.json"
        existing = git(repo, "show-ref", "--verify", "--quiet", "refs/heads/" + branch, check=False)
        is_resume = False
        stored_base = None
        state = {}

        if existing.returncode == 0:
            if state_file.exists():
                try:
                    state = json.loads(state_file.read_text(encoding="utf-8"))
                    if state.get("card_hash") == card_hash:
                        is_resume = True
                        stored_base = state.get("base")
                except Exception:
                    state = {}
            if not is_resume:
                reason = f"branch {branch} already exists and is not this run's resume"
                status_write(card, started, "error", 0, builder)
                emit_summary("ERROR", reason)
                return 2

        if not is_resume:
            dirty_files = [p for s, p in get_status_files(repo) if not is_orchestrate_path(p)]
            if dirty_files:
                reason = f"dirty worktree: {', '.join(dirty_files)}"
                status_write(card, started, "error", 0, builder)
                emit_summary("ERROR", reason)
                return 2
            base = head_sha
            git(repo, "checkout", "-b", branch, base)
            state = {
                "card_hash": card_hash,
                "base": base,
                "created_at": started,
                "run_id": run_id,
            }
            state_file.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
        else:
            base = stored_base or head_sha
            curr_branch = git(repo, "branch", "--show-current", check=False).stdout.strip()
            if curr_branch != branch:
                git(repo, "checkout", branch)
            state["run_id"] = run_id
            state_file.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")

        used = set()
        same_source = False
        plan = run / "plan.md"
        if card["tier"] == "planned" and not plan.exists():
            status_write(card, started, "plan", 0, "codex")
            prompt = f"Read the task card at {card['path']} and write a concise implementation plan to {plan}. Do not modify source files."
            try:
                code, output = call("codex", "plan", prompt, repo, run, plan,
                                    timeout=int(card["timeout_min"]) * 60,
                                    effort=review_effort)
            except TimeoutError:
                status_write(card, started, "timeout", 0, "codex")
                emit_summary("TIMEOUT", "plan timed out")
                return 2
            if code and not plan.exists():
                if QUOTA.search(output):
                    status_write(card, started, "quota", 0, "codex")
                    emit_summary("QUOTA", "plan quota exhausted")
                    return 2
                raise RuntimeError("codex plan failed")
            if not plan.exists():
                plan.write_text(output, encoding="utf-8")
            status_write(card, started, "plan ready", 0, "codex")
            emit_summary("PLAN_READY", "plan ready")
            return 2

        for round_no in range(3):
            rounds = round_no
            status_write(card, started, "build", round_no, builder)
            context = ["Implement this task card. Full card content follows:", card["body"],
                       "Card front matter:", card["path"].read_text(encoding="utf-8").split("---", 2)[1],
                       "Work only on files allowed by the card. Do not commit.",
                       f"Before finishing, write {run / 'report.md'} in exactly this shape (4 lines):",
                       "STATUS: done|blocked", "FILES: ...", "CHECK: <what you ran, result>", "OPEN: ..."]
            if plan.exists():
                context += ["Plan:", plan.read_text(encoding="utf-8")]
            review = run / "review.md"
            check_log = run / "check.log"
            if round_no:
                findings_text = review.read_text(encoding="utf-8") if review.exists() else (
                    "No review was produced; the previous check failed.\n" +
                    ("\n".join(check_log.read_text(encoding="utf-8").splitlines()[-40:]) if check_log.exists() else "missing")
                )
                full_prompt = "\n".join(context + [
                    "Fix the previous findings. Previous review:",
                    review.read_text(encoding="utf-8") if review.exists() else "No review was produced; the previous check failed.",
                    "Previous check log:", check_log.read_text(encoding="utf-8") if check_log.exists() else "missing"
                ])
                short_prompt = f"{findings_text}\n\nFix them, rewrite report.md."
            else:
                full_prompt = "\n".join(context)
                short_prompt = full_prompt

            builder_session = get_session(run, "builder", builder) if round_no else None
            prompt = short_prompt if builder_session else full_prompt
            if (run / "report.md").exists():
                (run / "report.md").unlink()
            try:
                code, output = call(builder, "build", prompt, repo, run,
                                    run / "codex_last.txt" if builder == "codex" else None,
                                    timeout=int(card["timeout_min"]) * 60,
                                    session_id=builder_session, role="builder")
            except TimeoutError:
                status_write(card, started, "timeout", round_no, builder)
                emit_summary("TIMEOUT", "build timed out")
                return 2

            if builder_session and code and not QUOTA.search(output):
                fallback.append(f"{builder} build resume failed; retried fresh")
                clear_session(run, "builder", builder)
                try:
                    code, output = call(builder, "build", full_prompt, repo, run,
                                        run / "codex_last.txt" if builder == "codex" else None,
                                        timeout=int(card["timeout_min"]) * 60,
                                        session_id=None, role="builder")
                except TimeoutError:
                    status_write(card, started, "timeout", round_no, builder)
                    emit_summary("TIMEOUT", "build timed out")
                    return 2

            used.add(builder)
            if code and QUOTA.search(output):
                other = "agy" if builder == "codex" else "codex"
                old_builder = builder
                builder = other
                same_source = same_source or builder == reviewer
                try:
                    _, code, output, _ = swap_executor("build", old_builder, builder, full_prompt, repo, run,
                                                       fallback, "quota", same_source,
                                                       int(card["timeout_min"]) * 60)
                except TimeoutError:
                    status_write(card, started, "timeout", round_no, builder)
                    emit_summary("TIMEOUT", "build timed out")
                    return 2
                used.add(builder)
            if code:
                if QUOTA.search(output):
                    status_write(card, started, "quota", round_no, builder)
                    emit_summary("QUOTA", "builder quota exhausted")
                    return 2
                raise RuntimeError("builder failed")

            status_write(card, started, "check", round_no, builder)
            check = subprocess.run(card["check"], cwd=repo, shell=True, encoding="utf-8", errors="replace", capture_output=True)
            check_result = "passed" if check.returncode == 0 else f"failed (exit {check.returncode})"
            (run / "check.log").write_text((check.stdout or "") + (check.stderr or ""), encoding="utf-8")
            passed = check.returncode == 0
            if not passed:
                try:
                    (run / "review.md").unlink()
                except FileNotFoundError:
                    pass

            if passed:
                report_status = get_report_status(run)
                if report_status == "blocked":
                    status_write(card, started, "blocked", round_no, builder)
                    emit_summary("BLOCKED", "builder reported blocked")
                    return 2
                if report_status != "done":
                    passed = False
                    fallback.append(f"report.md status is {report_status or 'missing'} (expected 'done')")

            if passed:
                disallowed = get_disallowed_files(repo, base, card.get("may_change", []), run)
                if disallowed:
                    passed = False
                    msg = f"disallowed files changed: {', '.join(disallowed)}"
                    fallback.append(msg)

            if passed and not is_quick:
                actual_reviewer = "codex" if same_source else reviewer
                status_write(card, started, "review", round_no, actual_reviewer)
                sync_untracked(repo, run)
                diff = git(repo, "diff", base).stdout
                (run / "diff.patch").write_text(diff, encoding="utf-8")
                report = run / "report.md"
                material = make_review_material(card, run, repo, diff, report, actual_reviewer)
                try:
                    (run / "review.md").unlink()
                except FileNotFoundError:
                    pass
                review_model = "gpt-6-astra" if same_source else "gpt-6-luna"
                rev_session = get_session(run, "reviewer", actual_reviewer)
                try:
                    rc, review_out = call(actual_reviewer, "review", material, repo, run,
                                          run / "review.md",
                                          model=review_model, timeout=int(card["timeout_min"]) * 60,
                                          session_id=rev_session, role="reviewer",
                                          effort=review_effort)
                except TimeoutError:
                    status_write(card, started, "timeout", round_no, actual_reviewer)
                    emit_summary("TIMEOUT", "review timed out")
                    return 2
                used.add(actual_reviewer)

                if rev_session and rc and not QUOTA.search(review_out):
                    fallback.append(f"{actual_reviewer} review resume failed; retried fresh")
                    clear_session(run, "reviewer", actual_reviewer)
                    try:
                        (run / "review.md").unlink()
                    except FileNotFoundError:
                        pass
                    try:
                        rc, review_out = call(actual_reviewer, "review", material, repo, run,
                                              run / "review.md",
                                              model=review_model, timeout=int(card["timeout_min"]) * 60,
                                              session_id=None, role="reviewer",
                                              effort=review_effort)
                    except TimeoutError:
                        status_write(card, started, "timeout", round_no, actual_reviewer)
                        emit_summary("TIMEOUT", "review timed out")
                        return 2

                if not rc and not valid_verdict(run):
                    try:
                        (run / "review.md").unlink()
                    except FileNotFoundError:
                        pass
                    try:
                        rc, review_out = call(actual_reviewer, "review", material,
                                              repo, run, run / "review.md", model=review_model,
                                              timeout=int(card["timeout_min"]) * 60,
                                              session_id=get_session(run, "reviewer", actual_reviewer), role="reviewer",
                                              effort=review_effort)
                    except TimeoutError:
                        status_write(card, started, "timeout", round_no, actual_reviewer)
                        emit_summary("TIMEOUT", "review timed out")
                        return 2
                if (rc and QUOTA.search(review_out)) or (not rc and not valid_verdict(run)):
                    other = "agy" if actual_reviewer == "codex" else "codex"
                    old_reviewer = actual_reviewer
                    reviewer = other
                    same_source = reviewer == builder
                    try:
                        (run / "review.md").unlink()
                    except FileNotFoundError:
                        pass
                    swap_target = "codex" if same_source else reviewer
                    swap_material = make_review_material(card, run, repo, diff, report, swap_target)
                    try:
                        actual_reviewer, rc, review_out, same_source = swap_executor(
                            "review", old_reviewer, reviewer, swap_material, repo, run, fallback,
                            "quota" if QUOTA.search(review_out) else "invalid verdict", same_source,
                            int(card["timeout_min"]) * 60, effort=review_effort)
                    except TimeoutError:
                        status_write(card, started, "timeout", round_no, reviewer)
                        emit_summary("TIMEOUT", "review timed out")
                        return 2
                    used.add("codex" if same_source else reviewer)
                if rc and QUOTA.search(review_out):
                    status_write(card, started, "quota", round_no, reviewer)
                    emit_summary("QUOTA", "reviewer quota exhausted")
                    return 2
                if rc:
                    raise RuntimeError("reviewer failed")
                verdict_file = run / "review.md"
                if not verdict_file.exists():
                    verdict_file.write_text(review_out, encoding="utf-8")
                verdict = verdict_file.read_text(encoding="utf-8").splitlines()[0:1]
                if not verdict or verdict[0] not in ("VERDICT: PASS", "VERDICT: FAIL"):
                    status_write(card, started, "reviewer failure", round_no, actual_reviewer)
                    emit_summary("ERROR", "invalid reviewer verdict")
                    return 2
                passed = verdict[0] == "VERDICT: PASS"

            if passed:
                disallowed = get_disallowed_files(repo, base, card.get("may_change", []), run)
                if disallowed:
                    passed = False
                    msg = f"disallowed files changed: {', '.join(disallowed)}"
                    fallback.append(msg)

            if passed:
                emit_summary("PASS")
                status_write(card, started, "complete", round_no, builder)
                return 0
            if round_no == 2:
                break

        emit_summary("FAIL")
        status_write(card, started, "failed", rounds, builder)
        return 1
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        status_write(card, started, "error", rounds, builder)
        emit_summary("ERROR", f"error: {exc}")
        return 2
    finally:
        if lock is not None:
            try:
                lock.unlink()
            except FileNotFoundError:
                pass


def main(argv=None):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    argv = list(sys.argv[1:] if argv is None else argv)
    if len(argv) < 2 or argv[0] not in ("run", "status"):
        print("usage: orchestrate.py run <card.md> [--quick] | status <card.md>", file=sys.stderr)
        return 2
    try:
        card = parse_card(Path(argv[1]))
        if argv[0] == "status":
            status = card["run"] / "status"
            if not status.exists():
                print("not started")
            else:
                parts = status.read_text(encoding="utf-8").strip().rsplit(" · ", 1)
                try:
                    started = float((card["run"] / "started").read_text(encoding="utf-8"))
                    parts[-1] = str(int((time.time() - started) // 60)) + " min"
                except (OSError, ValueError):
                    pass
                print(" · ".join(parts))
            return 0
        summary_file = card["run"] / "summary.md"
        if summary_file.exists():
            summary_file.unlink()
        code = run_card(card, "--quick" in argv[2:])
        if summary_file.exists():
            sys.stdout.write(summary_file.read_text(encoding="utf-8"))
        return code
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

