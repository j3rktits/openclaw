import type { Bot } from "grammy";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { OpenClawConfig, ReplyToMode, TelegramAccountConfig } from "../config/types.js";
import type { RuntimeEnv } from "../runtime.js";
import type { TelegramMessageContext } from "./bot-message-context.js";
import type { TelegramBotOptions } from "./bot.js";
import type { TelegramStreamMode, TelegramContext } from "./bot/types.js";
import type { OpsJobQueueItem } from "./jobs-queue.js";
import { appendJobToQueue } from "./jobs-queue.js";
import { planOpsJobViaOpenAI } from "./openai-ops-planner.js";
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
import { danger, logVerbose } from "../globals.js";
import { deliverReplies } from "./bot/delivery.js";
import { resolveTelegramDraftStreamingChunking } from "./draft-chunking.js";
import { createTelegramDraftStream } from "./draft-stream.js";
import { cacheSticker, describeStickerImage } from "./sticker-cache.js";

const EMPTY_RESPONSE_FALLBACK = "No response generated. Please try again.";

// Bump this when debugging "which instance is answering my Telegram?"
const TELEGRAM_FASTPATH_TAG = "llm-test 2a9a987c4 20260217-2156";
const TELEGRAM_ALLOWLIST_CHAT_ID = Number(
  (process.env.TELEGRAM_ALLOWLIST_CHAT_ID ?? "1670436854").trim(),
);

function makeEnvContext(): string {
  const base = [
    "Host roles:",
    "- llm-test: Ubuntu 22.04, runs OpenClaw via docker compose in /home/derp/openclaw",
    "- dead: reachable from llm-test via SSH alias 'dead' over Tailscale",
    "",
    "Facts:",
    "- Docker Compose is used",
    "- OpenClaw internal logs are at /tmp/openclaw/openclaw-*.log (inside gateway container)",
    "- Prefer bounded commands (docker logs --tail N, journalctl -n N, tail -n N)",
    "- Do not install packages unless explicitly asked",
    "- Do not suggest editing IDENTITY.md/TOOLS.md as a solution",
  ].join("\n");

  // Optional user-maintained context file (not committed): lets you teach the planner about your real env.
  // Keep it short; we hard-cap how much we include.
  const ctxPath = (process.env.OPENCLAW_ENV_CONTEXT_PATH ?? "/home/node/.openclaw/env-context.md").trim();
  if (!ctxPath) return base;
  try {
    const raw = fs.readFileSync(ctxPath, "utf8");
    const snippet = raw.slice(0, 12 * 1024).trim();
    if (!snippet) return base;
    return `${base}\n\nAdditional local context (${ctxPath}):\n${snippet}`;
  } catch {
    return base;
  }
}

function newJobId(): string {
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, "");
  const rand = crypto.randomBytes(4).toString("hex");
  return `${ts}-${rand}`;
}

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

  // Hard allowlist for DMs (avoid being driven by random chats).
  if (!isGroup && TELEGRAM_ALLOWLIST_CHAT_ID && Number(chatId) !== TELEGRAM_ALLOWLIST_CHAT_ID) {
    return;
  }

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
      "",
      "For anything else: describe what you want. The bot will queue a job and reply later with the command output.",
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

  // Fast-path: "tail log(s)" in DMs returns the OpenClaw gateway internal log tail.
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

  // All other DMs: OpenAI planner -> queue JSONL job -> immediate ack.
  if (!isGroup && rawText) {
    const plan = await planOpsJobViaOpenAI({ envContext: makeEnvContext(), request: rawText });
    if (!plan.ok) {
      const text = `Planner error: ${plan.error}`;
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

    const job: OpsJobQueueItem = {
      id: newJobId(),
      ts: new Date().toISOString(),
      request: rawText,
      host: plan.job.host,
      cwd: plan.job.cwd ?? null,
      commands: plan.job.commands,
      timeoutSec: plan.job.timeoutSec,
      maxLines: plan.job.maxLines,
      replyTo: { channel: "telegram", chatId: String(chatId) },
    };

    try {
      await appendJobToQueue(job);
      const text = `Queued job ${job.id} on ${job.host}.`;
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
    } catch (e: any) {
      const text = `Failed to queue job: ${String(e?.message ?? e)}`;
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
