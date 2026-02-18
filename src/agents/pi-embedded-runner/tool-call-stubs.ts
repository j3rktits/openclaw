import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent, ToolCall } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";

type JsonToolCallStub = {
  name?: unknown;
  arguments?: unknown;
  params?: unknown;
  input?: unknown;
};

function stripJsonCodeFence(text: string): string {
  const trimmed = text.trim();
  // Prefer extracting JSON from a fenced block if present. Some models emit:
  // ```json
  // {...}
  // ```
  // plus extra text. We take the first fenced payload.
  const fullFence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fullFence) {
    return fullFence[1].trim();
  }
  const firstFence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (firstFence) {
    return firstFence[1].trim();
  }
  return trimmed;
}

function extractFirstJsonValue(text: string): string | null {
  const s = text;
  let start = -1;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === "{" || c === "[") {
      start = i;
      break;
    }
  }
  if (start < 0) {
    return null;
  }

  // Extract the first balanced JSON value (object/array), skipping braces inside strings.
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let i = start; i < s.length; i += 1) {
    const c = s[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (c === "\\") {
        escaped = true;
        continue;
      }
      if (c === "\"") {
        inString = false;
      }
      continue;
    }

    if (c === "\"") {
      inString = true;
      continue;
    }
    if (c === "{" || c === "[") {
      stack.push(c);
      continue;
    }
    if (c === "}" || c === "]") {
      const last = stack[stack.length - 1];
      const ok = (last === "{" && c === "}") || (last === "[" && c === "]");
      if (!ok) {
        return null;
      }
      stack.pop();
      if (stack.length === 0) {
        return s.slice(start, i + 1).trim();
      }
    }
  }

  return null;
}

function parseToolCallArgs(raw: unknown): Record<string, unknown> | null {
  if (raw === undefined || raw === null) {
    return {};
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) {
      return {};
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function parseToolCallStubsFromText(text: string): Array<{ name: string; args: Record<string, any> }> | null {
  const cleaned = stripJsonCodeFence(text);
  const candidate = extractFirstJsonValue(cleaned) ?? cleaned.trim();
  if (!candidate) {
    return null;
  }
  const upper = candidate.trim().toUpperCase();
  if (upper === "NOOP" || upper === "NOOP {}") {
    return null;
  }

  const head = candidate.trimStart();
  if (!(head.startsWith("{") || head.startsWith("["))) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }

  const calls = Array.isArray(parsed) ? parsed : [parsed];
  const out: Array<{ name: string; args: Record<string, any> }> = [];

  for (const call of calls) {
    if (!call || typeof call !== "object") {
      return null;
    }
    const stub = call as JsonToolCallStub;
    const name = typeof stub.name === "string" ? stub.name.trim() : "";
    if (!name) {
      return null;
    }
    const rawArgs = stub.arguments ?? stub.params ?? stub.input;
    const args = parseToolCallArgs(rawArgs);
    if (!args) {
      return null;
    }
    out.push({ name, args });
  }

  return out.length > 0 ? out : null;
}

function coerceAssistantTextToToolCalls(msg: AssistantMessage, allowedToolNames?: Set<string>): AssistantMessage {
  if (!msg || msg.role !== "assistant") {
    return msg;
  }
  if (!Array.isArray(msg.content) || msg.content.length < 1) {
    return msg;
  }
  const texts: string[] = [];
  for (const block of msg.content as unknown[]) {
    if (!block || typeof block !== "object") {
      return msg;
    }
    const type = (block as { type?: unknown }).type;
    if (type !== "text") {
      return msg;
    }
    const text = (block as { text?: unknown }).text;
    if (typeof text !== "string") {
      return msg;
    }
    if (text.trim()) {
      texts.push(text);
    }
  }
  if (texts.length === 0) {
    return msg;
  }

  const stubs = parseToolCallStubsFromText(texts.join("\n"));
  if (!stubs) {
    return msg;
  }

  const allow = allowedToolNames
    ? new Set(Array.from(allowedToolNames).map((name) => name.toLowerCase()))
    : null;
  for (const stub of stubs) {
    if (allow && !allow.has(stub.name.toLowerCase())) {
      return msg;
    }
  }

  const now = Date.now();
  let counter = 0;
  const toolCalls: ToolCall[] = stubs.map((stub) => {
    counter += 1;
    return {
      type: "toolCall",
      id: `call_${now}_${counter}`,
      name: stub.name,
      // Important: include arguments even if empty so transcript repair doesn't drop tool calls.
      arguments: stub.args ?? {},
    };
  });

  return {
    ...msg,
    stopReason: "toolUse",
    content: toolCalls,
  };
}

function buildErrorAssistantMessage(params: {
  message: string;
  provider?: string;
  modelId?: string;
}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: params.message }],
    api: "openai-completions",
    provider: (params.provider ?? "unknown") as never,
    model: params.modelId ?? "unknown",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: params.message,
    timestamp: Date.now(),
  };
}

export function wrapStreamFnToolCallStubs(
  streamFn: StreamFn,
  opts?: {
    enabled?: boolean;
    allowedToolNames?: Set<string>;
  },
): StreamFn {
  if (!opts?.enabled) {
    return streamFn;
  }

  return async (model, context, options) => {
    const upstream = await streamFn(model, context, options);
    const downstream = createAssistantMessageEventStream();
    void (async () => {
      try {
        for await (const event of upstream as unknown as AsyncIterable<AssistantMessageEvent>) {
          if (event.type === "done") {
            const nextMessage = coerceAssistantTextToToolCalls(event.message, opts.allowedToolNames);
            if (nextMessage !== event.message) {
              downstream.push({
                ...event,
                reason: "toolUse",
                message: nextMessage,
              });
            } else {
              downstream.push(event);
            }
            continue;
          }
          downstream.push(event);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        downstream.push({
          type: "error",
          reason: "error",
          error: buildErrorAssistantMessage({
            message,
            provider: (model as { provider?: string } | null)?.provider ?? undefined,
            modelId: (model as { id?: string } | null)?.id ?? undefined,
          }),
        });
      }
    })();
    return downstream;
  };
}
