import { validatePlannedOpsJob } from "./ops-job-validate.js";
import type { PlannedOpsJob } from "./ops-job-validate.js";

type ChatCompletionsResponse = {
  choices?: Array<{
    message?: { content?: string };
  }>;
  error?: { message?: string };
};

function jsonOnlyPrompt(params: { envContext: string; request: string }) {
  const system = [
    "You are an operations planner.",
    "You produce ONLY a single JSON object, no prose, no code fences.",
    "The JSON must have exactly these fields:",
    '{ "host": "llm-test"|"dead", "cwd": string|null, "commands": string[1..6], "timeoutSec": number(5..300), "maxLines": number(50..1000) }',
    "",
    "Rules:",
    "- Choose host explicitly. Default to llm-test unless the request explicitly says dead/on dead/from dead.",
    "- NEVER embed ssh in commands. If host==dead, commands are executed on dead automatically.",
    "- Commands must be bounded: docker logs --tail N, journalctl -n N, tail -n N, etc.",
    "- Do not install packages unless explicitly asked.",
    "- If ambiguous, include a safe discovery command first (docker ps | grep, systemctl list-units | grep).",
    "- Never invent outputs.",
    "- Never suggest editing IDENTITY.md/TOOLS.md as a solution.",
    "- Avoid destructive actions (rm -rf, mkfs, dd to /dev, fork bombs).",
    "",
    "Environment facts:",
    params.envContext.trim(),
  ].join("\n");

  const user = ["User request:", params.request.trim(), "", "Return JSON now."].join("\n");
  return { system, user };
}

async function fetchWithTimeout(url: string, init: RequestInit & { timeoutMs?: number }) {
  const controller = new AbortController();
  const timeoutMs = init.timeoutMs ?? 20_000;
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

export async function planOpsJobViaOpenAI(params: {
  envContext: string;
  request: string;
}): Promise<{ ok: true; job: PlannedOpsJob } | { ok: false; error: string; raw?: string }> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return { ok: false, error: "OPENAI_API_KEY is not set in the gateway environment." };
  }
  const model = process.env.OPENAI_MODEL?.trim() || "gpt-4.1";
  const { system, user } = jsonOnlyPrompt({ envContext: params.envContext, request: params.request });
  const body = {
    model,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };

  try {
    const res = await fetchWithTimeout("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      timeoutMs: 25_000,
    });

    const text = await res.text();
    if (!res.ok) {
      return { ok: false, error: `OpenAI API error (${res.status})`, raw: text.slice(0, 2000) };
    }
    const data = JSON.parse(text) as ChatCompletionsResponse;
    const content = String(data?.choices?.[0]?.message?.content ?? "").trim();
    if (!content) {
      return { ok: false, error: "Planner returned empty content." };
    }
    let parsed: any;
    try {
      parsed = JSON.parse(content);
    } catch {
      return { ok: false, error: "Planner returned non-JSON content.", raw: content.slice(0, 2000) };
    }
    const v = validatePlannedOpsJob(parsed);
    if (!v.ok) {
      return { ok: false, error: `Invalid plan: ${v.error}`, raw: content.slice(0, 2000) };
    }
    return { ok: true, job: v.job };
  } catch (e: any) {
    return { ok: false, error: `Planner request failed: ${String(e?.message ?? e)}` };
  }
}

