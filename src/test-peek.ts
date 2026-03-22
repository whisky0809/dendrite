import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TurnSnapshotMessage, TurnSnapshot } from "./types.js";
import { extractTextContent, estimateTokens } from "./types.js";
import { DendriteStore, type TurnListEntry } from "./store.js";
import { resolveTurn, formatPeekDashboard } from "./cli.js";

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

// === Task 4: resolveTurn tests ===

{
  const turns: TurnListEntry[] = [
    { filename: "1000_5.json", turnIndex: 5, timestamp: 1000 },
    { filename: "2000_10.json", turnIndex: 10, timestamp: 2000 },
    { filename: "3000_15.json", turnIndex: 15, timestamp: 3000 },
  ];

  // Positive index: match by turnIndex
  assert.deepEqual(resolveTurn(turns, 10), turns[1]);
  // Negative index: count from end
  assert.deepEqual(resolveTurn(turns, -1), turns[2]);
  assert.deepEqual(resolveTurn(turns, -2), turns[1]);
  // No match
  assert.equal(resolveTurn(turns, 99), null);
  assert.equal(resolveTurn(turns, -4), null);

  console.log("PASS: resolveTurn");
}

// === Task 5: formatPeekDashboard tests ===

{
  const dashSnapshot: TurnSnapshot = {
    timestamp: new Date("2026-03-21T01:43:00Z").getTime(),
    turnIndex: 14,
    sessionId: "233d8a9b-1234-5678-abcd-1234567890ab",
    segments: [
      {
        id: "seg_active1",
        topic: "setting up drift model",
        status: "active",
        messageCount: 14,
        tokenCount: 1306,
        summary: null,
        tier: "active",
        allocatedTokens: 1306,
        compositeScore: 1,
        semanticScore: 1,
        recencyScore: 1,
      },
      {
        id: "seg_closed1",
        topic: "initial project setup",
        status: "closed",
        messageCount: 80,
        tokenCount: 30000,
        summary: "Setting up the project structure",
        tier: "full",
        allocatedTokens: 27336,
        compositeScore: 0.67,
        semanticScore: 0.58,
        recencyScore: 0.90,
      },
    ],
    messages: [
      { role: "user", segmentId: null, tokenCount: 10, contentPreview: "system message", contentFull: "system message full" },
      { role: "user", segmentId: "seg_active1", tokenCount: 50, contentPreview: "hello there", contentFull: "hello there, this is the full content" },
      { role: "assistant", segmentId: "seg_active1", tokenCount: 100, contentPreview: "hi! how can I help", contentFull: "hi! how can I help you today?" },
      { role: "user", segmentId: "seg_closed1", tokenCount: 30, contentPreview: "setup question", contentFull: "setup question full text" },
    ],
    systemPreamble: "You are a helpful assistant.",
    stats: {
      tokenBudget: 256000,
      tokensUsed: 28642,
      segmentsTotal: 2,
      segmentsIncluded: 2,
      segmentsExcluded: 0,
      embeddingsAvailable: true,
      driftAvailable: true,
      fallbacks: [],
    },
  };

  // Default view
  const defaultOut = formatPeekDashboard(dashSnapshot, { full: false, segmentsOnly: false });
  assert.ok(defaultOut.includes("233d8a9b"), "Should include short session ID");
  assert.ok(defaultOut.includes("Turn #14"), "Should include turn number");
  assert.ok(defaultOut.includes("28,642"), "Should include formatted token count");
  assert.ok(defaultOut.includes("256,000"), "Should include formatted budget");
  assert.ok(defaultOut.includes("setting up drift model"), "Should include segment topic");
  assert.ok(defaultOut.includes("initial project setup"), "Should include second segment topic");
  assert.ok(defaultOut.includes("hello there"), "Should include message preview");
  assert.ok(defaultOut.includes("TIER"), "Should include segment table header");

  // segmentsOnly
  const segOnly = formatPeekDashboard(dashSnapshot, { full: false, segmentsOnly: true });
  assert.ok(segOnly.includes("setting up drift model"), "segmentsOnly should include segment topics");
  assert.ok(!segOnly.includes("hello there"), "segmentsOnly should NOT include message previews");

  // full mode
  const fullOut = formatPeekDashboard(dashSnapshot, { full: true, segmentsOnly: false });
  assert.ok(fullOut.includes("hello there, this is the full content"), "full mode should show contentFull");

  // Legacy snapshot
  const legacySnapshot: TurnSnapshot = {
    timestamp: 1000,
    turnIndex: 1,
    sessionId: "legacy-session-id-1234",
    segments: [],
    messages: undefined,
    assembledContext: "This is raw assembled context from the old format.",
    stats: {
      tokenBudget: 100000,
      tokensUsed: 500,
      segmentsTotal: 0,
      segmentsIncluded: 0,
      segmentsExcluded: 0,
      embeddingsAvailable: false,
      driftAvailable: false,
      fallbacks: [],
    },
  };
  const legacyOut = formatPeekDashboard(legacySnapshot, { full: false, segmentsOnly: false });
  assert.ok(legacyOut.includes("legacy snapshot"), "Legacy should show legacy note");
  assert.ok(legacyOut.includes("raw assembled context from the old format"), "Legacy should show raw content");

  console.log("PASS: formatPeekDashboard");
}
