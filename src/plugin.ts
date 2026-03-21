/**
 * Dendrite v2 — OpenClaw Context Engine Plugin
 *
 * Entry point. Registers the context engine with OpenClaw's plugin API.
 * Types are imported as type-only; no runtime dependency on the SDK.
 */

import { Segmenter, callDriftModel, buildDriftPrompt } from "./segmenter.js";
import { scoreSegments, getEmbedding } from "./scorer.js";
import { generateSummary } from "./summarizer.js";
import { allocateBudgets, buildMessageArray } from "./assembler.js";
import {
  DEFAULT_CONFIG,
  estimateTokens,
  extractTextContent,
  type DendriteConfig,
  type SimpleMessage,
  type SegmentIndex,
} from "./types.js";
import { DendriteStore } from "./store.js";
import { SegmentPool } from "./segment-pool.js";
import { registerDendriteCli } from "./cli.js";

// ── AgentMessage <-> SimpleMessage conversion ──

function toSimpleMessage(msg: any, index: number): SimpleMessage | null {
  const role = msg.role;
  if (role !== "user" && role !== "assistant" && role !== "toolResult") return null;
  const content = extractTextContent(msg);
  if (!content) return null;
  return {
    id: msg.id || `msg_${index}_${msg.timestamp || Date.now()}`,
    role,
    content,
    timestamp: msg.timestamp || Date.now(),
  };
}

function toAgentMessage(msg: { role: string; content: string; timestamp: number }): any {
  if (msg.role === "system") {
    return null;
  }
  // Convert toolResult to user role when we don't have the original structural message.
  // This prevents emitting broken role:"tool" messages with no matching tool_call_id.
  const safeRole = msg.role === "toolResult" ? "user" : msg.role;
  const prefix = msg.role === "toolResult" ? "[Tool result] " : "";
  return {
    role: safeRole,
    content: [{ type: "text", text: prefix + msg.content }],
    timestamp: msg.timestamp,
  };
}

// ── Original message lookup for lossless assembly ──

function buildOriginalLookup(messages: any[]): Map<string, any[]> {
  const map = new Map<string, any[]>();
  for (const msg of messages) {
    const key = `${msg.role}:${msg.timestamp}`;
    const arr = map.get(key);
    if (arr) arr.push(msg);
    else map.set(key, [msg]);
  }
  return map;
}

function lookupOriginal(map: Map<string, any[]>, role: string, timestamp: number): any | null {
  const key = `${role}:${timestamp}`;
  const arr = map.get(key);
  if (!arr || arr.length === 0) return null;
  return arr.shift()!;
}

// ── Session state ──

interface SessionState {
  segmenter: Segmenter;
  config: DendriteConfig;
  queryEmbedding: number[];
  totalTurns: number;
  indexDirty: boolean;
  embeddingsAvailable: boolean;
  driftAvailable: boolean;
  sessionFile: string;
}

const sessions = new Map<string, SessionState>();

function createSessionState(config: DendriteConfig): SessionState {
  return {
    segmenter: new Segmenter({
      minMessagesBeforeDrift: config.minMessagesBeforeDrift,
      maxSegmentMessages: config.maxSegmentMessages,
      driftThreshold: config.driftThreshold,
    }),
    config,
    queryEmbedding: [],
    totalTurns: 0,
    indexDirty: false,
    embeddingsAvailable: true,
    driftAvailable: true,
    sessionFile: "",
  };
}

function getSession(sessionId: string, config: DendriteConfig): SessionState {
  let state = sessions.get(sessionId);
  if (!state) {
    state = createSessionState(config);
    sessions.set(sessionId, state);
  }
  return state;
}

// ── Plugin export ──

export default function dendrite(api: any) {
  const pluginConfig: DendriteConfig = { ...DEFAULT_CONFIG, ...(api.pluginConfig || {}) };

  // OpenClawConfig doesn't expose configDir/configPath — use standard ~/.openclaw location.
  const configDir = process.env.HOME + "/.openclaw";
  const configPath = configDir + "/openclaw.json";
  const store = new DendriteStore(configDir, configPath);
  const pool = new SegmentPool(configDir);

  const log = (msg: string, data?: any) => api.logger?.info?.(`dendrite: ${msg}${data ? " " + JSON.stringify(data) : ""}`);
  const debug = (msg: string, data?: any) => api.logger?.debug?.(`dendrite: ${msg}${data ? " " + JSON.stringify(data) : ""}`);

  // ── API key resolution (lazy, cached) ──
  let cachedOpenRouterKey: string | null = null;
  let cachedGoogleKey: string | null = null;

  async function getOpenRouterKey(): Promise<string> {
    if (cachedOpenRouterKey !== null) return cachedOpenRouterKey;
    let key = "";
    try {
      const auth = await api.runtime?.modelAuth?.resolveApiKeyForProvider?.({ provider: "openrouter" });
      key = auth?.apiKey || process.env.OPENROUTER_API_KEY || "";
    } catch {
      key = process.env.OPENROUTER_API_KEY || "";
    }
    cachedOpenRouterKey = key;
    debug("resolved openrouter key", { available: !!key });
    return key;
  }

  async function getGoogleKey(): Promise<string> {
    if (cachedGoogleKey !== null) return cachedGoogleKey;
    let key = "";
    try {
      const auth = await api.runtime?.modelAuth?.resolveApiKeyForProvider?.({ provider: "google" });
      key = auth?.apiKey || (auth as any)?.key || process.env.GEMINI_API_KEY || "";
    } catch {
      key = process.env.GEMINI_API_KEY || "";
    }
    cachedGoogleKey = key;
    debug("resolved google key", { available: !!key });
    return key;
  }

  debug("registering context engine", { driftModel: pluginConfig.driftModel, summaryModel: pluginConfig.summaryModel, embeddingModel: pluginConfig.embeddingModel });

  api.registerContextEngine("dendrite", () => ({
    info: {
      id: "dendrite",
      name: "Dendrite",
      ownsCompaction: true,
    },

    async bootstrap(params: { sessionId: string; sessionFile: string }) {
      debug("bootstrap called", { sessionId: params.sessionId, hasFile: !!params.sessionFile });
      const state = getSession(params.sessionId, pluginConfig);
      state.sessionFile = params.sessionFile || "";

      try {
        if (params.sessionFile) {
          const fs = await import("node:fs");
          const content = fs.readFileSync(params.sessionFile, "utf-8");
          const lines = content.split("\n").filter(Boolean);

          let lastIndex: SegmentIndex | null = null;
          const allSimpleMessages: SimpleMessage[] = [];

          for (let i = lines.length - 1; i >= 0; i--) {
            try {
              const entry = JSON.parse(lines[i]);
              if (entry.dendrite === "segment-index" && !lastIndex) {
                lastIndex = { version: entry.version, segments: entry.segments };
              }
            } catch { /* skip malformed lines */ }
          }

          let msgIndex = 0;
          for (const line of lines) {
            try {
              const entry = JSON.parse(line);
              if (entry.role === "user" || entry.role === "assistant" || entry.role === "toolResult") {
                const simple = toSimpleMessage(entry, msgIndex++);
                if (simple) allSimpleMessages.push(simple);
              }
            } catch { /* skip */ }
          }

          if (lastIndex) {
            state.segmenter.loadIndex(lastIndex, allSimpleMessages);
            state.totalTurns = allSimpleMessages.length;
            api.logger?.info?.(`dendrite: restored ${lastIndex.segments.length} segments from transcript`);
          }
        }
      } catch (err) {
        api.logger?.warn?.("dendrite: failed to restore from transcript, starting fresh", err);
      }

      return { bootstrapped: true };
    },

    async ingest(params: { sessionId: string; message: any; isHeartbeat?: boolean }) {
      debug("ingest called", { sessionId: params.sessionId, role: params.message?.role, isHeartbeat: params.isHeartbeat });
      if (params.isHeartbeat) return { ingested: false };

      const state = getSession(params.sessionId, pluginConfig);
      const simple = toSimpleMessage(params.message, state.totalTurns);
      if (!simple) return { ingested: false };

      state.totalTurns++;
      const result = state.segmenter.addMessage(simple);
      debug("addMessage result", { action: result.action, needsDriftCheck: result.needsDriftCheck, totalTurns: state.totalTurns, segments: state.segmenter.segments.length });

      if (result.needsDriftCheck && result.pendingMessage && state.driftAvailable) {
        try {
          const recent = state.segmenter.getRecentMessages(6);
          const { system, user } = buildDriftPrompt(recent, result.pendingMessage.content);
          const verdict = await callDriftModel(system, user, pluginConfig.driftModel, await getOpenRouterKey());

          debug("drift verdict", verdict);
          if (verdict.classification === "tangent" && verdict.confidence >= pluginConfig.driftThreshold) {
            const topic = verdict.suggested_topic || "tangent";
            log(`topic drift detected → new segment: "${topic}"`);
            state.segmenter.splitOnDrift(topic);
            state.indexDirty = true;

            const closedSeg = state.segmenter.segments[state.segmenter.segments.length - 2];
            if (closedSeg) {
              const segText = state.segmenter.getMessages(closedSeg.messageIds)
                .map(m => m.content).join(" ");
              const embedding = await getEmbedding(segText, pluginConfig.embeddingModel, await getGoogleKey());
              if (embedding.length > 0) {
                closedSeg.embedding = embedding;
              } else {
                state.embeddingsAvailable = false;
                log("embedding unavailable, falling back to recency-only scoring", { model: pluginConfig.embeddingModel });
              }

              // Eager summary generation for the closed segment
              if (!closedSeg.summary) {
                try {
                  const summaryMsgs = state.segmenter.getMessages(closedSeg.messageIds);
                  closedSeg.summary = await generateSummary(closedSeg.topic, summaryMsgs, pluginConfig.summaryModel, await getOpenRouterKey());
                  closedSeg.summaryTokens = estimateTokens(closedSeg.summary);
                } catch {
                  // Summary will be generated lazily in assemble() as fallback
                }
              }
            }

            // Persist to pool (only if we have a session file path)
            if (state.sessionFile) {
              try {
                pool.persistSession(params.sessionId, state.segmenter.segments, "default", state.sessionFile);
              } catch {
                // Non-critical
              }
            }
          }
        } catch (err: any) {
          state.driftAvailable = false;
          const errMsg = err?.message || err?.status || String(err);
          log("drift detection failed, disabling for session", { error: errMsg, model: pluginConfig.driftModel });
        }
      }

      if (result.action === "force-split") {
        state.indexDirty = true;

        // Eager summary for force-split closed segment
        const forceClosed = state.segmenter.segments[state.segmenter.segments.length - 2];
        if (forceClosed && !forceClosed.summary) {
          try {
            const summaryMsgs = state.segmenter.getMessages(forceClosed.messageIds);
            forceClosed.summary = await generateSummary(forceClosed.topic, summaryMsgs, pluginConfig.summaryModel, await getOpenRouterKey());
            forceClosed.summaryTokens = estimateTokens(forceClosed.summary);
          } catch { /* fallback in assemble */ }
        }
        // Compute embedding for force-split segment if missing
        if (forceClosed && forceClosed.embedding.length === 0) {
          const segText = state.segmenter.getMessages(forceClosed.messageIds).map(m => m.content).join(" ");
          const embedding = await getEmbedding(segText, pluginConfig.embeddingModel, await getGoogleKey());
          if (embedding.length > 0) forceClosed.embedding = embedding;
        }
        // Persist to pool (only if we have a session file path)
        if (state.sessionFile) {
          try {
            pool.persistSession(params.sessionId, state.segmenter.segments, "default", state.sessionFile);
          } catch { /* non-critical */ }
        }
      }

      if (state.totalTurns % 5 === 0) {
        const recentMsgs = state.segmenter.getRecentMessages(pluginConfig.queryWindowSize);
        const queryText = recentMsgs.map(m => m.content).join(" ");
        const embedding = await getEmbedding(queryText, pluginConfig.embeddingModel, await getGoogleKey());
        if (embedding.length > 0) {
          state.queryEmbedding = embedding;
        } else {
          state.embeddingsAvailable = false;
        }

        const active = state.segmenter.activeSegment;
        if (active) {
          const activeText = state.segmenter.getMessages(active.messageIds)
            .map(m => m.content).join(" ");
          const activeEmbed = await getEmbedding(activeText, pluginConfig.embeddingModel, await getGoogleKey());
          if (activeEmbed.length > 0) active.embedding = activeEmbed;
        }
      }

      if (state.indexDirty && api.addTranscriptEntry) {
        try {
          const index = state.segmenter.toIndex();
          await api.addTranscriptEntry({
            type: "custom",
            dendrite: "segment-index",
            version: index.version,
            segments: index.segments,
          });
          state.indexDirty = false;
        } catch (err) {
          api.logger?.warn?.("dendrite: failed to persist segment index", err);
        }
      }

      return { ingested: true };
    },

    async assemble(params: { sessionId: string; messages: any[]; tokenBudget?: number }) {
      const state = getSession(params.sessionId, pluginConfig);
      const currentSegments = state.segmenter.segments;
      const segments = pool.getCombinedSegments(currentSegments, params.sessionId);
      debug("assemble called", { sessionId: params.sessionId, segments: segments.length, tokenBudget: params.tokenBudget, msgCount: params.messages?.length });

      if (segments.length < 2) {
        debug("passthrough — fewer than 2 segments");
        return {
          messages: params.messages,
          estimatedTokens: params.messages.reduce((sum: number, m: any) =>
            sum + estimateTokens(extractTextContent(m)), 0),
        };
      }

      const tokenBudget = params.tokenBudget || 32000;
      const effectiveAlpha = state.embeddingsAvailable ? pluginConfig.relevanceAlpha : 0;

      const scored = scoreSegments(
        segments,
        state.queryEmbedding,
        pluginConfig.recencyHalfLifeMs,
        effectiveAlpha
      );

      let summarizedThisTurn = 0;
      for (const entry of scored) {
        const seg = entry.segment;
        if (seg.status === "closed" && !seg.summary && summarizedThisTurn < 1) {
          // Skip cross-session segments — they can't be lazily summarized here
          if (seg.sessionId && seg.transcriptPath) continue;
          const msgs = state.segmenter.getMessages(seg.messageIds);
          seg.summary = await generateSummary(seg.topic, msgs, pluginConfig.summaryModel, await getOpenRouterKey());
          seg.summaryTokens = estimateTokens(seg.summary);
          summarizedThisTurn++;
        }
      }

      // Find the most recent N closed segments from the current session for pinning
      const currentClosed = currentSegments
        .filter(s => s.status === "closed")
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
        .slice(0, pluginConfig.pinRecentSegments);
      const pinnedSegmentIds = currentClosed.map(s => s.id);

      const budgets = allocateBudgets(scored, tokenBudget - pluginConfig.reserveTokens, pluginConfig.reserveTokens, {
        currentSessionId: params.sessionId,
        pinRecentSegments: pluginConfig.pinRecentSegments,
        maxCrossSessionBudgetRatio: pluginConfig.maxCrossSessionBudgetRatio,
        pinnedSegmentIds,
      });
      const assembled = buildMessageArray(budgets, (ids, segment) => {
        if (segment.sessionId && segment.transcriptPath) {
          return pool.loadMessages(segment.transcriptPath, ids);
        }
        return state.segmenter.getMessages(ids);
      });

      const systemPreamble = assembled.filter(m => m.role === "system").map(m => m.content).join("\n\n");
      const originalLookup = buildOriginalLookup(params.messages);
      const conversationMessages = assembled
        .filter(m => m.role !== "system")
        .map(m => {
          const original = lookupOriginal(originalLookup, m.role, m.timestamp);
          return original || toAgentMessage(m);
        })
        .filter(Boolean);

      const estimatedTokens = budgets.reduce((sum, b) => sum + b.allocatedTokens, 0);

      const fallbacks: string[] = [];
      if (!state.embeddingsAvailable) fallbacks.push("embedding-unavailable:recency-only");
      if (summarizedThisTurn > 0) fallbacks.push(`summaries-generated:${summarizedThisTurn}`);

      if (api.addTranscriptEntry) {
        try {
          await api.addTranscriptEntry({
            type: "custom",
            dendrite: "assembly-log",
            contextWindow: tokenBudget,
            budgetUsed: estimatedTokens,
            segments: budgets.map(b => ({
              id: b.segment.id,
              tier: b.tier,
              tokens: b.allocatedTokens,
            })),
            fallbacks,
          });
        } catch {
          // Non-critical
        }
      }

      // Persist turn snapshot for CLI peek tool
      try {
        const assembledText = [
          systemPreamble || "",
          ...conversationMessages.map((m: any) => `${m.role}: ${typeof m.content === "string" ? m.content : ""}`),
        ].filter(Boolean).join("\n\n");

        store.persistTurn({
          timestamp: Date.now(),
          turnIndex: state.totalTurns,
          sessionId: params.sessionId,
          segments: budgets.map(b => ({
            id: b.segment.id,
            topic: b.segment.topic,
            status: b.segment.status,
            messageCount: b.segment.messageCount,
            tokenCount: b.segment.tokenCount,
            summary: b.segment.summary,
            tier: b.tier,
            allocatedTokens: b.allocatedTokens,
            compositeScore: b.scored.score,
            semanticScore: b.scored.semanticScore,
            recencyScore: b.scored.recencyScoreValue,
          })),
          assembledContext: assembledText,
          stats: {
            tokenBudget,
            tokensUsed: estimatedTokens,
            segmentsTotal: segments.length,
            segmentsIncluded: budgets.filter(b => b.tier !== "excluded").length,
            segmentsExcluded: budgets.filter(b => b.tier === "excluded").length,
            embeddingsAvailable: state.embeddingsAvailable,
            driftAvailable: state.driftAvailable,
            fallbacks,
          },
        });
      } catch (err) {
        debug("failed to persist turn snapshot", { error: String(err) });
      }

      return {
        messages: conversationMessages,
        estimatedTokens,
        systemPromptAddition: systemPreamble || undefined,
      };
    },

    async compact() {
      debug("compact called (noop)");
      return { ok: true, compacted: false };
    },

    async dispose() {
      // No-op: OpenClaw calls dispose() after every turn, but session state
      // must persist across turns for segmentation to work. The sessions Map
      // is cleaned up when the process exits.
      debug("dispose called (no-op, state preserved)");
    },
  }));

  // ── CLI registration ──
  // Registrar must be synchronous — OpenClaw doesn't await async registrars.
  api.registerCli(
    ({ program, config, logger }: { program: any; config: any; logger: any }) => {
      registerDendriteCli({ program, config, logger });
    },
    { commands: ["dendrite"] }
  );
}
