# Telegram Ops (Queue + Runner)

This repo is deployed on `llm-test` (Ubuntu 22.04) and receives Telegram DMs.

## Objective

Telegram DMs should reliably produce *plain-text* results from deterministic Linux/Docker/Git operations on `llm-test` (and optionally via SSH to `dead`).

## Non-goals

- Do not stream tool traces (no `<tools>`, no JSON envelopes) back to Telegram.
- Do not rely on session tools for DM request/response.
- Do not solve reliability by expanding a large fixed list of Telegram commands.

## How It Works

- `ping` and `tail logs` are deterministic fast-paths.
- All other DMs:
  1. Use OpenAI (planner) to convert the request into a bounded job (host + 1..6 commands + timeout + maxLines).
  2. Append the job as one JSON object per line to `/var/lib/openclaw/jobs.jsonl`.
  3. A Python runner daemon executes the job deterministically and posts results back to Telegram.

## Teaching The Planner About Your Environment

The planner prompt includes a short built-in context plus an optional local file:

- Host path: `/home/derp/.openclaw/env-context.md`
- Container path: `/home/node/.openclaw/env-context.md`

Keep it short and factual (projects, compose dirs, SSH aliases, service names).

Do not put secrets in `env-context.md`.
