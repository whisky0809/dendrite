import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TurnSnapshotMessage, TurnSnapshot } from "./types.js";
import { extractTextContent, estimateTokens } from "./types.js";
import { DendriteStore } from "./store.js";

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

// === Task 3: resolveSessionId and getSessionLabel ===

function makeSnapshot(sessionId: string, segments: TurnSnapshot["segments"]): TurnSnapshot {
  return {
    timestamp: 1000,
    turnIndex: 1,
    sessionId,
    segments,
    messages: [],
    systemPreamble: "",
    stats: {
      tokenBudget: 100000,
      tokensUsed: 500,
      segmentsTotal: segments.length,
      segmentsIncluded: segments.length,
      segmentsExcluded: 0,
      embeddingsAvailable: true,
      driftAvailable: true,
      fallbacks: [],
    },
  };
}

{
  // Set up temp directory
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dendrite-test-"));
  const configPath = path.join(tmpDir, "config.json");
  const store = new DendriteStore(tmpDir, configPath);

  const sessionA = "aaa-1111-session";
  const sessionB = "aaa-2222-session";
  const sessionC = "bbb-3333-session";

  // Create session directories with snapshots
  const segActive = {
    id: "seg_1", topic: "Active Topic", status: "active" as const,
    messageCount: 5, tokenCount: 500, summary: null, tier: "active" as const,
    allocatedTokens: 500, compositeScore: 1, semanticScore: 1, recencyScore: 1,
  };
  const segClosed = {
    id: "seg_2", topic: "Closed Topic", status: "closed" as const,
    messageCount: 3, tokenCount: 300, summary: null, tier: "partial" as const,
    allocatedTokens: 300, compositeScore: 0.5, semanticScore: 0.5, recencyScore: 0.5,
  };

  store.persistTurn(makeSnapshot(sessionA, [segActive]));
  store.persistTurn(makeSnapshot(sessionB, [segClosed]));
  // sessionC: empty (no turns) — just create the directory
  const sessionCDir = path.join(tmpDir, "dendrite", "turns", sessionC);
  fs.mkdirSync(sessionCDir, { recursive: true });

  // --- resolveSessionId tests ---

  // Unique prefix resolves to full ID
  assert.equal(store.resolveSessionId("bbb"), sessionC);

  // Ambiguous prefix (2+ matches) returns null
  assert.equal(store.resolveSessionId("aaa"), null);

  // No match returns null
  assert.equal(store.resolveSessionId("zzz"), null);

  // Full ID works
  assert.equal(store.resolveSessionId(sessionA), sessionA);

  // --- getSessionLabel tests ---

  // Session with active segment returns that topic
  assert.equal(store.getSessionLabel(sessionA), "Active Topic");

  // Session with only closed segments returns the last closed topic
  assert.equal(store.getSessionLabel(sessionB), "Closed Topic");

  // Empty session (no turns) returns "(no topic)"
  assert.equal(store.getSessionLabel(sessionC), "(no topic)");

  // Clean up
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log("PASS: resolveSessionId and getSessionLabel");
}
