# OpenClaw Ops Runner (JSONL Queue)

This runner consumes ops jobs appended by the Telegram bot to an append-only JSONL queue and posts results back to Telegram.

Paths (defaults):
- Jobs: `/var/lib/openclaw/jobs.jsonl`
- Results: `/var/lib/openclaw/results.jsonl`
- Cursor: `/var/lib/openclaw/jobs.cursor`

Required env:
- `TELEGRAM_BOT_TOKEN`

Optional env:
- `JOBS_PATH`, `RESULTS_PATH`, `CURSOR_PATH`
- `SSH_ALIAS` (default: `dead`)
- `POLL_INTERVAL_SEC` (default: `0.5`)

