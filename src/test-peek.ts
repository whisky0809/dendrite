import { strict as assert } from "node:assert";
import type { TurnSnapshotMessage, TurnSnapshot } from "./types.js";
import { extractTextContent, estimateTokens } from "./types.js";

// === Task 1: TurnSnapshot type checks ===

const msg: TurnSnapshotMessage = {
  role: "user",
  segmentId: "seg_abc",
  tokenCount: 100,
  contentPreview: "hello",
  contentFull: "hello world",
};
assert.equal(msg.role, "user");
assert.equal(msg.segmentId, "seg_abc");

const snapshot: TurnSnapshot = {
  timestamp: 1000,
  turnIndex: 1,
  sessionId: "test",
  segments: [],
  messages: [msg],
  systemPreamble: "",
  stats: {
    tokenBudget: 100000,
    tokensUsed: 100,
    segmentsTotal: 0,
    segmentsIncluded: 0,
    segmentsExcluded: 0,
    embeddingsAvailable: false,
    driftAvailable: false,
    fallbacks: [],
  },
};
assert.equal(snapshot.messages!.length, 1);
assert.equal(snapshot.systemPreamble, "");

// Backward compat: assembledContext is optional
const legacy: TurnSnapshot = {
  ...snapshot,
  assembledContext: "old format",
  messages: undefined,
};
assert.equal(legacy.assembledContext, "old format");

// === Task 2 prep: content extraction ===
const agentMsg = {
  role: "user",
  content: [{ type: "text", text: "Hello, can you help me?" }],
};
const extracted = extractTextContent(agentMsg);
assert.equal(extracted, "Hello, can you help me?");
assert.equal(estimateTokens(extracted), Math.ceil(23 / 4));

const longText = "x".repeat(300);
const preview = longText.slice(0, 200);
assert.equal(preview.length, 200);

console.log("PASS: TurnSnapshot types and content extraction");
