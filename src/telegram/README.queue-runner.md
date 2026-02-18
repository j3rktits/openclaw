# Telegram Ops: OpenAI Planner + JSONL Queue + Python Runner

Design goal: Telegram DMs always produce plain-text replies with deterministic execution.

Flow:
1. Telegram DM arrives at OpenClaw gateway.
2. `ping` + `tail logs` are handled as deterministic fast-paths.
3. All other DMs:
   - OpenAI planner turns the request into a JSON plan (host/cwd/commands/timeout/maxLines).
   - The gateway appends a job (one JSON object per line) to `/var/lib/openclaw/jobs.jsonl`.
   - The Python runner consumes jobs and posts results back to Telegram.

Secrets:
- Gateway (planner): `${OPENCLAW_CONFIG_DIR}/secrets.env` contains `OPENAI_API_KEY` (not in git).
- Runner: `/etc/openclaw/openclaw-runner.env` contains `TELEGRAM_BOT_TOKEN` (not in git).

