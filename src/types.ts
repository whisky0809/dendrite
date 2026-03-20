/**
 * Dendrite v2 types.
 *
 * We define our own lightweight message types for internal use.
 * The plugin.ts entry point handles conversion to/from AgentMessage.
 */

import { randomUUID } from "node:crypto";
import type { Tier } from "./assembler.js";

// ── Segment ──

export interface Segment {
  id: string;
  topic: string;
  embedding: number[];
  messageIds: string[];
  messageCount: number;
  tokenCount: number;
  summary: string | null;
  summaryTokens: number;
  lastActiveAt: number;
  status: "active" | "closed";
  sessionId?: string;
  transcriptPath?: string;
}

export interface SegmentIndex {
  version: 1;
  segments: Segment[];
}

export function createSegment(topic: string): Segment {
  return {
    id: `seg_${randomUUID().slice(0, 12)}`,
    topic,
    embedding: [],
    messageIds: [],
    messageCount: 0,
    tokenCount: 0,
    summary: null,
    summaryTokens: 0,
    lastActiveAt: Date.now(),
    status: "active",
  };
}

// ── Config ──

export interface DendriteConfig {
  driftModel: string;
  summaryModel: string;
  embeddingModel: string;
  driftThreshold: number;
  minMessagesBeforeDrift: number;
  relevanceAlpha: number;
  reserveTokens: number;
  maxSegmentMessages: number;
  queryWindowSize: number;
  pinRecentSegments: number;
  maxCrossSessionBudgetRatio: number;
  recencyHalfLifeMs: number;
}

export const DEFAULT_CONFIG: DendriteConfig = {
  driftModel: "nvidia/nemotron-3-super-120b-a12b:free",
  summaryModel: "nvidia/nemotron-3-super-120b-a12b:free",
  embeddingModel: "gemini-embedding-001",
  driftThreshold: 0.7,
  minMessagesBeforeDrift: 3,
  relevanceAlpha: 0.7,
  reserveTokens: 16384,
  maxSegmentMessages: 80,
  queryWindowSize: 5,
  pinRecentSegments: 3,
  maxCrossSessionBudgetRatio: 0.3,
  recencyHalfLifeMs: 86400000,
};

// ── Turn snapshot (persisted by CLI store) ──

export interface TurnSnapshotSegment {
  id: string;
  topic: string;
  status: "active" | "closed";
  messageCount: number;
  tokenCount: number;
  summary: string | null;
  tier: Tier;
  allocatedTokens: number;
  compositeScore: number;
  semanticScore: number;
  recencyScore: number;
}

export interface TurnSnapshot {
  timestamp: number;
  turnIndex: number;
  sessionId: string;
  segments: TurnSnapshotSegment[];
  assembledContext: string;
  stats: {
    tokenBudget: number;
    tokensUsed: number;
    segmentsTotal: number;
    segmentsIncluded: number;
    segmentsExcluded: number;
    embeddingsAvailable: boolean;
    driftAvailable: boolean;
    fallbacks: string[];
  };
}

// ── Message helpers ──

// Lightweight message representation for internal use.
// plugin.ts converts AgentMessage <-> SimpleMessage at the boundary.

export interface SimpleMessage {
  id: string;
  role: "user" | "assistant" | "toolResult";
  content: string;
  timestamp: number;
}

/** Estimate tokens from a string using chars/4 heuristic. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Extract plain text from a message (handles both string and array content).
 * Works with UserMessage, AssistantMessage, and ToolResultMessage shapes.
 */
export function extractTextContent(msg: { role: string; content: unknown }): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((block: any) => block.type === "text")
      .map((block: any) => block.text)
      .join("");
  }
  return "";
}

/** Check if a message is a user message. */
export function isUserMessage(msg: { role: string }): boolean {
  return msg.role === "user";
}
