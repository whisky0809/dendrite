# Index-Based Assembly Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Dendrite's lossy message-reconstruction assembly with index-based pass-through that returns original AgentMessage objects untouched.

**Architecture:** The assembler stops building messages and instead returns an ordered list of indices into `params.messages`. The plugin filters the original array by those indices. Cross-session segments contribute summaries only (via `systemPromptAddition`), never conversation messages. Tool grouping is preserved by construction.

**Tech Stack:** TypeScript (ESM, Node16 resolution), tsx test runner, assert-based tests

**Spec:** `docs/superpowers/specs/2026-03-24-dendrite-v3-index-based-assembly.md`

---

## Chunk 1: Assembler — SelectionPlan + selectPartialIndices

### Task 1: Add `originalIndex` to SimpleMessage

**Files:**
- Modify: `src/types.ts:129-134`

- [ ] **Step 1: Add the field**

In `src/types.ts`, add `originalIndex` to the `SimpleMessage` interface:

```typescript
export interface SimpleMessage {
  id: string;
  role: "user" | "assistant" | "toolResult";
  content: string;
  timestamp: number;
  /** Position in params.messages, set during assemble(). Ephemeral — recomputed every turn. */
  originalIndex?: number;
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: PASS (no consumers of originalIndex yet)

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(types): add originalIndex to SimpleMessage"
```

### Task 2: Add `getMessage(id)` to Segmenter

**Files:**
- Modify: `src/segmenter.ts:206-211`
- Test: `src/test-segmenter.ts`

- [ ] **Step 1: Write failing test**

Append to `src/test-segmenter.ts`, before the results summary:

```typescript
// ── getMessage ──
console.log("\n  getMessage:");

const getMsgSegmenter = new Segmenter({ minMessagesBeforeDrift: 3, maxSegmentMessages: 100, driftThreshold: 0.7 });
const getMsgMsg: SimpleMessage = { id: "gm1", role: "user", content: "test", timestamp: 1 };
getMsgSegmenter.addMessage(getMsgMsg);
assert(getMsgSegmenter.getMessage("gm1")?.content === "test", "getMessage returns stored message");
assert(getMsgSegmenter.getMessage("nonexistent") === undefined, "getMessage returns undefined for missing");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/test-segmenter.ts`
Expected: FAIL — `getMessage` does not exist

- [ ] **Step 3: Add getMessage to Segmenter**

In `src/segmenter.ts`, after the `getMessages` method (~line 211):

```typescript
  /** Get a single message by ID. Returns undefined if not found. */
  getMessage(id: string): SimpleMessage | undefined {
    return this.messageStore.get(id);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx src/test-segmenter.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/segmenter.ts src/test-segmenter.ts
git commit -m "feat(segmenter): add getMessage(id) accessor"
```

### Task 3: Write `selectPartialIndices`

**Files:**
- Modify: `src/assembler.ts`
- Test: `src/test-assembler.ts`

- [ ] **Step 1: Write failing tests**

Add to `src/test-assembler.ts` before the results summary. These tests exercise tool-group-aware partial selection:

```typescript
// ── selectPartialIndices ──
console.log("\n  selectPartialIndices:");

// Import at top of file will be needed:
// import { selectPartialIndices } from "./assembler.js";

// Helper: mock params.messages array
const mockMessages: any[] = [
  { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },         // idx 0
  { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 2 },        // idx 1
  { role: "user", content: [{ type: "text", text: "run ls" }], timestamp: 3 },         // idx 2
  {                                                                                     // idx 3
    role: "assistant",
    content: [{ type: "toolCall", id: "tc1", name: "exec", arguments: "{}" }],
    timestamp: 4,
  },
  { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "f1" }], timestamp: 5 },  // idx 4
  { role: "toolResult", toolCallId: "tc2", content: [{ type: "text", text: "f2" }], timestamp: 6 },  // idx 5
  { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 7 },      // idx 6
  { role: "user", content: [{ type: "text", text: "thanks" }], timestamp: 8 },         // idx 7
];

const tokenEst = (msg: any) => {
  if (typeof msg.content === "string") return Math.ceil(msg.content.length / 4);
  if (Array.isArray(msg.content)) return msg.content.reduce((s: number, b: any) =>
    s + Math.ceil((b.text || b.name || "").length / 4), 0);
  return 10;
};

// Test: large budget includes everything
const allIndices = [0, 1, 2, 3, 4, 5, 6, 7];
const selAll = selectPartialIndices(allIndices, mockMessages, 99999, tokenEst);
assert(selAll.length === 8, "partial: large budget includes all");

// Test: tight budget takes most recent complete groups
const selTight = selectPartialIndices(allIndices, mockMessages, 20, tokenEst);
assert(selTight.length > 0, "partial: tight budget includes something");
// Should not start with toolResult (no orphaned results)
assert(mockMessages[selTight[0]]?.role !== "toolResult", "partial: no leading toolResult");

// Test: tool group is atomic — assistant + toolResults stay together
const toolGroupIndices = [3, 4, 5]; // assistant(toolCall) + 2 toolResults
const selGroup = selectPartialIndices(toolGroupIndices, mockMessages, 99999, tokenEst);
assert(selGroup.includes(3) && selGroup.includes(4) && selGroup.includes(5),
  "partial: tool group included atomically");

// Test: orphaned toolResults at segment boundary are skipped
const orphanIndices = [4, 5, 6, 7]; // starts with toolResults (assistant is in prior segment)
const selOrphan = selectPartialIndices(orphanIndices, mockMessages, 99999, tokenEst);
assert(!selOrphan.includes(4) && !selOrphan.includes(5),
  "partial: orphaned toolResults skipped");
assert(selOrphan.includes(6) && selOrphan.includes(7),
  "partial: non-orphaned messages kept");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/test-assembler.ts`
Expected: FAIL — `selectPartialIndices` does not exist

- [ ] **Step 3: Implement selectPartialIndices**

Add to `src/assembler.ts` after the `allocateBudgets` function, before `buildMessageArray`:

```typescript
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
```

- [ ] **Step 4: Add import in test file**

Update the import line at the top of `src/test-assembler.ts`:

```typescript
import { allocateBudgets, buildMessageArray, selectPartialIndices, type BudgetAllocation } from "./assembler.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx src/test-assembler.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/assembler.ts src/test-assembler.ts
git commit -m "feat(assembler): add selectPartialIndices with tool-group preservation"
```

### Task 4: Write `buildSelectionPlan`

**Files:**
- Modify: `src/assembler.ts`
- Test: `src/test-assembler.ts`

- [ ] **Step 1: Write failing tests**

Add to `src/test-assembler.ts` before the results summary:

```typescript
// ── buildSelectionPlan ──
console.log("\n  buildSelectionPlan:");

// Import at top: add buildSelectionPlan to the import
// import { ..., buildSelectionPlan } from "./assembler.js";

// Create segments with known indices
const planActive = createSegment("plan-active");
planActive.status = "active";
planActive.tokenCount = 200;
planActive.messageCount = 2;
planActive.messageIds = ["pa1", "pa2"];

const planFull = createSegment("plan-full");
planFull.status = "closed";
planFull.tokenCount = 100;
planFull.messageCount = 2;
planFull.messageIds = ["pf1", "pf2"];

const planSummary = createSegment("plan-summary");
planSummary.status = "closed";
planSummary.tokenCount = 5000;
planSummary.messageCount = 50;
planSummary.messageIds = Array.from({ length: 50 }, (_, i) => `ps${i}`);
planSummary.summary = "Summary of topic.";
planSummary.summaryTokens = 10;

const planExcluded = createSegment("plan-excluded");
planExcluded.status = "closed";
planExcluded.tokenCount = 5000;
planExcluded.messageCount = 50;
planExcluded.messageIds = Array.from({ length: 50 }, (_, i) => `pe${i}`);

const planScored: ScoredSegment[] = [
  { segment: planActive, score: 1.0, semanticScore: 1, recencyScoreValue: 1 },
  { segment: planFull, score: 0.8, semanticScore: 0.9, recencyScoreValue: 0.5 },
  { segment: planSummary, score: 0.3, semanticScore: 0.2, recencyScoreValue: 0.4 },
  { segment: planExcluded, score: 0.05, semanticScore: 0.01, recencyScoreValue: 0.1 },
];

// Mock params.messages: just need role/content/timestamp for token estimation
const planMessages: any[] = [
  { role: "user", content: [{ type: "text", text: "full msg 1" }], timestamp: 1 },   // idx 0 → pf1
  { role: "assistant", content: [{ type: "text", text: "full msg 2" }], timestamp: 2 },  // idx 1 → pf2
  { role: "user", content: [{ type: "text", text: "active msg 1" }], timestamp: 3 },  // idx 2 → pa1
  { role: "assistant", content: [{ type: "text", text: "active msg 2" }], timestamp: 4 }, // idx 3 → pa2
];

// Index mapping: segment message IDs → params.messages indices
const planIndexMap = new Map<string, number>([
  ["pf1", 0], ["pf2", 1], ["pa1", 2], ["pa2", 3],
  // planSummary and planExcluded have no indices (not in params.messages)
]);

const planBudgets = allocateBudgets(planScored, 5000, 500);
const plan = buildSelectionPlan(planBudgets, (segment) => {
  return segment.messageIds
    .map(id => planIndexMap.get(id))
    .filter((i): i is number => i !== undefined);
}, planMessages, (msg) => {
  const text = Array.isArray(msg.content)
    ? msg.content.map((b: any) => b.text || "").join("")
    : String(msg.content || "");
  return Math.ceil(text.length / 4);
});

// Active segment indices should be present
assert(plan.indices.includes(2) && plan.indices.includes(3),
  "plan: active segment indices present");

// Full segment indices should be present
assert(plan.indices.includes(0) && plan.indices.includes(1),
  "plan: full segment indices present");

// Summary segment should produce a summary block, no indices
assert(plan.summaryBlocks.length > 0, "plan: summary blocks present");
assert(plan.summaryBlocks.some(b => b.includes("plan-summary")),
  "plan: summary block references topic");

// Indices should be sorted (chronological order)
for (let j = 1; j < plan.indices.length; j++) {
  assert(plan.indices[j] > plan.indices[j - 1],
    `plan: indices sorted (${plan.indices[j - 1]} < ${plan.indices[j]})`);
}

// segmentPlans should have entries for all segments
assert(plan.segmentPlans.length === 4, "plan: 4 segment plans");

// Cross-session segment: always summary-only
const crossPlanSeg = createSegment("cross-plan");
crossPlanSeg.status = "closed";
crossPlanSeg.tokenCount = 100;
crossPlanSeg.messageCount = 5;
crossPlanSeg.messageIds = ["cp1", "cp2", "cp3", "cp4", "cp5"];
crossPlanSeg.sessionId = "other-session";
crossPlanSeg.summary = "Cross session context.";
crossPlanSeg.summaryTokens = 10;

const crossPlanScored: ScoredSegment[] = [
  { segment: planActive, score: 1.0, semanticScore: 1, recencyScoreValue: 1 },
  { segment: crossPlanSeg, score: 0.9, semanticScore: 0.95, recencyScoreValue: 0.8 },
];

const crossPlanBudgets = allocateBudgets(crossPlanScored, 10000, 500, {
  currentSessionId: "current",
  pinRecentSegments: 0,
  maxCrossSessionBudgetRatio: 0.5,
  pinnedSegmentIds: [],
});

const crossPlan = buildSelectionPlan(crossPlanBudgets, (segment) => {
  return segment.messageIds
    .map(id => planIndexMap.get(id))
    .filter((i): i is number => i !== undefined);
}, planMessages, (msg) => Math.ceil(String(msg.content).length / 4));

// Cross-session segment should NOT have indices in the plan
const crossIndices = crossPlanSeg.messageIds
  .map(id => planIndexMap.get(id))
  .filter((i): i is number => i !== undefined);
for (const ci of crossIndices) {
  assert(!crossPlan.indices.includes(ci),
    `plan: cross-session index ${ci} not in plan`);
}
// But should have a summary block
assert(crossPlan.summaryBlocks.some(b => b.includes("cross-plan")),
  "plan: cross-session summary block present");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/test-assembler.ts`
Expected: FAIL — `buildSelectionPlan` does not exist

- [ ] **Step 3: Implement buildSelectionPlan**

Add to `src/assembler.ts`:

```typescript
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
 *
 * @param allocations — budget allocations from allocateBudgets()
 * @param getOriginalIndices — returns originalIndex values for a segment's messages
 * @param messages — params.messages array (for structure inspection in partial selection)
 * @param estimateTokensFn — token estimator for AgentMessages
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
          // Budget-trim: take most recent that fit
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
```

- [ ] **Step 4: Update import in test file**

Add `buildSelectionPlan` to the import line in `src/test-assembler.ts`:

```typescript
import { allocateBudgets, buildMessageArray, selectPartialIndices, buildSelectionPlan, type BudgetAllocation } from "./assembler.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx src/test-assembler.ts`
Expected: PASS

- [ ] **Step 6: Run all existing tests to ensure no regressions**

Run: `npm test`
Expected: PASS (buildMessageArray and old tests still work — we haven't removed anything yet)

- [ ] **Step 7: Commit**

```bash
git add src/assembler.ts src/test-assembler.ts
git commit -m "feat(assembler): add buildSelectionPlan and SelectionPlan type"
```

### Task 5: Enforce cross-session summary-only in `allocateBudgets`

**Files:**
- Modify: `src/assembler.ts:34-38` (signature) and cross-session handling
- Test: `src/test-assembler.ts`

- [ ] **Step 1: Write failing test**

Add to `src/test-assembler.ts` before the results summary:

```typescript
// ── Cross-session summary-only enforcement ──
console.log("\n  cross-session summary-only:");

const crossForceSeg = createSegment("cross-force");
crossForceSeg.status = "closed";
crossForceSeg.tokenCount = 100; // small enough to fit as "full" normally
crossForceSeg.messageCount = 3;
crossForceSeg.messageIds = ["cf1", "cf2", "cf3"];
crossForceSeg.sessionId = "past-session-id";
crossForceSeg.summary = "Cross session summary.";
crossForceSeg.summaryTokens = 10;

const crossForceScored: ScoredSegment[] = [
  { segment: activeSeg, score: 1.0, semanticScore: 1, recencyScoreValue: 1 },
  { segment: crossForceSeg, score: 0.95, semanticScore: 0.99, recencyScoreValue: 0.9 },
];

// Even with huge budget, cross-session must not get full/partial
const crossForceBudgets = allocateBudgets(crossForceScored, 100000, 500, {
  currentSessionId: "current-session",
  pinRecentSegments: 0,
  maxCrossSessionBudgetRatio: 1.0, // no cap — still should be summary only
  pinnedSegmentIds: [],
});

const crossForceTier = crossForceBudgets.find(b => b.segment.id === crossForceSeg.id)!.tier;
assert(crossForceTier === "summary", `cross-session forced to summary (got ${crossForceTier})`);

// Cross-session without summary → excluded
const crossNoSummary = createSegment("cross-no-summary");
crossNoSummary.status = "closed";
crossNoSummary.tokenCount = 100;
crossNoSummary.messageCount = 3;
crossNoSummary.messageIds = ["cns1"];
crossNoSummary.sessionId = "past-session-id";
crossNoSummary.summary = null; // no summary

const crossNoSummaryScored: ScoredSegment[] = [
  { segment: activeSeg, score: 1.0, semanticScore: 1, recencyScoreValue: 1 },
  { segment: crossNoSummary, score: 0.9, semanticScore: 0.95, recencyScoreValue: 0.8 },
];

const crossNoSummaryBudgets = allocateBudgets(crossNoSummaryScored, 100000, 500, {
  currentSessionId: "current-session",
  pinRecentSegments: 0,
  maxCrossSessionBudgetRatio: 1.0,
  pinnedSegmentIds: [],
});

const crossNoSummaryTier = crossNoSummaryBudgets.find(b => b.segment.id === crossNoSummary.id)!.tier;
assert(crossNoSummaryTier === "excluded", `cross-session no summary → excluded (got ${crossNoSummaryTier})`);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/test-assembler.ts`
Expected: FAIL — cross-session segment gets "full" tier instead of "summary"

- [ ] **Step 3: Modify allocateBudgets**

In `src/assembler.ts`, make `options` required and add cross-session enforcement. Change the signature:

```typescript
export function allocateBudgets(
  scored: ScoredSegment[],
  totalBudget: number,
  reserveTokens: number,
  options: AllocateOptions
): BudgetAllocation[] {
```

Remove the fallback: delete `const opts = options || { ... };` and replace all `opts.` references with `options.`.

In the main loop, the existing code already declares `const isCrossSession = seg.sessionId !== undefined;` on line 73. Add the enforcement block right after the `remaining <= 0` check (which already uses `isCrossSession`), reusing the existing variable:

```typescript
    // Cross-session segments: summary-only (never full/partial)
    if (isCrossSession) {
      if (seg.summary && seg.summaryTokens <= effectiveRemaining) {
        allocations.push({ segment: seg, tier: "summary", allocatedTokens: seg.summaryTokens, scored: entry });
        remaining -= seg.summaryTokens;
      } else {
        allocations.push({ segment: seg, tier: "excluded", allocatedTokens: 0, scored: entry });
      }
      continue;
    }
```

- [ ] **Step 4: Fix callers of allocateBudgets that don't pass options**

The test file `src/test-assembler.ts` has calls like `allocateBudgets(scored, 10000, 2000)` without options. Add the required parameter:

```typescript
// For all calls without options, add:
{ currentSessionId: undefined, pinRecentSegments: 0, maxCrossSessionBudgetRatio: 1.0, pinnedSegmentIds: [] }
```

Also update these files that call `allocateBudgets` without options:
- `src/test-integration.ts`
- `src/test-assemble-boundary.ts`
- `src/test-tool-preservation.ts` (will be rewritten in Task 7, but must compile now)
- `src/test-cross-session.ts` (also references `buildMessageArray` — update import and usage)

- [ ] **Step 5: Run tests to verify**

Run: `npx tsx src/test-assembler.ts`
Expected: PASS

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/assembler.ts src/test-assembler.ts src/test-integration.ts src/test-assemble-boundary.ts
git commit -m "feat(assembler): enforce cross-session summary-only, make options required"
```

---

## Chunk 2: Plugin — Index Reconciliation + Assemble Rewrite

### Task 6: Rewrite `assemble()` with index-based selection

This is the core change. The new assemble() does:
1. Reconcile segment messages → `params.messages` indices
2. Score and allocate (unchanged)
3. `buildSelectionPlan()` → indices
4. Include untracked messages
5. Return `params.messages` filtered by indices

**Files:**
- Modify: `src/plugin.ts:351-601`

- [ ] **Step 1: Add reconciliation helper**

Add a new function in `src/plugin.ts` after the `getSession` function (~line 102):

```typescript
/**
 * Reconcile segment messages with params.messages indices.
 * Uses (timestamp, role) matching with ordered consumption.
 * Returns: trackedOriginalIndices set, indexToSegmentId map.
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
```

- [ ] **Step 2: Rewrite assemble()**

Replace the body of `async assemble(params)` starting after the passthrough check (`if (segments.length < 2)`) through to the `return` statement. The new implementation:

```typescript
      // ── Reconcile segment messages with params.messages indices ──
      const { trackedOriginalIndices, indexToSegmentId } = reconcileIndices(
        currentSegments, state.segmenter, params.messages
      );

      const tokenBudget = params.tokenBudget || 32000;
      const effectiveAlpha = state.embeddingsAvailable ? pluginConfig.relevanceAlpha : 0;

      const scored = scoreSegments(
        segments,
        state.queryEmbedding,
        pluginConfig.recencyHalfLifeMs,
        effectiveAlpha
      );

      // Lazy summary generation for unsummarized segments
      let summarizedThisTurn = 0;
      for (const entry of scored) {
        const seg = entry.segment;
        if (seg.status === "closed" && !seg.summary && summarizedThisTurn < 1) {
          if (seg.sessionId && seg.transcriptPath) continue;
          const msgs = state.segmenter.getMessages(seg.messageIds);
          seg.summary = await generateSummary(seg.topic, msgs, pluginConfig.summaryModel, await getOpenRouterKey());
          seg.summaryTokens = estimateTokens(seg.summary);
          summarizedThisTurn++;
        }
      }

      // Pinned segments
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
```

- [ ] **Step 3: Delete dead code**

Remove from `src/plugin.ts`:
- The `toAgentMessage` function (lines 49-61)
- Update imports: add `buildSelectionPlan` to the assembler import, remove `buildMessageArray`

```typescript
import { allocateBudgets, buildSelectionPlan } from "./assembler.js";
```

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/plugin.ts
git commit -m "feat(plugin): rewrite assemble() with index-based selection

Delete toAgentMessage, orphan repair code, timestamp lookup.
Assembly now returns original params.messages objects by index."
```

---

## Chunk 3: Tests — Rewrite and Regression

### Task 7: Rewrite test-tool-preservation.ts for index-based assembly

The old tests verified timestamp-based lookup and orphan repair. The new tests verify that index-based selection preserves tool structure by construction.

**Files:**
- Rewrite: `src/test-tool-preservation.ts`

- [ ] **Step 1: Rewrite the test file**

Replace `src/test-tool-preservation.ts` entirely:

```typescript
import { allocateBudgets, buildSelectionPlan, selectPartialIndices } from "./assembler.js";
import { createSegment, estimateTokens, extractTextContent, type SimpleMessage } from "./types.js";
import { Segmenter } from "./segmenter.js";
import type { ScoredSegment } from "./scorer.js";

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}

const defaultOpts = { currentSessionId: undefined, pinRecentSegments: 0, maxCrossSessionBudgetRatio: 1.0, pinnedSegmentIds: [] as string[] };

console.log("=== Tool Structure Preservation (v3 index-based) ===\n");

// Helper to build mock AgentMessages
function makeUser(text: string, ts: number): any {
  return { role: "user", content: [{ type: "text", text }], timestamp: ts };
}
function makeAssistantText(text: string, ts: number): any {
  return { role: "assistant", content: [{ type: "text", text }], timestamp: ts };
}
function makeAssistantToolCall(calls: { id: string; name: string }[], ts: number): any {
  return {
    role: "assistant",
    content: calls.map(c => ({ type: "toolCall", id: c.id, name: c.name, arguments: "{}" })),
    timestamp: ts,
  };
}
function makeToolResult(toolCallId: string, text: string, ts: number): any {
  return { role: "toolResult", toolCallId, toolName: "exec", content: [{ type: "text", text }], timestamp: ts };
}

// ── Test 1: Full assembly preserves tool calls via reference equality ──
console.log("  reference equality:");
{
  const paramsMessages = [
    makeUser("Run ls", 100),
    makeAssistantToolCall([{ id: "tc1", name: "exec" }], 101),
    makeToolResult("tc1", "file1.txt\nfile2.txt", 102),
    makeAssistantText("Here are the files.", 103),
    makeUser("Thanks!", 104),
  ];

  // Ingest into segmenter
  const segmenter = new Segmenter({ minMessagesBeforeDrift: 999, maxSegmentMessages: 100, driftThreshold: 0.9 });
  const simples: SimpleMessage[] = [];
  for (let i = 0; i < paramsMessages.length; i++) {
    const role = paramsMessages[i].role;
    const text = extractTextContent(paramsMessages[i]) ||
      (role === "assistant" ? "[Tool calls]" : "");
    if (!text) continue;
    const s: SimpleMessage = {
      id: `msg_${i}`, role, content: text, timestamp: paramsMessages[i].timestamp,
    };
    simples.push(s);
    segmenter.addMessage(s);
  }

  // Reconcile: set originalIndex
  for (const s of simples) {
    const idx = paramsMessages.findIndex(m => m.timestamp === s.timestamp && m.role === s.role);
    s.originalIndex = idx >= 0 ? idx : undefined;
  }

  const scored: ScoredSegment[] = [
    { segment: segmenter.segments[0], score: 1.0, semanticScore: 1, recencyScoreValue: 1 },
  ];
  const budgets = allocateBudgets(scored, 100000, 16384, defaultOpts);
  const plan = buildSelectionPlan(budgets, (seg) => {
    return seg.messageIds
      .map(id => segmenter.getMessage(id)?.originalIndex)
      .filter((i): i is number => i !== undefined);
  }, paramsMessages, (msg) => estimateTokens(extractTextContent(msg)));

  const output = plan.indices.map(i => paramsMessages[i]);

  // Reference equality — exact same objects
  assert(output[0] === paramsMessages[0], "user message is same object");
  assert(output[1] === paramsMessages[1], "toolCall assistant is same object");
  assert(output[2] === paramsMessages[2], "toolResult is same object");

  // Tool structure intact
  assert(output[1].content[0].type === "toolCall", "toolCall content preserved");
  assert(output[1].content[0].id === "tc1", "toolCall ID preserved");
  assert(output[2].toolCallId === "tc1", "toolCallId preserved");
}

// ── Test 2: Multi-tool assistant with consecutive toolResults ──
console.log("\n  multi-tool consecutive results:");
{
  const paramsMessages = [
    makeUser("Run two commands", 200),
    makeAssistantToolCall([{ id: "tc_a", name: "exec" }, { id: "tc_b", name: "read" }], 201),
    makeToolResult("tc_a", "output A", 202),
    makeToolResult("tc_b", "output B", 203),
    makeAssistantText("Both done.", 204),
  ];

  const segmenter = new Segmenter({ minMessagesBeforeDrift: 999, maxSegmentMessages: 100, driftThreshold: 0.9 });
  for (let i = 0; i < paramsMessages.length; i++) {
    const role = paramsMessages[i].role;
    const text = extractTextContent(paramsMessages[i]) ||
      (role === "assistant" ? "[Tool calls]" : "");
    if (!text) continue;
    const s: SimpleMessage = {
      id: `msg_${i}`, role, content: text,
      timestamp: paramsMessages[i].timestamp, originalIndex: i,
    };
    segmenter.addMessage(s);
  }

  const scored: ScoredSegment[] = [
    { segment: segmenter.segments[0], score: 1.0, semanticScore: 1, recencyScoreValue: 1 },
  ];
  const budgets = allocateBudgets(scored, 100000, 16384, defaultOpts);
  const plan = buildSelectionPlan(budgets, (seg) => {
    return seg.messageIds
      .map(id => segmenter.getMessage(id)?.originalIndex)
      .filter((i): i is number => i !== undefined);
  }, paramsMessages, (msg) => estimateTokens(extractTextContent(msg)));

  const output = plan.indices.map(i => paramsMessages[i]);

  assert(output.length === 5, "all 5 messages included");
  // Check consecutive toolResults are present (the v2 bug)
  assert(output[2].role === "toolResult" && output[2].toolCallId === "tc_a", "first toolResult present");
  assert(output[3].role === "toolResult" && output[3].toolCallId === "tc_b", "second toolResult present");
  // No role alternation violation because originals are returned as-is
  assert(output[1].role === "assistant", "assistant before toolResults");
  assert(output[4].role === "assistant", "assistant after toolResults");
}

// ── Test 3: No orphan repair needed ──
console.log("\n  no orphan repair needed:");
{
  // With index-based assembly, tool groups are never broken within a segment.
  // This test verifies there's no toolResult without its assistant in output.
  const paramsMessages = [
    makeUser("hello", 300),
    makeAssistantToolCall([{ id: "tc1", name: "read" }], 301),
    makeToolResult("tc1", "data", 302),
    makeAssistantText("Got it", 303),
    makeUser("new topic", 304),
    makeAssistantText("Sure", 305),
  ];

  // Two segments with a drift split between msg 3 and 4
  const seg1 = createSegment("topic-1");
  seg1.status = "closed";
  seg1.messageIds = ["m0", "m1", "m2", "m3"];
  seg1.messageCount = 4;
  seg1.tokenCount = 100;
  seg1.summary = "First topic.";
  seg1.summaryTokens = 10;

  const seg2 = createSegment("topic-2");
  seg2.status = "active";
  seg2.messageIds = ["m4", "m5"];
  seg2.messageCount = 2;
  seg2.tokenCount = 50;

  const scored: ScoredSegment[] = [
    { segment: seg2, score: 1.0, semanticScore: 1, recencyScoreValue: 1 },
    { segment: seg1, score: 0.2, semanticScore: 0.1, recencyScoreValue: 0.3 },
  ];

  // Tight budget: only active segment fits, seg1 gets summary-only
  const budgets = allocateBudgets(scored, 100, 100, defaultOpts);

  // Map: seg1 messages have indices 0-3, seg2 has 4-5
  const indexMap = new Map([["m0", 0], ["m1", 1], ["m2", 2], ["m3", 3], ["m4", 4], ["m5", 5]]);

  const plan = buildSelectionPlan(budgets, (seg) => {
    return seg.messageIds.map(id => indexMap.get(id)).filter((i): i is number => i !== undefined);
  }, paramsMessages, (msg) => estimateTokens(extractTextContent(msg)));

  const output = plan.indices.map(i => paramsMessages[i]);

  // seg1 should be summary-only, so its messages (incl toolResult) should NOT be in output
  assert(!output.some(m => m.timestamp === 302), "toolResult from summarized segment not in output");
  // seg2 messages should be present
  assert(output.some(m => m.timestamp === 304), "active segment user present");
  assert(output.some(m => m.timestamp === 305), "active segment assistant present");
  // Summary should be in summaryBlocks
  assert(plan.summaryBlocks.length > 0, "summarized segment has summary block");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 2: Run test**

Run: `npx tsx src/test-tool-preservation.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/test-tool-preservation.ts
git commit -m "test: rewrite tool preservation tests for index-based assembly"
```

### Task 8: Update test-assemble-boundary.ts and test-plugin-assembly.ts

These tests reference `buildMessageArray` and the old lookup logic. Update them to use index-based assembly.

**Files:**
- Rewrite: `src/test-assemble-boundary.ts`
- Rewrite: `src/test-plugin-assembly.ts`

- [ ] **Step 1: Rewrite test-assemble-boundary.ts**

Replace with a test that verifies the full round-trip: ingest → reconcile → buildSelectionPlan → filter params.messages. The key assertion is **reference equality** — returned messages are the exact same objects.

```typescript
import { Segmenter } from "./segmenter.js";
import { scoreSegments } from "./scorer.js";
import { allocateBudgets, buildSelectionPlan } from "./assembler.js";
import { extractTextContent, estimateTokens, type SimpleMessage } from "./types.js";

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}

const defaultOpts = { currentSessionId: undefined, pinRecentSegments: 0, maxCrossSessionBudgetRatio: 1.0, pinnedSegmentIds: [] as string[] };

function toSimpleMessage(msg: any, index: number): SimpleMessage | null {
  const role = msg.role;
  if (role !== "user" && role !== "assistant" && role !== "toolResult") return null;
  let content = extractTextContent(msg);
  if (!content && role === "assistant" && Array.isArray(msg.content)) {
    const toolCalls = msg.content.filter((b: any) => b.type === "toolCall");
    if (toolCalls.length > 0) {
      content = `[Tool calls: ${toolCalls.map((t: any) => t.name || "unknown").join(", ")}]`;
    }
  }
  if (!content) return null;
  return { id: `msg_${index}_${msg.timestamp}`, role, content, timestamp: msg.timestamp };
}

console.log("=== Assemble Boundary (v3 index-based) ===\n");

// Test: full round-trip with tool calls — reference equality
console.log("  round-trip reference equality:");
{
  const agentMessages: any[] = [
    { role: "user", content: [{ type: "text", text: "Read /tmp/test.txt" }], timestamp: 1000 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "tc_1", name: "read", arguments: '{"path":"/tmp/test.txt"}' }],
      timestamp: 1001,
    },
    {
      role: "toolResult", toolCallId: "tc_1", toolName: "read",
      content: [{ type: "text", text: "file contents" }], timestamp: 1002,
    },
    { role: "assistant", content: [{ type: "text", text: "The file contains: file contents" }], timestamp: 1003 },
    { role: "user", content: [{ type: "text", text: "Thanks!" }], timestamp: 1004 },
  ];

  // Ingest
  const segmenter = new Segmenter({ minMessagesBeforeDrift: 999, maxSegmentMessages: 100, driftThreshold: 0.9 });
  for (let i = 0; i < agentMessages.length; i++) {
    const s = toSimpleMessage(agentMessages[i], i);
    if (s) segmenter.addMessage(s);
  }

  // Reconcile
  for (const seg of segmenter.segments) {
    for (const msgId of seg.messageIds) {
      const simple = segmenter.getMessage(msgId);
      if (simple) {
        const idx = agentMessages.findIndex(m => m.timestamp === simple.timestamp && m.role === simple.role);
        simple.originalIndex = idx >= 0 ? idx : undefined;
      }
    }
  }

  // Score + allocate + plan
  const scored = scoreSegments(segmenter.segments, [], 86400000, 0.7);
  const budgets = allocateBudgets(scored, 100000, 16384, defaultOpts);
  const plan = buildSelectionPlan(budgets, (seg) => {
    return seg.messageIds
      .map(id => segmenter.getMessage(id)?.originalIndex)
      .filter((i): i is number => i !== undefined);
  }, agentMessages, (msg) => estimateTokens(extractTextContent(msg)));

  const output = plan.indices.map(i => agentMessages[i]);

  assert(output.length === 5, `all 5 messages selected (got ${output.length})`);

  // Reference equality
  for (let i = 0; i < output.length; i++) {
    assert(output[i] === agentMessages[i], `message ${i} is same object reference`);
  }

  // Tool structure intact
  assert(output[1].content[0].type === "toolCall", "toolCall preserved");
  assert(output[2].toolCallId === "tc_1", "toolCallId preserved");
}

// Test: consecutive toolResults survive (the v2 bug)
console.log("\n  consecutive toolResults preserved:");
{
  const agentMessages: any[] = [
    { role: "user", content: [{ type: "text", text: "Do two things" }], timestamp: 2000 },
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "tc_a", name: "exec", arguments: "{}" },
        { type: "toolCall", id: "tc_b", name: "read", arguments: "{}" },
      ],
      timestamp: 2001,
    },
    { role: "toolResult", toolCallId: "tc_a", toolName: "exec", content: [{ type: "text", text: "out A" }], timestamp: 2002 },
    { role: "toolResult", toolCallId: "tc_b", toolName: "read", content: [{ type: "text", text: "out B" }], timestamp: 2003 },
    { role: "assistant", content: [{ type: "text", text: "Both done" }], timestamp: 2004 },
  ];

  const segmenter = new Segmenter({ minMessagesBeforeDrift: 999, maxSegmentMessages: 100, driftThreshold: 0.9 });
  for (let i = 0; i < agentMessages.length; i++) {
    const s = toSimpleMessage(agentMessages[i], i);
    if (s) {
      s.originalIndex = i;
      segmenter.addMessage(s);
    }
  }

  const scored = scoreSegments(segmenter.segments, [], 86400000, 0.7);
  const budgets = allocateBudgets(scored, 100000, 16384, defaultOpts);
  const plan = buildSelectionPlan(budgets, (seg) => {
    return seg.messageIds
      .map(id => segmenter.getMessage(id)?.originalIndex)
      .filter((i): i is number => i !== undefined);
  }, agentMessages, (msg) => estimateTokens(extractTextContent(msg)));

  const output = plan.indices.map(i => agentMessages[i]);

  assert(output.length === 5, "all messages present");
  assert(output[2].role === "toolResult" && output[3].role === "toolResult",
    "consecutive toolResults both present (was the v2 bug)");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 2: Rewrite test-plugin-assembly.ts**

This file tested the old orphan repair pipeline. Replace with tests for the index-based assembly — specifically testing that no orphan repair is needed:

```typescript
import { extractTextContent } from "./types.js";

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}

console.log("=== Plugin Assembly (v3 — orphan repair eliminated) ===\n");

// With index-based assembly, the orphan repair code is deleted.
// These tests verify the properties that made orphan repair unnecessary.

// Test 1: selecting by index preserves tool pairing by construction
console.log("  tool pairing by construction:");
{
  const messages: any[] = [
    { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 100 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "tc_1", name: "read", arguments: '{"path":"/tmp"}' }],
      stopReason: "toolUse",
      timestamp: 200,
    },
    {
      role: "toolResult",
      toolCallId: "tc_1",
      toolName: "read",
      content: [{ type: "text", text: "file contents" }],
      timestamp: 300,
    },
    { role: "assistant", content: [{ type: "text", text: "Done" }], timestamp: 400 },
  ];

  // Index-based selection: include all
  const indices = [0, 1, 2, 3];
  const output = indices.map(i => messages[i]);

  // Verify: toolCall and toolResult are paired
  const toolCallIds = new Set<string>();
  const toolResultIds = new Set<string>();
  for (const msg of output) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const c of msg.content) {
        if (c.type === "toolCall") toolCallIds.add(c.id);
      }
    }
    if (msg.role === "toolResult" && msg.toolCallId) {
      toolResultIds.add(msg.toolCallId);
    }
  }

  // Every toolResult has a matching toolCall
  for (const id of toolResultIds) {
    assert(toolCallIds.has(id), `toolResult ${id} has matching toolCall`);
  }
  // Every toolCall has a matching toolResult
  for (const id of toolCallIds) {
    assert(toolResultIds.has(id), `toolCall ${id} has matching toolResult`);
  }
}

// Test 2: excluding a segment excludes the entire tool group
console.log("\n  segment exclusion is atomic:");
{
  const messages: any[] = [
    { role: "user", content: [{ type: "text", text: "topic 1" }], timestamp: 100 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "tc_1", name: "exec", arguments: "{}" }],
      timestamp: 200,
    },
    { role: "toolResult", toolCallId: "tc_1", toolName: "exec", content: [{ type: "text", text: "output" }], timestamp: 300 },
    { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 400 },
    // --- segment boundary ---
    { role: "user", content: [{ type: "text", text: "topic 2" }], timestamp: 500 },
    { role: "assistant", content: [{ type: "text", text: "sure" }], timestamp: 600 },
  ];

  // Only include segment 2 (indices 4, 5)
  const indices = [4, 5];
  const output = indices.map(i => messages[i]);

  // No orphaned toolResults or toolCalls
  assert(!output.some(m => m.role === "toolResult"), "no toolResults from excluded segment");
  assert(!output.some(m =>
    m.role === "assistant" && Array.isArray(m.content) &&
    m.content.some((c: any) => c.type === "toolCall")
  ), "no toolCalls from excluded segment");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 3: Run tests**

Run: `npx tsx src/test-tool-preservation.ts && npx tsx src/test-assemble-boundary.ts && npx tsx src/test-plugin-assembly.ts`
Expected: PASS

- [ ] **Step 4: Run full test suite**

Run: `npm run test:all`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/test-assemble-boundary.ts src/test-plugin-assembly.ts
git commit -m "test: rewrite boundary and plugin assembly tests for v3"
```

### Task 9: Update test-integration.ts and test-cross-session.ts

**Files:**
- Modify: `src/test-integration.ts`
- Modify: `src/test-cross-session.ts`

- [ ] **Step 1: Update test-integration.ts imports and calls**

Replace `buildMessageArray` with `buildSelectionPlan` in imports and usage. The integration test needs to create mock `params.messages` and use index-based selection instead of `buildMessageArray`.

Key changes:
- Import `buildSelectionPlan` instead of `buildMessageArray`
- Create a `paramsMessages` array from the SimpleMessages (mock AgentMessages with same timestamps/roles)
- Set `originalIndex` on each SimpleMessage
- Use `buildSelectionPlan` and map indices to paramsMessages
- Update assertions to check indices-based output

- [ ] **Step 2: Update test-cross-session.ts**

This file imports `buildMessageArray` and uses it for cross-session assembly. Update it to use `buildSelectionPlan`. Cross-session segments should now always get `summary` or `excluded` tier — update assertions accordingly.

Key changes:
- Import `buildSelectionPlan` instead of `buildMessageArray`
- Cross-session assertions: verify segments get `summary` tier (not `full`/`partial`)
- Verify cross-session segment messages do NOT appear in `plan.indices`
- Verify cross-session summaries appear in `plan.summaryBlocks`

- [ ] **Step 3: Run tests**

Run: `npm run test:all`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/test-integration.ts src/test-cross-session.ts
git commit -m "test: update integration and cross-session tests for index-based assembly"
```

### Task 10: Regression test — consecutive role check

**Files:**
- Create: `src/test-regression-ordering.ts`
- Modify: `package.json` (add to test script)

- [ ] **Step 1: Write the regression test**

This test creates the exact scenario that caused the v2 bug: multi-tool assistant turns with consecutive toolResults, then verifies the assembled output maintains valid role sequences.

```typescript
/**
 * Regression test: "Message ordering conflict" bug.
 *
 * Verifies that index-based assembly never produces consecutive
 * same-role messages when returning original AgentMessages.
 */
import { Segmenter } from "./segmenter.js";
import { scoreSegments } from "./scorer.js";
import { allocateBudgets, buildSelectionPlan } from "./assembler.js";
import { extractTextContent, estimateTokens, type SimpleMessage } from "./types.js";

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}

const defaultOpts = { currentSessionId: undefined, pinRecentSegments: 0, maxCrossSessionBudgetRatio: 1.0, pinnedSegmentIds: [] as string[] };

function toSimple(msg: any, i: number): SimpleMessage | null {
  const role = msg.role;
  if (role !== "user" && role !== "assistant" && role !== "toolResult") return null;
  let content = extractTextContent(msg);
  if (!content && role === "assistant" && Array.isArray(msg.content)) {
    const tc = msg.content.filter((b: any) => b.type === "toolCall");
    if (tc.length > 0) content = `[Tool calls: ${tc.map((t: any) => t.name).join(", ")}]`;
  }
  if (!content) return null;
  return { id: `msg_${i}_${msg.timestamp}`, role, content, timestamp: msg.timestamp, originalIndex: i };
}

console.log("=== Regression: Message Ordering ===\n");

// Reproduce the exact scenario from the bug: heartbeat session with
// multi-tool assistant turns producing consecutive toolResults
console.log("  multi-tool heartbeat scenario:");
{
  const now = Date.now();
  const paramsMessages: any[] = [
    // Turn 1: heartbeat
    { role: "user", content: [{ type: "text", text: "HEARTBEAT" }], timestamp: now - 10000 },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Checking..." },
        { type: "toolCall", id: "tc_read", name: "read", arguments: "{}" },
      ],
      timestamp: now - 9999,
    },
    { role: "toolResult", toolCallId: "tc_read", toolName: "read", content: [{ type: "text", text: "state data" }], timestamp: now - 9000 },
    { role: "toolResult", toolCallId: "tc_cal", toolName: "exec", content: [{ type: "text", text: "calendar" }], timestamp: now - 8999 },
    { role: "assistant", content: [{ type: "text", text: "HEARTBEAT_OK" }], timestamp: now - 8998 },

    // Turn 2: another heartbeat with even more tool calls
    { role: "user", content: [{ type: "text", text: "HEARTBEAT" }], timestamp: now - 5000 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "tc_r2", name: "read", arguments: "{}" }],
      timestamp: now - 4999,
    },
    { role: "toolResult", toolCallId: "tc_r2", toolName: "read", content: [{ type: "text", text: "data" }], timestamp: now - 4000 },
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "tc_edit", name: "edit", arguments: "{}" },
        { type: "toolCall", id: "tc_write", name: "write", arguments: "{}" },
      ],
      timestamp: now - 3999,
    },
    { role: "toolResult", toolCallId: "tc_edit", toolName: "edit", content: [{ type: "text", text: "ok" }], timestamp: now - 3000 },
    { role: "toolResult", toolCallId: "tc_write", toolName: "write", content: [{ type: "text", text: "ok" }], timestamp: now - 2999 },
    { role: "assistant", content: [{ type: "text", text: "Evening routine complete." }], timestamp: now - 2998 },

    // Turn 3: user message (this is where v2 would fail)
    { role: "user", content: [{ type: "text", text: "So, I just woke up again" }], timestamp: now },
  ];

  // Ingest all
  const segmenter = new Segmenter({ minMessagesBeforeDrift: 999, maxSegmentMessages: 100, driftThreshold: 0.9 });
  for (let i = 0; i < paramsMessages.length; i++) {
    const s = toSimple(paramsMessages[i], i);
    if (s) segmenter.addMessage(s);
  }

  // Score and assemble
  const scored = scoreSegments(segmenter.segments, [], 86400000, 0.7);
  const budgets = allocateBudgets(scored, 100000, 16384, defaultOpts);
  const plan = buildSelectionPlan(budgets, (seg) => {
    return seg.messageIds
      .map(id => segmenter.getMessage(id)?.originalIndex)
      .filter((i): i is number => i !== undefined);
  }, paramsMessages, (msg) => estimateTokens(extractTextContent(msg)));

  const output = plan.indices.map(i => paramsMessages[i]);

  assert(output.length === paramsMessages.length, `all ${paramsMessages.length} messages included`);

  // THE KEY ASSERTION: output messages are the originals, not reconstructions
  for (let i = 0; i < output.length; i++) {
    assert(output[i] === paramsMessages[i], `message ${i} is reference-equal`);
  }

  // Verify the consecutive toolResults are still there (valid in OpenClaw with toolCallId binding)
  const roles = output.map(m => m.role);
  let consecutiveToolResults = 0;
  for (let i = 1; i < roles.length; i++) {
    if (roles[i] === "toolResult" && roles[i - 1] === "toolResult") {
      consecutiveToolResults++;
    }
  }
  // Consecutive toolResults ARE valid when they have toolCallIds binding them to an assistant.
  // The v2 bug was that reconstruction LOST the toolCallId, making them invalid.
  // With pass-through, they keep their toolCallId.
  assert(consecutiveToolResults > 0, "consecutive toolResults exist (valid with toolCallId binding)");

  // Verify all toolResults have toolCallIds
  for (const msg of output) {
    if (msg.role === "toolResult") {
      assert(typeof msg.toolCallId === "string" && msg.toolCallId.length > 0,
        `toolResult at ts=${msg.timestamp} has toolCallId`);
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 2: Add to test script in package.json**

Add `&& tsx src/test-regression-ordering.ts` to the `test` script in `package.json`.

- [ ] **Step 3: Run test**

Run: `npx tsx src/test-regression-ordering.ts`
Expected: PASS

- [ ] **Step 4: Run full suite**

Run: `npm run test:all`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/test-regression-ordering.ts package.json
git commit -m "test: add regression test for message ordering conflict bug"
```

---

## Chunk 4: Cleanup

### Task 11: Remove dead code from assembler.ts

**Files:**
- Modify: `src/assembler.ts`

- [ ] **Step 1: Remove `AssembledMessage` interface and `buildMessageArray` function**

Delete the `AssembledMessage` interface and the entire `buildMessageArray` function from `src/assembler.ts`. These are replaced by `SelectionPlan` and `buildSelectionPlan`.

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: PASS (no remaining references to deleted code)

If build fails, grep for remaining references and update:

Run: `grep -r "buildMessageArray\|AssembledMessage" src/ --include="*.ts"`

- [ ] **Step 3: Run full test suite**

Run: `npm run test:all`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/assembler.ts
git commit -m "chore: remove buildMessageArray and AssembledMessage (replaced by buildSelectionPlan)"
```

### Task 12: Final verification

- [ ] **Step 1: Type check**

Run: `npm run build`
Expected: PASS

- [ ] **Step 2: Full test suite**

Run: `npm run test:all`
Expected: PASS

- [ ] **Step 3: Verify no remaining references to deleted code**

Run: `grep -r "toAgentMessage\|buildMessageArray\|AssembledMessage\|orphan" src/ --include="*.ts" | grep -v test | grep -v ".md"`
Expected: No matches (except comments if any)
