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
assertApprox(cosineSimilarity([0, 0], [0, 0]), 0.0, 0.01, "zero vectors");
assertApprox(cosineSimilarity([0, 0], [1, 1]), 0.0, 0.01, "one zero vector");
assertApprox(cosineSimilarity([1, 2], [1]), 0.0, 0.01, "different length vectors");

// recencyScore — time-based
console.log("\n  recencyScore (time-based):");
const oneDay = 86400000;
assertApprox(recencyScore(0, oneDay), 1.0, 0.01, "0ms ago = 1.0");
assertApprox(recencyScore(oneDay, oneDay), 0.5, 0.01, "1 day ago ≈ 0.5");
assertApprox(recencyScore(oneDay * 3, oneDay), 0.125, 0.01, "3 days ago ≈ 0.125");
assert(recencyScore(oneDay * 7, oneDay) < 0.01, "7 days ago ≈ 0");
assert(recencyScore(oneDay / 2, oneDay) > recencyScore(oneDay * 2, oneDay), "more recent > less recent");

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

const queryEmbedding = [1, 0, 0];
const halfLifeMs = 86400000;

const scored = scoreSegments(
  [segA, segB, segC],
  queryEmbedding,
  halfLifeMs,
  0.7
);

assert(scored[0].segment.status === "active", "active segment ranked first");

const scoreA = scored.find(s => s.segment.id === segA.id)!.score;
const scoreB = scored.find(s => s.segment.id === segB.id)!.score;
assert(scoreA > scoreB, "semantically similar segment scores higher");
assert(scored.every(s => s.score >= 0 && s.score <= 1), "all scores in [0, 1]");

// Recency-only fallback (alpha = 0)
console.log("\n  recency-only fallback:");
const recencyOnly = scoreSegments([segA, segB], queryEmbedding, halfLifeMs, 0);
assert(recencyOnly[0].segment.id === segA.id, "recency-only: more recent first");

// Cross-session segment scoring
console.log("\n  cross-session segment scoring:");
const pastSeg = createSegment("past-session-topic");
pastSeg.embedding = [0.95, 0.05, 0];
pastSeg.lastActiveAt = Date.now() - oneDay; // 1 day ago
pastSeg.status = "closed";
pastSeg.sessionId = "past-session";
pastSeg.transcriptPath = "/tmp/past.jsonl";

const crossScored = scoreSegments(
  [segA, pastSeg, segC],
  queryEmbedding,
  halfLifeMs,
  0.7
);
assert(crossScored[0].segment.status === "active", "cross: active first");
// pastSeg has high semantic similarity but lower recency
const pastScore = crossScored.find(s => s.segment.id === pastSeg.id)!;
assert(pastScore.score > 0, "cross: past segment has positive score");
assert(pastScore.recencyScoreValue < 1, "cross: past segment has decayed recency");

// Missing embedding on pool segment — recency only
console.log("\n  missing embedding fallback:");
const noEmbedSeg = createSegment("no-embed");
noEmbedSeg.embedding = [];
noEmbedSeg.lastActiveAt = Date.now() - 1000;
noEmbedSeg.status = "closed";
noEmbedSeg.sessionId = "old-session";

const noEmbedScored = scoreSegments(
  [noEmbedSeg],
  queryEmbedding,
  halfLifeMs,
  0.7
);
assert(noEmbedScored[0].semanticScore === 0, "no-embed: semantic score is 0");
assert(noEmbedScored[0].recencyScoreValue > 0, "no-embed: still has recency score");

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
