import { createSegment, estimateTokens, extractTextContent, isUserMessage, DEFAULT_CONFIG } from "./types.js";

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}

console.log("=== Types ===\n");

// createSegment
const seg = createSegment("test-topic");
assert(seg.id.startsWith("seg_"), "createSegment: id has seg_ prefix");
assert(seg.topic === "test-topic", "createSegment: topic set");
assert(seg.status === "active", "createSegment: status is active");
assert(seg.messageIds.length === 0, "createSegment: empty messageIds");
assert(seg.summary === null, "createSegment: no summary");
assert(seg.embedding.length === 0, "createSegment: empty embedding");

// estimateTokens
assert(estimateTokens("hello world") === 3, "estimateTokens: short string");
assert(estimateTokens("a".repeat(400)) === 100, "estimateTokens: 400 chars = 100 tokens");
assert(estimateTokens("") === 0, "estimateTokens: empty string");

// extractTextContent — string content
const userMsg = { role: "user" as const, content: "hello", timestamp: Date.now() };
assert(extractTextContent(userMsg) === "hello", "extractTextContent: string content");

// extractTextContent — array content
const userMsgArray = {
  role: "user" as const,
  content: [{ type: "text" as const, text: "hello" }, { type: "text" as const, text: " world" }],
  timestamp: Date.now()
};
assert(extractTextContent(userMsgArray) === "hello world", "extractTextContent: array content");

// extractTextContent — assistant message
const assistantMsg = {
  role: "assistant" as const,
  content: [{ type: "text" as const, text: "response" }],
  api: "anthropic" as any, provider: "anthropic" as any,
  model: "test", usage: {} as any, stopReason: "end" as any, timestamp: Date.now()
};
assert(extractTextContent(assistantMsg) === "response", "extractTextContent: assistant message");

// isUserMessage
assert(isUserMessage(userMsg) === true, "isUserMessage: user message");
assert(isUserMessage(assistantMsg) === false, "isUserMessage: assistant message");

// ── New cross-session fields ──
console.log("\n  cross-session Segment fields:");

const crossSeg = createSegment("cross-session-topic");
assert(crossSeg.sessionId === undefined, "sessionId defaults to undefined");
assert(crossSeg.transcriptPath === undefined, "transcriptPath defaults to undefined");

crossSeg.sessionId = "test-session-id";
crossSeg.transcriptPath = "/tmp/test.jsonl";
assert(crossSeg.sessionId === "test-session-id", "sessionId can be set");
assert(crossSeg.transcriptPath === "/tmp/test.jsonl", "transcriptPath can be set");

// ── New config fields ──
console.log("\n  cross-session config defaults:");
assert(DEFAULT_CONFIG.pinRecentSegments === 3, "pinRecentSegments default is 3");
assert(DEFAULT_CONFIG.maxCrossSessionBudgetRatio === 0.3, "maxCrossSessionBudgetRatio default is 0.3");
assert(DEFAULT_CONFIG.recencyHalfLifeMs === 86400000, "recencyHalfLifeMs default is 86400000 (1 day)");
assert(DEFAULT_CONFIG.reserveTokens === 16384, "reserveTokens bumped to 16384");

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
