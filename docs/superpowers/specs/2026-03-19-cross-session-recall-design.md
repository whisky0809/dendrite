# Cross-Session Segment Recall

> Dendrite becomes a RAG engine over your entire conversation history — every past session's segments are scored alongside the current session's, and the most relevant context surfaces automatically.

## Problem

Dendrite v2 operates within a single session. When a session resets (daily, idle, manual), all segment state is lost from the assembly pipeline. The user starts fresh, and relevant context from past sessions — even conversations from hours ago — is invisible to the agent. The original vision is an infinite context window that dynamically loads the most relevant parts of the *entire* conversation history, not just the current session.

## Approach

Extend the existing assembly pipeline to score segments from all past sessions alongside the current session's segments. Past segments are loaded from per-session segment files on disk, with their pre-computed embeddings and summaries. Full messages are loaded lazily from transcript files only when a past segment scores high enough for full or partial expansion.

This is RAG applied to conversation context management. The retrieval corpus is every past conversation. The query is the current conversation. The assembly step is retrieval + tiered inclusion.

## Architecture

### SegmentPool

A new class in `src/segment-pool.ts`. Manages the cross-session segment pool.

**Responsibilities:**
- On construction, loads all per-session segment files from `~/.openclaw/dendrite/segments/*.json`
- Holds all closed segments from past sessions in memory (metadata, embeddings, summaries — not full messages)
- Provides `getCombinedSegments(currentSegments)` — returns current session segments + pool segments as a single array for scoring
- Provides `persistSession(sessionId, segments, transcriptPath)` — writes a session's closed segments to its segment file
- Provides `loadMessages(sessionId, transcriptPath, messageIds)` — lazily reads a transcript JSONL and returns messages matching the requested IDs

**What it does NOT do:**
- Score or assemble — that stays in `scorer.ts` and `assembler.ts`
- Own the current session's segments — `Segmenter` still does that
- Cache loaded messages — each lazy load reads from disk (keeps memory bounded)

### Per-Session Segment File

Stored at `~/.openclaw/dendrite/segments/<sessionId>.json`.

```json
{
  "sessionId": "823381ff-...",
  "agentId": "atlas",
  "transcriptPath": "/home/whisky/.openclaw/agents/atlas/sessions/823381ff-....jsonl",
  "exportedAt": 1742212800000,
  "segments": [
    {
      "id": "seg_abc123",
      "topic": "Docker networking",
      "embedding": [0.12, -0.34, ...],
      "messageIds": ["msg_0_1742212800000", "msg_1_1742212800123"],
      "messageCount": 8,
      "tokenCount": 3200,
      "summary": "Discussed Docker bridge networking...",
      "summaryTokens": 85,
      "lastActiveAt": 1742212800000,
      "status": "closed"
    }
  ]
}
```

Each segment in the pool carries `sessionId` and `transcriptPath` so the lazy loader knows which file to read from.

## Changes

### Segment Type

Two new optional fields on the `Segment` interface:

```typescript
interface Segment {
  // ... existing fields ...
  sessionId?: string;       // which session this segment belongs to
  transcriptPath?: string;  // path to transcript JSONL for lazy message loading
}
```

Current-session segments don't set these (the `Segmenter` already has their messages in its `messageStore`). Pool segments always have them set.

### Recency Scoring

The current `recencyScore()` uses turn-based decay, which breaks across sessions because `totalTurns` resets per session. Switch to time-based decay:

```typescript
export function recencyScore(msSinceActive: number, halfLifeMs: number): number {
  return Math.pow(0.5, msSinceActive / halfLifeMs);
}
```

Default half-life: 10 minutes (600,000 ms). With `relevanceAlpha` at 0.7, this means past-session segments are scored almost entirely on semantic similarity — they only surface when genuinely relevant to the current conversation.

### Assembly Budget Allocation

Three new constraints in `allocateBudgets()`:

**1. Pinned recent segments.** The most recent `pinRecentSegments` (default 3) closed segments from the current session are guaranteed at least summary tier, regardless of score. Processed after the active segment, before general scoring.

**2. Cross-session budget cap.** Cross-session segments can use at most `maxCrossSessionBudgetRatio` (default 0.3) of the total assembly budget. Prevents old history from crowding out the current conversation.

**3. Response reserve.** `reserveTokens` default bumped from 8192 to 16384 to leave room for model responses.

Allocation order:
1. Active segment — full (always)
2. Pinned recent segments — at least summary, promoted to full/partial if budget allows
3. Remaining current-session segments — scored normally
4. Cross-session segments — scored normally, capped at ratio

`allocateBudgets()` needs the current session ID and pin count to distinguish current vs cross-session segments. The function signature changes to accept these as parameters.

### buildMessageArray Callback

The `getMessages` callback signature changes from `(ids: string[]) => SimpleMessage[]` to `(ids: string[], segment: Segment) => SimpleMessage[]`. This lets the caller route to either the `Segmenter`'s in-memory message store (current session) or `SegmentPool.loadMessages()` (past sessions) based on whether the segment has a `sessionId` set.

### Plugin Lifecycle Changes

**Plugin init (registration time):**
- Create the `SegmentPool` instance, loading all segment files from `~/.openclaw/dendrite/segments/`
- The pool is shared across all sessions (it lives alongside the `sessions` Map, not inside `SessionState`)

**bootstrap():**
- Unchanged — still restores the current session from its transcript
- The pool is already loaded at plugin init

**ingest() — on segment close:**
- After a drift split or force split, the existing code already computes the embedding for the closed segment
- New: generate the summary immediately (eager, not lazy)
- New: call `pool.persistSession()` to write/update the per-session segment file

**assemble():**
- Get combined segments via `pool.getCombinedSegments(state.segmenter.segments)`
- Pass combined array to `scoreSegments()` (function itself unchanged)
- Lazy summary generation in `assemble()` stays as a fallback for segments that somehow reach assembly without a summary
- The `getMessages` callback routes to pool or segmenter based on segment's `sessionId`

### Eager Summary Generation

Summaries are generated at segment close time in `ingest()`, not lazily in `assemble()`. This ensures every segment in the pool is ready for any tier of inclusion. The existing lazy path in `assemble()` remains as a fallback for edge cases (crash between close and summarize, segments from before this change).

## CLI: `dendrite rebuild`

A new subcommand added to the existing CLI registration in `cli.ts`. Backfills per-session segment files from existing transcripts.

**Process:**
1. Reads `openclaw.json` → `agents.list` → finds the agent with `"default": true`
2. Lists all `*.jsonl` transcript files in `~/.openclaw/agents/<agentId>/sessions/`
3. For each transcript:
   - Extracts the last `segment-index` entry (contains embeddings)
   - Skips if a corresponding segment file already exists and is up to date
   - For segments missing summaries, generates them via the summary model (with rate limiting)
   - Writes per-session segment file to `~/.openclaw/dendrite/segments/`
4. Reports progress: `Processed 12 sessions, 47 segments, generated 23 summaries`

**Flags:**
- `--dry-run` — report what would be processed without writing anything
- `--force` — reprocess sessions even if segment files already exist
- `--agent <id>` — override agent (defaults to the agent with `"default": true`)

## New Config Fields

Added to `DendriteConfig` and the plugin manifest's `configSchema`:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `pinRecentSegments` | integer | 3 | Number of most recent closed segments guaranteed at least summary tier |
| `maxCrossSessionBudgetRatio` | number | 0.3 | Max fraction of assembly budget for cross-session segments |
| `recencyHalfLifeMs` | integer | 600000 | Half-life for time-based recency decay (ms) |
| `reserveTokens` | integer | 16384 | Tokens reserved for model response (bumped from 8192) |

## Error Handling

| Failure | Behavior |
|---------|----------|
| Segment file corrupt/unreadable | Skip that session's segments, log warning, continue with remaining pool |
| Transcript file missing (for lazy load) | Fall back to summary-only tier for that segment, log warning |
| Transcript file exists but message IDs not found | Fall back to summary-only tier, log warning |
| Pool directory doesn't exist | Create it on first `persistSession()` call |
| `rebuild` encounters rate limits | Back off and retry with exponential delay, report partial progress |
| Embedding missing on pool segment | Score with recency only (alpha forced to 0 for that segment) |

## File Changes Summary

**New file:**
- `src/segment-pool.ts` — `SegmentPool` class

**Modified files:**
- `src/types.ts` — `sessionId?`, `transcriptPath?` on Segment; new config fields; bumped `reserveTokens` default
- `src/scorer.ts` — time-based `recencyScore()`
- `src/assembler.ts` — pinned segments, cross-session budget cap in `allocateBudgets()`
- `src/plugin.ts` — pool creation, eager summaries, pool persistence, combined scoring
- `src/cli.ts` — `dendrite rebuild` subcommand
- `src/segmenter.ts` — minor: `buildMessageArray` callback signature change

**Unchanged:**
- `src/summarizer.ts` — same function, called at a different point
- `scoreSegments()` — same signature, bigger input array
- Transcript format — segment-index entries unchanged
- OpenClaw plugin API contract — `bootstrap`, `ingest`, `assemble`, `compact` signatures unchanged

## Testing

- **Unit: SegmentPool** — load from files, persist, combine with current segments, lazy message loading, corrupt file handling
- **Unit: recencyScore** — time-based decay at various intervals
- **Unit: allocateBudgets** — pinned segments, cross-session cap, mixed current/past segments
- **Unit: rebuild CLI** — transcript parsing, segment file generation, skip existing, force mode
- **Integration** — multi-session scenario: pre-build segment files, run assemble, verify past segments surface when semantically relevant
- **Manual** — run `rebuild` against real transcripts, verify segment files, start new session and check cross-session recall

## Scope Boundaries

Not in scope for this change:
- Cross-agent recall (segments from agent A surfacing in agent B)
- Segment deduplication across sessions
- Automatic cleanup/expiry of old segment files
- Message content modification
- Changes to the OpenClaw plugin API contract
