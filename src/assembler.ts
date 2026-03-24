import type { Segment } from "./types.js";
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
  options: AllocateOptions
): BudgetAllocation[] {
  const allocations: BudgetAllocation[] = [];
  const pinnedIds = new Set(options.pinnedSegmentIds);
  const crossSessionBudget = totalBudget * options.maxCrossSessionBudgetRatio;
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

    // Cross-session segments: summary-only (never full/partial)
    if (isCrossSession) {
      if (seg.summary && seg.summaryTokens <= remaining) {
        allocations.push({ segment: seg, tier: "summary", allocatedTokens: seg.summaryTokens, scored: entry });
        remaining -= seg.summaryTokens;
      } else {
        allocations.push({ segment: seg, tier: "excluded", allocatedTokens: 0, scored: entry });
      }
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
 * Select indices for partial-tier segments, preserving tool groups.
 * Walks backward from the end, including complete groups that fit the budget.
 * A tool group = one assistant message + all immediately following toolResult messages.
 * Orphaned toolResults (no parent assistant in this segment) are skipped.
 */
export function selectPartialIndices(
  indices: number[],
  messages: any[],
  tokenBudget: number,
  estimateTokensFn: (msg: any) => number
): number[] {
  const selected: number[] = [];
  let tokens = 0;
  let i = indices.length - 1;

  while (i >= 0) {
    const group: number[] = [];
    const role = messages[indices[i]]?.role;

    if (role === "toolResult") {
      // Collect all consecutive toolResults
      while (i >= 0 && messages[indices[i]]?.role === "toolResult") {
        group.unshift(indices[i]);
        i--;
      }
      // Parent assistant must be next. If not, these are orphaned — skip.
      if (i >= 0 && messages[indices[i]]?.role === "assistant") {
        group.unshift(indices[i]);
        i--;
      } else {
        continue; // skip orphaned toolResults
      }
    } else {
      // Standalone user or assistant
      group.push(indices[i]);
      i--;
    }

    const groupTokens = group.reduce(
      (sum, idx) => sum + estimateTokensFn(messages[idx]), 0
    );
    if (tokens + groupTokens > tokenBudget) break;

    selected.unshift(...group);
    tokens += groupTokens;
  }

  return selected;
}

export interface SelectionPlan {
  /** Ordered indices into params.messages to include (sorted ascending) */
  indices: number[];
  /** Summary text blocks for systemPromptAddition */
  summaryBlocks: string[];
  /** Per-segment metadata for logging */
  segmentPlans: Array<{
    segmentId: string;
    tier: Tier;
    includedCount: number;
    totalCount: number;
  }>;
}

/**
 * Build a selection plan from budget allocations.
 * Returns indices into params.messages (sorted ascending) and summary blocks.
 */
export function buildSelectionPlan(
  allocations: BudgetAllocation[],
  getOriginalIndices: (segment: Segment) => number[],
  messages: any[],
  estimateTokensFn: (msg: any) => number
): SelectionPlan {
  const indicesSet = new Set<number>();
  const summaryBlocks: string[] = [];
  const segmentPlans: SelectionPlan["segmentPlans"] = [];

  for (const alloc of allocations) {
    const seg = alloc.segment;
    const allIndices = getOriginalIndices(seg);

    switch (alloc.tier) {
      case "active":
      case "full": {
        // Include all indices. For active, if over budget, take most recent.
        if (alloc.tier === "active" && alloc.allocatedTokens < seg.tokenCount) {
          const trimmed = selectPartialIndices(
            allIndices, messages, alloc.allocatedTokens, estimateTokensFn
          );
          for (const idx of trimmed) indicesSet.add(idx);
          segmentPlans.push({
            segmentId: seg.id, tier: alloc.tier,
            includedCount: trimmed.length, totalCount: allIndices.length,
          });
        } else {
          for (const idx of allIndices) indicesSet.add(idx);
          segmentPlans.push({
            segmentId: seg.id, tier: alloc.tier,
            includedCount: allIndices.length, totalCount: allIndices.length,
          });
        }
        break;
      }
      case "partial": {
        summaryBlocks.push(
          `[Prior context — ${seg.topic}: ${seg.summary}]`
        );
        const recentBudget = alloc.allocatedTokens - (seg.summaryTokens || 0);
        const partial = selectPartialIndices(
          allIndices, messages, recentBudget, estimateTokensFn
        );
        for (const idx of partial) indicesSet.add(idx);
        segmentPlans.push({
          segmentId: seg.id, tier: "partial",
          includedCount: partial.length, totalCount: allIndices.length,
        });
        break;
      }
      case "summary": {
        const text = seg.summary
          || `${seg.topic}: ~${seg.messageCount} messages`;
        summaryBlocks.push(`[Prior context — ${seg.topic}: ${text}]`);
        segmentPlans.push({
          segmentId: seg.id, tier: "summary",
          includedCount: 0, totalCount: allIndices.length,
        });
        break;
      }
      case "excluded": {
        segmentPlans.push({
          segmentId: seg.id, tier: "excluded",
          includedCount: 0, totalCount: allIndices.length,
        });
        break;
      }
    }
  }

  // Sort indices ascending to preserve original message ordering
  const indices = Array.from(indicesSet).sort((a, b) => a - b);

  return { indices, summaryBlocks, segmentPlans };
}

