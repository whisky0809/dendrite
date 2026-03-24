/**
 * Integration test: full dendrite pipeline without OpenClaw.
 *
 * Simulates: cold start → multi-topic conversation → assembly with budget pressure.
 * Does NOT call live LLMs — uses the Segmenter directly with manual splits.
 */

import { Segmenter } from "./segmenter.js";
import { scoreSegments } from "./scorer.js";
import { allocateBudgets, buildMessageArray } from "./assembler.js";
import { estimateTokens, type SimpleMessage } from "./types.js";

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}

console.log("=== Integration ===\n");

// ── Simulate a conversation with topic changes ──

const segmenter = new Segmenter({
  minMessagesBeforeDrift: 2,
  maxSegmentMessages: 100,
  driftThreshold: 0.7,
});

// Use recent timestamps (current time offsets) so time-based recency scoring works correctly
const now = Date.now();

// Phase 1: REST API discussion (6 messages) — happened ~60 minutes ago
const restMessages: SimpleMessage[] = [
  { id: "r1", role: "user", content: "Let's design the REST API for our task management system", timestamp: now - 3600000 },
  { id: "r2", role: "assistant", content: "Great idea. We need CRUD endpoints for tasks, users, and projects", timestamp: now - 3540000 },
  { id: "r3", role: "user", content: "Should we use JWT or session cookies for authentication?", timestamp: now - 3480000 },
  { id: "r4", role: "assistant", content: "JWT is better for mobile clients. I suggest 15-minute access tokens with refresh tokens", timestamp: now - 3420000 },
  { id: "r5", role: "user", content: "Agreed on JWT. What about rate limiting?", timestamp: now - 3360000 },
  { id: "r6", role: "assistant", content: "100 requests per minute per user, with burst allowance of 20", timestamp: now - 3300000 },
];
for (const msg of restMessages) segmenter.addMessage(msg);

// Simulate drift detection: topic change to Docker
segmenter.addMessage({ id: "d0", role: "user", content: "Wait, how does our Docker container networking work?", timestamp: now - 3240000 });
segmenter.splitOnDrift("docker-networking");

// Phase 2: Docker discussion (4 messages) — happened ~30 minutes ago
const dockerMessages: SimpleMessage[] = [
  { id: "d1", role: "assistant", content: "We use bridge networking with port mapping", timestamp: now - 1800000 },
  { id: "d2", role: "user", content: "Can we switch to host networking for better performance?", timestamp: now - 1740000 },
  { id: "d3", role: "assistant", content: "Host networking removes isolation. Bridge is safer for production", timestamp: now - 1680000 },
];
for (const msg of dockerMessages) segmenter.addMessage(msg);

// Another drift: K8s
segmenter.addMessage({ id: "k0", role: "user", content: "What about Kubernetes deployment strategy?", timestamp: now - 600000 });
segmenter.splitOnDrift("kubernetes-deployment");

// Phase 3: K8s discussion (active) — happening now
const k8sMessages: SimpleMessage[] = [
  { id: "k1", role: "assistant", content: "We should use rolling deployments with health checks", timestamp: now - 300000 },
  { id: "k2", role: "user", content: "Helm or Kustomize?", timestamp: now - 60000 },
];
for (const msg of k8sMessages) segmenter.addMessage(msg);

// Verify segment structure
assert(segmenter.segments.length === 3, "3 segments created");
assert(segmenter.segments[0].topic === "conversation", "seg 0: REST API (default topic)");
assert(segmenter.segments[0].status === "closed", "seg 0: closed");
assert(segmenter.segments[1].topic === "docker-networking", "seg 1: docker");
assert(segmenter.segments[1].status === "closed", "seg 1: closed");
assert(segmenter.segments[2].topic === "kubernetes-deployment", "seg 2: k8s (active)");
assert(segmenter.segments[2].status === "active", "seg 2: active");

// Add mock embeddings and summaries
segmenter.segments[0].embedding = [1, 0, 0]; // REST API
segmenter.segments[0].summary = "Designed REST API for task management. Decided on JWT auth (15-min tokens). Rate limiting: 100 req/min with burst of 20.";
segmenter.segments[0].summaryTokens = estimateTokens(segmenter.segments[0].summary);

segmenter.segments[1].embedding = [0, 1, 0]; // Docker
segmenter.segments[1].summary = "Discussed Docker networking. Using bridge mode with port mapping. Host networking rejected for production (isolation concerns).";
segmenter.segments[1].summaryTokens = estimateTokens(segmenter.segments[1].summary);

segmenter.segments[2].embedding = [0, 0, 1]; // K8s

console.log("\n  Assembly with large budget:");

// Score with K8s-like query (active topic)
const queryEmbed = [0, 0, 1]; // K8s-similar
const scored = scoreSegments(segmenter.segments, queryEmbed, 86400000, 0.7);

assert(scored[0].segment.status === "active", "active segment ranked first");
assert(scored[0].segment.topic === "kubernetes-deployment", "active is K8s");

// Large budget — everything fits
const defaultAllocOpts = { currentSessionId: undefined, pinRecentSegments: 0, maxCrossSessionBudgetRatio: 1.0, pinnedSegmentIds: [] as string[] };
const largeBudget = allocateBudgets(scored, 50000, 2000, defaultAllocOpts);
const fullCount = largeBudget.filter(b => b.tier === "full" || b.tier === "active").length;
assert(fullCount === 3, "large budget: all segments fully expanded");

const largeResult = buildMessageArray(largeBudget, (ids, _segment) => segmenter.getMessages(ids));
assert(largeResult.length >= 12, "large budget: all messages present");

console.log("\n  Assembly with tight budget:");

// Tight budget — forces compression
const tightBudget = allocateBudgets(scored, 100, 200, defaultAllocOpts);
const excluded = tightBudget.filter(b => b.tier === "excluded").length;
const summarized = tightBudget.filter(b => b.tier === "summary").length;
assert(excluded + summarized > 0, "tight budget: some segments compressed or excluded");
assert(tightBudget[0].tier === "active", "tight budget: active always present");

const tightResult = buildMessageArray(tightBudget, (ids, _segment) => segmenter.getMessages(ids));
assert(tightResult.length < largeResult.length, "tight budget: fewer messages than large");
assert(tightResult.some(m => m.role === "system"), "tight budget: has system preamble with summaries");

console.log("\n  Topic return simulation:");

// Now simulate the user returning to REST API topic
const returnQuery = [0.9, 0, 0.1]; // REST API-similar
const returnScored = scoreSegments(segmenter.segments, returnQuery, 86400000, 0.7);

// REST API segment should score higher than Docker
const restScore = returnScored.find(s => s.segment.topic === "conversation")!;
const dockerScore = returnScored.find(s => s.segment.topic === "docker-networking")!;
assert(restScore.score > dockerScore.score, "return: REST API scores higher than Docker when query is similar");

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
