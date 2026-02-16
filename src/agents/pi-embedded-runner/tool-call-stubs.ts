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
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
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
  if (!cleaned) {
    return null;
  }
  const upper = cleaned.trim().toUpperCase();
  if (upper === "NOOP" || upper === "NOOP {}") {
    return null;
  }

  // Only treat content that is *entirely* JSON as a tool call stub.
  const head = cleaned.trimStart();
  if (!(head.startsWith("{") || head.startsWith("["))) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
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
  if (!Array.isArray(msg.content) || msg.content.length !== 1) {
    return msg;
  }

  const block = msg.content[0] as unknown;
  if (!block || typeof block !== "object") {
    return msg;
  }
  const text =
    (block as { type?: unknown; text?: unknown }).type === "text"
      ? (block as { text?: unknown }).text
      : undefined;
  if (typeof text !== "string") {
    return msg;
  }

  const stubs = parseToolCallStubsFromText(text);
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
