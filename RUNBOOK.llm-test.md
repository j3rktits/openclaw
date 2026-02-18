# OpenClaw / Ollama Stack – Canonical Runbook
Host: llm-test (Ubuntu 22.04)
Laptop: dead

---

## Objective / Non-goals

### Objective: Telegram → OpenClaw → Linux/Docker/Git-capable Agent (environment-aware)

You are working on an OpenClaw deployment on host `llm-test` (Ubuntu 22.04) that receives Telegram DMs.
Goal: when a user sends a Telegram message, OpenClaw should route it to an agent that can reliably perform Linux/Docker/Git operations on `llm-test` (and optionally SSH to `dead`) and then reply with the command output.

#### What success looks like (acceptance criteria)
1. For Telegram DMs, the bot ALWAYS replies with a useful result (never "no reply").
2. Replies MUST be plain text (no `<tools>` blocks, no JSON tool envelopes, no internal traces).
3. Commands must be executed deterministically using a queued job runner (not tool calls in Telegram), with:
   - timeouts
   - bounded output (tail / max lines)
   - clear errors when a command fails
4. The agent should use environment knowledge from files in the repo / workspace (runbook, compose paths, known container names) instead of inventing assumptions.
5. Do NOT solve this by adding more hardcoded Telegram command lists or "text file command tables" that Telegram reads. That approach does not scale and is not the intent.

#### Routing / behavior requirements
- Telegram messages should be handled by a Linux-ops oriented agent (Ollama model) that:
  - prefers executing commands over speculative explanations
  - asks ONE clarifying question only when truly necessary
- The default behavior should be:
  a) determine target (llm-test vs dead)
  b) determine execution mode (docker vs systemd vs file)
  c) run the minimal command(s)
  d) return output + next suggested command if needed

#### Implementation guidance (preferred)
- Keep a small set of truly safe, deterministic shortcuts (e.g., `ping`, `tail logs`) ONLY if they eliminate known failure modes.
- For everything else, use a robust "ops intent → plan → queue → deterministic execution" flow:
  - plan commands (bounded, safe) with best-quality planning
  - append the plan to an append-only JSONL queue
  - run the plan in a deterministic runner with limits
  - post results back to Telegram as plain text

#### Environment facts you must respect
- Host: `llm-test`
- Docker Compose is used to run OpenClaw.
- OpenClaw internal log is at `/tmp/openclaw/openclaw-*.log` inside the gateway container (or equivalent).
- Ollama baseUrl is `http://127.0.0.1:11434/v1` (host networking).
- Job queue paths (host + container-mounted):
  - Jobs: `/var/lib/openclaw/jobs.jsonl`
  - Results: `/var/lib/openclaw/results.jsonl`
  - Cursor: `/var/lib/openclaw/jobs.cursor`
- We previously saw failures caused by tool envelope leakage and session tool misuse; the fix direction is: plain-text replies + queued execution.

#### Non-goals / anti-patterns (DO NOT DO THESE)
- Do not add more "commands list in a text file" for Telegram to interpret.
- Do not return invented summaries when you did not run a command.
- Do not rely on session tools for Telegram DM request/response.
- Do not emit JSON-only tool stubs or tool traces in user-visible Telegram replies.

#### Concrete example desired behavior
User: "Tail logs for <service>"

Agent:
1) Detect ambiguity (container vs systemd unit). Try docker first:
   `docker ps --format ... | grep -i <service> || true`
2) If container exists: `docker logs --tail=200 <ctr>`
   else: `systemctl list-units --type=service | grep -i <service> || true` then `journalctl -u <unit> -n 200`
3) Reply with the output and ONE next-step suggestion.

If the output is large, tail it and say "(truncated)".

## 1. Current Architecture

### Server: llm-test
- Ubuntu 22.04
- Docker + OpenClaw gateway (Telegram ingress)
- OpenAI API (planner only, best-quality)
- Python runner daemon (deterministic execution + Telegram postback)
- Ollama running locally (optional / unrelated to queued ops flow)
- Gateway uses network_mode: host
- Ollama base URL: http://127.0.0.1:11434/v1
- Telegram DMs:
  - `ping`, `tail logs` are deterministic fast-paths
  - everything else is planned then queued to `/var/lib/openclaw/jobs.jsonl`

### Laptop: dead
- VS Code
- Codex extension installed
- Edits performed via SSH into llm-test
- Not integrated into OpenClaw automatically

Important:
Telegram → OpenClaw runs entirely on llm-test.
It does NOT hand off to VS Code or Codex on dead.
SSH to dead only occurs if explicitly invoked by OpenClaw.

---

## 2. Model & Provider Reality

Operationally:
- Telegram planning uses OpenAI API via `OPENAI_API_KEY`.
- Deterministic execution is done by a Python runner (no tool calls in Telegram).

However:
- Ollama may still be used elsewhere in OpenClaw, but queued ops reliability does not depend on it.

---

## 3. Node / Codex CLI State

On llm-test:
- node and npm are NOT installed.
- apt candidate nodejs version is 12.22.x.
- Node 12 is too old for modern CLI tooling.

If installing Codex CLI:
- Install Node 18+ or 20+ (via nvm or NodeSource).
- `npm install -g @openai/codex`
- Run `codex` and complete OAuth login or configure API key mode.

Installing Codex CLI improves server-side workflow only.
It does NOT automatically fix Telegram behavior.

---

## 4. What Is Actually Broken Today

Observed Telegram issues:
- JSON blobs returned as plain text
- Occasional “no reply”
- Tool-call inconsistencies
- Slowness

These are caused by:
- OpenClaw + local model tool adherence behavior
- Router model choice (3B)
- Tool allowlists
- Telegram streaming configuration

This is NOT a Codex CLI problem.

---

## 5. Current Config Knobs Impacting Telegram Reliability

### A) Router Agent (id: main)

Currently:
- Primary model: qwen2.5:3b-instruct
- 7B is fallback
- Tools allowlist does NOT include the `message` tool

Implication:
- 3B model may hallucinate tool calls or emit JSON-as-text
- Missing `message` tool can cause replies not to send properly
- Tool schema adherence weaker on smaller models

Possible Improvement:
- Promote 7B model to primary for Router
- Add `message` tool to allowlist
- Narrow tool exposure to reduce ambiguity

---

### B) Telegram Channel Config

Current:
- channels.telegram.streamMode = "off"

Implication:
- Responses are buffered until completion
- Failures can appear as “no reply”
- Long-running tool calls may timeout silently

Possible Improvement:
- Set streamMode to "partial" or "block"
- Tune timeout behavior

---

### C) Sandbox Mode

Currently:
- sandbox.mode = off

Implication:
- Allows SSH and network operations
- Correct for this stack
- Not causing Telegram failures

---

## 6. Decision Paths

### A) Harden Telegram + OpenClaw (Recommended First)

Goals:
- Improve tool-call reliability
- Eliminate JSON-as-text failures
- Ensure consistent reply behavior

Actions:
1. Promote Router model to 7B.
2. Add `message` tool to Router allowlist.
3. Enable Telegram streamMode = "partial".
4. Reduce tool surface area where possible.
5. Validate session handling.

Outcome:
Stable Telegram-based ops workflow.
$0 cost.
No external dependencies.

---

### B) Install OpenAI Codex CLI (Optional Workflow Upgrade)

Goal:
Improve server-side editing and ops workflow.

Actions:
1. Install Node 20 via nvm.
2. Install Codex CLI globally.
3. Authenticate via OAuth or API key.
4. Run Codex inside project directory on llm-test.

Benefits:
- Faster refactors
- Cleaner in-place changes
- Reduced SSH mental friction

Non-goals:
- Does not fix Telegram behavior.
- Does not replace OpenClaw automatically.

---

## 7. Security Note

If any API keys were ever pasted in logs or chat:
- Revoke in OpenAI dashboard.
- Generate new keys.
- Never store raw tokens in versioned files.

---

## 8. Final Summary

- OpenClaw “Codex Ops” is a local Ollama agent, not OpenAI Codex.
- Node is absent; apt offers Node 12.22.x (too old).
- Telegram issues stem from model/tool reliability and routing.
- Fix OpenClaw reliability first.
- Codex CLI is optional and workflow-focused.
- Clean separation of:
    - Telegram ops (OpenClaw + Ollama)
    - Heavy refactors (Codex CLI, optional)
    - VS Code browsing (dead)
