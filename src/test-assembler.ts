import { allocateBudgets, buildMessageArray, type BudgetAllocation } from "./assembler.js";
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
const budgetLarge = allocateBudgets(scored, 10000, 2000);
assert(budgetLarge[0].tier === "active", "large budget: active segment is active tier");
assert(budgetLarge[1].tier === "full", "large budget: high-relevance gets full");
assert(budgetLarge[2].tier === "full", "large budget: medium-relevance gets full (budget available)");

// Tight budget — forces compression
const budgetTight = allocateBudgets(scored, 1000, 500);
assert(budgetTight[0].tier === "active", "tight budget: active still active");
const tiers = budgetTight.map(b => b.tier);
assert(tiers.includes("summary") || tiers.includes("excluded"), "tight budget: some segments compressed");

// Very tight — active segment gets reserveTokens as a guaranteed floor.
// totalBudget=200, reserveTokens=300: active gets min(500, 200+300) = 500 (all tokens fit).
// Since active.tokenCount(500) <= totalBudget+reserveTokens(500), allocatedTokens = 500.
const budgetTiny = allocateBudgets(scored, 200, 300);
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

// ── buildMessageArray ──
console.log("\n  buildMessageArray:");

const messages: Map<string, SimpleMessage> = new Map();
const msgA1: SimpleMessage = { id: "a1", role: "user", content: "Hello about topic A", timestamp: 1 };
const msgA2: SimpleMessage = { id: "a2", role: "assistant", content: "Sure, topic A response", timestamp: 2 };
const msgActive1: SimpleMessage = { id: "act1", role: "user", content: "Active topic message", timestamp: 3 };
messages.set("a1", msgA1);
messages.set("a2", msgA2);
messages.set("act1", msgActive1);

activeSeg.messageIds = ["act1"];
closedA.messageIds = ["a1", "a2"];

const allocations: BudgetAllocation[] = [
  { segment: activeSeg, tier: "active", allocatedTokens: 500, scored: scored[0] },
  { segment: closedA, tier: "summary", allocatedTokens: 20, scored: scored[1] },
];

const result = buildMessageArray(allocations, (ids, _segment) =>
  ids.map(id => messages.get(id)!).filter(Boolean)
);

// Should have a preamble system message + active messages
assert(result.length >= 2, "buildMessageArray: has preamble + active messages");

// First message should be the system preamble with summaries
const preamble = result[0];
assert(preamble.role === "system", "buildMessageArray: first message is system role");
assert(typeof preamble.content === "string" && preamble.content.includes("topic-a"), "buildMessageArray: preamble includes topic-a summary");

// Active messages should be present
const activeMessages = result.filter(m => m.role === "user" && typeof m.content === "string" && m.content.includes("Active topic"));
assert(activeMessages.length === 1, "buildMessageArray: active messages included");

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
