# Dendrite v3 — Index-Based Assembly

> The assembler selects, it does not reconstruct.

## Problem

Dendrite v2's assembly pipeline converts OpenClaw `AgentMessage` objects into a flat `SimpleMessage` format, scores and selects them, then attempts to reconstruct `AgentMessage` objects from the simplified copies. This lossy round-trip is the root cause of "Message ordering conflict" errors that break sessions.

The specific failures:

1. **Consecutive `toolResult` messages.** A single assistant turn can invoke multiple tools, producing multiple `toolResult` messages. OpenClaw groups these with their parent assistant via `toolCallId`. Dendrite's `SimpleMessage` strips this grouping. When the assembler returns the messages, OpenClaw sees consecutive `toolResult` roles without the binding that makes them valid.

2. **Orphaned tool calls.** The timestamp+role lookup used to map SimpleMessages back to originals is fragile — multiple messages can share timestamps, and tool-call-only assistant messages don't have text content to match. Mismatches produce orphaned `toolCall` blocks without corresponding `toolResult` entries.

3. **Patching doesn't scale.** Three rounds of tool-pairing repair code (commits `76c3192`, `e0cbee4`, `f709c34`) have been added to `plugin.ts`, totaling ~60 lines of post-assembly fixup. Each new edge case in the AgentMessage format will require another patch.

The core insight: **Dendrite's value is in scoring and selecting segments. The assembler should output a selection (which messages to include), not a reconstruction (new message objects).**

## Approach

Replace the message-reconstruction pipeline with index-based pass-through:

1. The segmenter tracks which positions in `params.messages` belong to each segment.
2. The assembler computes budget allocations (unchanged) and returns an ordered list of original message indices.
3. The plugin maps indices back to the original `AgentMessage` objects and returns them untouched.

OpenClaw gets its own objects back. Tool grouping, content block structure, and role sequencing are preserved by construction rather than repaired after the fact.

## Architecture

### What stays the same

- **Segmenter** — topic drift detection, segment lifecycle, force-splits. Still ingests message content for drift prompts and token estimation.
- **Scorer** — composite relevance scoring (semantic + recency). Operates on Segment metadata, not messages.
- **Summarizer** — generates text summaries from segment content. Called at segment close time.
- **Budget allocator** — tiered allocation (active/full/partial/summary/excluded). Logic unchanged.
- **SegmentPool** — cross-session segment storage and retrieval.
- **CLI** — peek, config, logs, rebuild commands.
- **Plugin lifecycle** — bootstrap, ingest, assemble, compact signatures unchanged.

### What changes

#### 1. Reconciliation: mapping segment messages to params.messages indices

The segmenter ingests messages one at a time (via `ingest()`), but the original `params.messages` array is only available during `assemble()`. The reconciliation step maps each SimpleMessage in the segmenter to its position in `params.messages`.

```typescript
interface SimpleMessage {
  id: string;
  role: "user" | "assistant" | "toolResult";
  content: string;
  timestamp: number;
  originalIndex?: number;  // position in params.messages, set during assemble()
}
```

**Why not use message IDs?** OpenClaw's `AgentMessage` types (`UserMessage`, `AssistantMessage`, `ToolResultMessage`) do not have an `id` field. The current `toSimpleMessage` generates synthetic IDs from `msg_${index}_${timestamp}`, where `index` is the ingest-time counter. These synthetic IDs are not stable across ingest and assemble — OpenClaw may filter, reorder, or inject messages between calls.

**Reconciliation strategy: timestamp + role matching.** At the start of each `assemble()` call, walk `params.messages` and match to SimpleMessages by `(timestamp, role)`:

```typescript
// In assemble(), before scoring:
// Build a lookup: (timestamp, role) → list of params.messages indices
const lookup = new Map<string, number[]>();
for (let i = 0; i < params.messages.length; i++) {
  const msg = params.messages[i];
  const key = `${msg.timestamp}:${msg.role}`;
  const arr = lookup.get(key);
  if (arr) arr.push(i);
  else lookup.set(key, [i]);
}

// Track which params.messages indices are covered by segments
const trackedOriginalIndices = new Set<number>();

// Match each segment's messages to params.messages positions
for (const seg of currentSegments) {
  for (const msgId of seg.messageIds) {
    const simple = state.segmenter.getMessage(msgId);
    if (!simple) continue;
    const key = `${simple.timestamp}:${simple.role}`;
    const candidates = lookup.get(key);
    if (candidates && candidates.length > 0) {
      // Consume the first match (handles multiple messages at same timestamp)
      simple.originalIndex = candidates.shift()!;
      trackedOriginalIndices.add(simple.originalIndex);
      if (candidates.length === 0) lookup.delete(key);
    } else {
      simple.originalIndex = undefined; // not found in params.messages
    }
  }
}
```

This is similar to v2's lookup but with a critical difference: **we consume matches and use the result as indices, not as objects to reconstruct**. The timestamp+role match is imperfect (multiple messages can share a timestamp), but consuming matches in order handles this — messages within a segment are ordered chronologically, matching the order in `params.messages`.

**When reconciliation fails:** If a SimpleMessage has no match (OpenClaw dropped it, or it was added during a session that no longer exists), its `originalIndex` stays `undefined` and it is excluded from the selection. The segment's token count may be slightly overstated, but this is benign — budget allocation uses the segment's pre-computed `tokenCount`, and the actual output will be slightly under budget.

#### 2. Assembler returns indices, not messages

`buildMessageArray()` is replaced by `buildSelectionPlan()`:

```typescript
interface SelectionPlan {
  /** Ordered indices into params.messages to include */
  indices: number[];
  /** Summary text blocks for systemPromptAddition */
  summaryBlocks: string[];
  /** Per-segment metadata for logging */
  segmentPlans: Array<{
    segmentId: string;
    tier: Tier;
    includedCount: number;
    totalCount: number;
  }>;
}

function buildSelectionPlan(
  allocations: BudgetAllocation[],
  getOriginalIndices: (segment: Segment) => number[]
): SelectionPlan;
```

The `getOriginalIndices` callback returns the `originalIndex` values for a segment's messages. For partial-tier segments (budget-trimmed), the function takes the N most recent indices that fit the budget.

#### 3. Plugin assemble() becomes a filter

```typescript
async assemble(params) {
  // ... scoring and budget allocation (unchanged) ...

  const plan = buildSelectionPlan(budgets, (segment) => {
    return segment.messageIds
      .map(id => state.segmenter.getMessage(id)?.originalIndex)
      .filter((i): i is number => i !== undefined);
  });

  const messages = plan.indices.map(i => params.messages[i]);
  const systemPreamble = plan.summaryBlocks.join("\n\n");

  return {
    messages,
    estimatedTokens,
    systemPromptAddition: systemPreamble || undefined,
  };
}
```

**Deleted code:**
- `toAgentMessage()` — no longer needed (was converting SimpleMessage back to AgentMessage)
- `AssembledMessage` type — replaced by indices
- Original-message lookup block (timestamp+role matching, ~30 lines)
- Orphaned tool-call/toolResult repair (~60 lines)
- `buildMessageArray()` — replaced by `buildSelectionPlan()`

#### 4. Cross-session segments are summary-only

Cross-session segments (from the SegmentPool) don't have entries in `params.messages`. They cannot be included as conversation messages without reconstruction — which is exactly the problem we're eliminating.

**Design decision:** Cross-session segments are eligible for `summary` tier only. They contribute to `systemPromptAddition` but never inject messages into the conversation array.

This is the correct abstraction. Messages from a different session have broken tool pairings, missing context, and confusing role sequences. A summary like `[Prior context — Docker networking: Configured bridge network for container-to-container communication, resolved DNS resolution issue by switching to custom network]` gives the model everything it needs to pick up the thread. The full messages add risk for minimal value.

The `allocateBudgets()` function already handles this — cross-session segments with `sessionId` set are allocated to summary or excluded tiers. The change is to enforce this as a hard constraint rather than a budget-driven outcome. Note: `options` parameter to `allocateBudgets()` becomes required (it is already always passed by the plugin).

```typescript
// In allocateBudgets(): cross-session segments are capped at summary tier
if (seg.sessionId !== undefined && seg.sessionId !== opts.currentSessionId) {
  // Can only be summary or excluded, never full/partial
  if (seg.summary && seg.summaryTokens <= effectiveRemaining) {
    allocations.push({ segment: seg, tier: "summary", ... });
  } else {
    allocations.push({ segment: seg, tier: "excluded", ... });
  }
  continue;
}
```

#### 5. Partial segments preserve tool groups

When a segment gets partial-tier allocation (summary + recent messages), the current approach takes the N most recent messages by token count. This can split tool groups — including a `toolResult` without its parent assistant.

With index-based assembly, we avoid this by selecting messages in complete tool groups. A tool group is: one assistant message (containing `toolCall` blocks) + all immediately following `toolResult` messages.

The partial selection walks backward from the end of the segment and includes complete groups:

```typescript
function selectPartialIndices(
  indices: number[],
  messages: any[],  // params.messages for structure inspection
  tokenBudget: number,
  estimateTokensFn: (msg: any) => number
): number[] {
  const selected: number[] = [];
  let tokens = 0;
  let i = indices.length - 1;

  while (i >= 0) {
    const group: number[] = [];
    const role = messages[indices[i]]?.role;

    if (role === "toolResult") {
      // Collect all consecutive toolResults
      while (i >= 0 && messages[indices[i]]?.role === "toolResult") {
        group.unshift(indices[i]);
        i--;
      }
      // The parent assistant must be the next message back.
      // If it's not an assistant (segment boundary split the group),
      // drop the orphaned toolResults — they can't stand alone.
      if (i >= 0 && messages[indices[i]]?.role === "assistant") {
        group.unshift(indices[i]);
        i--;
      } else {
        // Orphaned toolResults at segment boundary — skip them
        continue;
      }
    } else {
      // Standalone user or assistant message
      group.push(indices[i]);
      i--;
    }

    const groupTokens = group.reduce(
      (sum, idx) => sum + estimateTokensFn(messages[idx]), 0
    );
    if (tokens + groupTokens > tokenBudget) break;

    selected.unshift(...group);
    tokens += groupTokens;
  }

  return selected;
}
```

### Index reconciliation on bootstrap

When a session is restored from a transcript (bootstrap), the segmenter has SimpleMessages with IDs but no `originalIndex` values. These are set on the first `assemble()` call when `params.messages` is available.

If an ID from the segmenter doesn't appear in `params.messages` (e.g., OpenClaw's sanitization dropped it), that message is treated as absent — it doesn't appear in the selection. The segment's token count may be slightly overstated, but this is benign.

If `params.messages` contains messages not tracked by any segment (e.g., system messages, or messages ingested after the last index persist), they pass through unchanged — included at their original position.

### Untracked messages

Not all messages in `params.messages` will be tracked by segments. These fall into categories:

- **System messages** — OpenClaw injects system prompts, metadata. Role is `system`, which `toSimpleMessage` filters out. Must be preserved.
- **Messages after the last ingest** — if assemble() is called before the latest message is ingested (race-free by contract, but possible on bootstrap). Must be preserved.
- **Messages the segmenter filtered** — tool-call-only assistants with no text content get placeholder SimpleMessages, so these are typically tracked. But if `toSimpleMessage` returned null (unknown role), the message is untracked. Must be preserved — they are valid AgentMessages that OpenClaw expects to see.

**Strategy:** All untracked messages are included. The reconciliation step (Section 1) builds `trackedOriginalIndices` — the set of `params.messages` positions claimed by segments. Everything not in that set is untracked and included at its original position.

```typescript
// After building selection from segments:
const selectedSet = new Set(plan.indices);
const untracked: number[] = [];
for (let i = 0; i < params.messages.length; i++) {
  if (!trackedOriginalIndices.has(i) && !selectedSet.has(i)) {
    untracked.push(i);
  }
}
// Merge and sort to maintain original ordering
const allIndices = [...plan.indices, ...untracked].sort((a, b) => a - b);
```

This is intentionally permissive. The assembler's job is to *exclude* low-relevance tracked messages, not to filter untracked ones. If an untracked message shouldn't be in context, that's OpenClaw's responsibility — Dendrite passes it through.

### Turn snapshots

The current `assemble()` builds `TurnSnapshotMessage[]` from the assembled `SimpleMessage` array for CLI peek inspection. With index-based assembly, snapshots are built from `params.messages` at the selected indices, using `extractTextContent()` to get preview text:

```typescript
const snapshotMessages: TurnSnapshotMessage[] = [];
for (const idx of allIndices) {
  const msg = params.messages[idx];
  if (msg.role === "system") continue;
  const text = extractTextContent(msg);
  // Find which segment this index belongs to
  const segId = indexToSegmentId.get(idx) ?? null;
  snapshotMessages.push({
    role: msg.role as "user" | "assistant" | "toolResult",
    segmentId: segId,
    tokenCount: estimateTokens(text),
    contentPreview: text.slice(0, 200),
    contentFull: text,
  });
}
```

The `indexToSegmentId` map is built during reconciliation — each tracked `originalIndex` maps to its segment's ID. Untracked messages get `segmentId: null`.

### dispose() lifecycle

`dispose()` remains a no-op. This change introduces no new resources that need cleanup.

## Error Handling

| Failure | Behavior |
|---------|----------|
| Message ID not found in params.messages | Skip that message in selection, log warning |
| Segment has no matched indices | Falls to summary or excluded tier naturally |
| params.messages shorter than expected | Reconcile with what's available, log mismatch |
| Cross-session segment without summary | Excluded (no summary = can't be summary tier) |
| Partial selection produces empty group | Skip that segment's messages, summary-only |
| All other errors | Unchanged from v2 (drift, embedding, summary failures) |

## File Changes

**Modified files:**
- `src/types.ts` — add `originalIndex?` to SimpleMessage
- `src/assembler.ts` — replace `buildMessageArray` with `buildSelectionPlan`, add `selectPartialIndices`, enforce cross-session summary-only
- `src/plugin.ts` — rewrite `assemble()` to use index-based selection, delete `toAgentMessage`, delete orphan repair code, add index reconciliation
- `src/segmenter.ts` — add `getMessage(id)` accessor for single message lookup

**Unchanged files:**
- `src/scorer.ts` — operates on Segment metadata
- `src/summarizer.ts` — generates text from SimpleMessage content
- `src/segment-pool.ts` — provides segments for scoring (cross-session segments become summary-only by assembler constraint, not pool change)
- `src/store.ts` — turn snapshot persistence
- `src/cli.ts` — CLI commands

**Deleted code (in modified files):**
- `toAgentMessage()` function (~12 lines)
- `AssembledMessage` interface
- Original-message lookup by timestamp+role (~28 lines)
- Orphaned tool-call stripping (~18 lines)
- Orphaned toolResult dropping (~16 lines)
- `buildMessageArray()` function (~95 lines)

**Net code change:** ~170 lines removed, ~130 lines added (reconciliation, selection plan, snapshot builder, partial group logic). Net reduction of ~40 lines, with significantly reduced complexity in the critical assembly path.

## Testing

- **Unit: buildSelectionPlan** — active/full/partial/summary/excluded tiers produce correct index lists
- **Unit: selectPartialIndices** — respects tool groups, doesn't split assistant+toolResult pairs
- **Unit: cross-session segments** — always summary or excluded, never full/partial
- **Unit: index reconciliation** — handles missing IDs, untracked messages, bootstrap state
- **Integration: full pipeline** — ingest messages, trigger drift, assemble, verify returned messages are identical objects from params.messages (reference equality)
- **Integration: tool groups** — multi-tool assistant turns survive assembly intact
- **Regression: consecutive role check** — assembled output never has consecutive same-role messages (the bug that motivated this rewrite)

## Migration

This is a non-breaking change from the perspective of OpenClaw's plugin API — `assemble()` still returns `{ messages, estimatedTokens, systemPromptAddition }`. Existing segment files, transcript entries, and turn snapshots remain valid.

The behavioral change is that cross-session segments can no longer be full/partial expanded. Any session that relied on seeing full messages from past sessions will see summaries instead. This is the intended improvement — those full messages were the source of tool-pairing errors.
