# Cross-Session Segment Recall Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable Dendrite to score and retrieve segments from all past sessions alongside the current session, making session boundaries invisible.

**Architecture:** Extend the assembly pipeline with a `SegmentPool` that loads pre-computed segment metadata (embeddings, summaries) from per-session segment files on disk. Switch recency scoring from turn-based to time-based decay. Add budget guardrails (pinned recent segments, cross-session cap) and a `rebuild` CLI command for backfilling existing transcripts.

**Tech Stack:** TypeScript (ESM, Node16 resolution), Node.js built-ins only, tsx for tests, OpenRouter API (summaries), Gemini API (embeddings)

**Spec:** `docs/superpowers/specs/2026-03-19-cross-session-recall-design.md`

---

## Chunk 1: Foundation — Types, Recency Scoring, and SegmentPool

### Task 1: Extend Segment interface and config in types.ts

**Files:**
- Modify: `src/types.ts:12-24` (Segment interface)
- Modify: `src/types.ts:48-70` (DendriteConfig + DEFAULT_CONFIG)
- Modify: `src/cli.ts:10-20` (CONFIG_TYPES map)
- Test: `src/test-types.ts`

- [ ] **Step 1: Write failing tests for new Segment fields and config defaults**

First, update the import at the top of `src/test-types.ts` to include `DEFAULT_CONFIG`:

```typescript
import { createSegment, estimateTokens, extractTextContent, isUserMessage, DEFAULT_CONFIG } from "./types.js";
```

Then add to the end of `src/test-types.ts` (before the summary printout):

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/test-types.ts`
Expected: TypeScript compilation error — `sessionId` and `transcriptPath` don't exist on Segment, new config fields missing.

- [ ] **Step 3: Add new fields to Segment interface**

In `src/types.ts`, add two optional fields to the `Segment` interface (after `status`):

```typescript
export interface Segment {
  id: string;
  topic: string;
  embedding: number[];
  messageIds: string[];
  messageCount: number;
  tokenCount: number;
  summary: string | null;
  summaryTokens: number;
  lastActiveAt: number;
  status: "active" | "closed";
  sessionId?: string;
  transcriptPath?: string;
}
```

- [ ] **Step 4: Add new config fields to DendriteConfig and DEFAULT_CONFIG**

In `src/types.ts`, extend `DendriteConfig`:

```typescript
export interface DendriteConfig {
  driftModel: string;
  summaryModel: string;
  embeddingModel: string;
  driftThreshold: number;
  minMessagesBeforeDrift: number;
  relevanceAlpha: number;
  reserveTokens: number;
  maxSegmentMessages: number;
  queryWindowSize: number;
  pinRecentSegments: number;
  maxCrossSessionBudgetRatio: number;
  recencyHalfLifeMs: number;
}
```

Update `DEFAULT_CONFIG`:

```typescript
export const DEFAULT_CONFIG: DendriteConfig = {
  driftModel: "nvidia/nemotron-3-super-120b-a12b:free",
  summaryModel: "nvidia/nemotron-3-super-120b-a12b:free",
  embeddingModel: "gemini-embedding-001",
  driftThreshold: 0.7,
  minMessagesBeforeDrift: 3,
  relevanceAlpha: 0.7,
  reserveTokens: 16384,
  maxSegmentMessages: 80,
  queryWindowSize: 5,
  pinRecentSegments: 3,
  maxCrossSessionBudgetRatio: 0.3,
  recencyHalfLifeMs: 86400000,
};
```

- [ ] **Step 5: Update CONFIG_TYPES in cli.ts**

In `src/cli.ts`, add the three new entries to `CONFIG_TYPES`:

```typescript
const CONFIG_TYPES: Record<keyof DendriteConfig, "string" | "number" | "integer"> = {
  driftModel: "string",
  summaryModel: "string",
  embeddingModel: "string",
  driftThreshold: "number",
  minMessagesBeforeDrift: "integer",
  relevanceAlpha: "number",
  reserveTokens: "integer",
  maxSegmentMessages: "integer",
  queryWindowSize: "integer",
  pinRecentSegments: "integer",
  maxCrossSessionBudgetRatio: "number",
  recencyHalfLifeMs: "integer",
};
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx tsx src/test-types.ts`
Expected: All tests pass, including the new cross-session assertions.

- [ ] **Step 7: Run full test suite to check nothing broke**

Run: `npm test`
Expected: All test files pass. The `reserveTokens` default change from 8192→16384 may cause assertion failures in `test-assembler.ts` if any test hardcodes the old default — fix if needed.

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/cli.ts src/test-types.ts
git commit -m "feat(types): add cross-session fields and config for segment recall"
```

---

### Task 2: Switch recency scoring to time-based decay

**Files:**
- Modify: `src/scorer.ts:23-31` (recencyScore function)
- Modify: `src/scorer.ts:41-83` (scoreSegments — remove totalTurns, use time-based)
- Test: `src/test-scorer.ts`

- [ ] **Step 1: Update test-scorer.ts for time-based recencyScore**

Replace lines 25-75 of `src/test-scorer.ts` (everything from the `// recencyScore` comment through the end of the `recency-only fallback` section, before the final summary printout). The new `recencyScore(msSinceActive, halfLifeMs)` takes milliseconds instead of turns.

```typescript
// recencyScore — time-based
console.log("\n  recencyScore (time-based):");
const oneDay = 86400000;
assertApprox(recencyScore(0, oneDay), 1.0, 0.01, "0ms ago = 1.0");
assertApprox(recencyScore(oneDay, oneDay), 0.5, 0.01, "1 day ago ≈ 0.5");
assertApprox(recencyScore(oneDay * 3, oneDay), 0.125, 0.01, "3 days ago ≈ 0.125");
assert(recencyScore(oneDay * 7, oneDay) < 0.01, "7 days ago ≈ 0");
assert(recencyScore(oneDay / 2, oneDay) > recencyScore(oneDay * 2, oneDay), "more recent > less recent");
```

Update `scoreSegments` tests — remove the `totalTurns` parameter, add `halfLifeMs`:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx src/test-scorer.ts`
Expected: Fails — `recencyScore` signature mismatch and `scoreSegments` missing `halfLifeMs` parameter.

- [ ] **Step 3: Implement time-based recencyScore**

In `src/scorer.ts`, replace the `recencyScore` function:

```typescript
/**
 * Recency score: exponential decay based on time since segment was last active.
 * Returns 1.0 for the most recent, decaying toward 0.
 */
export function recencyScore(msSinceActive: number, halfLifeMs: number): number {
  return Math.pow(0.5, msSinceActive / halfLifeMs);
}
```

- [ ] **Step 4: Update scoreSegments to use time-based decay**

Replace the `scoreSegments` function signature and body. Change `totalTurns` parameter to `halfLifeMs`:

```typescript
export function scoreSegments(
  segments: Segment[],
  queryEmbedding: number[],
  halfLifeMs: number,
  alpha: number
): ScoredSegment[] {
  const now = Date.now();
  const scored: ScoredSegment[] = segments.map((segment) => {
    if (segment.status === "active") {
      return { segment, score: 1.0, semanticScore: 1.0, recencyScoreValue: 1.0 };
    }

    const semantic = segment.embedding.length > 0
      ? Math.max(0, cosineSimilarity(segment.embedding, queryEmbedding))
      : 0;

    const msSinceActive = now - segment.lastActiveAt;
    const recency = recencyScore(msSinceActive, halfLifeMs);

    // If segment has no embedding, use recency only
    const effectiveAlpha = segment.embedding.length > 0 ? alpha : 0;
    const score = effectiveAlpha * semantic + (1 - effectiveAlpha) * recency;

    return { segment, score, semanticScore: semantic, recencyScoreValue: recency };
  });

  scored.sort((a, b) => {
    if (a.segment.status === "active") return -1;
    if (b.segment.status === "active") return 1;
    return b.score - a.score;
  });

  return scored;
}
```

Note: The per-segment `effectiveAlpha` handles the spec's "Embedding missing on pool segment → Score with recency only" requirement.

- [ ] **Step 5: Run scorer tests**

Run: `npx tsx src/test-scorer.ts`
Expected: All tests pass.

- [ ] **Step 6: Update the scoreSegments call site in plugin.ts**

In `src/plugin.ts`, update the `assemble()` method's `scoreSegments` call (lines 291-296). Change `state.totalTurns` to `pluginConfig.recencyHalfLifeMs`:

```typescript
const scored = scoreSegments(
  segments,
  state.queryEmbedding,
  pluginConfig.recencyHalfLifeMs,
  effectiveAlpha
);
```

Note: `state.totalTurns` is still used elsewhere in `plugin.ts` (message counting, periodic embedding refresh, snapshot metadata) — do NOT remove it from `SessionState`.

- [ ] **Step 7: Update test-integration.ts for new scoreSegments signature**

In `src/test-integration.ts`, update the two `scoreSegments` calls to use `halfLifeMs` instead of `totalTurns`:

- Line 88: change `scoreSegments(segmenter.segments, queryEmbed, 13, 0.7)` to `scoreSegments(segmenter.segments, queryEmbed, 86400000, 0.7)`
- Line 118: change `scoreSegments(segmenter.segments, returnQuery, 15, 0.7)` to `scoreSegments(segmenter.segments, returnQuery, 86400000, 0.7)`

Also update the `buildMessageArray` callbacks (lines 98, 110) from `(ids) =>` to `(ids, _segment) =>` to match the signature change coming in Task 4. This prevents `npm run build` (tsc --noEmit) from failing at this step.

- [ ] **Step 8: Run full test suite**

Run: `npm run test:all`
Expected: All tests pass (including integration tests).

- [ ] **Step 9: Commit**

```bash
git add src/scorer.ts src/test-scorer.ts src/plugin.ts src/test-integration.ts
git commit -m "feat(scorer): switch to time-based recency decay with configurable half-life"
```

---

### Task 3: Create SegmentPool class

**Files:**
- Create: `src/segment-pool.ts`
- Test: `src/test-segment-pool.ts`
- Modify: `package.json:11` (add test-segment-pool to test script)

- [ ] **Step 1: Write failing tests for SegmentPool**

Create `src/test-segment-pool.ts`:

```typescript
import { SegmentPool } from "./segment-pool.js";
import { createSegment, type Segment, type SimpleMessage } from "./types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dendrite-pool-test-"));
const segmentsDir = path.join(tmpDir, "dendrite", "segments");

console.log("=== SegmentPool ===\n");

// ── Construction with empty directory ──
console.log("  empty pool:");
const emptyPool = new SegmentPool(tmpDir);
assert(emptyPool.poolSegments.length === 0, "empty dir → no pool segments");

// ── persistSession ──
console.log("\n  persistSession:");

const seg1 = createSegment("topic-one");
seg1.status = "closed";
seg1.embedding = [0.1, 0.2, 0.3];
seg1.summary = "Summary of topic one";
seg1.summaryTokens = 10;
seg1.messageIds = ["msg_1", "msg_2"];
seg1.messageCount = 2;
seg1.tokenCount = 100;
seg1.lastActiveAt = Date.now() - 60000;

const seg2 = createSegment("topic-two");
seg2.status = "closed";
seg2.embedding = [0.4, 0.5, 0.6];
seg2.summary = "Summary of topic two";
seg2.summaryTokens = 12;
seg2.messageIds = ["msg_3", "msg_4", "msg_5"];
seg2.messageCount = 3;
seg2.tokenCount = 200;
seg2.lastActiveAt = Date.now() - 30000;

const activeSeg = createSegment("active-topic");
activeSeg.status = "active";

const transcriptPath = path.join(tmpDir, "session-abc.jsonl");

emptyPool.persistSession("session-abc", [seg1, seg2, activeSeg], "agent-1", transcriptPath);

assert(fs.existsSync(path.join(segmentsDir, "session-abc.json")), "segment file created");

// Verify file content
const fileContent = JSON.parse(fs.readFileSync(path.join(segmentsDir, "session-abc.json"), "utf-8"));
assert(fileContent.sessionId === "session-abc", "file has correct sessionId");
assert(fileContent.agentId === "agent-1", "file has correct agentId");
assert(fileContent.transcriptPath === transcriptPath, "file has correct transcriptPath");
assert(fileContent.segments.length === 2, "only closed segments are persisted (not active)");
assert(fileContent.segments[0].topic === "topic-one", "first segment topic correct");

// Pool should now have segments in memory
assert(emptyPool.poolSegments.length === 2, "pool has 2 segments after persist");
assert(emptyPool.poolSegments[0].sessionId === "session-abc", "pool segments have sessionId");
assert(emptyPool.poolSegments[0].transcriptPath === transcriptPath, "pool segments have transcriptPath");

// ── Loading from disk ──
console.log("\n  load from disk:");

const loadedPool = new SegmentPool(tmpDir);
assert(loadedPool.poolSegments.length === 2, "loaded pool has 2 segments from file");
assert(loadedPool.poolSegments[0].sessionId === "session-abc", "loaded segments have sessionId");
assert(loadedPool.poolSegments[0].embedding.length === 3, "loaded segments have embeddings");

// ── getCombinedSegments ──
console.log("\n  getCombinedSegments:");

const currentSeg = createSegment("current-topic");
currentSeg.status = "active";

const currentClosed = createSegment("current-closed");
currentClosed.status = "closed";

const combined = loadedPool.getCombinedSegments([currentSeg, currentClosed], "current-session");
assert(combined.length === 4, "combined = 2 current + 2 pool segments");
// Current session segments should NOT have sessionId set
assert(combined[0].sessionId === undefined, "current segments: no sessionId");
// Pool segments should have sessionId
const poolInCombined = combined.filter(s => s.sessionId !== undefined);
assert(poolInCombined.length === 2, "pool segments have sessionId in combined array");

// Should exclude segments from the same sessionId as current
const selfPool = new SegmentPool(tmpDir);
const selfCombined = selfPool.getCombinedSegments([currentSeg], "session-abc");
assert(selfCombined.length === 1, "getCombinedSegments excludes same-session segments");

// ── loadMessages ──
console.log("\n  loadMessages:");

// Create a transcript JSONL
const transcriptLines = [
  JSON.stringify({ role: "user", content: [{ type: "text", text: "Hello topic one" }], id: "msg_1", timestamp: 1000 }),
  JSON.stringify({ role: "assistant", content: [{ type: "text", text: "Response to topic one" }], id: "msg_2", timestamp: 2000 }),
  JSON.stringify({ role: "user", content: [{ type: "text", text: "Hello topic two" }], id: "msg_3", timestamp: 3000 }),
  JSON.stringify({ role: "assistant", content: [{ type: "text", text: "Response to topic two" }], id: "msg_4", timestamp: 4000 }),
  JSON.stringify({ role: "user", content: [{ type: "text", text: "More on topic two" }], id: "msg_5", timestamp: 5000 }),
];
fs.writeFileSync(transcriptPath, transcriptLines.join("\n"));

const msgs = loadedPool.loadMessages(transcriptPath, ["msg_1", "msg_3"]);
assert(msgs.length === 2, "loadMessages returns requested messages");
assert(msgs[0].id === "msg_1", "first message ID correct");
assert(msgs[0].content === "Hello topic one", "first message content correct");
assert(msgs[1].id === "msg_3", "second message ID correct");

// loadMessages with missing transcript
const missingMsgs = loadedPool.loadMessages("/nonexistent/path.jsonl", ["msg_1"]);
assert(missingMsgs.length === 0, "missing transcript returns empty array");

// loadMessages with IDs not found
const notFoundMsgs = loadedPool.loadMessages(transcriptPath, ["msg_999"]);
assert(notFoundMsgs.length === 0, "not-found IDs returns empty array");

// ── Corrupt file handling ──
console.log("\n  corrupt file handling:");

fs.writeFileSync(path.join(segmentsDir, "corrupt-session.json"), "not valid json{{{");
const poolWithCorrupt = new SegmentPool(tmpDir);
assert(poolWithCorrupt.poolSegments.length === 2, "corrupt file skipped, valid segments loaded");

// ── Multiple sessions ──
console.log("\n  multiple sessions:");

const seg3 = createSegment("other-topic");
seg3.status = "closed";
seg3.embedding = [0.7, 0.8, 0.9];
seg3.summary = "Other session topic";
seg3.summaryTokens = 8;
seg3.messageIds = ["msg_10"];
seg3.messageCount = 1;
seg3.tokenCount = 50;
seg3.lastActiveAt = Date.now() - 120000;

loadedPool.persistSession("session-def", [seg3], "agent-1", "/tmp/session-def.jsonl");
assert(loadedPool.poolSegments.length === 3, "pool grows with new session");
assert(fs.existsSync(path.join(segmentsDir, "session-def.json")), "second session file created");

// Cleanup
fs.rmSync(tmpDir, { recursive: true });

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/test-segment-pool.ts`
Expected: Fails — `./segment-pool.js` module not found.

- [ ] **Step 3: Implement SegmentPool**

Create `src/segment-pool.ts`:

```typescript
import * as fs from "node:fs";
import * as path from "node:path";
import type { Segment, SimpleMessage } from "./types.js";

export interface SessionSegmentFile {
  sessionId: string;
  agentId: string;
  transcriptPath: string;
  exportedAt: number;
  segments: Segment[];
}

export class SegmentPool {
  poolSegments: Segment[] = [];
  private segmentsDir: string;

  constructor(baseDir: string) {
    this.segmentsDir = path.join(baseDir, "dendrite", "segments");
    this.loadAll();
  }

  private loadAll(): void {
    if (!fs.existsSync(this.segmentsDir)) return;

    const files = fs.readdirSync(this.segmentsDir).filter(f => f.endsWith(".json"));
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(this.segmentsDir, file), "utf-8");
        const data: SessionSegmentFile = JSON.parse(raw);
        for (const seg of data.segments) {
          seg.sessionId = data.sessionId;
          seg.transcriptPath = data.transcriptPath;
          this.poolSegments.push(seg);
        }
      } catch {
        // Skip corrupt files
      }
    }
  }

  getCombinedSegments(currentSegments: Segment[], currentSessionId: string): Segment[] {
    const poolFiltered = this.poolSegments.filter(s => s.sessionId !== currentSessionId);
    return [...currentSegments, ...poolFiltered];
  }

  persistSession(sessionId: string, segments: Segment[], agentId: string, transcriptPath: string): void {
    fs.mkdirSync(this.segmentsDir, { recursive: true });

    const closedSegments = segments.filter(s => s.status === "closed");
    const file: SessionSegmentFile = {
      sessionId,
      agentId,
      transcriptPath,
      exportedAt: Date.now(),
      segments: closedSegments.map(s => ({
        ...s,
        sessionId: undefined,
        transcriptPath: undefined,
        messageIds: [...s.messageIds],
        embedding: [...s.embedding],
      })),
    };

    fs.writeFileSync(
      path.join(this.segmentsDir, `${sessionId}.json`),
      JSON.stringify(file, null, 2)
    );

    // Remove old pool segments for this session and add new ones
    this.poolSegments = this.poolSegments.filter(s => s.sessionId !== sessionId);
    for (const seg of closedSegments) {
      this.poolSegments.push({
        ...seg,
        sessionId,
        transcriptPath,
        messageIds: [...seg.messageIds],
        embedding: [...seg.embedding],
      });
    }
  }

  loadMessages(transcriptPath: string, messageIds: string[]): SimpleMessage[] {
    try {
      if (!fs.existsSync(transcriptPath)) return [];
      const content = fs.readFileSync(transcriptPath, "utf-8");
      const idSet = new Set(messageIds);
      const result: SimpleMessage[] = [];

      for (const line of content.split("\n").filter(Boolean)) {
        try {
          const entry = JSON.parse(line);
          if (entry.id && idSet.has(entry.id)) {
            const role = entry.role;
            if (role !== "user" && role !== "assistant" && role !== "toolResult") continue;
            const text = typeof entry.content === "string"
              ? entry.content
              : Array.isArray(entry.content)
                ? entry.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("")
                : "";
            if (text) {
              result.push({ id: entry.id, role, content: text, timestamp: entry.timestamp || 0 });
            }
            if (result.length === messageIds.length) break; // found all
          }
        } catch { /* skip malformed line */ }
      }

      // Return in the order requested
      const byId = new Map(result.map(m => [m.id, m]));
      return messageIds.map(id => byId.get(id)).filter((m): m is SimpleMessage => m !== undefined);
    } catch {
      return [];
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx src/test-segment-pool.ts`
Expected: All tests pass.

- [ ] **Step 5: Add test-segment-pool to the test script in package.json**

In `package.json`, update the `test` script to include the new test file:

```json
"test": "tsx src/test-types.ts && tsx src/test-segmenter.ts && tsx src/test-scorer.ts && tsx src/test-summarizer.ts && tsx src/test-assembler.ts && tsx src/test-store.ts && tsx src/test-cli.ts && tsx src/test-segment-pool.ts",
```

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/segment-pool.ts src/test-segment-pool.ts package.json
git commit -m "feat(segment-pool): add SegmentPool for cross-session segment storage and retrieval"
```

---

## Chunk 2: Assembly Changes and Plugin Integration

### Task 4: Update allocateBudgets for pinned segments and cross-session budget cap

**Files:**
- Modify: `src/assembler.ts:22-84` (allocateBudgets function signature and body)
- Modify: `src/assembler.ts:102-104` (buildMessageArray getMessages callback signature)
- Test: `src/test-assembler.ts`

- [ ] **Step 1: Write failing tests for pinned segments and cross-session cap**

Add new test blocks to `src/test-assembler.ts`. The `allocateBudgets` function gets two new parameters: `currentSessionId` and `pinRecentSegments` and `maxCrossSessionBudgetRatio`.

Add after existing `allocateBudgets` tests (before the `buildMessageArray` section):

```typescript
// ── Pinned recent segments ──
console.log("\n  pinned recent segments:");

const pinnedA = createSegment("pinned-recent-1");
pinnedA.tokenCount = 500;
pinnedA.status = "closed";
pinnedA.summary = "Recent topic A";
pinnedA.summaryTokens = 15;
pinnedA.lastActiveAt = Date.now() - 1000;

const pinnedB = createSegment("pinned-recent-2");
pinnedB.tokenCount = 500;
pinnedB.status = "closed";
pinnedB.summary = "Recent topic B";
pinnedB.summaryTokens = 15;
pinnedB.lastActiveAt = Date.now() - 2000;

const lowScoreSeg = createSegment("low-score");
lowScoreSeg.tokenCount = 500;
lowScoreSeg.status = "closed";
lowScoreSeg.summary = "Low score topic";
lowScoreSeg.summaryTokens = 15;
lowScoreSeg.lastActiveAt = Date.now() - 100000;

const scoredPinned: ScoredSegment[] = [
  { segment: activeSeg, score: 1.0, semanticScore: 1, recencyScoreValue: 1 },
  // lowScoreSeg is scored higher than pinned, but pinned should still be guaranteed
  { segment: lowScoreSeg, score: 0.9, semanticScore: 0.9, recencyScoreValue: 0.5 },
  { segment: pinnedA, score: 0.1, semanticScore: 0.05, recencyScoreValue: 0.2 },
  { segment: pinnedB, score: 0.05, semanticScore: 0.02, recencyScoreValue: 0.1 },
];

const pinnedBudgets = allocateBudgets(scoredPinned, 2000, 500, {
  currentSessionId: undefined,
  pinRecentSegments: 2,
  maxCrossSessionBudgetRatio: 0.3,
  pinnedSegmentIds: [pinnedA.id, pinnedB.id],
});
const pinnedTiers = pinnedBudgets.reduce((acc, b) => { acc[b.segment.id] = b.tier; return acc; }, {} as Record<string, string>);
assert(pinnedTiers[pinnedA.id] !== "excluded", "pinned segment A not excluded");
assert(pinnedTiers[pinnedB.id] !== "excluded", "pinned segment B not excluded");

// ── Cross-session budget cap ──
console.log("\n  cross-session budget cap:");

const crossSeg1 = createSegment("cross-1");
crossSeg1.tokenCount = 5000;
crossSeg1.status = "closed";
crossSeg1.summary = "Cross session 1";
crossSeg1.summaryTokens = 20;
crossSeg1.sessionId = "past-session";
crossSeg1.transcriptPath = "/tmp/past.jsonl";
crossSeg1.lastActiveAt = Date.now() - 60000;

const crossSeg2 = createSegment("cross-2");
crossSeg2.tokenCount = 5000;
crossSeg2.status = "closed";
crossSeg2.summary = "Cross session 2";
crossSeg2.summaryTokens = 20;
crossSeg2.sessionId = "past-session";
crossSeg2.transcriptPath = "/tmp/past.jsonl";
crossSeg2.lastActiveAt = Date.now() - 120000;

const scoredCross: ScoredSegment[] = [
  { segment: activeSeg, score: 1.0, semanticScore: 1, recencyScoreValue: 1 },
  { segment: crossSeg1, score: 0.9, semanticScore: 0.95, recencyScoreValue: 0.8 },
  { segment: crossSeg2, score: 0.8, semanticScore: 0.85, recencyScoreValue: 0.7 },
];

// Total budget 10000, cross-session cap 0.3 = 3000 tokens max for cross-session
const crossBudgets = allocateBudgets(scoredCross, 10000, 500, {
  currentSessionId: "current-session",
  pinRecentSegments: 0,
  maxCrossSessionBudgetRatio: 0.3,
  pinnedSegmentIds: [],
});
const crossTokensUsed = crossBudgets
  .filter(b => b.segment.sessionId !== undefined)
  .reduce((sum, b) => sum + b.allocatedTokens, 0);
assert(crossTokensUsed <= 10000 * 0.3, `cross-session tokens (${crossTokensUsed}) within 30% cap (${10000 * 0.3})`);
```

Also update the `buildMessageArray` test to pass the segment to `getMessages`:

```typescript
const result = buildMessageArray(allocations, (ids, _segment) =>
  ids.map(id => messages.get(id)!).filter(Boolean)
);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx src/test-assembler.ts`
Expected: Fails — `allocateBudgets` signature mismatch (new options parameter).

- [ ] **Step 3: Implement pinned segments and cross-session cap in allocateBudgets**

Update `src/assembler.ts`. Add the options interface and update `allocateBudgets`:

```typescript
export interface AllocateOptions {
  currentSessionId: string | undefined;
  pinRecentSegments: number;
  maxCrossSessionBudgetRatio: number;
  pinnedSegmentIds: string[];
}

export function allocateBudgets(
  scored: ScoredSegment[],
  totalBudget: number,
  reserveTokens: number,
  options?: AllocateOptions
): BudgetAllocation[] {
  const allocations: BudgetAllocation[] = [];
  const opts = options || { currentSessionId: undefined, pinRecentSegments: 0, maxCrossSessionBudgetRatio: 1.0, pinnedSegmentIds: [] };
  const pinnedIds = new Set(opts.pinnedSegmentIds);
  const crossSessionBudget = totalBudget * opts.maxCrossSessionBudgetRatio;
  let crossSessionUsed = 0;

  const activeBudget = totalBudget + reserveTokens;
  let remaining = totalBudget;

  // Separate into groups matching the spec's allocation order:
  // 1. Active, 2. Pinned recent, 3. Current-session rest, 4. Cross-session
  const active: ScoredSegment[] = [];
  const pinned: ScoredSegment[] = [];
  const currentRest: ScoredSegment[] = [];
  const crossSession: ScoredSegment[] = [];

  for (const entry of scored) {
    if (entry.segment.status === "active") {
      active.push(entry);
    } else if (pinnedIds.has(entry.segment.id)) {
      pinned.push(entry);
    } else if (entry.segment.sessionId !== undefined) {
      crossSession.push(entry);
    } else {
      currentRest.push(entry);
    }
  }

  // Process order: active → pinned → current-session → cross-session
  const ordered = [...active, ...pinned, ...currentRest, ...crossSession];

  for (const entry of ordered) {
    const seg = entry.segment;
    const isCrossSession = seg.sessionId !== undefined;

    if (seg.status === "active") {
      const tokens = Math.min(seg.tokenCount, activeBudget);
      const sharedUsed = Math.max(0, tokens - reserveTokens);
      remaining -= sharedUsed;
      allocations.push({ segment: seg, tier: "active", allocatedTokens: tokens, scored: entry });
      continue;
    }

    if (remaining <= 0) {
      allocations.push({ segment: seg, tier: "excluded", allocatedTokens: 0, scored: entry });
      continue;
    }

    // For cross-session segments, check budget cap
    const crossRemaining = isCrossSession ? crossSessionBudget - crossSessionUsed : Infinity;
    const effectiveRemaining = Math.min(remaining, isCrossSession ? crossRemaining : Infinity);

    if (effectiveRemaining <= 0) {
      allocations.push({ segment: seg, tier: "excluded", allocatedTokens: 0, scored: entry });
      continue;
    }

    const isPinned = pinnedIds.has(seg.id);

    // Try full expansion
    if (seg.tokenCount <= effectiveRemaining) {
      const tokens = seg.tokenCount;
      allocations.push({ segment: seg, tier: "full", allocatedTokens: tokens, scored: entry });
      remaining -= tokens;
      if (isCrossSession) crossSessionUsed += tokens;
      continue;
    }

    // Try summary + partial
    const summaryTokens = seg.summary ? seg.summaryTokens : 0;
    if (summaryTokens > 0 && summaryTokens < effectiveRemaining) {
      const partialBudget = effectiveRemaining - summaryTokens;
      if (partialBudget > 50) {
        const tokens = summaryTokens + partialBudget;
        allocations.push({ segment: seg, tier: "partial", allocatedTokens: tokens, scored: entry });
        remaining -= tokens;
        if (isCrossSession) crossSessionUsed += tokens;
        continue;
      }
    }

    // Summary only
    if (seg.summary && seg.summaryTokens <= effectiveRemaining) {
      allocations.push({ segment: seg, tier: "summary", allocatedTokens: seg.summaryTokens, scored: entry });
      remaining -= seg.summaryTokens;
      if (isCrossSession) crossSessionUsed += seg.summaryTokens;
      continue;
    }

    // Pinned segments are guaranteed at least summary tier by processing order
    // (they run before other segments and get first access to budget).
    // If we reach here, budget is truly exhausted.
    allocations.push({ segment: seg, tier: "excluded", allocatedTokens: 0, scored: entry });
  }

  return allocations;
}
```

- [ ] **Step 4: Update buildMessageArray callback signature**

In `src/assembler.ts`, change the `getMessages` callback to also receive the segment:

```typescript
export function buildMessageArray(
  allocations: BudgetAllocation[],
  getMessages: (ids: string[], segment: Segment) => SimpleMessage[]
): AssembledMessage[] {
```

Update all call sites within `buildMessageArray` to pass the segment:

- Line ~117: `activeMessages = getMessages(alloc.segment.messageIds, alloc.segment);`
- Line ~133: `const msgs = getMessages(alloc.segment.messageIds, alloc.segment);`
- Line ~138: `const msgs = getMessages(alloc.segment.messageIds, alloc.segment);`

- [ ] **Step 5: Update existing tests to use new signatures**

Update the existing `allocateBudgets` tests to pass `undefined` for the options parameter (backward compatible — the function uses defaults when options is undefined).

Update the `buildMessageArray` test callback from `(ids) =>` to `(ids, _segment) =>`.

- [ ] **Step 6: Run assembler tests**

Run: `npx tsx src/test-assembler.ts`
Expected: All tests pass.

- [ ] **Step 7: Run full test suite**

Run: `npm test`
Expected: All tests pass. The `plugin.ts` `buildMessageArray` call also needs the signature update — this is handled in Task 5.

- [ ] **Step 8: Commit**

```bash
git add src/assembler.ts src/test-assembler.ts
git commit -m "feat(assembler): add pinned segments, cross-session budget cap, segment-aware getMessages"
```

---

### Task 5: Wire SegmentPool into plugin.ts

**Files:**
- Modify: `src/plugin.ts`

This task wires together all the pieces: pool creation at plugin init, eager summary generation on segment close, pool persistence, combined segment scoring in assemble, and the routing `getMessages` callback.

- [ ] **Step 1: Add SegmentPool import**

At the top of `src/plugin.ts`, add:

```typescript
import { SegmentPool } from "./segment-pool.js";
```

- [ ] **Step 2: Create pool at plugin init**

Inside the `dendrite(api)` function body, after the `store` initialization (after line 96), add:

```typescript
const pool = new SegmentPool(configDir);
```

- [ ] **Step 3: Add eager summary generation on segment close (drift split)**

In `ingest()`, after the `if (closedSeg)` block closes (after line 224 — inside the `if (verdict.classification === "tangent")` block but after the embedding computation), add eager summary generation:

```typescript
// Eager summary generation for the closed segment
if (closedSeg && !closedSeg.summary) {
  try {
    const summaryMsgs = state.segmenter.getMessages(closedSeg.messageIds);
    closedSeg.summary = await generateSummary(closedSeg.topic, summaryMsgs, pluginConfig.summaryModel, await getOpenRouterKey());
    closedSeg.summaryTokens = estimateTokens(closedSeg.summary);
  } catch {
    // Summary will be generated lazily in assemble() as fallback
  }
}

// Persist to pool (only if we have a session file path)
if (state.sessionFile) {
  try {
    pool.persistSession(params.sessionId, state.segmenter.segments, "default", state.sessionFile);
  } catch {
    // Non-critical
  }
}
```

Note: `params.sessionFile` is not available in `ingest()` (ingest only receives `{ sessionId, message, isHeartbeat }`). We need to track it. Add `sessionFile` to `SessionState`:

```typescript
interface SessionState {
  segmenter: Segmenter;
  config: DendriteConfig;
  queryEmbedding: number[];
  totalTurns: number;
  indexDirty: boolean;
  embeddingsAvailable: boolean;
  driftAvailable: boolean;
  sessionFile: string;
}
```

And in `createSessionState`, add `sessionFile: ""`. In `bootstrap()`, after getting the state, set `state.sessionFile = params.sessionFile || ""`.

Then in the persist call, use `state.sessionFile` instead of `params.sessionFile`.

- [ ] **Step 4: Add eager summary + pool persist on force split**

In `ingest()`, inside the `if (result.action === "force-split")` block (after `state.indexDirty = true` on line 234), add:

```typescript
// Eager summary for force-split closed segment
const forceClosed = state.segmenter.segments[state.segmenter.segments.length - 2];
if (forceClosed && !forceClosed.summary) {
  try {
    const summaryMsgs = state.segmenter.getMessages(forceClosed.messageIds);
    forceClosed.summary = await generateSummary(forceClosed.topic, summaryMsgs, pluginConfig.summaryModel, await getOpenRouterKey());
    forceClosed.summaryTokens = estimateTokens(forceClosed.summary);
  } catch { /* fallback in assemble */ }
}
// Compute embedding for force-split segment if missing
if (forceClosed && forceClosed.embedding.length === 0) {
  const segText = state.segmenter.getMessages(forceClosed.messageIds).map(m => m.content).join(" ");
  const embedding = await getEmbedding(segText, pluginConfig.embeddingModel, await getGoogleKey());
  if (embedding.length > 0) forceClosed.embedding = embedding;
}
// Persist to pool (only if we have a session file path)
if (state.sessionFile) {
  try {
    pool.persistSession(params.sessionId, state.segmenter.segments, "default", state.sessionFile);
  } catch { /* non-critical */ }
}
```

- [ ] **Step 5: Update assemble() to use combined segments**

In `assemble()`, replace `const segments = state.segmenter.segments;` with:

```typescript
const currentSegments = state.segmenter.segments;
const segments = pool.getCombinedSegments(currentSegments, params.sessionId);
```

- [ ] **Step 6: Update assemble() scoreSegments call**

The `scoreSegments` call is already updated in Task 2. Verify it uses `pluginConfig.recencyHalfLifeMs`.

- [ ] **Step 7: Build pinned segment IDs and update allocateBudgets call**

Before the `allocateBudgets` call, compute pinned IDs:

```typescript
// Find the most recent N closed segments from the current session for pinning
const currentClosed = currentSegments
  .filter(s => s.status === "closed")
  .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  .slice(0, pluginConfig.pinRecentSegments);
const pinnedSegmentIds = currentClosed.map(s => s.id);
```

Update the `allocateBudgets` call:

```typescript
const budgets = allocateBudgets(scored, tokenBudget - pluginConfig.reserveTokens, pluginConfig.reserveTokens, {
  currentSessionId: params.sessionId,
  pinRecentSegments: pluginConfig.pinRecentSegments,
  maxCrossSessionBudgetRatio: pluginConfig.maxCrossSessionBudgetRatio,
  pinnedSegmentIds,
});
```

- [ ] **Step 8: Update buildMessageArray callback to route messages**

Replace the `buildMessageArray` call:

```typescript
const assembled = buildMessageArray(budgets, (ids, segment) => {
  if (segment.sessionId && segment.transcriptPath) {
    return pool.loadMessages(segment.transcriptPath, ids);
  }
  return state.segmenter.getMessages(ids);
});
```

- [ ] **Step 9: Run the full test suite**

Run: `npm test`
Expected: All tests pass. The integration test (`npm run test:integration`) should also pass since it doesn't exercise the pool path.

- [ ] **Step 10: Commit**

```bash
git add src/plugin.ts
git commit -m "feat(plugin): wire SegmentPool for cross-session recall with eager summaries"
```

---

## Chunk 3: CLI Rebuild Command and Integration Testing

### Task 6: Add `dendrite rebuild` CLI subcommand

**Files:**
- Modify: `src/cli.ts`
- Test: `src/test-cli.ts` (add rebuild tests)

- [ ] **Step 1: Write failing tests for the rebuild command**

Add rebuild-related tests to `src/test-cli.ts`. Since the CLI tests use Commander programmatically, add tests that verify the rebuild logic (transcript parsing, segment file generation). The rebuild logic should be extracted into a testable function.

Add a `rebuildSessions` function test:

First, update the imports at the top of `src/test-cli.ts`:

```typescript
import { parseConfigValue, validateConfigKey, rebuildSessions } from "./cli.js";
import { DEFAULT_CONFIG } from "./types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
```

Then add the following test block (before the summary printout):

```typescript
console.log("\n  rebuildSessions:");

// Create a mock transcript with segment-index
const rebuildDir = fs.mkdtempSync(path.join(os.tmpdir(), "dendrite-rebuild-"));
const sessionsDir = path.join(rebuildDir, "agents", "atlas", "sessions");
fs.mkdirSync(sessionsDir, { recursive: true });

const segOutDir = path.join(rebuildDir, "dendrite", "segments");

const mockTranscript = [
  JSON.stringify({ role: "user", content: [{ type: "text", text: "Hello" }], id: "msg_0", timestamp: 1000 }),
  JSON.stringify({ role: "assistant", content: [{ type: "text", text: "Hi there" }], id: "msg_1", timestamp: 2000 }),
  JSON.stringify({ role: "user", content: [{ type: "text", text: "New topic" }], id: "msg_2", timestamp: 3000 }),
  JSON.stringify({
    dendrite: "segment-index",
    version: 1,
    segments: [
      {
        id: "seg_aaa",
        topic: "greeting",
        embedding: [0.1, 0.2],
        messageIds: ["msg_0", "msg_1"],
        messageCount: 2,
        tokenCount: 50,
        summary: "Said hello",
        summaryTokens: 5,
        lastActiveAt: 2000,
        status: "closed",
      },
      {
        id: "seg_bbb",
        topic: "new-topic",
        embedding: [0.3, 0.4],
        messageIds: ["msg_2"],
        messageCount: 1,
        tokenCount: 30,
        summary: null,
        summaryTokens: 0,
        lastActiveAt: 3000,
        status: "active",
      },
    ],
  }),
].join("\n");

const sessionId = "test-rebuild-session";
fs.writeFileSync(path.join(sessionsDir, `${sessionId}.jsonl`), mockTranscript);

const result = await rebuildSessions({
  agentId: "atlas",
  configDir: rebuildDir,
  force: false,
  dryRun: false,
  summaryModel: "test",
  summaryApiKey: "",
  logger: { info: () => {}, warn: () => {}, error: () => {} },
});

assert(result.sessionsProcessed === 1, "rebuild: processed 1 session");
assert(result.segmentsTotal >= 1, "rebuild: found segments");
assert(fs.existsSync(path.join(segOutDir, `${sessionId}.json`)), "rebuild: created segment file");

// Verify segment file content
const segFile = JSON.parse(fs.readFileSync(path.join(segOutDir, `${sessionId}.json`), "utf-8"));
assert(segFile.segments.length === 1, "rebuild: only closed segments persisted");
assert(segFile.segments[0].topic === "greeting", "rebuild: correct topic");
assert(segFile.segments[0].summary === "Said hello", "rebuild: preserves existing summary");

// Skip if already exists
const result2 = await rebuildSessions({
  agentId: "atlas",
  configDir: rebuildDir,
  force: false,
  dryRun: false,
  summaryModel: "test",
  summaryApiKey: "",
  logger: { info: () => {}, warn: () => {}, error: () => {} },
});
assert(result2.sessionsProcessed === 0, "rebuild: skips existing segment files");

// Force mode
const result3 = await rebuildSessions({
  agentId: "atlas",
  configDir: rebuildDir,
  force: true,
  dryRun: false,
  summaryModel: "test",
  summaryApiKey: "",
  logger: { info: () => {}, warn: () => {}, error: () => {} },
});
assert(result3.sessionsProcessed === 1, "rebuild --force: reprocesses existing");

// Dry run
const result4 = await rebuildSessions({
  agentId: "atlas",
  configDir: rebuildDir,
  force: true,
  dryRun: true,
  summaryModel: "test",
  summaryApiKey: "",
  logger: { info: () => {}, warn: () => {}, error: () => {} },
});
assert(result4.sessionsProcessed === 1, "rebuild --dry-run: reports would process");

fs.rmSync(rebuildDir, { recursive: true });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/test-cli.ts`
Expected: Fails — `rebuildSessions` not exported from `cli.js`.

- [ ] **Step 3: Implement rebuildSessions function**

First, add `SimpleMessage` to the import from `./types.js` at the top of `src/cli.ts`:

```typescript
import { DEFAULT_CONFIG, type DendriteConfig, type TurnSnapshot, type SimpleMessage } from "./types.js";
```

Also add a static import for `generateSummary`:

```typescript
import { generateSummary } from "./summarizer.js";
```

Then add to `src/cli.ts`:

```typescript
export interface RebuildOptions {
  agentId: string;
  configDir: string;
  force: boolean;
  dryRun: boolean;
  summaryModel: string;
  summaryApiKey: string;
  logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}

export interface RebuildResult {
  sessionsProcessed: number;
  segmentsTotal: number;
  summariesGenerated: number;
}

export async function rebuildSessions(opts: RebuildOptions): Promise<RebuildResult> {
  const sessionsDir = path.join(opts.configDir, "agents", opts.agentId, "sessions");
  const segmentsDir = path.join(opts.configDir, "dendrite", "segments");

  if (!fs.existsSync(sessionsDir)) {
    opts.logger.warn(`No sessions directory found: ${sessionsDir}`);
    return { sessionsProcessed: 0, segmentsTotal: 0, summariesGenerated: 0 };
  }

  const transcriptFiles = fs.readdirSync(sessionsDir).filter(f => f.endsWith(".jsonl"));
  let sessionsProcessed = 0;
  let segmentsTotal = 0;
  let summariesGenerated = 0;

  for (const file of transcriptFiles) {
    const sessionId = file.replace(".jsonl", "");
    const segmentFile = path.join(segmentsDir, `${sessionId}.json`);

    if (!opts.force && fs.existsSync(segmentFile)) {
      continue;
    }

    const transcriptPath = path.join(sessionsDir, file);
    const content = fs.readFileSync(transcriptPath, "utf-8");
    const lines = content.split("\n").filter(Boolean);

    // Find last segment-index entry
    let lastIndex: { segments: any[] } | null = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.dendrite === "segment-index") {
          lastIndex = { segments: entry.segments };
          break;
        }
      } catch { /* skip */ }
    }

    if (!lastIndex || lastIndex.segments.length === 0) {
      continue;
    }

    const closedSegments = lastIndex.segments.filter((s: any) => s.status === "closed");
    if (closedSegments.length === 0) continue;

    // Generate summaries for segments missing them
    for (const seg of closedSegments) {
      if (!seg.summary && opts.summaryApiKey && !opts.dryRun) {
        try {
          // Load messages for this segment from transcript
          const idSet = new Set(seg.messageIds as string[]);
          const msgs: SimpleMessage[] = [];
          for (const line of lines) {
            try {
              const entry = JSON.parse(line);
              if (entry.id && idSet.has(entry.id)) {
                const role = entry.role;
                if (role !== "user" && role !== "assistant" && role !== "toolResult") continue;
                const text = typeof entry.content === "string"
                  ? entry.content
                  : Array.isArray(entry.content)
                    ? entry.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("")
                    : "";
                if (text) msgs.push({ id: entry.id, role, content: text, timestamp: entry.timestamp || 0 });
              }
            } catch { /* skip */ }
          }
          if (msgs.length > 0) {
            // Retry with exponential backoff for rate limits
            let lastErr: any;
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                seg.summary = await generateSummary(seg.topic, msgs, opts.summaryModel, opts.summaryApiKey);
                seg.summaryTokens = Math.ceil(seg.summary.length / 4);
                summariesGenerated++;
                lastErr = null;
                break;
              } catch (err: any) {
                lastErr = err;
                if (attempt < 2) {
                  const delay = 1000 * Math.pow(2, attempt); // 1s, 2s
                  await new Promise(r => setTimeout(r, delay));
                }
              }
            }
            if (lastErr) {
              opts.logger.warn(`Failed to generate summary for ${seg.id} after 3 attempts: ${lastErr?.message || lastErr}`);
            }
          }
        } catch (err: any) {
          opts.logger.warn(`Failed to process segment ${seg.id}: ${err?.message || err}`);
        }
      }
    }

    sessionsProcessed++;
    segmentsTotal += closedSegments.length;

    if (opts.dryRun) continue;

    fs.mkdirSync(segmentsDir, { recursive: true });
    const fileData = {
      sessionId,
      agentId: opts.agentId,
      transcriptPath,
      exportedAt: Date.now(),
      segments: closedSegments,
    };
    fs.writeFileSync(segmentFile, JSON.stringify(fileData, null, 2));
  }

  return { sessionsProcessed, segmentsTotal, summariesGenerated };
}
```

- [ ] **Step 4: Register the rebuild subcommand**

Add to `registerDendriteCli` in `src/cli.ts`, after the `peek` command registration:

```typescript
// ── rebuild ──
root
  .command("rebuild")
  .description("Backfill per-session segment files from existing transcripts")
  .option("--dry-run", "Report what would be processed without writing")
  .option("--force", "Reprocess sessions even if segment files exist")
  .option("--agent <id>", "Agent ID (defaults to agent with default: true)")
  .action(async (opts: { dryRun?: boolean; force?: boolean; agent?: string }) => {
    let agentId = opts.agent;

    if (!agentId) {
      // Find default agent from openclaw.json
      try {
        const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        const agents = raw?.agents?.list || [];
        const defaultAgent = agents.find((a: any) => a.default === true);
        agentId = defaultAgent?.id;
      } catch { /* */ }
    }

    if (!agentId) {
      console.error("No agent specified and no default agent found in openclaw.json");
      process.exit(1);
    }

    console.log(`Rebuilding segment files for agent: ${agentId}`);
    if (opts.dryRun) console.log("(dry run — no files will be written)\n");

    const effective = store.getEffectiveConfig();

    const result = await rebuildSessions({
      agentId,
      configDir,
      force: !!opts.force,
      dryRun: !!opts.dryRun,
      summaryModel: effective.summaryModel,
      summaryApiKey: process.env.OPENROUTER_API_KEY || "",
      logger: { info: console.log, warn: console.warn, error: console.error },
    });

    console.log(`\nProcessed ${result.sessionsProcessed} sessions, ${result.segmentsTotal} segments, generated ${result.summariesGenerated} summaries`);
  });
```

- [ ] **Step 5: Run CLI tests**

Run: `npx tsx src/test-cli.ts`
Expected: All tests pass.

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/cli.ts src/test-cli.ts
git commit -m "feat(cli): add dendrite rebuild command for backfilling segment files"
```

---

### Task 7: Cross-session integration test

**Files:**
- Create: `src/test-cross-session.ts`
- Modify: `package.json` (add to test:all script, not unit test script)

- [ ] **Step 1: Write integration test**

Create `src/test-cross-session.ts`:

```typescript
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
import { allocateBudgets, buildMessageArray } from "./assembler.js";
import { createSegment, estimateTokens, type SimpleMessage } from "./types.js";
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
    embedding: [0.8, 0.2, 0.1, 0.0],  // semantically close to networking queries
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
    embedding: [0.1, 0.1, 0.8, 0.2],  // semantically close to Python queries
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
currentActive.embedding = [0.7, 0.3, 0.1, 0.0];  // related to Docker
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
const queryEmbedding = [0.75, 0.25, 0.1, 0.0];  // Docker-related query
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

// ── Message assembly with lazy loading ──
console.log("\n  Message assembly with lazy loading:");

// Create current session message store
const currentMessages = new Map<string, SimpleMessage>();
currentMessages.set("c_msg_0", { id: "c_msg_0", role: "user", content: "Set up the project", timestamp: Date.now() - 5000 });
currentMessages.set("c_msg_1", { id: "c_msg_1", role: "user", content: "How do I use Docker compose with this?", timestamp: Date.now() });

const assembled = buildMessageArray(budgets, (ids, segment) => {
  if (segment.sessionId && segment.transcriptPath) {
    return pool.loadMessages(segment.transcriptPath, ids);
  }
  return ids.map(id => currentMessages.get(id)).filter((m): m is SimpleMessage => m !== undefined);
});

assert(assembled.length > 0, "assembled array is not empty");
// Active segment messages should always be present
const activeContent = assembled.filter(m => m.content.includes("Docker compose"));
assert(activeContent.length > 0, "active segment messages present in assembly");

// If Docker segment got full or partial tier, its messages should be lazy-loaded
const dockerBudget = budgets.find(b => b.segment.id === "seg_docker")!;
if (dockerBudget.tier === "full" || dockerBudget.tier === "partial") {
  const dockerContent = assembled.filter(m => m.content.includes("Docker bridge") || m.content.includes("docker0"));
  assert(dockerContent.length > 0, "Docker past-session messages lazy-loaded into assembly");
}

// If Docker segment got summary tier, its summary should be in the preamble
if (dockerBudget.tier === "summary") {
  const preamble = assembled.find(m => m.role === "system");
  assert(preamble !== undefined && preamble.content.includes("Docker"), "Docker summary in preamble");
}

console.log(`\n  Docker segment tier: ${dockerBudget.tier}`);
console.log(`  Python segment tier: ${budgets.find(b => b.segment.id === "seg_python")!.tier}`);

// Cleanup
fs.rmSync(tmpDir, { recursive: true });

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 2: Run integration test**

Run: `npx tsx src/test-cross-session.ts`
Expected: All tests pass.

- [ ] **Step 3: Add to test:all script**

Update `package.json` `test:all`:

```json
"test:all": "npm test && npm run test:integration && tsx src/test-cross-session.ts"
```

- [ ] **Step 4: Run full test suite**

Run: `npm run test:all`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/test-cross-session.ts package.json
git commit -m "test: add cross-session segment recall integration test"
```

---

### Task 8: Type-check and final validation

**Files:** All modified files

- [ ] **Step 1: Run type checker**

Run: `npm run build`
Expected: No TypeScript errors.

- [ ] **Step 2: Run full test suite**

Run: `npm run test:all`
Expected: All tests pass.

- [ ] **Step 3: Final commit (if any fixups needed)**

Run `git status` first to verify what changed. Stage only the relevant files:

```bash
git add src/types.ts src/scorer.ts src/assembler.ts src/segment-pool.ts src/segmenter.ts src/plugin.ts src/cli.ts src/test-*.ts package.json
git commit -m "chore: fix type errors and test adjustments for cross-session recall"
```
