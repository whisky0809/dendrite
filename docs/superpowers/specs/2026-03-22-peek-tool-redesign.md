# Peek Tool Redesign

**Date:** 2026-03-22
**Status:** Draft

## Problem

The `openclaw dendrite peek` command is broken and unhelpful:

1. **Empty assembled context** — `plugin.ts` line 537 uses `typeof m.content === "string" ? m.content : ""` to serialize messages, but assembled messages use content-block arrays, so every message renders as `"role: "` with no content.
2. **Flat text dump** — `formatPeekSummary()` outputs a wall of text: stats, a dense single-line-per-segment list, and the raw assembled context all in one stream.
3. **Opaque session selection** — raw UUIDs with no labels, interactive `readline` prompts that collide with plugin log output.
4. **No drill-down** — no way to see just segments, just one segment's messages, or full message content on demand.

## Goals

- Fix snapshot persistence so it captures real message content.
- Redesign the peek display as a context inspector / debugging tool.
- Make session/turn selection non-interactive and ergonomic.

## Non-Goals

- Browser-based or TUI visualization.
- Modifying the assembly pipeline itself (only the snapshot capture point).
- Real-time / live-updating peek (that's what `logs` is for).

## Design

### 1. Snapshot Data Model

Replace the flat `assembledContext: string` field with structured per-message data.

**New types (in `types.ts`):**

```typescript
interface TurnSnapshotMessage {
  role: "user" | "assistant" | "toolResult";  // matches SimpleMessage roles
  segmentId: string | null;   // which segment owns this message (null for system/injected)
  tokenCount: number;          // estimated tokens via estimateTokens()
  contentPreview: string;      // first 200 chars of extracted text
  contentFull: string;         // complete extracted text
}
```

Note: tool calls are not separate messages — they are content blocks within assistant messages. The `extractTextContent()` call on assistant messages with tool calls will produce the `[Tool calls: ...]` placeholder text that `toSimpleMessage()` generates.

**Modified `TurnSnapshot`:**

```typescript
interface TurnSnapshot {
  timestamp: number;
  turnIndex: number;
  sessionId: string;
  segments: TurnSnapshotSegment[];   // unchanged
  messages: TurnSnapshotMessage[];   // NEW — replaces assembledContext
  systemPreamble: string;            // NEW — the system prompt addition (empty string if none)
  stats: { ... };                    // unchanged

  // Legacy field — present in old snapshots, absent in new ones
  assembledContext?: string;
}
```

Both `messages` and `assembledContext` are optional at the TypeScript level to support reading old snapshots. New snapshots always have `messages` and never have `assembledContext`.

### 2. Snapshot Persistence Fix

In `plugin.ts`, replace the `assembledContext` construction block (~lines 535-538) with:

1. **Build a segment-ID lookup** from `budgets[].segment.messageIds` — a `Map<string, string>` mapping SimpleMessage ID to segmentId.
2. **Use positional correspondence** between the `assembled` array (SimpleMessages) and `conversationMessages` (AgentMessages). `conversationMessages` is the `.map()` result of `assembled.filter(m => m.role !== "system")`, so they share indices by construction. Use the SimpleMessage's ID at each position to look up the segment.
3. **For each message** in `conversationMessages`, use `extractTextContent()` to get the actual text content (handles both string and array content-block formats).
4. **Build `TurnSnapshotMessage` objects** with:
   - `role` from the assembled SimpleMessage (not the AgentMessage, since toolResults may have been converted to user role)
   - `segmentId` from the lookup (or `null` if no match — injected summaries, cross-session messages)
   - `tokenCount` via `estimateTokens()`
   - `contentPreview` — first 200 characters of extracted text
   - `contentFull` — complete extracted text
5. **Capture `systemPreamble`** as a separate field (already computed as a variable; will be `""` when no system messages exist).

### 3. CLI Selection UX

Replace the interactive readline-based pickers with a non-interactive progressive-disclosure flow:

**`peek` (no flags)** — List sessions and exit:

```
SESSIONS                                         TURNS  LAST ACTIVE
233d8a9b  setting up drift model                     4  2026-03-21 03:59
51f55c52  initial project setup                     26  2026-03-21 20:58
872bf1cb  debugging scorer weights                  11  2026-03-21 06:45

Use: openclaw dendrite peek -s <id> [-t <turn>]
     openclaw dendrite peek --last
```

Session "name" is derived from the topic of the most recent active segment in that session's latest turn snapshot. If no active segment exists (all closed), use the topic of the most recently closed segment. If the session has no segments at all, fall back to `(no topic)`.

**`peek -s <id>` (session only)** — List turns for that session and exit:

```
SESSION 233d8a9b — setting up drift model

 TURN    TIME                SEGS  TOKENS    BUDGET%
  #12    2026-03-21 02:32       2   24,100      9%
  #13    2026-03-21 02:39       2   26,800     10%
  #14    2026-03-21 02:43       2   28,642     11%
  #15    2026-03-21 03:59       3   31,200     12%

Use: openclaw dendrite peek -s 233d -t 14
```

**`peek -s <id> -t <turn>`** — Show the full peek dashboard (see section 4).

**`peek --last`** — Jump to the most recent turn across all sessions.

**Partial UUID matching:** `-s 233d` matches `233d8a9b-...`. If ambiguous, print matching sessions and exit with an error.

**Relative turn selection:** `-t -1` means last turn, `-t -2` second-to-last.

**No `readline` prompts anywhere.** If input is insufficient, print the relevant listing with a usage hint and exit.

### 4. Peek Dashboard Display

When a specific turn is selected, show a three-section dashboard:

**Header:**

```
Session: 233d8a9b  |  Turn #14  |  2026-03-21 01:43:00
Budget: 28,642 / 256,000 tokens (11%)  ██░░░░░░░░░░░░░░░░░░
Embeddings: ✓  |  Drift: ✓  |  Fallbacks: none
```

**Segment Table:**

```
 TIER      TOPIC                    MSGS   TOKENS     SCORE  (sem / rec)
 active    setting up drift model     14    1,306         —    —     —
 full      initial project setup      80   27,336      0.67  0.58  0.90
 excluded  old debugging session      23    4,102      0.12  0.05  0.22
```

**Message List** (grouped by segment):

```
── setting up drift model (active, 1,306 tokens) ──────────
  user        324t  "Can you check if the drift model is..."
  assistant   512t  "I'll look at the configuration for..."
  toolResult   89t  "{ driftModel: 'nvidia/nemotron-3...' }"
  assistant   381t  "The drift model is set to nvidia/ne..."

── initial project setup (full, 27,336 tokens) ────────────
  user        128t  "Let's start building the segmenter..."
  assistant   892t  "I'll create the initial Segmenter c..."
  ... 76 more messages ...
```

Messages with `segmentId: null` (system, injected summaries) are shown in a `── (system) ──` group at the top.

For segments with many messages, show the first 2 and last 2 with `... N more messages ...` in between.

### 5. Flags

| Flag | Short | Behavior |
|------|-------|----------|
| `--session <id>` | `-s` | Select session by full or partial UUID |
| `--turn <n>` | `-t` | Select turn by index; negative values count from end (`-1` = last) |
| `--last` | `-l` | Show the most recent turn across all sessions |
| `--full` | | Expand all messages with complete content instead of previews |
| `--json` | | Dump the raw snapshot as JSON (machine-readable) |
| `--segments-only` | | Show only the header + segment table, no message list |

`--last` and `-s`/`-t` are mutually exclusive. If both are provided, print an error.

### 6. Files Changed

| File | Change |
|------|--------|
| `src/types.ts` | Add `TurnSnapshotMessage`, add optional `messages` and `systemPreamble` to `TurnSnapshot`, make `assembledContext` optional (kept for backward compat with old snapshots) |
| `src/plugin.ts` | Fix snapshot persistence: build segment-ID lookup, use `extractTextContent()`, populate new fields |
| `src/cli.ts` | Rewrite `formatPeekSummary()`, replace readline pickers with non-interactive flow, add new flags |
| `src/store.ts` | Add `getSessionLabel(sessionId)` for topic-based labels, `resolveSessionId(partial)` for partial UUID matching |

### 7. Backward Compatibility

Old snapshot files still exist on disk with the `assembledContext` field. The new peek display should handle both formats gracefully:
- If `messages` array exists, use the new display.
- If only `assembledContext` exists, fall back to displaying it raw (the old behavior) with a note that this is a legacy snapshot.

This avoids needing to migrate or delete old snapshot data.

### 8. Testing

Add a test file `src/test-peek.ts` covering:

- **Snapshot message construction** — verify `TurnSnapshotMessage` objects are built correctly from mock assembled/conversation message pairs, including segment-ID mapping and content extraction.
- **Partial UUID matching** — `resolveSessionId()` with unique prefixes, ambiguous prefixes, and no-match cases.
- **Display formatting** — verify `formatPeekDashboard()` produces expected output structure for both new and legacy snapshot formats.
- **Relative turn selection** — `-t -1` resolves to last turn, `-t -2` to second-to-last, out-of-range produces error.
