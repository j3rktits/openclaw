# Telegram Ops Behavior (llm-test)

This folder contains the Telegram integration and dispatch logic.

## Objective

Telegram DMs should route to a Linux/Docker/Git-capable agent that can reliably execute ops commands on `llm-test` (and optionally SSH to `dead`) and reply with command output.

## Requirements

- Always reply (no "no reply").
- User-visible replies are plain text (no tool envelopes, no JSON stubs, no internal traces).
- Prefer deterministic `exec` plans with timeouts and bounded output.
- Prefer reading environment facts (compose paths, known container names) over inventing assumptions.

## Non-goals

- Do not add scalable-breaking "command tables" in user-editable text files.
- Do not rely on session tools for Telegram DM request/response.

## Implementation Notes

- Keep only a tiny set of deterministic shortcuts (e.g., `ping`, `tail logs`) when they eliminate known failure modes.
- For everything else, implement an ops intent -> exec plan flow.
