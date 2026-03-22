# Peek Tool Redesign Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix broken snapshot persistence and redesign `openclaw dendrite peek` as a non-interactive context inspector with structured output.

**Architecture:** Replace the flat `assembledContext` string in `TurnSnapshot` with structured per-message data (`TurnSnapshotMessage[]`), fix the content extraction bug in `plugin.ts`, add store helpers for session labels and partial UUID matching, then rewrite the CLI peek command with progressive-disclosure UX and a dashboard display.

**Tech Stack:** TypeScript (ESM, Node16 resolution), Node.js built-ins only, assert-based tests run via `npx tsx`.

**Spec:** `docs/superpowers/specs/2026-03-22-peek-tool-redesign.md`

**Worktree:** Yes — work in a dedicated worktree branched from `main`.

---

## Chunk 1: Data Model & Persistence

### Task 1: Update TurnSnapshot types

**Files:**
- Modify: `src/types.ts:80-112`

- [ ] **Step 1: Write failing test — TurnSnapshotMessage type exists**

Create `src/test-peek.ts`. All imports go at the top of the file; test blocks are appended below. The file structure is:

```typescript
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TurnSnapshotMessage, TurnSnapshot } from "./types.js";
import { extractTextContent, estimateTokens } from "./types.js";
import { DendriteStore, type TurnListEntry } from "./store.js";
import { resolveTurn, formatPeekDashboard } from "./cli.js";
```

Note: `resolveTurn` and `formatPeekDashboard` won't exist until Tasks 4-5. The test file will fail to import until those are implemented. To avoid this, use `try/catch` around dynamic imports for those, or simply accept that the full file won't run until all tasks are done. **Recommended approach:** build the test file incrementally — start with just the imports needed for Task 1, and add the rest as each task is implemented. The plan shows the final state of each test block below.

**Task 1 test block:**

```typescript
// Type-level check: TurnSnapshotMessage has the expected shape
const msg: TurnSnapshotMessage = {
  role: "user",
  segmentId: "seg_abc",
  tokenCount: 100,
  contentPreview: "hello",
  contentFull: "hello world",
};
assert.equal(msg.role, "user");
assert.equal(msg.segmentId, "seg_abc");

// Type-level check: TurnSnapshot has messages and systemPreamble
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
assert.equal(snapshot.messages.length, 1);
assert.equal(snapshot.systemPreamble, "");

// Backward compat: assembledContext is optional
const legacy: TurnSnapshot = {
  ...snapshot,
  assembledContext: "old format",
  messages: undefined as any,
};
assert.equal(legacy.assembledContext, "old format");

console.log("PASS: TurnSnapshot types");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/test-peek.ts`
Expected: FAIL — `TurnSnapshotMessage` does not exist, `messages` and `systemPreamble` are not on `TurnSnapshot`.

- [ ] **Step 3: Add TurnSnapshotMessage and update TurnSnapshot**

In `src/types.ts`, after the `TurnSnapshotSegment` interface (after line 94), add:

```typescript
export interface TurnSnapshotMessage {
  role: "user" | "assistant" | "toolResult";
  segmentId: string | null;
  tokenCount: number;
  contentPreview: string;
  contentFull: string;
}
```

Replace the existing `TurnSnapshot` interface (lines 96-112) with:

```typescript
export interface TurnSnapshot {
  timestamp: number;
  turnIndex: number;
  sessionId: string;
  segments: TurnSnapshotSegment[];
  messages?: TurnSnapshotMessage[];
  systemPreamble?: string;
  assembledContext?: string;
  stats: {
    tokenBudget: number;
    tokensUsed: number;
    segmentsTotal: number;
    segmentsIncluded: number;
    segmentsExcluded: number;
    embeddingsAvailable: boolean;
    driftAvailable: boolean;
    fallbacks: string[];
  };
}
```

All three fields (`messages`, `systemPreamble`, `assembledContext`) are optional so both old and new snapshots satisfy the type.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx src/test-peek.ts`
Expected: PASS

- [ ] **Step 5: Fix type error in cli.ts**

Making `assembledContext` optional will cause a type error at `src/cli.ts:122` (`snapshot.assembledContext`). Add a fallback: change `snapshot.assembledContext` to `snapshot.assembledContext ?? ""` in `formatPeekSummary`. This is a temporary fix — the whole function gets replaced in Task 5.

- [ ] **Step 6: Run existing tests to check for regressions**

Run: `npm run build && npm test`
Expected: No type errors, all existing tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/cli.ts src/test-peek.ts
git commit -m "feat(types): add TurnSnapshotMessage, update TurnSnapshot for structured messages"
```

---

### Task 2: Fix snapshot persistence in plugin.ts

**Files:**
- Modify: `src/plugin.ts:533-568`

- [ ] **Step 1: Write failing test — snapshot messages have real content**

Append to `src/test-peek.ts`:

```typescript
import { extractTextContent, estimateTokens } from "./types.js";

// Simulate the content extraction that the fixed persistence will do
const agentMsg = {
  role: "user",
  content: [{ type: "text", text: "Hello, can you help me?" }],
  timestamp: 1000,
  id: "msg_1",
};
const extracted = extractTextContent(agentMsg);
assert.equal(extracted, "Hello, can you help me?");
assert.equal(estimateTokens(extracted), Math.ceil(23 / 4));

// Verify preview truncation logic
const longText = "x".repeat(300);
const preview = longText.slice(0, 200);
assert.equal(preview.length, 200);

console.log("PASS: content extraction for snapshots");
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx tsx src/test-peek.ts`
Expected: PASS (this tests utility functions that already exist).

- [ ] **Step 3: Fix snapshot persistence in plugin.ts**

In `src/plugin.ts`, replace lines 533-571 (the entire `// Persist turn snapshot for CLI peek tool` block, including the catch) with:

```typescript
      // Persist turn snapshot for CLI peek tool
      try {
        // Build segment-ID lookup: SimpleMessage ID -> segment ID
        const msgToSegment = new Map<string, string>();
        for (const b of budgets) {
          for (const msgId of b.segment.messageIds) {
            msgToSegment.set(msgId, b.segment.id);
          }
        }

        // assembled (non-system) and conversationMessages share indices by construction:
        // conversationMessages = assembled.filter(non-system).map(lookup original)
        const assembledNonSystem = assembled.filter(m => m.role !== "system");
        const snapshotMessages: import("./types.js").TurnSnapshotMessage[] = [];
        for (let i = 0; i < conversationMessages.length; i++) {
          const agentMsg = conversationMessages[i] as any;
          const simpleMsg = assembledNonSystem[i];
          const text = extractTextContent(agentMsg);
          snapshotMessages.push({
            role: simpleMsg?.role ?? agentMsg.role,
            segmentId: simpleMsg ? (msgToSegment.get(simpleMsg.id) ?? null) : null,
            tokenCount: estimateTokens(text),
            contentPreview: text.slice(0, 200),
            contentFull: text,
          });
        }

        store.persistTurn({
          timestamp: Date.now(),
          turnIndex: state.totalTurns,
          sessionId: params.sessionId,
          segments: budgets.map(b => ({
            id: b.segment.id,
            topic: b.segment.topic,
            status: b.segment.status,
            messageCount: b.segment.messageCount,
            tokenCount: b.segment.tokenCount,
            summary: b.segment.summary,
            tier: b.tier,
            allocatedTokens: b.allocatedTokens,
            compositeScore: b.scored.score,
            semanticScore: b.scored.semanticScore,
            recencyScore: b.scored.recencyScoreValue,
          })),
          messages: snapshotMessages,
          systemPreamble: systemPreamble || "",
          stats: {
            tokenBudget,
            tokensUsed: estimatedTokens,
            segmentsTotal: segments.length,
            segmentsIncluded: budgets.filter(b => b.tier !== "excluded").length,
            segmentsExcluded: budgets.filter(b => b.tier === "excluded").length,
            embeddingsAvailable: state.embeddingsAvailable,
            driftAvailable: state.driftAvailable,
            fallbacks,
          },
        });
      } catch (err) {
        debug("failed to persist turn snapshot", { error: String(err) });
      }
```

- [ ] **Step 4: Run build to verify it type-checks**

Run: `npm run build`
Expected: No type errors.

- [ ] **Step 5: Run all tests**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/plugin.ts
git commit -m "fix(plugin): persist structured snapshot messages with real content extraction"
```

---

## Chunk 2: Store Helpers

### Task 3: Add resolveSessionId and getSessionLabel to DendriteStore

**Files:**
- Modify: `src/store.ts:54-64`
- Test: `src/test-peek.ts`

- [ ] **Step 1: Write failing test — resolveSessionId**

Append to `src/test-peek.ts`:

```typescript
import { DendriteStore } from "./store.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Set up a temp directory with fake session turn data
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peek-test-"));
const turnsRoot = path.join(tmpDir, "dendrite", "turns");
const configPath = path.join(tmpDir, "openclaw.json");

// Create three fake sessions
const sessions = ["233d8a9b-6dbb-4aae-8554-d8392b3db645", "51f55c52-cb97-4470-b778-79841343d3cc", "51f6aaaa-0000-0000-0000-000000000000"];
for (const s of sessions) {
  const dir = path.join(turnsRoot, s);
  fs.mkdirSync(dir, { recursive: true });
  // Write a minimal snapshot
  const snapshot = {
    timestamp: 1000,
    turnIndex: 1,
    sessionId: s,
    segments: [{ id: "seg_1", topic: "test topic for " + s.slice(0, 8), status: "active", messageCount: 5, tokenCount: 500, summary: null, tier: "active", allocatedTokens: 500, compositeScore: 1, semanticScore: 1, recencyScore: 1 }],
    messages: [],
    systemPreamble: "",
    stats: { tokenBudget: 100000, tokensUsed: 500, segmentsTotal: 1, segmentsIncluded: 1, segmentsExcluded: 0, embeddingsAvailable: true, driftAvailable: true, fallbacks: [] },
  };
  fs.writeFileSync(path.join(dir, "1000_1.json"), JSON.stringify(snapshot));
}

const store = new DendriteStore(tmpDir, configPath);

// Unique prefix resolves to full ID
assert.equal(store.resolveSessionId("233d"), "233d8a9b-6dbb-4aae-8554-d8392b3db645");

// Ambiguous prefix returns null
assert.equal(store.resolveSessionId("51f"), null);

// No match returns null
assert.equal(store.resolveSessionId("aaaa"), null);

// Full ID works
assert.equal(store.resolveSessionId("233d8a9b-6dbb-4aae-8554-d8392b3db645"), "233d8a9b-6dbb-4aae-8554-d8392b3db645");

console.log("PASS: resolveSessionId");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/test-peek.ts`
Expected: FAIL — `store.resolveSessionId is not a function`.

- [ ] **Step 3: Write failing test — getSessionLabel**

Append to `src/test-peek.ts`:

```typescript
// getSessionLabel — returns topic of most recent active segment
assert.equal(store.getSessionLabel("233d8a9b-6dbb-4aae-8554-d8392b3db645"), "test topic for 233d8a9b");

// Add a session with only closed segments
const closedDir = path.join(turnsRoot, "closed0000-0000-0000-0000-000000000000");
fs.mkdirSync(closedDir, { recursive: true });
const closedSnapshot = {
  timestamp: 2000,
  turnIndex: 1,
  sessionId: "closed0000-0000-0000-0000-000000000000",
  segments: [{ id: "seg_2", topic: "closed topic", status: "closed", messageCount: 10, tokenCount: 1000, summary: "summary", tier: "full", allocatedTokens: 1000, compositeScore: 0.5, semanticScore: 0.5, recencyScore: 0.5 }],
  messages: [],
  systemPreamble: "",
  stats: { tokenBudget: 100000, tokensUsed: 1000, segmentsTotal: 1, segmentsIncluded: 1, segmentsExcluded: 0, embeddingsAvailable: true, driftAvailable: true, fallbacks: [] },
};
fs.writeFileSync(path.join(closedDir, "2000_1.json"), JSON.stringify(closedSnapshot));
assert.equal(store.getSessionLabel("closed0000-0000-0000-0000-000000000000"), "closed topic");

// Empty session
const emptyDir = path.join(turnsRoot, "empty00000-0000-0000-0000-000000000000");
fs.mkdirSync(emptyDir, { recursive: true });
assert.equal(store.getSessionLabel("empty00000-0000-0000-0000-000000000000"), "(no topic)");

console.log("PASS: getSessionLabel");

// Cleanup
fs.rmSync(tmpDir, { recursive: true, force: true });
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx tsx src/test-peek.ts`
Expected: FAIL — `store.getSessionLabel is not a function`.

- [ ] **Step 5: Implement resolveSessionId and getSessionLabel**

In `src/store.ts`, add these methods to the `DendriteStore` class (after the `listSessions()` method, around line 64):

```typescript
  resolveSessionId(partial: string): string | null {
    const sessions = this.listSessions();
    const matches = sessions.filter(s => s.startsWith(partial));
    if (matches.length === 1) return matches[0];
    return null;
  }

  getSessionLabel(sessionId: string): string {
    const turns = this.listTurns(sessionId);
    if (turns.length === 0) return "(no topic)";
    const lastTurn = turns[turns.length - 1];
    const snapshot = this.getTurn(sessionId, lastTurn.filename);
    if (!snapshot || snapshot.segments.length === 0) return "(no topic)";

    // Prefer most recent active segment's topic
    const active = snapshot.segments.filter(s => s.status === "active");
    if (active.length > 0) return active[active.length - 1].topic;

    // Fall back to most recent closed segment
    return snapshot.segments[snapshot.segments.length - 1].topic;
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx tsx src/test-peek.ts`
Expected: PASS

- [ ] **Step 7: Run all tests**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/store.ts src/test-peek.ts
git commit -m "feat(store): add resolveSessionId and getSessionLabel helpers"
```

---

## Chunk 3: CLI Rewrite

### Task 4: Rewrite peek command — non-interactive selection

**Files:**
- Modify: `src/cli.ts:433-521`

This task replaces the interactive readline-based peek command with the non-interactive progressive-disclosure flow. The display formatting is in the next task.

- [ ] **Step 1: Write failing test — resolveTurn helper**

Append to `src/test-peek.ts` (re-create the temp store since we cleaned it up):

```typescript
import { resolveTurn } from "./cli.js";
import type { TurnListEntry } from "./store.js";

// resolveTurn tests
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
assert.deepEqual(resolveTurn(turns, -3), turns[0]);

// No match
assert.equal(resolveTurn(turns, 99), null);
assert.equal(resolveTurn(turns, -4), null);

console.log("PASS: resolveTurn");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/test-peek.ts`
Expected: FAIL — `resolveTurn` is not exported from `./cli.js`.

- [ ] **Step 3: Add resolveTurn helper to cli.ts**

Add this exported function near the top of `src/cli.ts` (after the imports, before the `CONFIG_TYPES` constant). Merge the `TurnListEntry` import into the existing store import — change `import { DendriteStore } from "./store.js"` to `import { DendriteStore, type TurnListEntry } from "./store.js"`:

```typescript
export function resolveTurn(turns: TurnListEntry[], index: number): TurnListEntry | null {
  if (index < 0) {
    const pos = turns.length + index;
    return pos >= 0 ? turns[pos] : null;
  }
  return turns.find(t => t.turnIndex === index) ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx src/test-peek.ts`
Expected: PASS

- [ ] **Step 5: Rewrite the peek command action**

In `src/cli.ts`, replace the entire peek command registration (lines 433-521) with the non-interactive version. Remove the `import * as readline from "node:readline";` from the top of the file (line 4) since it's no longer needed.

Replace lines 433-521 with:

```typescript
  // ── peek ──
  root
    .command("peek")
    .description("Inspect the assembled context for a specific turn")
    .option("-s, --session <id>", "Session ID (full or partial UUID)")
    .option("-t, --turn <n>", "Turn index (negative counts from end)")
    .option("-l, --last", "Show the most recent turn across all sessions")
    .option("--full", "Show full message content instead of previews")
    .option("--json", "Output raw snapshot as JSON")
    .option("--segments-only", "Show only header and segment table")
    .action(async (opts: { session?: string; turn?: string; last?: boolean; full?: boolean; json?: boolean; segmentsOnly?: boolean }) => {
      // --last is mutually exclusive with -s/-t
      if (opts.last && (opts.session || opts.turn)) {
        console.error("Error: --last cannot be combined with --session or --turn.");
        process.exit(1);
      }

      let sessionId: string | undefined;
      let turnEntry: TurnListEntry | undefined;

      if (opts.last) {
        // Find most recent turn across all sessions
        const sessions = store.listSessions();
        if (sessions.length === 0) {
          console.error("No turn snapshots found. Run a conversation with Dendrite enabled first.");
          process.exit(1);
        }
        let latestTimestamp = 0;
        for (const s of sessions) {
          const turns = store.listTurns(s);
          const last = turns[turns.length - 1];
          if (last && last.timestamp > latestTimestamp) {
            latestTimestamp = last.timestamp;
            sessionId = s;
            turnEntry = last;
          }
        }
      } else if (opts.session) {
        // Resolve partial UUID
        const resolved = store.resolveSessionId(opts.session);
        if (!resolved) {
          const sessions = store.listSessions();
          const matches = sessions.filter(s => s.startsWith(opts.session!));
          if (matches.length > 1) {
            console.error(`Ambiguous session prefix "${opts.session}". Matches:`);
            for (const m of matches) {
              console.error(`  ${m.slice(0, 8)}  ${store.getSessionLabel(m)}`);
            }
          } else {
            console.error(`No session matching "${opts.session}".`);
          }
          process.exit(1);
        }
        sessionId = resolved;

        if (opts.turn) {
          const turns = store.listTurns(sessionId);
          const idx = parseInt(opts.turn, 10);
          if (isNaN(idx)) {
            console.error(`Invalid turn index: ${opts.turn}`);
            process.exit(1);
          }
          const entry = resolveTurn(turns, idx);
          if (!entry) {
            console.error(`No turn matching index ${idx} in session ${sessionId.slice(0, 8)}.`);
            process.exit(1);
          }
          turnEntry = entry;
        }
      }

      // No session selected: list sessions
      if (!sessionId) {
        const sessions = store.listSessions();
        if (sessions.length === 0) {
          console.error("No turn snapshots found. Run a conversation with Dendrite enabled first.");
          process.exit(1);
        }

        console.log("");
        console.log("SESSIONS" + " ".repeat(42) + "TURNS  LAST ACTIVE");
        for (const s of sessions) {
          const turns = store.listTurns(s);
          const label = store.getSessionLabel(s);
          const lastTurn = turns[turns.length - 1];
          const lastTime = lastTurn ? new Date(lastTurn.timestamp).toISOString().slice(0, 16).replace("T", " ") : "—";
          console.log(`${s.slice(0, 8)}  ${label.padEnd(40)} ${String(turns.length).padStart(5)}  ${lastTime}`);
        }
        console.log("");
        console.log("Use: openclaw dendrite peek -s <id> [-t <turn>]");
        console.log("     openclaw dendrite peek --last");
        return;
      }

      // Session selected but no turn: list turns
      if (!turnEntry) {
        const turns = store.listTurns(sessionId);
        if (turns.length === 0) {
          console.error(`No turns found for session: ${sessionId}`);
          process.exit(1);
        }

        const label = store.getSessionLabel(sessionId);
        console.log("");
        console.log(`SESSION ${sessionId.slice(0, 8)} — ${label}`);
        console.log("");
        console.log(" TURN    TIME                SEGS  TOKENS    BUDGET%");
        for (const t of turns) {
          const snapshot = store.getTurn(sessionId, t.filename);
          if (!snapshot) continue;
          const time = new Date(t.timestamp).toISOString().slice(0, 16).replace("T", " ");
          const segs = snapshot.stats.segmentsTotal;
          const tokens = snapshot.stats.tokensUsed;
          const pct = Math.round(tokens / snapshot.stats.tokenBudget * 100);
          console.log(`  #${String(t.turnIndex).padEnd(5)} ${time}  ${String(segs).padStart(4)}  ${String(tokens.toLocaleString("en-US")).padStart(7)}  ${String(pct).padStart(5)}%`);
        }
        console.log("");
        console.log(`Use: openclaw dendrite peek -s ${sessionId.slice(0, 8)} -t <turn>`);
        return;
      }

      // Both session and turn selected: show dashboard
      const snapshot = store.getTurn(sessionId, turnEntry.filename);
      if (!snapshot) {
        console.error("Failed to load turn snapshot.");
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(snapshot, null, 2));
        return;
      }

      console.log(formatPeekDashboard(snapshot, { full: !!opts.full, segmentsOnly: !!opts.segmentsOnly }));
    });
```

- [ ] **Step 6: Run build to verify it type-checks**

Run: `npm run build`
Expected: No type errors. (The `formatPeekDashboard` function doesn't exist yet — add a stub that returns `"TODO"` so the build passes, or implement it in the next task first.)

Actually, to avoid a broken intermediate state, add a temporary stub before the `registerDendriteCli` function:

```typescript
function formatPeekDashboard(snapshot: TurnSnapshot, opts: { full: boolean; segmentsOnly: boolean }): string {
  return "TODO: dashboard";
}
```

- [ ] **Step 7: Run all tests**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/cli.ts src/test-peek.ts
git commit -m "feat(cli): rewrite peek command with non-interactive progressive-disclosure UX"
```

---

### Task 5: Implement formatPeekDashboard

**Files:**
- Modify: `src/cli.ts` (replace the stub from Task 4)

- [ ] **Step 1: Write failing test — dashboard output structure**

Append to `src/test-peek.ts`:

```typescript
import { formatPeekDashboard } from "./cli.js";

const dashboardSnapshot: TurnSnapshot = {
  timestamp: 1711000980000,
  turnIndex: 14,
  sessionId: "233d8a9b-6dbb-4aae-8554-d8392b3db645",
  segments: [
    { id: "seg_1", topic: "setting up drift model", status: "active" as const, messageCount: 3, tokenCount: 1306, summary: null, tier: "active" as any, allocatedTokens: 1306, compositeScore: 1, semanticScore: 1, recencyScore: 1 },
    { id: "seg_2", topic: "initial project setup", status: "closed" as const, messageCount: 80, tokenCount: 27336, summary: "Set up the project", tier: "full" as any, allocatedTokens: 27336, compositeScore: 0.67, semanticScore: 0.58, recencyScore: 0.90 },
  ],
  messages: [
    { role: "user", segmentId: "seg_1", tokenCount: 324, contentPreview: "Can you check the drift model?", contentFull: "Can you check the drift model?" },
    { role: "assistant", segmentId: "seg_1", tokenCount: 512, contentPreview: "I'll look at the configuration", contentFull: "I'll look at the configuration for the drift model." },
    { role: "user", segmentId: "seg_2", tokenCount: 128, contentPreview: "Let's start building", contentFull: "Let's start building the segmenter" },
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
const output = formatPeekDashboard(dashboardSnapshot, { full: false, segmentsOnly: false });
assert.ok(output.includes("Session: 233d8a9b"), "should include short session ID");
assert.ok(output.includes("Turn #14"), "should include turn number");
assert.ok(output.includes("28,642"), "should include tokens used with commas");
assert.ok(output.includes("256,000"), "should include budget with commas");
assert.ok(output.includes("setting up drift model"), "should include segment topic");
assert.ok(output.includes("initial project setup"), "should include second segment topic");
assert.ok(output.includes("Can you check the drift model?"), "should include message preview");

// segments-only: no messages
const segOnly = formatPeekDashboard(dashboardSnapshot, { full: false, segmentsOnly: true });
assert.ok(segOnly.includes("setting up drift model"), "segments-only should include segment table");
assert.ok(!segOnly.includes("Can you check the drift model?"), "segments-only should NOT include messages");

// full mode: shows contentFull
const fullOutput = formatPeekDashboard(dashboardSnapshot, { full: true, segmentsOnly: false });
assert.ok(fullOutput.includes("I'll look at the configuration for the drift model."), "full mode should show complete content");

console.log("PASS: formatPeekDashboard");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/test-peek.ts`
Expected: FAIL — `formatPeekDashboard` is not exported or returns `"TODO"`.

- [ ] **Step 3: Write failing test — legacy snapshot fallback**

Append to `src/test-peek.ts`:

```typescript
// Legacy snapshot (assembledContext, no messages)
const legacySnapshot: TurnSnapshot = {
  timestamp: 1711000980000,
  turnIndex: 5,
  sessionId: "old-session-id-here",
  segments: [
    { id: "seg_1", topic: "old conversation", status: "active" as const, messageCount: 10, tokenCount: 2000, summary: null, tier: "active" as any, allocatedTokens: 2000, compositeScore: 1, semanticScore: 1, recencyScore: 1 },
  ],
  assembledContext: "user: Hello\n\nassistant: Hi there",
  stats: {
    tokenBudget: 100000,
    tokensUsed: 2000,
    segmentsTotal: 1,
    segmentsIncluded: 1,
    segmentsExcluded: 0,
    embeddingsAvailable: false,
    driftAvailable: false,
    fallbacks: ["embeddings"],
  },
};

const legacyOutput = formatPeekDashboard(legacySnapshot, { full: false, segmentsOnly: false });
assert.ok(legacyOutput.includes("old conversation"), "legacy should show segment table");
assert.ok(legacyOutput.includes("legacy snapshot"), "legacy should include legacy note");
assert.ok(legacyOutput.includes("user: Hello"), "legacy should show raw assembledContext");

console.log("PASS: formatPeekDashboard legacy fallback");
```

- [ ] **Step 4: Implement formatPeekDashboard**

In `src/cli.ts`, replace the stub `formatPeekDashboard` with the real implementation. Also export it so tests can access it:

```typescript
export function formatPeekDashboard(snapshot: TurnSnapshot, opts: { full: boolean; segmentsOnly: boolean }): string {
  const lines: string[] = [];

  // ── Header ──
  const time = new Date(snapshot.timestamp).toISOString().slice(0, 19).replace("T", " ");
  lines.push(`Session: ${snapshot.sessionId.slice(0, 8)}  |  Turn #${snapshot.turnIndex}  |  ${time}`);

  const used = snapshot.stats.tokensUsed;
  const budget = snapshot.stats.tokenBudget;
  const pct = Math.round(used / budget * 100);
  const barLen = 20;
  const filled = Math.round(pct / 100 * barLen);
  const bar = "\u2588".repeat(filled) + "\u2591".repeat(barLen - filled);
  lines.push(`Budget: ${used.toLocaleString("en-US")} / ${budget.toLocaleString("en-US")} tokens (${pct}%)  ${bar}`);

  const emb = snapshot.stats.embeddingsAvailable ? "\u2713" : "\u2717";
  const drift = snapshot.stats.driftAvailable ? "\u2713" : "\u2717";
  const fb = snapshot.stats.fallbacks.length > 0 ? snapshot.stats.fallbacks.join(", ") : "none";
  lines.push(`Embeddings: ${emb}  |  Drift: ${drift}  |  Fallbacks: ${fb}`);
  lines.push("");

  // ── Segment Table ──
  lines.push(" TIER      TOPIC" + " ".repeat(24) + "MSGS   TOKENS     SCORE  (sem / rec)");
  for (const seg of snapshot.segments) {
    const tier = seg.tier.padEnd(9);
    const topic = seg.topic.length > 30 ? seg.topic.slice(0, 27) + "..." : seg.topic.padEnd(30);
    const msgs = String(seg.messageCount).padStart(4);
    const tokens = seg.allocatedTokens.toLocaleString("en-US").padStart(8);
    let score: string;
    if (seg.tier === "active") {
      score = "    \u2014    \u2014     \u2014";
    } else {
      score = `${seg.compositeScore.toFixed(2).padStart(5)}  ${seg.semanticScore.toFixed(2).padStart(4)}  ${seg.recencyScore.toFixed(2).padStart(4)}`;
    }
    lines.push(` ${tier} ${topic} ${msgs} ${tokens}  ${score}`);
  }

  if (opts.segmentsOnly) {
    return lines.join("\n");
  }

  lines.push("");

  // ── Message List ──
  const messages = snapshot.messages;
  if (messages && messages.length > 0) {
    // Group messages by segment
    const segmentOrder: (string | null)[] = [];
    const segmentMessages = new Map<string | null, typeof messages>();

    // System preamble group
    if (snapshot.systemPreamble) {
      segmentOrder.push("__system__");
      segmentMessages.set("__system__", [{
        role: "assistant" as const,
        segmentId: null,
        tokenCount: Math.ceil(snapshot.systemPreamble.length / 4),
        contentPreview: snapshot.systemPreamble.slice(0, 200),
        contentFull: snapshot.systemPreamble,
      }]);
    }

    for (const msg of messages) {
      const key = msg.segmentId;
      if (!segmentMessages.has(key)) {
        segmentOrder.push(key);
        segmentMessages.set(key, []);
      }
      segmentMessages.get(key)!.push(msg);
    }

    for (const key of segmentOrder) {
      const msgs = segmentMessages.get(key)!;
      // Find segment info for the header
      let header: string;
      if (key === "__system__") {
        header = "\u2500\u2500 (system) ";
      } else if (key) {
        const seg = snapshot.segments.find(s => s.id === key);
        header = seg
          ? `\u2500\u2500 ${seg.topic} (${seg.tier}, ${seg.allocatedTokens.toLocaleString("en-US")} tokens) `
          : `\u2500\u2500 (unknown segment) `;
      } else {
        header = "\u2500\u2500 (unmatched) ";
      }
      lines.push(header + "\u2500".repeat(Math.max(0, 60 - header.length)));

      const maxShow = opts.full ? msgs.length : (msgs.length > 6 ? 4 : msgs.length);
      const showFirst = opts.full ? msgs.length : Math.min(2, msgs.length);
      const showLast = opts.full ? 0 : (msgs.length > 6 ? 2 : 0);
      const hidden = msgs.length - showFirst - showLast;

      for (let i = 0; i < msgs.length; i++) {
        if (!opts.full && msgs.length > 6 && i >= showFirst && i < msgs.length - showLast) {
          if (i === showFirst) {
            lines.push(`  ... ${hidden} more messages ...`);
          }
          continue;
        }
        const m = msgs[i];
        const role = m.role.padEnd(11);
        const tokens = String(m.tokenCount) + "t";
        const content = opts.full ? m.contentFull : `"${m.contentPreview.slice(0, 60)}${m.contentPreview.length > 60 ? "..." : ""}"`;
        if (opts.full) {
          lines.push(`  ${role} ${tokens.padStart(6)}`);
          // Indent full content
          for (const contentLine of content.split("\n")) {
            lines.push(`    ${contentLine}`);
          }
        } else {
          lines.push(`  ${role} ${tokens.padStart(6)}  ${content}`);
        }
      }
      lines.push("");
    }
  } else if (snapshot.assembledContext != null) {
    // Legacy snapshot fallback
    lines.push("(legacy snapshot — showing raw assembled context)");
    lines.push("\u2500".repeat(60));
    lines.push(snapshot.assembledContext);
  }

  return lines.join("\n");
}
```

- [ ] **Step 5: Export formatPeekDashboard**

Make sure the function is exported (it is in the code above via `export function`). Also remove the old `formatPeekSummary` function (lines 97-125) since it's no longer used.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx tsx src/test-peek.ts`
Expected: PASS for all dashboard tests.

- [ ] **Step 7: Run build and all tests**

Run: `npm run build && npm test`
Expected: No type errors, all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/cli.ts src/test-peek.ts
git commit -m "feat(cli): implement peek dashboard with structured message display and legacy fallback"
```

---

## Chunk 4: Integration & Cleanup

### Task 6: Remove readline import and old formatPeekSummary

**Files:**
- Modify: `src/cli.ts:1-7` (imports), `src/cli.ts:97-125` (old function)

- [ ] **Step 1: Verify readline is no longer used**

Search `src/cli.ts` for any remaining uses of `readline`. If the rewrite in Task 4 removed all uses, the import is dead.

- [ ] **Step 2: Remove readline import**

In `src/cli.ts`, remove line 4: `import * as readline from "node:readline";`

- [ ] **Step 3: Remove old formatPeekSummary if not already removed**

If `formatPeekSummary` still exists in the file, remove it entirely.

- [ ] **Step 4: Run build and all tests**

Run: `npm run build && npm test`
Expected: All pass with no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts
git commit -m "chore(cli): remove unused readline import and old formatPeekSummary"
```

---

### Task 7: End-to-end verification

- [ ] **Step 1: Run the full test suite**

Run: `npm run test:all`
Expected: All unit and integration tests pass.

- [ ] **Step 2: Manual smoke test (if possible)**

If the OpenClaw environment is available:
```bash
openclaw dendrite peek
openclaw dendrite peek --last
openclaw dendrite peek --last --json
openclaw dendrite peek -s <first-few-chars>
openclaw dendrite peek -s <id> -t -1
openclaw dendrite peek -s <id> -t -1 --full
openclaw dendrite peek -s <id> -t -1 --segments-only
```

Verify:
- Session list shows topic labels, not just UUIDs
- Turn list shows per-turn stats
- Dashboard shows real message content (not empty `role:` lines)
- `--json` dumps valid JSON
- `--full` shows complete message text
- `--segments-only` omits the message list
- Old snapshots (from before this change) show with the legacy fallback note

- [ ] **Step 3: Final commit if any fixups needed**

```bash
git add -A
git commit -m "fix: address issues found during smoke testing"
```
