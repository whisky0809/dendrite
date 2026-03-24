import { allocateBudgets, selectPartialIndices, buildSelectionPlan, type BudgetAllocation } from "./assembler.js";
import { createSegment, type SimpleMessage } from "./types.js";
import type { ScoredSegment } from "./scorer.js";

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}

console.log("=== Assembler ===\n");

// ── allocateBudgets ──
console.log("  allocateBudgets:");

const activeSeg = createSegment("active-topic");
activeSeg.tokenCount = 500;
activeSeg.status = "active";

const closedA = createSegment("topic-a");
closedA.tokenCount = 1000;
closedA.status = "closed";
closedA.summary = "Summary of topic A discussion.";
closedA.summaryTokens = 20;

const closedB = createSegment("topic-b");
closedB.tokenCount = 800;
closedB.status = "closed";
closedB.summary = "Summary of topic B discussion.";
closedB.summaryTokens = 18;

const closedC = createSegment("topic-c");
closedC.tokenCount = 2000;
closedC.status = "closed";
closedC.summary = null; // no summary yet

const scored: ScoredSegment[] = [
  { segment: activeSeg, score: 1.0, semanticScore: 1, recencyScoreValue: 1 },
  { segment: closedA, score: 0.8, semanticScore: 0.9, recencyScoreValue: 0.5 },
  { segment: closedB, score: 0.5, semanticScore: 0.4, recencyScoreValue: 0.7 },
  { segment: closedC, score: 0.1, semanticScore: 0.05, recencyScoreValue: 0.2 },
];

// Plenty of budget — everything fits fully
const defaultAllocOpts = { currentSessionId: undefined, pinRecentSegments: 0, maxCrossSessionBudgetRatio: 1.0, pinnedSegmentIds: [] as string[] };
const budgetLarge = allocateBudgets(scored, 10000, 2000, defaultAllocOpts);
assert(budgetLarge[0].tier === "active", "large budget: active segment is active tier");
assert(budgetLarge[1].tier === "full", "large budget: high-relevance gets full");
assert(budgetLarge[2].tier === "full", "large budget: medium-relevance gets full (budget available)");

// Tight budget — forces compression
const budgetTight = allocateBudgets(scored, 1000, 500, defaultAllocOpts);
assert(budgetTight[0].tier === "active", "tight budget: active still active");
const tiers = budgetTight.map(b => b.tier);
assert(tiers.includes("summary") || tiers.includes("excluded"), "tight budget: some segments compressed");

// Very tight — active segment gets reserveTokens as a guaranteed floor.
// totalBudget=200, reserveTokens=300: active gets min(500, 200+300) = 500 (all tokens fit).
// Since active.tokenCount(500) <= totalBudget+reserveTokens(500), allocatedTokens = 500.
const budgetTiny = allocateBudgets(scored, 200, 300, defaultAllocOpts);
assert(budgetTiny[0].tier === "active", "tiny budget: active tier present");
// Active should get more than totalBudget alone (200), thanks to reserveTokens floor
assert(budgetTiny[0].allocatedTokens > 200, "tiny budget: active gets more than totalBudget alone (reserveTokens kicks in)");
assert(budgetTiny[0].allocatedTokens <= 500, "tiny budget: active capped at its own tokenCount");

// ── Pinned recent segments ──
console.log("\n  pinned recent segments:");

const pinnedA = createSegment("pinned-recent-1");
pinnedA.tokenCount = 500;
pinnedA.status = "closed";
pinnedA.summary = "Recent topic A";
pinnedA.summaryTokens = 15;
pinnedA.lastActiveAt = Date.now() - 1000;

const pinnedB = createSegment("pinned-recent-2");
pinnedB.tokenCount = 500;
pinnedB.status = "closed";
pinnedB.summary = "Recent topic B";
pinnedB.summaryTokens = 15;
pinnedB.lastActiveAt = Date.now() - 2000;

const lowScoreSeg = createSegment("low-score");
lowScoreSeg.tokenCount = 500;
lowScoreSeg.status = "closed";
lowScoreSeg.summary = "Low score topic";
lowScoreSeg.summaryTokens = 15;
lowScoreSeg.lastActiveAt = Date.now() - 100000;

const scoredPinned: ScoredSegment[] = [
  { segment: activeSeg, score: 1.0, semanticScore: 1, recencyScoreValue: 1 },
  // lowScoreSeg is scored higher than pinned, but pinned should still be guaranteed
  { segment: lowScoreSeg, score: 0.9, semanticScore: 0.9, recencyScoreValue: 0.5 },
  { segment: pinnedA, score: 0.1, semanticScore: 0.05, recencyScoreValue: 0.2 },
  { segment: pinnedB, score: 0.05, semanticScore: 0.02, recencyScoreValue: 0.1 },
];

const pinnedBudgets = allocateBudgets(scoredPinned, 2000, 500, {
  currentSessionId: undefined,
  pinRecentSegments: 2,
  maxCrossSessionBudgetRatio: 0.3,
  pinnedSegmentIds: [pinnedA.id, pinnedB.id],
});
const pinnedTiers = pinnedBudgets.reduce((acc, b) => { acc[b.segment.id] = b.tier; return acc; }, {} as Record<string, string>);
assert(pinnedTiers[pinnedA.id] !== "excluded", "pinned segment A not excluded");
assert(pinnedTiers[pinnedB.id] !== "excluded", "pinned segment B not excluded");

// ── Cross-session budget cap ──
console.log("\n  cross-session budget cap:");

const crossSeg1 = createSegment("cross-1");
crossSeg1.tokenCount = 5000;
crossSeg1.status = "closed";
crossSeg1.summary = "Cross session 1";
crossSeg1.summaryTokens = 20;
crossSeg1.sessionId = "past-session";
crossSeg1.transcriptPath = "/tmp/past.jsonl";
crossSeg1.lastActiveAt = Date.now() - 60000;

const crossSeg2 = createSegment("cross-2");
crossSeg2.tokenCount = 5000;
crossSeg2.status = "closed";
crossSeg2.summary = "Cross session 2";
crossSeg2.summaryTokens = 20;
crossSeg2.sessionId = "past-session";
crossSeg2.transcriptPath = "/tmp/past.jsonl";
crossSeg2.lastActiveAt = Date.now() - 120000;

const scoredCross: ScoredSegment[] = [
  { segment: activeSeg, score: 1.0, semanticScore: 1, recencyScoreValue: 1 },
  { segment: crossSeg1, score: 0.9, semanticScore: 0.95, recencyScoreValue: 0.8 },
  { segment: crossSeg2, score: 0.8, semanticScore: 0.85, recencyScoreValue: 0.7 },
];

// Total budget 10000, cross-session cap 0.3 = 3000 tokens max for cross-session
const crossBudgets = allocateBudgets(scoredCross, 10000, 500, {
  currentSessionId: "current-session",
  pinRecentSegments: 0,
  maxCrossSessionBudgetRatio: 0.3,
  pinnedSegmentIds: [],
});
const crossTokensUsed = crossBudgets
  .filter(b => b.segment.sessionId !== undefined)
  .reduce((sum, b) => sum + b.allocatedTokens, 0);
assert(crossTokensUsed <= 10000 * 0.3, `cross-session tokens (${crossTokensUsed}) within 30% cap (${10000 * 0.3})`);

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
  maxCrossSessionBudgetRatio: 1.0,
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
crossNoSummary.summary = null;

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

// ── buildSelectionPlan ──
console.log("\n  buildSelectionPlan:");

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

// Mock params.messages
const planMessages: any[] = [
  { role: "user", content: [{ type: "text", text: "full msg 1" }], timestamp: 1 },
  { role: "assistant", content: [{ type: "text", text: "full msg 2" }], timestamp: 2 },
  { role: "user", content: [{ type: "text", text: "active msg 1" }], timestamp: 3 },
  { role: "assistant", content: [{ type: "text", text: "active msg 2" }], timestamp: 4 },
];

const planIndexMap = new Map<string, number>([
  ["pf1", 0], ["pf2", 1], ["pa1", 2], ["pa2", 3],
]);

const planBudgets = allocateBudgets(planScored, 5000, 500, defaultAllocOpts);
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

assert(plan.indices.includes(2) && plan.indices.includes(3),
  "plan: active segment indices present");
assert(plan.indices.includes(0) && plan.indices.includes(1),
  "plan: full segment indices present");
assert(plan.summaryBlocks.length > 0, "plan: summary blocks present");
assert(plan.summaryBlocks.some(b => b.includes("plan-summary")),
  "plan: summary block references topic");

for (let j = 1; j < plan.indices.length; j++) {
  assert(plan.indices[j] > plan.indices[j - 1],
    `plan: indices sorted (${plan.indices[j - 1]} < ${plan.indices[j]})`);
}

assert(plan.segmentPlans.length === 4, "plan: 4 segment plans");

// ── selectPartialIndices ──
console.log("\n  selectPartialIndices:");

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

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
