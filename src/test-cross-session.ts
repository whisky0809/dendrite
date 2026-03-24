/**
 * Integration test: Cross-session segment recall.
 *
 * Simulates a multi-session scenario:
 * 1. Pre-build segment files for two past sessions
 * 2. Create a SegmentPool, verify it loads them
 * 3. Score combined segments (current + past)
 * 4. Allocate budgets with pinning and cross-session cap
 * 5. Build message array with lazy loading from transcript files
 */

import { SegmentPool } from "./segment-pool.js";
import { scoreSegments } from "./scorer.js";
import { allocateBudgets, buildSelectionPlan } from "./assembler.js";
import { createSegment, estimateTokens, extractTextContent, type SimpleMessage } from "./types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}

console.log("=== Cross-Session Integration ===\n");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dendrite-cross-"));
const segmentsDir = path.join(tmpDir, "dendrite", "segments");
fs.mkdirSync(segmentsDir, { recursive: true });

// ── Past session 1: Docker networking (1 day ago) ──
const dockerTranscriptPath = path.join(tmpDir, "docker-session.jsonl");
fs.writeFileSync(dockerTranscriptPath, [
  JSON.stringify({ role: "user", content: [{ type: "text", text: "How do I set up Docker bridge networking?" }], id: "d_msg_1", timestamp: Date.now() - 86400000 }),
  JSON.stringify({ role: "assistant", content: [{ type: "text", text: "Docker bridge networking uses docker0 interface..." }], id: "d_msg_2", timestamp: Date.now() - 86400000 + 1000 }),
].join("\n"));

const dockerSegFile = {
  sessionId: "docker-session",
  agentId: "atlas",
  transcriptPath: dockerTranscriptPath,
  exportedAt: Date.now() - 86400000,
  segments: [{
    id: "seg_docker",
    topic: "Docker networking",
    embedding: [0.8, 0.2, 0.1, 0.0],
    messageIds: ["d_msg_1", "d_msg_2"],
    messageCount: 2,
    tokenCount: 200,
    summary: "Discussed Docker bridge networking setup and docker0 interface",
    summaryTokens: 20,
    lastActiveAt: Date.now() - 86400000,
    status: "closed" as const,
  }],
};
fs.writeFileSync(path.join(segmentsDir, "docker-session.json"), JSON.stringify(dockerSegFile, null, 2));

// ── Past session 2: Python debugging (3 days ago) ──
const pythonTranscriptPath = path.join(tmpDir, "python-session.jsonl");
fs.writeFileSync(pythonTranscriptPath, [
  JSON.stringify({ role: "user", content: [{ type: "text", text: "My Python script has a memory leak" }], id: "p_msg_1", timestamp: Date.now() - 259200000 }),
  JSON.stringify({ role: "assistant", content: [{ type: "text", text: "Let's use tracemalloc to find the leak..." }], id: "p_msg_2", timestamp: Date.now() - 259200000 + 1000 }),
].join("\n"));

const pythonSegFile = {
  sessionId: "python-session",
  agentId: "atlas",
  transcriptPath: pythonTranscriptPath,
  exportedAt: Date.now() - 259200000,
  segments: [{
    id: "seg_python",
    topic: "Python memory leak",
    embedding: [0.1, 0.1, 0.8, 0.2],
    messageIds: ["p_msg_1", "p_msg_2"],
    messageCount: 2,
    tokenCount: 180,
    summary: "Debugged Python memory leak using tracemalloc",
    summaryTokens: 15,
    lastActiveAt: Date.now() - 259200000,
    status: "closed" as const,
  }],
};
fs.writeFileSync(path.join(segmentsDir, "python-session.json"), JSON.stringify(pythonSegFile, null, 2));

// ── Current session: asking about Docker compose ──
console.log("  Pool loading:");
const pool = new SegmentPool(tmpDir);
assert(pool.poolSegments.length === 2, "pool loaded 2 past segments");

const currentActive = createSegment("Docker compose");
currentActive.status = "active";
currentActive.embedding = [0.7, 0.3, 0.1, 0.0];
currentActive.messageIds = ["c_msg_1"];
currentActive.messageCount = 1;
currentActive.tokenCount = 50;

const currentClosed = createSegment("project setup");
currentClosed.status = "closed";
currentClosed.embedding = [0.2, 0.2, 0.2, 0.5];
currentClosed.messageIds = ["c_msg_0"];
currentClosed.messageCount = 1;
currentClosed.tokenCount = 40;
currentClosed.summary = "Set up the project repository";
currentClosed.summaryTokens = 10;
currentClosed.lastActiveAt = Date.now() - 5000;

const currentSegments = [currentClosed, currentActive];

// ── Combined segments ──
console.log("\n  Combined segments:");
const combined = pool.getCombinedSegments(currentSegments, "current-session");
assert(combined.length === 4, "combined: 2 current + 2 pool = 4");

// ── Scoring ──
console.log("\n  Scoring:");
const queryEmbedding = [0.75, 0.25, 0.1, 0.0];
const halfLifeMs = 86400000;

const scored = scoreSegments(combined, queryEmbedding, halfLifeMs, 0.7);
assert(scored[0].segment.status === "active", "active segment first");

// Docker segment should rank higher than Python (more semantically similar + more recent)
const dockerScore = scored.find(s => s.segment.id === "seg_docker")!;
const pythonScore = scored.find(s => s.segment.id === "seg_python")!;
assert(dockerScore.score > pythonScore.score, "Docker segment scores higher than Python (semantic + recency)");
assert(dockerScore.semanticScore > 0.5, "Docker segment has high semantic similarity");
assert(pythonScore.recencyScoreValue < dockerScore.recencyScoreValue, "Python has lower recency (3 days vs 1 day)");

// ── Budget allocation with cross-session cap ──
console.log("\n  Budget allocation:");
const pinnedIds = [currentClosed.id];
const budgets = allocateBudgets(scored, 5000, 500, {
  currentSessionId: "current-session",
  pinRecentSegments: 1,
  maxCrossSessionBudgetRatio: 0.3,
  pinnedSegmentIds: pinnedIds,
});

// Pinned segment should not be excluded
const pinnedBudget = budgets.find(b => b.segment.id === currentClosed.id)!;
assert(pinnedBudget.tier !== "excluded", "pinned current segment not excluded");

// Cross-session segments should be within cap
const crossTokens = budgets
  .filter(b => b.segment.sessionId !== undefined)
  .reduce((sum, b) => sum + b.allocatedTokens, 0);
assert(crossTokens <= 5000 * 0.3, `cross-session tokens (${crossTokens}) within 30% cap`);

// ── Message assembly with index-based selection ──
console.log("\n  Index-based assembly:");

// Create mock params.messages for current session
const paramsMessages: any[] = [
  { role: "user", content: [{ type: "text", text: "Set up the project" }], timestamp: Date.now() - 5000 },
  { role: "user", content: [{ type: "text", text: "How do I use Docker compose with this?" }], timestamp: Date.now() },
];

// Map current-session message IDs to params.messages indices
const idToIndex = new Map<string, number>([["c_msg_0", 0], ["c_msg_1", 1]]);

const estimateAgentTokens = (msg: any) => estimateTokens(extractTextContent(msg));
const plan = buildSelectionPlan(budgets, (segment) => {
  return segment.messageIds
    .map(id => idToIndex.get(id))
    .filter((i): i is number => i !== undefined);
}, paramsMessages, estimateAgentTokens);

// Active segment messages should be in indices
assert(plan.indices.includes(1), "active segment message in selection");

// Cross-session segments should be summary-only (never full/partial)
const dockerBudget = budgets.find(b => b.segment.id === "seg_docker")!;
const pythonBudget = budgets.find(b => b.segment.id === "seg_python")!;
assert(dockerBudget.tier === "summary" || dockerBudget.tier === "excluded",
  `Docker cross-session is summary/excluded (got ${dockerBudget.tier})`);
assert(pythonBudget.tier === "summary" || pythonBudget.tier === "excluded",
  `Python cross-session is summary/excluded (got ${pythonBudget.tier})`);

// Cross-session summaries should be in summaryBlocks
if (dockerBudget.tier === "summary") {
  assert(plan.summaryBlocks.some(b => b.includes("Docker")), "Docker summary in summaryBlocks");
}

console.log(`\n  Docker segment tier: ${dockerBudget.tier}`);
console.log(`  Python segment tier: ${pythonBudget.tier}`);

// Cleanup
fs.rmSync(tmpDir, { recursive: true });

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
