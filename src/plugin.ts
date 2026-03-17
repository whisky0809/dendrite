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
  isUserMessage,
  type DendriteConfig,
  type SimpleMessage,
  type SegmentIndex,
} from "./types.js";

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
  return {
    role: msg.role as "user" | "assistant",
    content: msg.content,
    timestamp: msg.timestamp,
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
  const pluginConfig: DendriteConfig = { ...DEFAULT_CONFIG, ...(api.config?.dendrite || {}) };

  api.registerContextEngine("dendrite", () => ({
    info: {
      id: "dendrite",
      name: "Dendrite",
      ownsCompaction: true,
    },

    async bootstrap(params: { sessionId: string; sessionFile: string }) {
      const state = getSession(params.sessionId, pluginConfig);

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
      if (params.isHeartbeat) return { ingested: false };

      const state = getSession(params.sessionId, pluginConfig);
      const simple = toSimpleMessage(params.message, state.totalTurns);
      if (!simple) return { ingested: false };

      state.totalTurns++;
      const result = state.segmenter.addMessage(simple);

      if (result.needsDriftCheck && result.pendingMessage) {
        try {
          const recent = state.segmenter.getRecentMessages(6);
          const { system, user } = buildDriftPrompt(recent, result.pendingMessage.content);
          const verdict = await callDriftModel(system, user, pluginConfig.driftModel);

          if (verdict.classification === "tangent" && verdict.confidence >= pluginConfig.driftThreshold) {
            const topic = verdict.suggested_topic || "tangent";
            state.segmenter.splitOnDrift(topic);
            state.indexDirty = true;

            const closedSeg = state.segmenter.segments[state.segmenter.segments.length - 2];
            if (closedSeg) {
              const segText = state.segmenter.getMessages(closedSeg.messageIds)
                .map(m => m.content).join(" ");
              const embedding = await getEmbedding(segText, pluginConfig.embeddingModel);
              if (embedding.length > 0) {
                closedSeg.embedding = embedding;
              } else {
                state.embeddingsAvailable = false;
                api.logger?.warn?.("dendrite: embedding unavailable, falling back to recency-only scoring");
              }
            }
          }
        } catch (err) {
          api.logger?.warn?.("dendrite: drift detection failed", err);
        }
      }

      if (result.action === "force-split") {
        state.indexDirty = true;
      }

      if (state.totalTurns % 5 === 0) {
        const recentMsgs = state.segmenter.getRecentMessages(pluginConfig.queryWindowSize);
        const queryText = recentMsgs.map(m => m.content).join(" ");
        const embedding = await getEmbedding(queryText, pluginConfig.embeddingModel);
        if (embedding.length > 0) {
          state.queryEmbedding = embedding;
        } else {
          state.embeddingsAvailable = false;
        }

        const active = state.segmenter.activeSegment;
        if (active) {
          const activeText = state.segmenter.getMessages(active.messageIds)
            .map(m => m.content).join(" ");
          const activeEmbed = await getEmbedding(activeText, pluginConfig.embeddingModel);
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
      const segments = state.segmenter.segments;

      if (segments.length < 2) {
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
        state.totalTurns,
        effectiveAlpha
      );

      let summarizedThisTurn = 0;
      for (const entry of scored) {
        const seg = entry.segment;
        if (seg.status === "closed" && !seg.summary && summarizedThisTurn < 1) {
          const msgs = state.segmenter.getMessages(seg.messageIds);
          seg.summary = await generateSummary(seg.topic, msgs, pluginConfig.summaryModel);
          seg.summaryTokens = estimateTokens(seg.summary);
          summarizedThisTurn++;
        }
      }

      const budgets = allocateBudgets(scored, tokenBudget - pluginConfig.reserveTokens, pluginConfig.reserveTokens);
      const assembled = buildMessageArray(budgets, (ids) => state.segmenter.getMessages(ids));

      const systemPreamble = assembled.filter(m => m.role === "system").map(m => m.content).join("\n\n");
      const conversationMessages = assembled
        .filter(m => m.role !== "system")
        .map(m => toAgentMessage(m))
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

      return {
        messages: conversationMessages,
        estimatedTokens,
        systemPromptAddition: systemPreamble || undefined,
      };
    },

    async compact() {
      return { ok: true, compacted: false };
    },

    async dispose() {
      sessions.clear();
    },
  }));
}
