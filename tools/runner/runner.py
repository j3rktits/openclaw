#!/usr/bin/env python3
import json
import os
import shlex
import subprocess
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple


DEFAULT_JOBS_PATH = "/var/lib/openclaw/jobs.jsonl"
DEFAULT_RESULTS_PATH = "/var/lib/openclaw/results.jsonl"
DEFAULT_CURSOR_PATH = "/var/lib/openclaw/jobs.cursor"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def read_env_float(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except Exception:
        return default


def clamp_int(v: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, v))


def truncate_last_lines(text: str, max_lines: int) -> Tuple[str, bool]:
    lines = text.splitlines()
    if len(lines) <= max_lines:
        return text, False
    kept = lines[-max_lines:]
    return "\n".join(kept), True


def safe_single_line(cmd: str) -> bool:
    if not cmd or not cmd.strip():
        return False
    return "\n" not in cmd and "\r" not in cmd


FOOTGUN_SUBSTRINGS = [
    "rm -rf /",
    "mkfs",
    " dd ",
    " of=/dev/",
    ":(){:|:&};:",
]


def is_footgun(cmd: str) -> bool:
    low = cmd.lower()
    if "rm" in low and "-rf" in low and " /" in low:
        return True
    if "mkfs" in low:
        return True
    if "dd " in low and "of=/dev/" in low:
        return True
    if ":(){:|:&};:" in cmd:
        return True
    return False


@dataclass
class Job:
    id: str
    ts: str
    request: str
    host: str
    cwd: Optional[str]
    commands: List[str]
    timeout_sec: int
    max_lines: int
    chat_id: str


def validate_job(obj: Any) -> Tuple[Optional[Job], Optional[str]]:
    if not isinstance(obj, dict):
        return None, "job is not an object"

    jid = str(obj.get("id", "")).strip()
    if not jid:
        return None, "missing id"

    host = str(obj.get("host", "")).strip()
    if host not in ("llm-test", "dead"):
        return None, f"invalid host: {host}"

    cwd = obj.get("cwd", None)
    if cwd is not None and cwd is not None and not isinstance(cwd, str):
        return None, "cwd must be string or null"
    cwd_s = str(cwd).strip() if isinstance(cwd, str) else None

    cmds = obj.get("commands", None)
    if not isinstance(cmds, list) or not (1 <= len(cmds) <= 6):
        return None, "commands must be a list of 1..6 strings"
    commands: List[str] = []
    for c in cmds:
        if not isinstance(c, str):
            return None, "commands must be strings"
        if not safe_single_line(c):
            return None, "commands must be non-empty single-line strings"
        if c.strip().lower().startswith("ssh "):
            return None, "do not embed ssh in commands; choose host=dead instead"
        if is_footgun(c):
            return None, "denied command (footgun)"
        commands.append(c.strip())

    timeout_sec = int(obj.get("timeoutSec", 60))
    timeout_sec = clamp_int(timeout_sec, 5, 300)
    max_lines = int(obj.get("maxLines", 200))
    max_lines = clamp_int(max_lines, 50, 1000)

    reply_to = obj.get("replyTo", {}) or {}
    if not isinstance(reply_to, dict):
        return None, "replyTo must be object"
    if str(reply_to.get("channel", "")).strip() != "telegram":
        return None, "replyTo.channel must be telegram"
    chat_id = str(reply_to.get("chatId", "")).strip()
    if not chat_id:
        return None, "replyTo.chatId missing"

    return (
        Job(
            id=jid,
            ts=str(obj.get("ts", "")).strip(),
            request=str(obj.get("request", "")).strip(),
            host=host,
            cwd=cwd_s,
            commands=commands,
            timeout_sec=timeout_sec,
            max_lines=max_lines,
            chat_id=chat_id,
        ),
        None,
    )


def run_one_command_local(cmd: str, cwd: Optional[str], timeout_sec: int) -> Tuple[int, str, str]:
    p = subprocess.run(
        ["bash", "-lc", cmd],
        cwd=cwd or None,
        text=True,
        capture_output=True,
        timeout=timeout_sec,
    )
    return p.returncode, p.stdout or "", p.stderr or ""


def run_one_command_dead(cmd: str, cwd: Optional[str], timeout_sec: int, ssh_alias: str) -> Tuple[int, str, str]:
    remote = cmd
    if cwd:
        remote = f"cd {shlex.quote(cwd)} && {cmd}"
    ssh_user = os.environ.get("SSH_USER", "derp").strip() or "derp"
    identity = os.environ.get("SSH_IDENTITY_FILE", "/home/derp/.openclaw/ssh/id_ed25519").strip()
    known_hosts = os.environ.get("SSH_KNOWN_HOSTS", "/home/derp/.openclaw/ssh/known_hosts").strip() or "/home/derp/.openclaw/ssh/known_hosts"
    ssh_cmd = [
        "ssh",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=5",
        "-o",
        "LogLevel=ERROR",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        f"UserKnownHostsFile={known_hosts}",
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        f"User={ssh_user}",
        ssh_alias,
        "--",
        "bash",
        "-lc",
        remote,
    ]
    if identity:
        ssh_cmd[1:1] = ["-i", identity]
    p = subprocess.run(
        ssh_cmd,
        text=True,
        capture_output=True,
        timeout=timeout_sec,
    )
    return p.returncode, p.stdout or "", p.stderr or ""


def execute_job(job: Job, ssh_alias: str) -> Tuple[int, str, str, bool]:
    exit_code = 0
    stdout_acc: List[str] = []
    stderr_acc: List[str] = []

    for cmd in job.commands:
        try:
            if job.host == "dead":
                code, out, err = run_one_command_dead(cmd, job.cwd, job.timeout_sec, ssh_alias)
            else:
                code, out, err = run_one_command_local(cmd, job.cwd, job.timeout_sec)
        except subprocess.TimeoutExpired:
            code, out, err = 124, "", f"timeout after {job.timeout_sec}s"
        except Exception as e:
            code, out, err = 1, "", f"exec failed: {e}"

        stdout_acc.append(out)
        stderr_acc.append(err)
        if code != 0 and exit_code == 0:
            exit_code = code

    stdout_all = "\n".join([s for s in stdout_acc if s]).strip()
    stderr_all = "\n".join([s for s in stderr_acc if s]).strip()
    stdout_trunc, t1 = truncate_last_lines(stdout_all, job.max_lines)
    stderr_trunc, t2 = truncate_last_lines(stderr_all, job.max_lines)
    truncated = t1 or t2
    return exit_code, stdout_trunc, stderr_trunc, truncated


def write_jsonl(path: str, obj: Dict[str, Any]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    line = json.dumps(obj, separators=(",", ":")) + "\n"
    with open(path, "a", encoding="utf-8") as f:
        f.write(line)


def write_cursor(path: str, offset: int) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(str(offset))
        f.write("\n")
    os.replace(tmp, path)


def read_cursor(path: str) -> int:
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = f.read().strip()
        return int(raw)
    except Exception:
        return 0


def telegram_send(token: str, chat_id: str, text: str) -> None:
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = {"chat_id": chat_id, "text": text, "disable_web_page_preview": True}
    data = urllib.parse.urlencode(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    with urllib.request.urlopen(req, timeout=20) as resp:
        _ = resp.read()


def format_result_message(job: Job, exit_code: int, stdout: str, stderr: str, truncated: bool) -> str:
    lines: List[str] = [f"Job {job.id} ({job.host}) exit={exit_code}"]
    for c in job.commands:
        lines.append(f"$ {c}")

    out = stdout.strip()
    err = stderr.strip()
    if out:
        lines.append(out)
    if err:
        lines.append(err)
    if truncated:
        lines.append("(truncated)")

    msg = "\n".join(lines).strip()
    # Telegram hard limit is 4096 chars; keep some headroom.
    if len(msg) <= 3800:
        return msg
    return msg[:3800] + "\n(truncated)"


def main() -> None:
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    if not token:
        raise SystemExit("TELEGRAM_BOT_TOKEN is required")

    jobs_path = os.environ.get("JOBS_PATH", DEFAULT_JOBS_PATH).strip() or DEFAULT_JOBS_PATH
    results_path = os.environ.get("RESULTS_PATH", DEFAULT_RESULTS_PATH).strip() or DEFAULT_RESULTS_PATH
    cursor_path = os.environ.get("CURSOR_PATH", DEFAULT_CURSOR_PATH).strip() or DEFAULT_CURSOR_PATH
    ssh_alias = os.environ.get("SSH_ALIAS", "dead").strip() or "dead"
    poll = read_env_float("POLL_INTERVAL_SEC", 0.5)

    os.makedirs(os.path.dirname(jobs_path), exist_ok=True)
    # Avoid noisy "missing file" loops on first boot.
    open(jobs_path, "ab").close()

    offset = read_cursor(cursor_path)
    while True:
        try:
            # Ensure the jobs file exists even if it was deleted/rotated.
            open(jobs_path, "ab").close()
            with open(jobs_path, "rb") as f:
                f.seek(offset)
                while True:
                    pos = f.tell()
                    line = f.readline()
                    if not line:
                        break
                    if not line.endswith(b"\n"):
                        f.seek(pos)
                        break

                    offset = f.tell()
                    try:
                        obj = json.loads(line.decode("utf-8"))
                    except Exception as e:
                        rid = f"parse-{int(time.time())}"
                        result = {
                            "id": rid,
                            "ts": now_iso(),
                            "host": "llm-test",
                            "exitCode": 2,
                            "stdout": "",
                            "stderr": f"JSON parse error: {e}",
                            "truncated": False,
                        }
                        write_jsonl(results_path, result)
                        # Can't reply (no chatId if parse failed).
                        write_cursor(cursor_path, offset)
                        continue

                    job, err = validate_job(obj)
                    if err or job is None:
                        rid = str(obj.get("id", "")).strip() or f"invalid-{int(time.time())}"
                        result = {
                            "id": rid,
                            "ts": now_iso(),
                            "host": str(obj.get("host", "llm-test")),
                            "exitCode": 2,
                            "stdout": "",
                            "stderr": f"Invalid job: {err}",
                            "truncated": False,
                        }
                        write_jsonl(results_path, result)
                        chat_id = ""
                        try:
                            chat_id = str(((obj.get("replyTo") or {}).get("chatId")) or "").strip()
                        except Exception:
                            chat_id = ""
                        if chat_id:
                            telegram_send(token, chat_id, f"Job {rid} invalid: {err}")
                        write_cursor(cursor_path, offset)
                        continue

                    exit_code, out, err_s, trunc = execute_job(job, ssh_alias)
                    result = {
                        "id": job.id,
                        "ts": now_iso(),
                        "host": job.host,
                        "exitCode": int(exit_code),
                        "stdout": out,
                        "stderr": err_s,
                        "truncated": bool(trunc),
                    }
                    write_jsonl(results_path, result)
                    telegram_send(token, job.chat_id, format_result_message(job, exit_code, out, err_s, trunc))
                    write_cursor(cursor_path, offset)
        except FileNotFoundError:
            # The queue directory might not exist yet; retry after a short sleep.
            pass
        except Exception as e:
            # Keep running; systemd will also restart if we crash.
            print(f"runner loop error: {e}", flush=True)

        time.sleep(poll)


if __name__ == "__main__":
    main()
