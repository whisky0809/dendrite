/**
 * Dendrite v3 — OpenClaw Context Engine Plugin
 *
 * Entry point. Registers the context engine with OpenClaw's plugin API.
 * Types are imported as type-only; no runtime dependency on the SDK.
 */

import { Segmenter, callDriftModel, buildDriftPrompt } from "./segmenter.js";
import { scoreSegments, getEmbedding } from "./scorer.js";
import { generateSummary } from "./summarizer.js";
import { allocateBudgets, buildSelectionPlan } from "./assembler.js";
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
  let content = extractTextContent(msg);
  // Assistant messages with only tool calls have no text content.
  // Generate a placeholder so they're tracked by the segmenter and stay
  // paired with their toolResult messages.
  if (!content && role === "assistant" && Array.isArray(msg.content)) {
    const toolCalls = msg.content.filter((b: any) => b.type === "toolCall");
    if (toolCalls.length > 0) {
      const names = toolCalls.map((t: any) => t.name || "unknown").join(", ");
      content = `[Tool calls: ${names}]`;
    }
  }
  if (!content) return null;
  return {
    id: msg.id || `msg_${index}_${msg.timestamp || Date.now()}`,
    role,
    content,
    timestamp: msg.timestamp || Date.now(),
  };
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

/**
 * Reconcile segment messages with params.messages indices.
 * Uses (timestamp, role) matching with ordered consumption.
 */
function reconcileIndices(
  segments: import("./types.js").Segment[],
  segmenter: Segmenter,
  paramsMessages: any[]
): { trackedOriginalIndices: Set<number>; indexToSegmentId: Map<number, string> } {
  // Build lookup: (timestamp:role) → list of params.messages indices
  const lookup = new Map<string, number[]>();
  for (let i = 0; i < paramsMessages.length; i++) {
    const msg = paramsMessages[i];
    const key = `${msg.timestamp}:${msg.role}`;
    const arr = lookup.get(key);
    if (arr) arr.push(i);
    else lookup.set(key, [i]);
  }

  const trackedOriginalIndices = new Set<number>();
  const indexToSegmentId = new Map<number, string>();

  // Clear stale originalIndex values from previous assemble() calls
  for (const seg of segments) {
    for (const msgId of seg.messageIds) {
      const simple = segmenter.getMessage(msgId);
      if (simple) simple.originalIndex = undefined;
    }
  }

  for (const seg of segments) {
    for (const msgId of seg.messageIds) {
      const simple = segmenter.getMessage(msgId);
      if (!simple) continue;
      const key = `${simple.timestamp}:${simple.role}`;
      const candidates = lookup.get(key);
      if (candidates && candidates.length > 0) {
        simple.originalIndex = candidates.shift()!;
        trackedOriginalIndices.add(simple.originalIndex);
        indexToSegmentId.set(simple.originalIndex, seg.id);
        if (candidates.length === 0) lookup.delete(key);
      } else {
        simple.originalIndex = undefined;
      }
    }
  }

  return { trackedOriginalIndices, indexToSegmentId };
}

// ── Plugin export ──

export default function dendrite(api: any) {
  const pluginConfig: DendriteConfig = { ...DEFAULT_CONFIG, ...(api.pluginConfig || {}) };

  // OpenClawConfig doesn't expose configDir/configPath — use standard ~/.openclaw location.
  const configDir = process.env.HOME + "/.openclaw";
  const configPath = configDir + "/openclaw.json";
  const store = new DendriteStore(configDir, configPath);
  const pool = new SegmentPool(configDir);

  const log = (msg: string, data?: any) => {
    api.logger?.info?.(`dendrite: ${msg}${data ? " " + JSON.stringify(data) : ""}`);
  };
  const debug = (msg: string, data?: any) => {
    api.logger?.debug?.(`dendrite: ${msg}${data ? " " + JSON.stringify(data) : ""}`);
  };

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

  /** Pick the right API key for the configured embedding model. */
  async function getEmbeddingKey(): Promise<string> {
    const model = pluginConfig.embeddingModel;
    // Models with "/" are OpenRouter-routed (e.g. "qwen/qwen3-embedding-8b")
    if (model.includes("/")) {
      return getOpenRouterKey();
    }
    return getGoogleKey();
  }

  log("registering context engine", { driftModel: pluginConfig.driftModel, summaryModel: pluginConfig.summaryModel, embeddingModel: pluginConfig.embeddingModel });

  api.registerContextEngine("dendrite", () => ({
    info: {
      id: "dendrite",
      name: "Dendrite",
      ownsCompaction: true,
    },

    async bootstrap(params: { sessionId: string; sessionFile: string }) {
      log("bootstrap called", { sessionId: params.sessionId, hasFile: !!params.sessionFile });
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
              // JSONL entries wrap the message: {type:"message", message:{role, content, ...}}
              const msg = entry.type === "message" && entry.message ? entry.message : entry;
              const role = msg.role;
              if (role === "user" || role === "assistant" || role === "toolResult") {
                const simple = toSimpleMessage(msg, msgIndex++);
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
              const embedding = await getEmbedding(segText, pluginConfig.embeddingModel, await getEmbeddingKey());
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
          const embedding = await getEmbedding(segText, pluginConfig.embeddingModel, await getEmbeddingKey());
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
        const embedding = await getEmbedding(queryText, pluginConfig.embeddingModel, await getEmbeddingKey());
        if (embedding.length > 0) {
          state.queryEmbedding = embedding;
        } else {
          state.embeddingsAvailable = false;
        }

        const active = state.segmenter.activeSegment;
        if (active) {
          const activeText = state.segmenter.getMessages(active.messageIds)
            .map(m => m.content).join(" ");
          const activeEmbed = await getEmbedding(activeText, pluginConfig.embeddingModel, await getEmbeddingKey());
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
      log("assemble called", { sessionId: params.sessionId, segments: segments.length, tokenBudget: params.tokenBudget, msgCount: params.messages?.length });

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

      // ── Reconcile segment messages with params.messages indices ──
      const { trackedOriginalIndices, indexToSegmentId } = reconcileIndices(
        currentSegments, state.segmenter, params.messages
      );

      const budgets = allocateBudgets(scored, tokenBudget - pluginConfig.reserveTokens, pluginConfig.reserveTokens, {
        currentSessionId: params.sessionId,
        pinRecentSegments: pluginConfig.pinRecentSegments,
        maxCrossSessionBudgetRatio: pluginConfig.maxCrossSessionBudgetRatio,
        pinnedSegmentIds,
      });

      // ── Build selection plan ──
      const estimateAgentTokens = (msg: any) => estimateTokens(extractTextContent(msg));

      const plan = buildSelectionPlan(budgets, (segment) => {
        return segment.messageIds
          .map(id => state.segmenter.getMessage(id)?.originalIndex)
          .filter((i): i is number => i !== undefined);
      }, params.messages, estimateAgentTokens);

      // Include untracked messages (system prompts, metadata, etc.)
      const selectedSet = new Set(plan.indices);
      const untracked: number[] = [];
      for (let i = 0; i < params.messages.length; i++) {
        if (!trackedOriginalIndices.has(i) && !selectedSet.has(i)) {
          untracked.push(i);
        }
      }
      const allIndices = [...plan.indices, ...untracked].sort((a, b) => a - b);
      const conversationMessages = allIndices.map(i => params.messages[i]);

      const systemPreamble = plan.summaryBlocks.join("\n\n");
      const estimatedTokens = budgets.reduce((sum, b) => sum + b.allocatedTokens, 0);

      log("assemble", {
        segments: segments.length,
        selected: plan.indices.length,
        untracked: untracked.length,
        output: conversationMessages.length,
      });

      // ── Observability ──
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
            segments: plan.segmentPlans.map(sp => ({
              id: sp.segmentId,
              tier: sp.tier,
              included: sp.includedCount,
              total: sp.totalCount,
            })),
            fallbacks,
          });
        } catch { /* non-critical */ }
      }

      // ── Turn snapshot ──
      try {
        const snapshotMessages: import("./types.js").TurnSnapshotMessage[] = [];
        for (const idx of allIndices) {
          const msg = params.messages[idx];
          if (msg.role === "system") continue;
          const text = extractTextContent(msg);
          snapshotMessages.push({
            role: msg.role as "user" | "assistant" | "toolResult",
            segmentId: indexToSegmentId.get(idx) ?? null,
            tokenCount: estimateTokens(text),
            contentPreview: text.slice(0, 200),
            contentFull: text,
          });
        }

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
          messages: snapshotMessages,
          systemPreamble: systemPreamble || "",
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
