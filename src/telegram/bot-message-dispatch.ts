import type { Bot } from "grammy";
import fs from "node:fs";
import path from "node:path";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import type { OpenClawConfig, ReplyToMode, TelegramAccountConfig } from "../config/types.js";
import type { RuntimeEnv } from "../runtime.js";
import type { TelegramMessageContext } from "./bot-message-context.js";
import type { TelegramBotOptions } from "./bot.js";
import type { TelegramStreamMode, TelegramContext } from "./bot/types.js";
import { resolveAgentDir } from "../agents/agent-scope.js";
import {
  findModelInCatalog,
  loadModelCatalog,
  modelSupportsVision,
} from "../agents/model-catalog.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { EmbeddedBlockChunker } from "../agents/pi-embedded-block-chunker.js";
import { resolveChunkMode } from "../auto-reply/chunk.js";
import { clearHistoryEntriesIfEnabled } from "../auto-reply/reply/history.js";
import { dispatchReplyWithBufferedBlockDispatcher } from "../auto-reply/reply/provider-dispatcher.js";
import { removeAckReactionAfterReply } from "../channels/ack-reactions.js";
import { logAckFailure, logTypingFailure } from "../channels/logging.js";
import { createReplyPrefixOptions } from "../channels/reply-prefix.js";
import { createTypingCallbacks } from "../channels/typing.js";
import { resolveMarkdownTableMode } from "../config/markdown-tables.js";
import { resolveConfigPath } from "../config/paths.js";
import { danger, logVerbose } from "../globals.js";
import { deliverReplies } from "./bot/delivery.js";
import { resolveTelegramDraftStreamingChunking } from "./draft-chunking.js";
import { createTelegramDraftStream } from "./draft-stream.js";
import { cacheSticker, describeStickerImage } from "./sticker-cache.js";

const EMPTY_RESPONSE_FALLBACK = "No response generated. Please try again.";

const execAsync = promisify(execCb);
// Bump this when debugging "which instance is answering my Telegram?"
const TELEGRAM_FASTPATH_TAG = "llm-test 2a9a987c4 20260217-2156";

async function readFileTail(params: { filePath: string; maxBytes: number }): Promise<string> {
  const fh = await fs.promises.open(params.filePath, "r");
  try {
    const stat = await fh.stat();
    const start = Math.max(0, stat.size - params.maxBytes);
    const len = stat.size - start;
    if (len <= 0) {
      return "";
    }
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    return buf.toString("utf8");
  } finally {
    await fh.close();
  }
}

function tailLines(text: string, maxLines: number): string {
  const lines = text.split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - maxLines)).join("\n").trim();
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

type OllamaTagsResponse = {
  models?: Array<{
    name?: string;
    size?: number;
    modified_at?: string;
    digest?: string;
  }>;
};

async function fetchOllamaTags(): Promise<string[]> {
  try {
    // OLLAMA_BASE_URL includes /v1; Ollama's tags endpoint is /api/tags.
    const base = process.env.OLLAMA_BASE_URL
      ? new URL(process.env.OLLAMA_BASE_URL).origin
      : "http://127.0.0.1:11434";
    const url = `${base}/api/tags`;
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) {
      return [];
    }
    const data = (await res.json()) as OllamaTagsResponse;
    const names = (data.models ?? [])
      .map((m) => String(m?.name ?? "").trim())
      .filter(Boolean);
    names.sort();
    return names;
  } catch {
    return [];
  }
}

function normalizeModelName(input: string): { providerRef: string; ollamaName: string } | null {
  const raw = input.trim();
  if (!raw) return null;
  const noProvider = raw.startsWith("ollama/") ? raw.slice("ollama/".length) : raw;
  const cleaned = noProvider.trim();
  if (!cleaned) return null;
  return { providerRef: `ollama/${cleaned}`, ollamaName: cleaned };
}

function suggestedFallbacksFor(primaryOllamaName: string): string[] {
  const name = primaryOllamaName.trim();
  const pairs: Record<string, string> = {
    "qwen2.5:7b-instruct": "qwen2.5:3b-instruct",
    "qwen2.5:3b-instruct": "qwen2.5:7b-instruct",
    "qwen2.5-coder:7b": "qwen2.5-coder:3b",
    "qwen2.5-coder:3b": "qwen2.5-coder:7b",
  };
  const fb = pairs[name];
  return fb ? [`ollama/${fb}`] : [];
}

async function writeConfigJsonAtomic(filePath: string, obj: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.openclaw.json.tmp.${Date.now()}`);
  const data = `${JSON.stringify(obj, null, 2)}\n`;
  await fs.promises.writeFile(tmp, data, { encoding: "utf8", mode: 0o600 });
  await fs.promises.rename(tmp, filePath);
}

async function runShellCommand(params: {
  cmd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}): Promise<{ exitCode: number; output: string }> {
  const timeoutMs = params.timeoutMs ?? 12_000;
  const maxOutputBytes = params.maxOutputBytes ?? 256 * 1024;
  try {
    const { stdout, stderr } = await execAsync(params.cmd, {
      timeout: timeoutMs,
      maxBuffer: maxOutputBytes,
      windowsHide: true,
    });
    const out = `${stdout ?? ""}${stderr ?? ""}`.trim();
    return { exitCode: 0, output: out };
  } catch (err: any) {
    const code = typeof err?.code === "number" ? err.code : 1;
    const stdout = String(err?.stdout ?? "");
    const stderr = String(err?.stderr ?? err?.message ?? "");
    const out = `${stdout}${stderr}`.trim();
    return { exitCode: code, output: out };
  }
}

function formatCmdResult(params: { title: string; cmd: string; exitCode: number; output: string }) {
  // Keep plain-text output to avoid Telegram Markdown parse issues (which can look like "no output").
  const header = `${params.title}\ncmd: ${params.cmd}\nexit: ${params.exitCode}`;
  if (!params.output) {
    return header;
  }
  return `${header}\n\n${params.output}`;
}

function formatOpenclawInternalLog(raw: string): string {
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj: any = JSON.parse(trimmed);
      const time = String(obj?.time ?? "").trim();
      const lvl = String(obj?._meta?.logLevelName ?? "").trim();
      const nameStr = String(obj?._meta?.name ?? "").trim();
      let subsystem = "";
      try {
        // _meta.name looks like {"subsystem":"gateway"} (stringified json).
        const parsed = JSON.parse(nameStr);
        subsystem = String(parsed?.subsystem ?? "").trim();
      } catch {
        subsystem = "";
      }
      const parts: string[] = [];
      for (let i = 0; i < 10; i += 1) {
        const v = obj?.[String(i)];
        if (v === undefined) break;
        if (i === 0 && typeof v === "string" && v.includes("\"subsystem\"")) {
          continue;
        }
        if (typeof v === "string") {
          parts.push(v);
        } else {
          parts.push(JSON.stringify(v));
        }
      }
      const msg = parts.join(" ").trim();
      const prefix = [time, lvl, subsystem ? `[${subsystem}]` : ""].filter(Boolean).join(" ");
      out.push(`${prefix} ${msg}`.trim());
    } catch {
      out.push(trimmed);
    }
  }
  return out.join("\n");
}

async function readLatestOpenclawLogTail(params: {
  dir?: string;
  maxBytes?: number;
  maxLines?: number;
}): Promise<{ filePath: string | null; tail: string }> {
  const dir = params.dir ?? "/tmp/openclaw";
  const maxBytes = params.maxBytes ?? 256 * 1024;
  const maxLines = params.maxLines ?? 200;

  let entries: string[] = [];
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return { filePath: null, tail: "" };
  }
  const candidates = entries
    .filter((name) => name.startsWith("openclaw-") && name.endsWith(".log"))
    .sort();
  const latest = candidates[candidates.length - 1];
  if (!latest) {
    return { filePath: null, tail: "" };
  }
  const filePath = path.join(dir, latest);
  const chunk = await readFileTail({ filePath, maxBytes }).catch(() => "");
  return { filePath, tail: tailLines(chunk, maxLines) };
}

async function resolveStickerVisionSupport(cfg: OpenClawConfig, agentId: string) {
  try {
    const catalog = await loadModelCatalog({ config: cfg });
    const defaultModel = resolveDefaultModelForAgent({ cfg, agentId });
    const entry = findModelInCatalog(catalog, defaultModel.provider, defaultModel.model);
    if (!entry) {
      return false;
    }
    return modelSupportsVision(entry);
  } catch {
    return false;
  }
}

type ResolveBotTopicsEnabled = (ctx: TelegramContext) => boolean | Promise<boolean>;

type DispatchTelegramMessageParams = {
  context: TelegramMessageContext;
  bot: Bot;
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  replyToMode: ReplyToMode;
  streamMode: TelegramStreamMode;
  textLimit: number;
  telegramCfg: TelegramAccountConfig;
  opts: Pick<TelegramBotOptions, "token">;
  resolveBotTopicsEnabled: ResolveBotTopicsEnabled;
};

export const dispatchTelegramMessage = async ({
  context,
  bot,
  cfg,
  runtime,
  replyToMode,
  streamMode,
  textLimit,
  telegramCfg,
  opts,
  resolveBotTopicsEnabled,
}: DispatchTelegramMessageParams) => {
  const {
    ctxPayload,
    primaryCtx,
    msg,
    chatId,
    isGroup,
    threadSpec,
    historyKey,
    historyLimit,
    groupHistories,
    route,
    skillFilter,
    sendTyping,
    sendRecordVoice,
    ackReactionPromise,
    reactionApi,
    removeAckAfterReply,
  } = context;

  const rawText = (msg.text ?? msg.caption ?? "").trim();
  const rawTextLower = rawText.toLowerCase();

  // Fast-path: keep Telegram connectivity tests snappy and avoid LLM/tool-call weirdness.
  if (!isGroup && rawTextLower === "ping") {
    await deliverReplies({
      replies: [{ text: `PONG (${TELEGRAM_FASTPATH_TAG}; host=${os.hostname()})` }],
      chatId: String(chatId),
      token: opts.token,
      runtime,
      bot,
      replyToMode,
      textLimit,
      thread: threadSpec,
      tableMode: resolveMarkdownTableMode({ cfg, channel: "telegram", accountId: route.accountId }),
      chunkMode: resolveChunkMode(cfg, "telegram", route.accountId),
      linkPreview: telegramCfg.linkPreview,
    });
    return;
  }

  // Fast-path: quick "help" in DMs.
  if (!isGroup && (rawTextLower === "help" || rawTextLower === "/help")) {
    const text = [
      "Examples (DM):",
      "",
      "ping",
      "tail logs",
      "tailscale ip",
      "ls dead",
      "is dead online",
      "",
      "For anything else: describe what you want and the bot will run the right commands and return the output.",
      "",
      "Optional targeting (when you want to force it):",
      "- dead: <shell command>   (run on dead via SSH)",
      "- cmd: <shell command>    (run on llm-test)",
    ].join("\n");
    await deliverReplies({
      replies: [{ text }],
      chatId: String(chatId),
      token: opts.token,
      runtime,
      bot,
      replyToMode,
      textLimit,
      thread: threadSpec,
      tableMode: resolveMarkdownTableMode({ cfg, channel: "telegram", accountId: route.accountId }),
      chunkMode: resolveChunkMode(cfg, "telegram", route.accountId),
      linkPreview: telegramCfg.linkPreview,
    });
    return;
  }

  // Fast-path: list / switch Ollama models in DMs.
  if (!isGroup && (rawTextLower === "models" || rawTextLower === "/models" || rawTextLower === "list models")) {
    const names = await fetchOllamaTags();
    const text = names.length
      ? `Ollama models installed on llm-test:\n\n${names.join("\n")}`
      : "Could not list Ollama models right now.";
    await deliverReplies({
      replies: [{ text }],
      chatId: String(chatId),
      token: opts.token,
      runtime,
      bot,
      replyToMode,
      textLimit,
      thread: threadSpec,
      tableMode: resolveMarkdownTableMode({ cfg, channel: "telegram", accountId: route.accountId }),
      chunkMode: resolveChunkMode(cfg, "telegram", route.accountId),
      linkPreview: telegramCfg.linkPreview,
    });
    return;
  }

  if (!isGroup && (rawTextLower === "model" || rawTextLower === "/model" || rawTextLower === "current model")) {
    const binding = (cfg.bindings ?? []).find((b) => b?.match?.channel === "telegram");
    const agentId = binding?.agentId ?? "main";
    const agent = (cfg.agents?.list ?? []).find((a) => a?.id === agentId);
    const modelCfg = agent?.model;
    const primary =
      typeof modelCfg === "string" ? modelCfg : (modelCfg?.primary ?? "unknown");
    const fallbacks =
      typeof modelCfg === "object" && Array.isArray(modelCfg?.fallbacks) ? modelCfg.fallbacks : [];
    const text = `Telegram is bound to agent: ${agentId}\nprimary model: ${primary}\nfallbacks: ${fallbacks.join(", ") || "(none)"}`;
    await deliverReplies({
      replies: [{ text }],
      chatId: String(chatId),
      token: opts.token,
      runtime,
      bot,
      replyToMode,
      textLimit,
      thread: threadSpec,
      tableMode: resolveMarkdownTableMode({ cfg, channel: "telegram", accountId: route.accountId }),
      chunkMode: resolveChunkMode(cfg, "telegram", route.accountId),
      linkPreview: telegramCfg.linkPreview,
    });
    return;
  }

  if (!isGroup) {
    const m = rawText.match(/^(?:use\\s+)?model\\s+(.+)$/i);
    if (m) {
      const requested = normalizeModelName(m[1] ?? "");
      if (!requested) {
        await deliverReplies({
          replies: [{ text: "Usage: use model <name>. Try: models" }],
          chatId: String(chatId),
          token: opts.token,
          runtime,
          bot,
          replyToMode,
          textLimit,
          thread: threadSpec,
          tableMode: resolveMarkdownTableMode({ cfg, channel: "telegram", accountId: route.accountId }),
          chunkMode: resolveChunkMode(cfg, "telegram", route.accountId),
          linkPreview: telegramCfg.linkPreview,
        });
        return;
      }

      const installed = await fetchOllamaTags();
      if (installed.length && !installed.includes(requested.ollamaName)) {
        const text = `Model not installed: ${requested.ollamaName}\n\nInstalled:\n${installed.join("\n")}`;
        await deliverReplies({
          replies: [{ text }],
          chatId: String(chatId),
          token: opts.token,
          runtime,
          bot,
          replyToMode,
          textLimit,
          thread: threadSpec,
          tableMode: resolveMarkdownTableMode({ cfg, channel: "telegram", accountId: route.accountId }),
          chunkMode: resolveChunkMode(cfg, "telegram", route.accountId),
          linkPreview: telegramCfg.linkPreview,
        });
        return;
      }

      const configPath = resolveConfigPath();
      try {
        const raw = await fs.promises.readFile(configPath, "utf8");
        const obj = JSON.parse(raw) as any;
        const binding = (obj.bindings ?? []).find((b: any) => b?.match?.channel === "telegram");
        const agentId = binding?.agentId ?? "main";
        const agents = (obj.agents ?? {}).list ?? [];
        const agent = agents.find((a: any) => a?.id === agentId);
        if (!agent) {
          throw new Error(`agent not found: ${agentId}`);
        }
        agent.model = agent.model && typeof agent.model === "object" ? agent.model : {};
        agent.model.primary = requested.providerRef;
        const fallbacks = suggestedFallbacksFor(requested.ollamaName);
        if (fallbacks.length) {
          agent.model.fallbacks = fallbacks;
        }
        await writeConfigJsonAtomic(configPath, obj);

        const text = `Set Telegram agent (${agentId}) primary model to: ${requested.providerRef}\nRestarting gateway to apply...`;
        await deliverReplies({
          replies: [{ text }],
          chatId: String(chatId),
          token: opts.token,
          runtime,
          bot,
          replyToMode,
          textLimit,
          thread: threadSpec,
          tableMode: resolveMarkdownTableMode({ cfg, channel: "telegram", accountId: route.accountId }),
          chunkMode: resolveChunkMode(cfg, "telegram", route.accountId),
          linkPreview: telegramCfg.linkPreview,
        });

        // Restart the container by exiting the gateway process; Docker restart policy brings it back.
        setTimeout(() => process.exit(0), 750);
        return;
      } catch (e: any) {
        const text = `Failed to switch model: ${String(e?.message ?? e)}`;
        await deliverReplies({
          replies: [{ text }],
          chatId: String(chatId),
          token: opts.token,
          runtime,
          bot,
          replyToMode,
          textLimit,
          thread: threadSpec,
          tableMode: resolveMarkdownTableMode({ cfg, channel: "telegram", accountId: route.accountId }),
          chunkMode: resolveChunkMode(cfg, "telegram", route.accountId),
          linkPreview: telegramCfg.linkPreview,
        });
        return;
      }
    }
  }

  // Fast-path: "tail log(s)" in DMs returns the OpenClaw gateway internal log tail.
  // This avoids LLM tool-call drift (e.g. "/path/to/...") and avoids leaking tool envelopes in streaming.
  if (!isGroup && (rawTextLower === "tail log" || rawTextLower === "tail logs")) {
    const latest = await readLatestOpenclawLogTail({ maxLines: 200 });
    const formatted = latest.tail ? formatOpenclawInternalLog(latest.tail) : "";
    const text = formatted
      ? `OpenClaw internal log tail (${latest.filePath ?? "unknown"}):\n\n${formatted}`
      : "No OpenClaw internal logs found yet.";
    await deliverReplies({
      replies: [{ text }],
      chatId: String(chatId),
      token: opts.token,
      runtime,
      bot,
      replyToMode,
      textLimit,
      thread: threadSpec,
      tableMode: resolveMarkdownTableMode({ cfg, channel: "telegram", accountId: route.accountId }),
      chunkMode: resolveChunkMode(cfg, "telegram", route.accountId),
      linkPreview: telegramCfg.linkPreview,
    });
    return;
  }

  // Fast-path: tailscale ip in DMs (works with network_mode: host because tailscale0 is a host iface).
  const looksLikeTailscaleIpQuestion =
    rawTextLower.includes("tailscale") &&
    /\bip\b/.test(rawTextLower) &&
    (rawTextLower.includes("llm-test") || rawTextLower.includes("server") || rawTextLower.includes("tailscale ip"));
  if (
    !isGroup &&
    (rawTextLower === "tailscale ip" ||
      rawTextLower === "ts ip" ||
      rawTextLower === "tailscale ip llm-test" ||
      looksLikeTailscaleIpQuestion)
  ) {
    const cmd = "ip -4 -o addr show dev tailscale0 | awk '{print $4}' | head -n 1";
    const res = await runShellCommand({ cmd, timeoutMs: 5000, maxOutputBytes: 32 * 1024 });
    const ip = res.output.split(/\s+/)[0]?.trim() ?? "";
    const text = ip ? `llm-test tailscale0: ${ip}` : formatCmdResult({ title: "tailscale ip failed", cmd, exitCode: res.exitCode, output: res.output });
    await deliverReplies({
      replies: [{ text }],
      chatId: String(chatId),
      token: opts.token,
      runtime,
      bot,
      replyToMode,
      textLimit,
      thread: threadSpec,
      tableMode: resolveMarkdownTableMode({ cfg, channel: "telegram", accountId: route.accountId }),
      chunkMode: resolveChunkMode(cfg, "telegram", route.accountId),
      linkPreview: telegramCfg.linkPreview,
    });
    return;
  }

  // Fast-path: "is dead online" in DMs.
  const looksLikeDeadOnlineQuestion =
    /\bdead\b/.test(rawTextLower) && /\b(online|up)\b/.test(rawTextLower);
  if (
    !isGroup &&
    (rawTextLower === "is dead online" ||
      rawTextLower === "dead online" ||
      rawTextLower === "is dead up" ||
      looksLikeDeadOnlineQuestion)
  ) {
    const cmd = `ssh -o BatchMode=yes -o ConnectTimeout=5 dead -- bash -lc ${shQuote("echo OK; hostname; uptime -p")}`;
    const res = await runShellCommand({ cmd, timeoutMs: 9000, maxOutputBytes: 64 * 1024 });
    const text = res.exitCode === 0 && res.output
      ? `dead is online:\n\n${res.output}`
    : formatCmdResult({ title: "dead is offline (ssh failed)", cmd, exitCode: res.exitCode, output: res.output });
    await deliverReplies({
      replies: [{ text }],
      chatId: String(chatId),
      token: opts.token,
      runtime,
      bot,
      replyToMode,
      textLimit,
      thread: threadSpec,
      tableMode: resolveMarkdownTableMode({ cfg, channel: "telegram", accountId: route.accountId }),
      chunkMode: resolveChunkMode(cfg, "telegram", route.accountId),
      linkPreview: telegramCfg.linkPreview,
    });
    return;
  }

  // Fast-path: "ls dead [path]" in DMs.
  if (!isGroup) {
    const m = rawText.match(/^ls\s+dead(?:\s+(.*))?$/i);
    if (m) {
      const target = (m[1] ?? "").trim() || "~";
      const remoteCmd = `ls -la --color=never ${shQuote(target)}`;
      const cmd = `ssh -o BatchMode=yes -o ConnectTimeout=5 dead -- bash -lc ${shQuote(remoteCmd)}`;
      const res = await runShellCommand({ cmd, timeoutMs: 12_000, maxOutputBytes: 256 * 1024 });
      const text = formatCmdResult({ title: `ls dead ${target}`, cmd, exitCode: res.exitCode, output: res.output });
      await deliverReplies({
        replies: [{ text }],
        chatId: String(chatId),
        token: opts.token,
        runtime,
        bot,
        replyToMode,
        textLimit,
        thread: threadSpec,
        tableMode: resolveMarkdownTableMode({ cfg, channel: "telegram", accountId: route.accountId }),
        chunkMode: resolveChunkMode(cfg, "telegram", route.accountId),
        linkPreview: telegramCfg.linkPreview,
      });
      return;
    }
  }

  // Fast-path: explicit command mode in DMs.
  // - dead: <cmd>  -> run on dead via ssh
  // - cmd:  <cmd>  -> run locally (gateway container / llm-test host netns)
  if (!isGroup) {
    const deadPrefix = rawText.match(/^dead:\s*(.+)$/i);
    if (deadPrefix) {
      const userCmd = deadPrefix[1].trim();
      if (!userCmd) {
        // fallthrough to normal handling
      } else if (/\b(-f|--follow)\b/.test(userCmd) || /\b(tail\s+-f|journalctl\s+-f|watch|top)\b/i.test(userCmd)) {
        const text = "Interactive/following commands aren’t supported over Telegram. Use a bounded command like `tail -n 200 ...`.";
        await deliverReplies({
          replies: [{ text }],
          chatId: String(chatId),
          token: opts.token,
          runtime,
          bot,
          replyToMode,
          textLimit,
          thread: threadSpec,
          tableMode: resolveMarkdownTableMode({ cfg, channel: "telegram", accountId: route.accountId }),
          chunkMode: resolveChunkMode(cfg, "telegram", route.accountId),
          linkPreview: telegramCfg.linkPreview,
        });
        return;
      } else {
        const cmd = `ssh -o BatchMode=yes -o ConnectTimeout=5 dead -- bash -lc ${shQuote(userCmd)}`;
        const res = await runShellCommand({ cmd, timeoutMs: 20_000, maxOutputBytes: 512 * 1024 });
        const text = formatCmdResult({ title: "dead:", cmd, exitCode: res.exitCode, output: res.output });
        await deliverReplies({
          replies: [{ text }],
          chatId: String(chatId),
          token: opts.token,
          runtime,
          bot,
          replyToMode,
          textLimit,
          thread: threadSpec,
          tableMode: resolveMarkdownTableMode({ cfg, channel: "telegram", accountId: route.accountId }),
          chunkMode: resolveChunkMode(cfg, "telegram", route.accountId),
          linkPreview: telegramCfg.linkPreview,
        });
        return;
      }
    }

    const cmdPrefix = rawText.match(/^cmd:\s*(.+)$/i);
    if (cmdPrefix) {
      const userCmd = cmdPrefix[1].trim();
      if (!userCmd) {
        // fallthrough to normal handling
      } else if (/\b(-f|--follow)\b/.test(userCmd) || /\b(tail\s+-f|journalctl\s+-f|watch|top)\b/i.test(userCmd)) {
        const text = "Interactive/following commands aren’t supported over Telegram. Use a bounded command like `tail -n 200 ...`.";
        await deliverReplies({
          replies: [{ text }],
          chatId: String(chatId),
          token: opts.token,
          runtime,
          bot,
          replyToMode,
          textLimit,
          thread: threadSpec,
          tableMode: resolveMarkdownTableMode({ cfg, channel: "telegram", accountId: route.accountId }),
          chunkMode: resolveChunkMode(cfg, "telegram", route.accountId),
          linkPreview: telegramCfg.linkPreview,
        });
        return;
      } else {
        const res = await runShellCommand({ cmd: userCmd, timeoutMs: 20_000, maxOutputBytes: 512 * 1024 });
        const text = formatCmdResult({ title: "cmd:", cmd: userCmd, exitCode: res.exitCode, output: res.output });
        await deliverReplies({
          replies: [{ text }],
          chatId: String(chatId),
          token: opts.token,
          runtime,
          bot,
          replyToMode,
          textLimit,
          thread: threadSpec,
          tableMode: resolveMarkdownTableMode({ cfg, channel: "telegram", accountId: route.accountId }),
          chunkMode: resolveChunkMode(cfg, "telegram", route.accountId),
          linkPreview: telegramCfg.linkPreview,
        });
        return;
      }
    }
  }

  const isPrivateChat = msg.chat.type === "private";
  const draftThreadId = threadSpec.id;
  const draftMaxChars = Math.min(textLimit, 4096);
  const canStreamDraft =
    streamMode !== "off" &&
    isPrivateChat &&
    typeof draftThreadId === "number" &&
    (await resolveBotTopicsEnabled(primaryCtx));
  const draftStream = canStreamDraft
    ? createTelegramDraftStream({
        api: bot.api,
        chatId,
        draftId: msg.message_id || Date.now(),
        maxChars: draftMaxChars,
        thread: threadSpec,
        log: logVerbose,
        warn: logVerbose,
      })
    : undefined;
  const draftChunking =
    draftStream && streamMode === "block"
      ? resolveTelegramDraftStreamingChunking(cfg, route.accountId)
      : undefined;
  const draftChunker = draftChunking ? new EmbeddedBlockChunker(draftChunking) : undefined;
  let lastPartialText = "";
  let draftText = "";
  const updateDraftFromPartial = (text?: string) => {
    if (!draftStream || !text) {
      return;
    }
    if (text === lastPartialText) {
      return;
    }
    if (streamMode === "partial") {
      lastPartialText = text;
      draftStream.update(text);
      return;
    }
    let delta = text;
    if (text.startsWith(lastPartialText)) {
      delta = text.slice(lastPartialText.length);
    } else {
      // Streaming buffer reset (or non-monotonic stream). Start fresh.
      draftChunker?.reset();
      draftText = "";
    }
    lastPartialText = text;
    if (!delta) {
      return;
    }
    if (!draftChunker) {
      draftText = text;
      draftStream.update(draftText);
      return;
    }
    draftChunker.append(delta);
    draftChunker.drain({
      force: false,
      emit: (chunk) => {
        draftText += chunk;
        draftStream.update(draftText);
      },
    });
  };
  const flushDraft = async () => {
    if (!draftStream) {
      return;
    }
    if (draftChunker?.hasBuffered()) {
      draftChunker.drain({
        force: true,
        emit: (chunk) => {
          draftText += chunk;
        },
      });
      draftChunker.reset();
      if (draftText) {
        draftStream.update(draftText);
      }
    }
    await draftStream.flush();
  };

  const disableBlockStreaming =
    Boolean(draftStream) ||
    (typeof telegramCfg.blockStreaming === "boolean" ? !telegramCfg.blockStreaming : undefined);

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId: route.agentId,
    channel: "telegram",
    accountId: route.accountId,
  });
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "telegram",
    accountId: route.accountId,
  });
  const chunkMode = resolveChunkMode(cfg, "telegram", route.accountId);

  // Handle uncached stickers: get a dedicated vision description before dispatch
  // This ensures we cache a raw description rather than a conversational response
  const sticker = ctxPayload.Sticker;
  if (sticker?.fileId && sticker.fileUniqueId && ctxPayload.MediaPath) {
    const agentDir = resolveAgentDir(cfg, route.agentId);
    const stickerSupportsVision = await resolveStickerVisionSupport(cfg, route.agentId);
    let description = sticker.cachedDescription ?? null;
    if (!description) {
      description = await describeStickerImage({
        imagePath: ctxPayload.MediaPath,
        cfg,
        agentDir,
        agentId: route.agentId,
      });
    }
    if (description) {
      // Format the description with sticker context
      const stickerContext = [sticker.emoji, sticker.setName ? `from "${sticker.setName}"` : null]
        .filter(Boolean)
        .join(" ");
      const formattedDesc = `[Sticker${stickerContext ? ` ${stickerContext}` : ""}] ${description}`;

      sticker.cachedDescription = description;
      if (!stickerSupportsVision) {
        // Update context to use description instead of image
        ctxPayload.Body = formattedDesc;
        ctxPayload.BodyForAgent = formattedDesc;
        // Clear media paths so native vision doesn't process the image again
        ctxPayload.MediaPath = undefined;
        ctxPayload.MediaType = undefined;
        ctxPayload.MediaUrl = undefined;
        ctxPayload.MediaPaths = undefined;
        ctxPayload.MediaUrls = undefined;
        ctxPayload.MediaTypes = undefined;
      }

      // Cache the description for future encounters
      if (sticker.fileId) {
        cacheSticker({
          fileId: sticker.fileId,
          fileUniqueId: sticker.fileUniqueId,
          emoji: sticker.emoji,
          setName: sticker.setName,
          description,
          cachedAt: new Date().toISOString(),
          receivedFrom: ctxPayload.From,
        });
        logVerbose(`telegram: cached sticker description for ${sticker.fileUniqueId}`);
      } else {
        logVerbose(`telegram: skipped sticker cache (missing fileId)`);
      }
    }
  }

  const replyQuoteText =
    ctxPayload.ReplyToIsQuote && ctxPayload.ReplyToBody
      ? ctxPayload.ReplyToBody.trim() || undefined
      : undefined;
  const deliveryState = {
    delivered: false,
    skippedNonSilent: 0,
  };

  const { queuedFinal } = await dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      ...prefixOptions,
      deliver: async (payload, info) => {
        if (info.kind === "final") {
          await flushDraft();
          draftStream?.stop();
        }
        const result = await deliverReplies({
          replies: [payload],
          chatId: String(chatId),
          token: opts.token,
          runtime,
          bot,
          replyToMode,
          textLimit,
          thread: threadSpec,
          tableMode,
          chunkMode,
          onVoiceRecording: sendRecordVoice,
          linkPreview: telegramCfg.linkPreview,
          replyQuoteText,
        });
        if (result.delivered) {
          deliveryState.delivered = true;
        }
      },
      onSkip: (_payload, info) => {
        if (info.reason !== "silent") {
          deliveryState.skippedNonSilent += 1;
        }
      },
      onError: (err, info) => {
        runtime.error?.(danger(`telegram ${info.kind} reply failed: ${String(err)}`));
      },
      onReplyStart: createTypingCallbacks({
        start: sendTyping,
        onStartError: (err) => {
          logTypingFailure({
            log: logVerbose,
            channel: "telegram",
            target: String(chatId),
            error: err,
          });
        },
      }).onReplyStart,
    },
    replyOptions: {
      skillFilter,
      disableBlockStreaming,
      onPartialReply: draftStream ? (payload) => updateDraftFromPartial(payload.text) : undefined,
      onModelSelected,
    },
  });
  draftStream?.stop();
  let sentFallback = false;
  if (!deliveryState.delivered && deliveryState.skippedNonSilent > 0) {
    const result = await deliverReplies({
      replies: [{ text: EMPTY_RESPONSE_FALLBACK }],
      chatId: String(chatId),
      token: opts.token,
      runtime,
      bot,
      replyToMode,
      textLimit,
      thread: threadSpec,
      tableMode,
      chunkMode,
      linkPreview: telegramCfg.linkPreview,
      replyQuoteText,
    });
    sentFallback = result.delivered;
  }

  const hasFinalResponse = queuedFinal || sentFallback;
  if (!hasFinalResponse) {
    if (isGroup && historyKey) {
      clearHistoryEntriesIfEnabled({ historyMap: groupHistories, historyKey, limit: historyLimit });
    }
    return;
  }
  removeAckReactionAfterReply({
    removeAfterReply: removeAckAfterReply,
    ackReactionPromise,
    ackReactionValue: ackReactionPromise ? "ack" : null,
    remove: () => reactionApi?.(chatId, msg.message_id ?? 0, []) ?? Promise.resolve(),
    onError: (err) => {
      if (!msg.message_id) {
        return;
      }
      logAckFailure({
        log: logVerbose,
        channel: "telegram",
        target: `${chatId}/${msg.message_id}`,
        error: err,
      });
    },
  });
  if (isGroup && historyKey) {
    clearHistoryEntriesIfEnabled({ historyMap: groupHistories, historyKey, limit: historyLimit });
  }
};
