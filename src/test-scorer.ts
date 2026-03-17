import { cosineSimilarity, recencyScore, scoreSegments, type ScoredSegment } from "./scorer.js";
import { createSegment } from "./types.js";

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}
function assertApprox(actual: number, expected: number, tolerance: number, name: string) {
  assert(Math.abs(actual - expected) <= tolerance, `${name} (${actual.toFixed(3)} ≈ ${expected})`);
}

console.log("=== Scorer ===\n");

// cosineSimilarity
console.log("  cosineSimilarity:");
assertApprox(cosineSimilarity([1, 0], [1, 0]), 1.0, 0.01, "identical vectors");
assertApprox(cosineSimilarity([1, 0], [0, 1]), 0.0, 0.01, "orthogonal vectors");
assertApprox(cosineSimilarity([1, 0], [-1, 0]), -1.0, 0.01, "opposite vectors");
assertApprox(cosineSimilarity([], []), 0.0, 0.01, "empty vectors");
assertApprox(cosineSimilarity([3, 4], [3, 4]), 1.0, 0.01, "scaled identical");

// recencyScore
console.log("\n  recencyScore:");
assertApprox(recencyScore(0), 1.0, 0.01, "0 turns ago = 1.0");
assertApprox(recencyScore(10), 0.5, 0.05, "10 turns ago ≈ 0.5");
assert(recencyScore(100) < 0.01, "100 turns ago ≈ 0");
assert(recencyScore(5) > recencyScore(20), "more recent > less recent");

// scoreSegments
console.log("\n  scoreSegments:");
const segA = createSegment("topic-a");
segA.embedding = [1, 0, 0];
segA.lastActiveAt = Date.now();
segA.status = "closed";

const segB = createSegment("topic-b");
segB.embedding = [0, 1, 0];
segB.lastActiveAt = Date.now() - 60000; // 1 minute ago
segB.status = "closed";

const segC = createSegment("active-topic");
segC.embedding = [0.9, 0.1, 0];
segC.status = "active";

const queryEmbedding = [1, 0, 0]; // most similar to segA
const totalTurns = 20;

const scored = scoreSegments(
  [segA, segB, segC],
  queryEmbedding,
  totalTurns,
  0.7 // alpha
);

// Active segment should always be first (highest score)
assert(scored[0].segment.status === "active", "active segment ranked first");

// segA should rank higher than segB (more similar to query)
const scoreA = scored.find(s => s.segment.id === segA.id)!.score;
const scoreB = scored.find(s => s.segment.id === segB.id)!.score;
assert(scoreA > scoreB, "semantically similar segment scores higher");

// All scores between 0 and 1
assert(scored.every(s => s.score >= 0 && s.score <= 1), "all scores in [0, 1]");

// Recency-only fallback (alpha = 0)
console.log("\n  recency-only fallback:");
const recencyOnly = scoreSegments([segA, segB], queryEmbedding, totalTurns, 0);
assert(recencyOnly[0].segment.id === segA.id, "recency-only: more recent first");

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
