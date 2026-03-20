import type { Segment, SimpleMessage } from "./types.js";
import { estimateTokens } from "./types.js";
import type { ScoredSegment } from "./scorer.js";

export type Tier = "active" | "full" | "partial" | "summary" | "excluded";

export interface BudgetAllocation {
  segment: Segment;
  tier: Tier;
  allocatedTokens: number;
  scored: ScoredSegment;
}

export interface AllocateOptions {
  currentSessionId: string | undefined;
  pinRecentSegments: number;
  maxCrossSessionBudgetRatio: number;
  pinnedSegmentIds: string[];
}

/**
 * Allocate token budgets to scored segments.
 *
 * The caller should pass `totalBudget` as `contextWindow - reserveTokens`.
 * `reserveTokens` is the guaranteed floor for the active segment.
 * Active segment gets at least `reserveTokens` worth of its most recent messages.
 * Other segments compete for the remaining budget after the active segment.
 *
 * When `options` is provided:
 * - Pinned segments (by ID) are allocated before other current-session segments.
 * - Cross-session segments (sessionId !== undefined) are capped at
 *   `totalBudget * maxCrossSessionBudgetRatio` tokens in aggregate.
 */
export function allocateBudgets(
  scored: ScoredSegment[],
  totalBudget: number,
  reserveTokens: number,
  options?: AllocateOptions
): BudgetAllocation[] {
  const allocations: BudgetAllocation[] = [];
  const opts = options || { currentSessionId: undefined, pinRecentSegments: 0, maxCrossSessionBudgetRatio: 1.0, pinnedSegmentIds: [] };
  const pinnedIds = new Set(opts.pinnedSegmentIds);
  const crossSessionBudget = totalBudget * opts.maxCrossSessionBudgetRatio;
  let crossSessionUsed = 0;

  const activeBudget = totalBudget + reserveTokens;
  let remaining = totalBudget;

  // Separate into groups matching the spec's allocation order:
  // 1. Active, 2. Pinned recent, 3. Current-session rest, 4. Cross-session
  const active: ScoredSegment[] = [];
  const pinned: ScoredSegment[] = [];
  const currentRest: ScoredSegment[] = [];
  const crossSession: ScoredSegment[] = [];

  for (const entry of scored) {
    if (entry.segment.status === "active") {
      active.push(entry);
    } else if (pinnedIds.has(entry.segment.id)) {
      pinned.push(entry);
    } else if (entry.segment.sessionId !== undefined) {
      crossSession.push(entry);
    } else {
      currentRest.push(entry);
    }
  }

  // Process order: active → pinned → current-session → cross-session
  const ordered = [...active, ...pinned, ...currentRest, ...crossSession];

  for (const entry of ordered) {
    const seg = entry.segment;
    const isCrossSession = seg.sessionId !== undefined;

    if (seg.status === "active") {
      const tokens = Math.min(seg.tokenCount, activeBudget);
      const sharedUsed = Math.max(0, tokens - reserveTokens);
      remaining -= sharedUsed;
      allocations.push({ segment: seg, tier: "active", allocatedTokens: tokens, scored: entry });
      continue;
    }

    if (remaining <= 0) {
      allocations.push({ segment: seg, tier: "excluded", allocatedTokens: 0, scored: entry });
      continue;
    }

    // For cross-session segments, check budget cap
    const crossRemaining = isCrossSession ? crossSessionBudget - crossSessionUsed : Infinity;
    const effectiveRemaining = Math.min(remaining, isCrossSession ? crossRemaining : Infinity);

    if (effectiveRemaining <= 0) {
      allocations.push({ segment: seg, tier: "excluded", allocatedTokens: 0, scored: entry });
      continue;
    }

    // Try full expansion
    if (seg.tokenCount <= effectiveRemaining) {
      const tokens = seg.tokenCount;
      allocations.push({ segment: seg, tier: "full", allocatedTokens: tokens, scored: entry });
      remaining -= tokens;
      if (isCrossSession) crossSessionUsed += tokens;
      continue;
    }

    // Try summary + partial
    const summaryTokens = seg.summary ? seg.summaryTokens : 0;
    if (summaryTokens > 0 && summaryTokens < effectiveRemaining) {
      const partialBudget = effectiveRemaining - summaryTokens;
      if (partialBudget > 50) {
        const tokens = summaryTokens + partialBudget;
        allocations.push({ segment: seg, tier: "partial", allocatedTokens: tokens, scored: entry });
        remaining -= tokens;
        if (isCrossSession) crossSessionUsed += tokens;
        continue;
      }
    }

    // Summary only
    if (seg.summary && seg.summaryTokens <= effectiveRemaining) {
      allocations.push({ segment: seg, tier: "summary", allocatedTokens: seg.summaryTokens, scored: entry });
      remaining -= seg.summaryTokens;
      if (isCrossSession) crossSessionUsed += seg.summaryTokens;
      continue;
    }

    // Pinned segments are guaranteed at least summary tier by processing order
    // (they run before other segments and get first access to budget).
    // If we reach here, budget is truly exhausted.
    allocations.push({ segment: seg, tier: "excluded", allocatedTokens: 0, scored: entry });
  }

  return allocations;
}

/**
 * Lightweight message type returned by the assembler.
 * Converted to AgentMessage by the plugin layer.
 */
export interface AssembledMessage {
  role: "system" | "user" | "assistant" | "toolResult";
  content: string;
  timestamp: number;
}

/**
 * Build the final message array from budget allocations.
 *
 * @param allocations — sorted budget allocations (active first)
 * @param getMessages — function to retrieve messages by IDs
 */
export function buildMessageArray(
  allocations: BudgetAllocation[],
  getMessages: (ids: string[], segment: Segment) => SimpleMessage[]
): AssembledMessage[] {
  const result: AssembledMessage[] = [];

  // Collect summaries for the preamble
  const summaryBlocks: string[] = [];
  const partialSegments: { allocation: BudgetAllocation; messages: SimpleMessage[] }[] = [];
  let activeMessages: SimpleMessage[] = [];
  const fullSegmentMessages: { segment: Segment; messages: SimpleMessage[] }[] = [];

  for (const alloc of allocations) {
    switch (alloc.tier) {
      case "active": {
        activeMessages = getMessages(alloc.segment.messageIds, alloc.segment);
        // If active exceeds budget, take most recent messages
        if (alloc.allocatedTokens < alloc.segment.tokenCount) {
          let tokens = 0;
          const trimmed: SimpleMessage[] = [];
          for (let i = activeMessages.length - 1; i >= 0; i--) {
            const msgTokens = estimateTokens(activeMessages[i].content);
            if (tokens + msgTokens > alloc.allocatedTokens) break;
            trimmed.unshift(activeMessages[i]);
            tokens += msgTokens;
          }
          activeMessages = trimmed;
        }
        break;
      }
      case "full": {
        const msgs = getMessages(alloc.segment.messageIds, alloc.segment);
        fullSegmentMessages.push({ segment: alloc.segment, messages: msgs });
        break;
      }
      case "partial": {
        const msgs = getMessages(alloc.segment.messageIds, alloc.segment);
        // Take summary + recent messages that fit
        summaryBlocks.push(`[Prior context — ${alloc.segment.topic}: ${alloc.segment.summary}]`);
        const recentBudget = alloc.allocatedTokens - (alloc.segment.summaryTokens || 0);
        let tokens = 0;
        const recent: SimpleMessage[] = [];
        for (let i = msgs.length - 1; i >= 0; i--) {
          const t = estimateTokens(msgs[i].content);
          if (tokens + t > recentBudget) break;
          recent.unshift(msgs[i]);
          tokens += t;
        }
        partialSegments.push({ allocation: alloc, messages: recent });
        break;
      }
      case "summary": {
        const text = alloc.segment.summary || `${alloc.segment.topic}: ~${alloc.segment.messageCount} messages`;
        summaryBlocks.push(`[Prior context — ${alloc.segment.topic}: ${text}]`);
        break;
      }
      // "excluded" — nothing added
    }
  }

  // Step 1: System preamble with all summaries
  if (summaryBlocks.length > 0) {
    result.push({
      role: "system",
      content: summaryBlocks.join("\n\n"),
      timestamp: 0,
    });
  }

  // Step 2: Full expansion segments (chronologically by first message timestamp)
  fullSegmentMessages.sort((a, b) => (a.messages[0]?.timestamp || 0) - (b.messages[0]?.timestamp || 0));
  for (const { messages } of fullSegmentMessages) {
    for (const msg of messages) {
      result.push({ role: msg.role, content: msg.content, timestamp: msg.timestamp });
    }
  }

  // Step 3: Partial segments (recent messages)
  for (const { messages } of partialSegments) {
    for (const msg of messages) {
      result.push({ role: msg.role, content: msg.content, timestamp: msg.timestamp });
    }
  }

  // Step 4: Active segment messages (always last, in full)
  for (const msg of activeMessages) {
    result.push({ role: msg.role, content: msg.content, timestamp: msg.timestamp });
  }

  return result;
}
