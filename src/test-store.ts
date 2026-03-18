import { DendriteStore } from "./store.js";
import { DEFAULT_CONFIG, type TurnSnapshot } from "./types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dendrite-test-"));
const configPath = path.join(tmpDir, "openclaw.json");

const minimalConfig = {
  plugins: {
    entries: {
      dendrite: {
        enabled: true,
        config: {
          driftThreshold: 0.5,
        },
      },
    },
  },
};
fs.writeFileSync(configPath, JSON.stringify(minimalConfig, null, 2));

const store = new DendriteStore(tmpDir, configPath);

console.log("=== DendriteStore ===\n");

console.log("  persistTurn / getTurn:");

const snapshot: TurnSnapshot = {
  timestamp: Date.now(),
  turnIndex: 1,
  sessionId: "test-session",
  segments: [
    {
      id: "seg1",
      topic: "greeting",
      status: "active",
      messageCount: 5,
      tokenCount: 200,
      summary: null,
      tier: "active",
      allocatedTokens: 200,
      compositeScore: 1.0,
      semanticScore: 1.0,
      recencyScore: 1.0,
    },
  ],
  assembledContext: "Hello, this is the assembled context",
  stats: {
    tokenBudget: 32000,
    tokensUsed: 200,
    segmentsTotal: 1,
    segmentsIncluded: 1,
    segmentsExcluded: 0,
    embeddingsAvailable: true,
    driftAvailable: true,
    fallbacks: [],
  },
};

store.persistTurn(snapshot);

const turns = store.listTurns("test-session");
assert(turns.length === 1, "listTurns returns 1 turn after persist");
assert(turns[0].turnIndex === 1, "listed turn has correct turnIndex");

const retrieved = store.getTurn("test-session", turns[0].filename);
assert(retrieved !== null, "getTurn returns the snapshot");
assert(retrieved!.assembledContext === snapshot.assembledContext, "getTurn preserves assembledContext");
assert(retrieved!.segments.length === 1, "getTurn preserves segments");

console.log("\n  listTurns ordering:");

const snapshot2: TurnSnapshot = { ...snapshot, turnIndex: 2, timestamp: Date.now() + 1000 };
store.persistTurn(snapshot2);

const allTurns = store.listTurns("test-session");
assert(allTurns.length === 2, "listTurns returns 2 turns");
assert(allTurns[0].turnIndex < allTurns[1].turnIndex, "turns are ordered chronologically");

console.log("\n  getConfig:");

const config = store.getConfig();
assert(config !== null, "getConfig returns config");
assert(config!.driftThreshold === 0.5, "getConfig reads user-set value");

console.log("\n  setConfig:");

store.setConfig("reserveTokens", 4096);
const updated = store.getConfig();
assert(updated!.reserveTokens === 4096, "setConfig persists new value");

const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
assert(raw.plugins.entries.dendrite.config.reserveTokens === 4096, "setConfig writes to openclaw.json under .config");

console.log("\n  listSessions:");

const snapshot3: TurnSnapshot = { ...snapshot, sessionId: "other-session", turnIndex: 1 };
store.persistTurn(snapshot3);

const sessions = store.listSessions();
assert(sessions.length === 2, "listSessions returns 2 sessions");
assert(sessions.includes("test-session"), "listSessions includes test-session");
assert(sessions.includes("other-session"), "listSessions includes other-session");

// Snapshot shape validation
console.log("\n  snapshot shape validation:");

const fullSnapshot: TurnSnapshot = {
  timestamp: Date.now(),
  turnIndex: 5,
  sessionId: "shape-test",
  segments: [
    {
      id: "seg_abc",
      topic: "coding",
      status: "active",
      messageCount: 10,
      tokenCount: 500,
      summary: null,
      tier: "active",
      allocatedTokens: 500,
      compositeScore: 1.0,
      semanticScore: 1.0,
      recencyScore: 1.0,
    },
    {
      id: "seg_def",
      topic: "architecture",
      status: "closed",
      messageCount: 20,
      tokenCount: 1200,
      summary: "Discussed system architecture",
      tier: "summary",
      allocatedTokens: 30,
      compositeScore: 0.6,
      semanticScore: 0.5,
      recencyScore: 0.8,
    },
  ],
  assembledContext: "[Prior context — architecture: Discussed system architecture]\n\nuser: Current message",
  stats: {
    tokenBudget: 32000,
    tokensUsed: 530,
    segmentsTotal: 2,
    segmentsIncluded: 2,
    segmentsExcluded: 0,
    embeddingsAvailable: true,
    driftAvailable: true,
    fallbacks: [],
  },
};

store.persistTurn(fullSnapshot);
const retrieved2 = store.getTurn("shape-test", store.listTurns("shape-test")[0].filename);
assert(retrieved2!.segments.length === 2, "full snapshot preserves all segments");
assert(retrieved2!.segments[1].tier === "summary", "full snapshot preserves tier info");
assert(retrieved2!.stats.tokensUsed === 530, "full snapshot preserves stats");

fs.rmSync(tmpDir, { recursive: true });

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
