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

/**
 * Allocate token budgets to scored segments.
 *
 * The caller should pass `totalBudget` as `contextWindow - reserveTokens`.
 * `reserveTokens` is the guaranteed floor for the active segment.
 * Active segment gets at least `reserveTokens` worth of its most recent messages.
 * Other segments compete for the remaining budget after the active segment.
 */
export function allocateBudgets(
  scored: ScoredSegment[],
  totalBudget: number,
  reserveTokens: number
): BudgetAllocation[] {
  const allocations: BudgetAllocation[] = [];

  // Active segment gets reserveTokens as a guaranteed floor, plus any
  // additional budget needed (up to its full size).
  // Total available for active = totalBudget + reserveTokens.
  const activeBudget = totalBudget + reserveTokens;
  let remaining = totalBudget; // remaining for non-active segments

  for (const entry of scored) {
    const seg = entry.segment;

    if (seg.status === "active") {
      // Active segment: guaranteed at least reserveTokens, up to full size
      const tokens = Math.min(seg.tokenCount, activeBudget);
      // Any tokens beyond reserveTokens come from the shared budget
      const sharedUsed = Math.max(0, tokens - reserveTokens);
      remaining -= sharedUsed;
      allocations.push({ segment: seg, tier: "active", allocatedTokens: tokens, scored: entry });
      continue;
    }

    if (remaining <= 0) {
      allocations.push({ segment: seg, tier: "excluded", allocatedTokens: 0, scored: entry });
      continue;
    }

    // Try full expansion
    if (seg.tokenCount <= remaining) {
      allocations.push({ segment: seg, tier: "full", allocatedTokens: seg.tokenCount, scored: entry });
      remaining -= seg.tokenCount;
      continue;
    }

    // Try summary + partial (recent messages)
    const summaryTokens = seg.summary ? seg.summaryTokens : 0;
    if (summaryTokens > 0 && summaryTokens < remaining) {
      // Give summary + as many recent messages as fit
      const partialBudget = remaining - summaryTokens;
      if (partialBudget > 50) {
        allocations.push({ segment: seg, tier: "partial", allocatedTokens: summaryTokens + partialBudget, scored: entry });
        remaining -= summaryTokens + partialBudget;
        continue;
      }
    }

    // Summary only
    if (seg.summary && seg.summaryTokens <= remaining) {
      allocations.push({ segment: seg, tier: "summary", allocatedTokens: seg.summaryTokens, scored: entry });
      remaining -= seg.summaryTokens;
      continue;
    }

    // Excluded
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
  getMessages: (ids: string[]) => SimpleMessage[]
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
        activeMessages = getMessages(alloc.segment.messageIds);
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
        const msgs = getMessages(alloc.segment.messageIds);
        fullSegmentMessages.push({ segment: alloc.segment, messages: msgs });
        break;
      }
      case "partial": {
        const msgs = getMessages(alloc.segment.messageIds);
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
