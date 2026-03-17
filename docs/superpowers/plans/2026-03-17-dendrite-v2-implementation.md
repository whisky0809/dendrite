# Dendrite v2 — Context Engine Plugin Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an OpenClaw context engine plugin that segments conversations by topic and assembles a relevance-driven context window each turn.

**Architecture:** A plugin implementing the `ContextEngine` interface from `openclaw/plugin-sdk`. Conversations are segmented by LLM-based drift detection. Each turn, `assemble()` scores segments for relevance and builds a message array that fits the token budget — most-relevant segments get full messages, less-relevant get summaries, irrelevant get nothing.

**Tech Stack:** TypeScript, OpenClaw plugin SDK types (imported as type-only), OpenRouter free models for drift/summary, Gemini embeddings for relevance scoring.

**Spec:** `docs/superpowers/specs/2026-03-17-dendrite-v2-context-engine-design.md`

**Deliberate simplifications (to revisit after v2.0 ships):**
- API calls use direct `fetch()` with `process.env` keys instead of `api.runtime`. This avoids an SDK dependency for v2.0. Can be upgraded to `api.runtime` once the plugin API stabilizes.
- `systemPromptAddition` is used for summary preambles. Verified: the `AssembleResult` type includes this optional field.
- Summary generation is capped at 1 per `assemble()` call to limit latency. Segments without summaries use fallback text until the next turn.

---

## File Structure

```
dendrite/                                 (repo root: /home/whisky/branching-conversations)
├── openclaw.plugin.json                  # NEW: plugin manifest
├── package.json                          # MODIFY: add openclaw.extensions entry, deps
├── tsconfig.json                         # MODIFY: adjust for plugin loading
├── src/
│   ├── types.ts                          # NEW: Segment, SegmentIndex, DendriteConfig, message helpers
│   ├── segmenter.ts                      # NEW: detectDrift(), segment lifecycle (create/close/split)
│   ├── scorer.ts                         # NEW: scoreSegments() — embedding similarity + recency
│   ├── summarizer.ts                     # NEW: generateSummary() — lazy LLM summary generation
│   ├── assembler.ts                      # NEW: assemble() — token budget allocation, message array builder
│   ├── plugin.ts                         # NEW: entry point — registerContextEngine, ContextEngine impl
│   ├── test-types.ts                     # NEW: tests for types module
│   ├── test-segmenter.ts                 # NEW: tests for segmenter
│   ├── test-scorer.ts                    # NEW: tests for scorer
│   ├── test-summarizer.ts               # NEW: tests for summarizer
│   ├── test-assembler.ts                 # NEW: tests for assembler
│   └── test-integration.ts              # NEW: full pipeline integration test
├── v1/                                   # MOVE: all existing v1 src/ files for reference
├── skills/
│   └── dendrite-inspect.md               # NEW: agent-facing inspection skill
└── docs/superpowers/specs/...            # existing
```

**Note on v1 code:** Existing `src/` files are moved to `v1/` for reference. The LLM drift detection prompt and JSON parsing from `v1/llm-drift-detector.ts` are extracted into the new `segmenter.ts` as a standalone function — no coupling to v1's `BranchNode` types.

**Note on OpenClaw types:** The `ContextEngine` interface, `AgentMessage`, `AssembleResult`, etc. are imported as type-only from the OpenClaw SDK. The actual SDK types live at:
- `openclaw/plugin-sdk/context-engine/types.js` — `ContextEngine`, `AssembleResult`, `CompactResult`, `IngestResult`
- `@mariozechner/pi-ai` — `UserMessage`, `AssistantMessage`, `ToolResultMessage`, `Message`
- `@mariozechner/pi-agent-core` — `AgentMessage`

**Key type reference (from OpenClaw SDK):**

```typescript
// The message types we receive in assemble() and ingest():
interface UserMessage { role: "user"; content: string | (TextContent | ImageContent)[]; timestamp: number; }
interface AssistantMessage { role: "assistant"; content: (TextContent | ThinkingContent | ToolCall)[]; /* ... */ timestamp: number; }
interface ToolResultMessage { role: "toolResult"; toolCallId: string; /* ... */ timestamp: number; }
type Message = UserMessage | AssistantMessage | ToolResultMessage;
type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

// The ContextEngine methods we implement:
ingest(params: { sessionId: string; message: AgentMessage; isHeartbeat?: boolean }): Promise<IngestResult>;
assemble(params: { sessionId: string; messages: AgentMessage[]; tokenBudget?: number }): Promise<AssembleResult>;
compact(params: { sessionId: string; sessionFile: string; tokenBudget?: number; force?: boolean; /* ... */ }): Promise<CompactResult>;
bootstrap?(params: { sessionId: string; sessionFile: string }): Promise<BootstrapResult>;
```

---

## Chunk 1: Project Setup + Types

### Task 1: Move v1 code and restructure project

**Files:**
- Move: all `src/*.ts` files → `v1/`
- Modify: `package.json`
- Create: `openclaw.plugin.json`

- [ ] **Step 1: Move v1 source files to v1/ directory**

```bash
mkdir -p v1
git mv src/types.ts src/branch-tree.ts src/drift-detector.ts src/llm-drift-detector.ts \
  src/tokenizer.ts src/context-composer.ts src/session-adapter.ts src/state.ts \
  src/index.ts src/test.ts src/demo.ts src/demo-auto.ts src/demo-llm.ts \
  src/validate-sessions.ts src/inspect.ts v1/
```

- [ ] **Step 2: Move v1 hooks to v1/**

```bash
git mv hooks v1/hooks
```

- [ ] **Step 3: Create plugin manifest**

Create `openclaw.plugin.json`:

```json
{
  "id": "dendrite",
  "name": "Dendrite",
  "kind": "context-engine",
  "description": "Topic-aware context assembly — viewport, not container",
  "configSchema": {
    "type": "object",
    "properties": {
      "driftModel": { "type": "string", "default": "openrouter/hunter-alpha" },
      "summaryModel": { "type": "string", "default": "minimax/minimax-m2.5:free" },
      "embeddingModel": { "type": "string", "default": "gemini-embedding-001" },
      "driftThreshold": { "type": "number", "default": 0.7 },
      "minMessagesBeforeDrift": { "type": "integer", "default": 3 },
      "relevanceAlpha": { "type": "number", "default": 0.7 },
      "reserveTokens": { "type": "integer", "default": 8192 },
      "maxSegmentMessages": { "type": "integer", "default": 80 },
      "queryWindowSize": { "type": "integer", "default": 5 }
    }
  }
}
```

- [ ] **Step 4: Update package.json**

```json
{
  "name": "dendrite",
  "version": "2.0.0",
  "description": "Topic-aware context engine plugin for OpenClaw",
  "type": "module",
  "openclaw": {
    "extensions": ["./src/plugin.ts"]
  },
  "scripts": {
    "build": "tsc --noEmit",
    "test": "tsx src/test-types.ts && tsx src/test-segmenter.ts && tsx src/test-scorer.ts && tsx src/test-summarizer.ts && tsx src/test-assembler.ts",
    "test:integration": "tsx src/test-integration.ts",
    "test:all": "npm test && npm run test:integration"
  },
  "devDependencies": {
    "@types/node": "^25.5.0",
    "tsx": "^4.21.0",
    "typescript": "^5.9.3"
  }
}
```

Key changes: `type: "module"` (OpenClaw plugins are ESM), `openclaw.extensions` field, `tsc --noEmit` for type checking only (jiti loads TS directly), version bump to 2.0.0.

- [ ] **Step 5: Update tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "declaration": true,
    "sourceMap": true,
    "skipLibCheck": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "v1"]
}
```

Added `skipLibCheck` and excluded `v1/`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: restructure for v2 — move v1 to v1/, add plugin manifest"
```

---

### Task 2: Core types

**Files:**
- Create: `src/types.ts`
- Test: `src/test-types.ts`

- [ ] **Step 1: Write tests for types and helpers**

Create `src/test-types.ts`:

```typescript
import { createSegment, estimateTokens, extractTextContent, isUserMessage } from "./types.js";

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

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/test-types.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write types implementation**

Create `src/types.ts`:

```typescript
/**
 * Dendrite v2 types.
 *
 * We define our own lightweight message types for internal use.
 * The plugin.ts entry point handles conversion to/from AgentMessage.
 */

import { randomUUID } from "node:crypto";

// ── Segment ──

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
}

export interface SegmentIndex {
  version: 1;
  segments: Segment[];
}

export function createSegment(topic: string): Segment {
  return {
    id: `seg_${randomUUID().slice(0, 12)}`,
    topic,
    embedding: [],
    messageIds: [],
    messageCount: 0,
    tokenCount: 0,
    summary: null,
    summaryTokens: 0,
    lastActiveAt: Date.now(),
    status: "active",
  };
}

// ── Config ──

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
}

export const DEFAULT_CONFIG: DendriteConfig = {
  driftModel: "openrouter/hunter-alpha",
  summaryModel: "minimax/minimax-m2.5:free",
  embeddingModel: "gemini-embedding-001",
  driftThreshold: 0.7,
  minMessagesBeforeDrift: 3,
  relevanceAlpha: 0.7,
  reserveTokens: 8192,
  maxSegmentMessages: 80,
  queryWindowSize: 5,
};

// ── Message helpers ──

// Lightweight message representation for internal use.
// plugin.ts converts AgentMessage <-> SimpleMessage at the boundary.

export interface SimpleMessage {
  id: string;
  role: "user" | "assistant" | "toolResult";
  content: string;
  timestamp: number;
}

/** Estimate tokens from a string using chars/4 heuristic. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Extract plain text from a message (handles both string and array content).
 * Works with UserMessage, AssistantMessage, and ToolResultMessage shapes.
 */
export function extractTextContent(msg: { role: string; content: unknown }): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((block: any) => block.type === "text")
      .map((block: any) => block.text)
      .join("");
  }
  return "";
}

/** Check if a message is a user message. */
export function isUserMessage(msg: { role: string }): boolean {
  return msg.role === "user";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx src/test-types.ts`
Expected: all assertions pass

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/test-types.ts
git commit -m "feat(v2): core types — Segment, SegmentIndex, DendriteConfig, message helpers"
```

---

## Chunk 2: Segmenter — Drift Detection + Segment Lifecycle

### Task 3: Drift detection function

**Files:**
- Create: `src/segmenter.ts`
- Test: `src/test-segmenter.ts`
- Reference: `v1/llm-drift-detector.ts` (lines 125-198 — prompt construction and response parsing)

The segmenter extracts the LLM prompt logic from v1's `LLMDriftDetector` into standalone functions. No dependency on v1 types.

- [ ] **Step 1: Write tests for drift detection**

Create `src/test-segmenter.ts`:

```typescript
import {
  parseDriftResponse,
  buildDriftPrompt,
  Segmenter,
} from "./segmenter.js";
import { createSegment, type SimpleMessage } from "./types.js";

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}

console.log("=== Segmenter ===\n");

// parseDriftResponse — valid JSON
console.log("  parseDriftResponse:");
const validJson = JSON.stringify({
  classification: "tangent",
  confidence: 0.9,
  suggested_topic: "docker-networking",
  reasoning: "shifted to Docker"
});
const result = parseDriftResponse(validJson);
assert(result.classification === "tangent", "valid JSON: classification");
assert(result.confidence === 0.9, "valid JSON: confidence");
assert(result.suggested_topic === "docker-networking", "valid JSON: topic");

// parseDriftResponse — JSON in code fence
const fenced = "```json\n" + validJson + "\n```";
const fencedResult = parseDriftResponse(fenced);
assert(fencedResult.classification === "tangent", "fenced JSON: classification");

// parseDriftResponse — garbage fallback
const garbage = "I think this is on topic because reasons";
const garbageResult = parseDriftResponse(garbage);
assert(garbageResult.classification === "on_topic", "garbage: defaults to on_topic");
assert(garbageResult.confidence === 0.4, "garbage: low confidence");

// parseDriftResponse — text with keyword
const tangentText = "This is clearly a tangent about something else";
const tangentResult = parseDriftResponse(tangentText);
assert(tangentResult.classification === "tangent", "keyword detection: tangent");

// buildDriftPrompt
console.log("\n  buildDriftPrompt:");
const messages: SimpleMessage[] = [
  { id: "1", role: "user", content: "Let's design the REST API", timestamp: 1 },
  { id: "2", role: "assistant", content: "Sure, let's start with endpoints", timestamp: 2 },
];
const { system, user } = buildDriftPrompt(messages, "How does Docker networking work?");
assert(system.includes("on_topic"), "prompt: system mentions on_topic");
assert(system.includes("tangent"), "prompt: system mentions tangent");
assert(user.includes("REST API"), "prompt: user includes conversation");
assert(user.includes("Docker networking"), "prompt: user includes new message");

// Segmenter — segment lifecycle
console.log("\n  Segmenter lifecycle:");
const segmenter = new Segmenter({
  minMessagesBeforeDrift: 3,
  maxSegmentMessages: 5,
  driftThreshold: 0.7,
});

// Cold start — creates first segment
const msg1: SimpleMessage = { id: "m1", role: "user", content: "Hello", timestamp: 1 };
const result1 = segmenter.addMessage(msg1);
assert(result1.action === "added", "cold start: action is added");
assert(segmenter.segments.length === 1, "cold start: one segment");
assert(segmenter.activeSegment!.topic === "conversation", "cold start: default topic");

// Below min messages — no drift detection needed
const msg2: SimpleMessage = { id: "m2", role: "assistant", content: "Hi there", timestamp: 2 };
const result2 = segmenter.addMessage(msg2);
assert(result2.action === "added", "below min: action is added");
assert(result2.needsDriftCheck === false, "below min: no drift check needed");

const msg3: SimpleMessage = { id: "m3", role: "user", content: "Another message", timestamp: 3 };
const result3 = segmenter.addMessage(msg3);
assert(result3.needsDriftCheck === false, "at min: still no drift check (3 msgs = min)");

// Above min messages — needs drift check
const msg4: SimpleMessage = { id: "m4", role: "user", content: "Something new", timestamp: 4 };
const result4 = segmenter.addMessage(msg4);
assert(result4.needsDriftCheck === true, "above min: needs drift check");

// Force split on max segment size
const msg5: SimpleMessage = { id: "m5", role: "user", content: "Msg 5", timestamp: 5 };
segmenter.addMessage(msg5); // 5th message, hits maxSegmentMessages
const msg6: SimpleMessage = { id: "m6", role: "user", content: "Msg 6", timestamp: 6 };
const result6 = segmenter.addMessage(msg6);
assert(result6.action === "force-split", "max size: force split");
assert(segmenter.segments.length === 2, "max size: two segments");

// loadIndex / toIndex round-trip
console.log("\n  Segmenter serialization:");
const segRT = new Segmenter({ minMessagesBeforeDrift: 3, maxSegmentMessages: 100, driftThreshold: 0.7 });
const rtMsg1: SimpleMessage = { id: "rt1", role: "user", content: "Round trip 1", timestamp: 100 };
const rtMsg2: SimpleMessage = { id: "rt2", role: "assistant", content: "Round trip 2", timestamp: 200 };
segRT.addMessage(rtMsg1);
segRT.addMessage(rtMsg2);
const exported = segRT.toIndex();
assert(exported.version === 1, "toIndex: version is 1");
assert(exported.segments.length === 1, "toIndex: one segment");

// Restore into a fresh Segmenter
const segRT2 = new Segmenter({ minMessagesBeforeDrift: 3, maxSegmentMessages: 100, driftThreshold: 0.7 });
segRT2.loadIndex(exported, [rtMsg1, rtMsg2]);
assert(segRT2.segments.length === 1, "loadIndex: one segment restored");
assert(segRT2.activeSegment!.messageIds.includes("rt1"), "loadIndex: message IDs preserved");
assert(segRT2.getMessages(["rt1"])[0].content === "Round trip 1", "loadIndex: message store restored");

// Close segment and open new one
console.log("\n  Segmenter split:");
const seg2 = new Segmenter({ minMessagesBeforeDrift: 2, maxSegmentMessages: 100, driftThreshold: 0.7 });
seg2.addMessage({ id: "a1", role: "user", content: "REST API", timestamp: 1 });
seg2.addMessage({ id: "a2", role: "assistant", content: "Sure", timestamp: 2 });
seg2.addMessage({ id: "a3", role: "user", content: "Docker?", timestamp: 3 });
seg2.splitOnDrift("docker-networking");
assert(seg2.segments.length === 2, "split: two segments");
assert(seg2.segments[0].status === "closed", "split: first segment closed");
assert(seg2.activeSegment!.topic === "docker-networking", "split: new topic set");
assert(seg2.activeSegment!.messageIds.includes("a3"), "split: new message moved to new segment");

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/test-segmenter.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write segmenter implementation**

Create `src/segmenter.ts`. Key functions:

- `buildDriftPrompt(messages, newMessage)` — constructs system + user prompts for the LLM (extracted from v1 `llm-drift-detector.ts` lines 125-149)
- `parseDriftResponse(raw)` — parses LLM JSON response with fallback (extracted from v1 lines 181-198)
- `callDriftModel(prompt, model)` — makes the HTTP request to OpenRouter
- `Segmenter` class — manages segment lifecycle:
  - `addMessage(msg)` — adds message to active segment, returns whether drift check is needed
  - `splitOnDrift(topic)` — closes active segment, opens new one with given topic
  - `getRecentMessages(n)` — returns last N messages from active segment for drift prompt
  - `segments` / `activeSegment` — state accessors
  - `loadIndex(index)` / `toIndex()` — serialize/deserialize

```typescript
import { createSegment, estimateTokens, type Segment, type SegmentIndex, type SimpleMessage, type DendriteConfig } from "./types.js";

// ── Drift detection prompt (extracted from v1 llm-drift-detector.ts) ──

export interface DriftVerdict {
  classification: "on_topic" | "tangent" | "uncertain";
  confidence: number;
  suggested_topic: string;
  reasoning: string;
}

export function buildDriftPrompt(
  recentMessages: SimpleMessage[],
  newMessage: string
): { system: string; user: string } {
  // Prompt faithfully extracted from v1 llm-drift-detector.ts (lines 125-141),
  // validated against 14/14 real Atlas session boundaries.
  const system = `You are a conversation topic analyzer. Your job is to determine whether a new message continues the current conversation topic or diverges into a tangent that would benefit from a separate context.

Respond with ONLY a JSON object (no markdown, no code fences):
{
  "classification": "on_topic" or "tangent" or "uncertain",
  "confidence": 0.0 to 1.0,
  "suggested_topic": "short-topic-name if tangent, empty string if on_topic",
  "reasoning": "brief one-sentence explanation"
}

Rules:
- "on_topic": The message deepens, continues, or directly relates to the current discussion
- "tangent": The message shifts to a substantially different subject that would need different context to answer well
- "uncertain": Could go either way
- A question that RELATES to the current topic (e.g., asking about a dependency of what's being discussed) is still on_topic
- Phrases like "wait", "actually", "btw", "by the way" are hints but not proof of tangent — check if the actual content is related
- Be conservative: only classify as "tangent" when the topic genuinely shifts`;

  const history = recentMessages
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  const user = `Current conversation:\n${history}\n\nNew message:\nuser: ${newMessage}\n\nIs this new message on-topic or a tangent?`;

  return { system, user };
}

export function parseDriftResponse(raw: string): DriftVerdict {
  // Strip code fences (v1-style aggressive approach for robustness)
  let cleaned = raw.replace(/```json?\s*/g, "").replace(/```\s*/g, "").trim();

  try {
    const parsed = JSON.parse(cleaned);
    return {
      classification: parsed.classification || "on_topic",
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      suggested_topic: parsed.suggested_topic || "",
      reasoning: parsed.reasoning || "",
    };
  } catch {
    // Fallback: keyword detection
    const lower = raw.toLowerCase();
    if (lower.includes("tangent")) {
      return { classification: "tangent", confidence: 0.4, suggested_topic: "", reasoning: raw.slice(0, 100) };
    }
    return { classification: "on_topic", confidence: 0.4, suggested_topic: "", reasoning: raw.slice(0, 100) };
  }
}

export async function callDriftModel(
  system: string,
  user: string,
  model: string
): Promise<DriftVerdict> {
  const apiKey = process.env.OPENROUTER_API_KEY || "";
  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: 200,
      temperature: 0.1,
    }),
  });

  if (!resp.ok) {
    throw new Error(`Drift model error: ${resp.status} ${resp.statusText}`);
  }

  const data = (await resp.json()) as any;
  const content = data.choices?.[0]?.message?.content || "";
  return parseDriftResponse(content);
}

// ── Segmenter class ──

export interface AddMessageResult {
  action: "added" | "force-split";
  needsDriftCheck: boolean;
  /** The message that needs a drift check (only set when needsDriftCheck=true) */
  pendingMessage?: SimpleMessage;
}

interface SegmenterOptions {
  minMessagesBeforeDrift: number;
  maxSegmentMessages: number;
  driftThreshold: number;
}

export class Segmenter {
  segments: Segment[] = [];
  /** All messages indexed by ID for retrieval */
  private messageStore = new Map<string, SimpleMessage>();

  private opts: SegmenterOptions;

  constructor(opts: SegmenterOptions) {
    this.opts = opts;
  }

  get activeSegment(): Segment | null {
    return this.segments.find((s) => s.status === "active") || null;
  }

  /** Add a message. Returns whether the caller needs to run drift detection. */
  addMessage(msg: SimpleMessage): AddMessageResult {
    this.messageStore.set(msg.id, msg);

    // Cold start
    if (this.segments.length === 0) {
      const seg = createSegment("conversation");
      seg.messageIds.push(msg.id);
      seg.messageCount = 1;
      seg.tokenCount += estimateTokens(msg.content);
      seg.lastActiveAt = msg.timestamp;
      this.segments.push(seg);
      return { action: "added", needsDriftCheck: false };
    }

    const active = this.activeSegment!;

    // Force split if max size exceeded
    if (active.messageCount >= this.opts.maxSegmentMessages) {
      active.status = "closed";
      const newSeg = createSegment(active.topic);
      newSeg.messageIds.push(msg.id);
      newSeg.messageCount = 1;
      newSeg.tokenCount = estimateTokens(msg.content);
      newSeg.lastActiveAt = msg.timestamp;
      this.segments.push(newSeg);
      return { action: "force-split", needsDriftCheck: false };
    }

    // Add to active segment
    active.messageIds.push(msg.id);
    active.messageCount++;
    active.tokenCount += estimateTokens(msg.content);
    active.lastActiveAt = msg.timestamp;

    // Check if drift detection is needed
    const needsDriftCheck =
      msg.role === "user" &&
      active.messageCount > this.opts.minMessagesBeforeDrift;

    return {
      action: "added",
      needsDriftCheck,
      pendingMessage: needsDriftCheck ? msg : undefined,
    };
  }

  /** Split the active segment: close it, move the last message to a new segment with given topic. */
  splitOnDrift(topic: string): void {
    const active = this.activeSegment;
    if (!active || active.messageCount === 0) return;

    // The last message (the one that triggered drift) moves to the new segment
    const lastMsgId = active.messageIds.pop()!;
    const lastMsg = this.messageStore.get(lastMsgId);
    active.messageCount--;
    if (lastMsg) active.tokenCount -= estimateTokens(lastMsg.content);
    active.status = "closed";

    const newSeg = createSegment(topic);
    newSeg.messageIds.push(lastMsgId);
    newSeg.messageCount = 1;
    newSeg.tokenCount = lastMsg ? estimateTokens(lastMsg.content) : 0;
    newSeg.lastActiveAt = lastMsg?.timestamp || Date.now();
    this.segments.push(newSeg);
  }

  /** Get recent messages from the active segment for building the drift prompt. */
  getRecentMessages(n: number): SimpleMessage[] {
    const active = this.activeSegment;
    if (!active) return [];
    const ids = active.messageIds.slice(-n);
    return ids
      .map((id) => this.messageStore.get(id))
      .filter((m): m is SimpleMessage => m !== undefined);
  }

  /** Get messages by IDs (for assembler). */
  getMessages(ids: string[]): SimpleMessage[] {
    return ids
      .map((id) => this.messageStore.get(id))
      .filter((m): m is SimpleMessage => m !== undefined);
  }

  /** Load from a persisted SegmentIndex. */
  loadIndex(index: SegmentIndex, messages: SimpleMessage[]): void {
    this.segments = index.segments;
    this.messageStore.clear();
    for (const msg of messages) {
      this.messageStore.set(msg.id, msg);
    }
  }

  /** Export current state as a SegmentIndex. */
  toIndex(): SegmentIndex {
    return { version: 1, segments: this.segments };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx src/test-segmenter.ts`
Expected: all assertions pass

- [ ] **Step 5: Commit**

```bash
git add src/segmenter.ts src/test-segmenter.ts
git commit -m "feat(v2): segmenter — drift detection prompts, segment lifecycle"
```

---

## Chunk 3: Scorer — Relevance Scoring

### Task 4: Relevance scoring with embeddings + recency

**Files:**
- Create: `src/scorer.ts`
- Test: `src/test-scorer.ts`

- [ ] **Step 1: Write tests for scorer**

Create `src/test-scorer.ts`:

```typescript
import { cosineSimilarity, recencyScore, scoreSegments, type ScoredSegment } from "./scorer.js";
import { createSegment } from "./types.js";

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}
function assertApprox(actual: number, expected: number, tolerance: number, name: string) {
  assert(Math.abs(actual - expected) <= tolerance, `${name} (${actual.toFixed(3)} ≈ ${expected})`);
}

console.log("=== Scorer ===\n");

// cosineSimilarity
console.log("  cosineSimilarity:");
assertApprox(cosineSimilarity([1, 0], [1, 0]), 1.0, 0.01, "identical vectors");
assertApprox(cosineSimilarity([1, 0], [0, 1]), 0.0, 0.01, "orthogonal vectors");
assertApprox(cosineSimilarity([1, 0], [-1, 0]), -1.0, 0.01, "opposite vectors");
assertApprox(cosineSimilarity([], []), 0.0, 0.01, "empty vectors");
assertApprox(cosineSimilarity([3, 4], [3, 4]), 1.0, 0.01, "scaled identical");

// recencyScore
console.log("\n  recencyScore:");
assertApprox(recencyScore(0), 1.0, 0.01, "0 turns ago = 1.0");
assertApprox(recencyScore(10), 0.5, 0.05, "10 turns ago ≈ 0.5");
assert(recencyScore(100) < 0.01, "100 turns ago ≈ 0");
assert(recencyScore(5) > recencyScore(20), "more recent > less recent");

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

const queryEmbedding = [1, 0, 0]; // most similar to segA
const totalTurns = 20;

const scored = scoreSegments(
  [segA, segB, segC],
  queryEmbedding,
  totalTurns,
  0.7 // alpha
);

// Active segment should always be first (highest score)
assert(scored[0].segment.status === "active", "active segment ranked first");

// segA should rank higher than segB (more similar to query)
const scoreA = scored.find(s => s.segment.id === segA.id)!.score;
const scoreB = scored.find(s => s.segment.id === segB.id)!.score;
assert(scoreA > scoreB, "semantically similar segment scores higher");

// All scores between 0 and 1
assert(scored.every(s => s.score >= 0 && s.score <= 1), "all scores in [0, 1]");

// Recency-only fallback (alpha = 0)
console.log("\n  recency-only fallback:");
const recencyOnly = scoreSegments([segA, segB], queryEmbedding, totalTurns, 0);
assert(recencyOnly[0].segment.id === segA.id, "recency-only: more recent first");

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/test-scorer.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write scorer implementation**

Create `src/scorer.ts`:

```typescript
import type { Segment } from "./types.js";

export interface ScoredSegment {
  segment: Segment;
  score: number;
  semanticScore: number;
  recencyScoreValue: number;
}

/** Cosine similarity between two vectors. Returns 0 for empty/zero vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Recency score: exponential decay based on turns since segment was last active.
 * Returns 1.0 for the most recent, decaying toward 0.
 * Half-life of ~10 turns.
 */
export function recencyScore(turnsSinceActive: number): number {
  const halfLife = 10;
  return Math.pow(0.5, turnsSinceActive / halfLife);
}

/**
 * Score all segments for relevance.
 *
 * Active segment always gets score 1.0 (Infinity priority).
 * Others scored by: alpha * semantic + (1-alpha) * recency.
 *
 * Returns sorted array, highest score first.
 */
export function scoreSegments(
  segments: Segment[],
  queryEmbedding: number[],
  totalTurns: number,
  alpha: number
): ScoredSegment[] {
  const scored: ScoredSegment[] = segments.map((segment) => {
    // Active segment always wins
    if (segment.status === "active") {
      return { segment, score: 1.0, semanticScore: 1.0, recencyScoreValue: 1.0 };
    }

    const semantic = segment.embedding.length > 0
      ? Math.max(0, cosineSimilarity(segment.embedding, queryEmbedding))
      : 0;

    // Calculate turns since last active using actual timestamps.
    // We estimate the average turn duration from totalTurns and the time span,
    // then derive turnsSince from the segment's lastActiveAt.
    const now = Date.now();
    const oldestSegment = segments.reduce((oldest, s) =>
      s.lastActiveAt < oldest.lastActiveAt ? s : oldest, segments[0]);
    const timeSpan = now - oldestSegment.lastActiveAt;
    const avgTurnDuration = totalTurns > 1 ? timeSpan / totalTurns : 60000; // fallback: 1 min
    const timeSinceActive = now - segment.lastActiveAt;
    const turnsSince = avgTurnDuration > 0 ? timeSinceActive / avgTurnDuration : 0;

    const recency = recencyScore(turnsSince);

    const score = alpha * semantic + (1 - alpha) * recency;

    return { segment, score, semanticScore: semantic, recencyScoreValue: recency };
  });

  // Sort: active first, then by score descending
  scored.sort((a, b) => {
    if (a.segment.status === "active") return -1;
    if (b.segment.status === "active") return 1;
    return b.score - a.score;
  });

  return scored;
}

/**
 * Call embedding model to get a vector for the given text.
 * Falls back to empty vector on failure.
 */
export async function getEmbedding(text: string, model: string): Promise<number[]> {
  const apiKey = process.env.GEMINI_API_KEY || "";
  if (!apiKey) return [];

  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: `models/${model}`,
          content: { parts: [{ text }] },
        }),
      }
    );

    if (!resp.ok) return [];
    const data = (await resp.json()) as any;
    return data.embedding?.values || [];
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx src/test-scorer.ts`
Expected: all assertions pass

- [ ] **Step 5: Commit**

```bash
git add src/scorer.ts src/test-scorer.ts
git commit -m "feat(v2): scorer — cosine similarity, recency decay, segment ranking"
```

---

## Chunk 4: Summarizer + Assembler

### Task 5: Lazy summary generation

**Files:**
- Create: `src/summarizer.ts`
- Test: `src/test-summarizer.ts`

- [ ] **Step 1: Write tests for summarizer**

Create `src/test-summarizer.ts`:

```typescript
import { buildSummaryPrompt, parseSummaryResponse, fallbackSummary } from "./summarizer.js";
import type { SimpleMessage } from "./types.js";

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}

console.log("=== Summarizer ===\n");

// buildSummaryPrompt
const messages: SimpleMessage[] = [
  { id: "1", role: "user", content: "Let's design a REST API", timestamp: 1 },
  { id: "2", role: "assistant", content: "Sure, starting with user endpoints", timestamp: 2 },
  { id: "3", role: "user", content: "We should use JWT for auth", timestamp: 3 },
  { id: "4", role: "assistant", content: "Agreed, JWT with 15min expiry", timestamp: 4 },
];

const prompt = buildSummaryPrompt("REST API design", messages);
assert(prompt.system.includes("summarize"), "prompt: system says summarize");
assert(prompt.user.includes("REST API"), "prompt: includes conversation content");
assert(prompt.user.includes("JWT"), "prompt: includes key decision");

// parseSummaryResponse
const goodResponse = "Discussed REST API design. Decided on JWT auth with 15-minute token expiry. Still need to define user endpoints and error handling.";
const summary = parseSummaryResponse(goodResponse);
assert(summary.length > 0, "parseSummaryResponse: non-empty");
assert(summary.length < 500, "parseSummaryResponse: reasonably short");

// parseSummaryResponse — strips code fences
const fenced = "```\nSome summary text here\n```";
assert(parseSummaryResponse(fenced) === "Some summary text here", "parseSummaryResponse: strips fences");

// fallbackSummary
const fallback = fallbackSummary("Docker networking", 12);
assert(fallback.includes("Docker networking"), "fallbackSummary: includes topic");
assert(fallback.includes("12"), "fallbackSummary: includes message count");

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/test-summarizer.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write summarizer implementation**

Create `src/summarizer.ts`:

```typescript
import type { SimpleMessage } from "./types.js";

export function buildSummaryPrompt(
  topic: string,
  messages: SimpleMessage[]
): { system: string; user: string } {
  const system = `You summarize conversation segments concisely. Include:
- Topic and what was discussed
- Key decisions made
- Open questions or unfinished items
- Any code or technical artifacts referenced

Keep it under 150 words. Write in plain text, no markdown headers.`;

  const conversation = messages
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  const user = `Summarize this conversation segment about "${topic}":\n\n${conversation}`;

  return { system, user };
}

export function parseSummaryResponse(raw: string): string {
  return raw
    .replace(/^```(?:\w+)?\s*/m, "")
    .replace(/\s*```\s*$/m, "")
    .trim();
}

export function fallbackSummary(topic: string, messageCount: number): string {
  return `${topic}: ~${messageCount} messages, summary unavailable`;
}

export async function callSummaryModel(
  system: string,
  user: string,
  model: string
): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY || "";
  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: 300,
      temperature: 0.2,
    }),
  });

  if (!resp.ok) {
    throw new Error(`Summary model error: ${resp.status} ${resp.statusText}`);
  }

  const data = (await resp.json()) as any;
  return parseSummaryResponse(data.choices?.[0]?.message?.content || "");
}

/**
 * Generate a summary for a segment. Handles errors with fallback.
 */
export async function generateSummary(
  topic: string,
  messages: SimpleMessage[],
  model: string
): Promise<string> {
  try {
    const { system, user } = buildSummaryPrompt(topic, messages);
    return await callSummaryModel(system, user, model);
  } catch {
    return fallbackSummary(topic, messages.length);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx src/test-summarizer.ts`
Expected: all assertions pass

- [ ] **Step 5: Commit**

```bash
git add src/summarizer.ts src/test-summarizer.ts
git commit -m "feat(v2): summarizer — lazy summary generation with LLM"
```

---

### Task 6: Assembler — token budget allocation and message array construction

**Files:**
- Create: `src/assembler.ts`
- Test: `src/test-assembler.ts`

- [ ] **Step 1: Write tests for assembler**

Create `src/test-assembler.ts`:

```typescript
import { allocateBudgets, buildMessageArray, type BudgetAllocation } from "./assembler.js";
import { createSegment, type SimpleMessage } from "./types.js";
import type { ScoredSegment } from "./scorer.js";

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}

console.log("=== Assembler ===\n");

// ── allocateBudgets ──
console.log("  allocateBudgets:");

const activeSeg = createSegment("active-topic");
activeSeg.tokenCount = 500;
activeSeg.status = "active";

const closedA = createSegment("topic-a");
closedA.tokenCount = 1000;
closedA.status = "closed";
closedA.summary = "Summary of topic A discussion.";
closedA.summaryTokens = 20;

const closedB = createSegment("topic-b");
closedB.tokenCount = 800;
closedB.status = "closed";
closedB.summary = "Summary of topic B discussion.";
closedB.summaryTokens = 18;

const closedC = createSegment("topic-c");
closedC.tokenCount = 2000;
closedC.status = "closed";
closedC.summary = null; // no summary yet

const scored: ScoredSegment[] = [
  { segment: activeSeg, score: 1.0, semanticScore: 1, recencyScoreValue: 1 },
  { segment: closedA, score: 0.8, semanticScore: 0.9, recencyScoreValue: 0.5 },
  { segment: closedB, score: 0.5, semanticScore: 0.4, recencyScoreValue: 0.7 },
  { segment: closedC, score: 0.1, semanticScore: 0.05, recencyScoreValue: 0.2 },
];

// Plenty of budget — everything fits fully
const budgetLarge = allocateBudgets(scored, 10000, 2000);
assert(budgetLarge[0].tier === "active", "large budget: active segment is active tier");
assert(budgetLarge[1].tier === "full", "large budget: high-relevance gets full");
assert(budgetLarge[2].tier === "full", "large budget: medium-relevance gets full (budget available)");

// Tight budget — forces compression
const budgetTight = allocateBudgets(scored, 1000, 500);
assert(budgetTight[0].tier === "active", "tight budget: active still active");
const tiers = budgetTight.map(b => b.tier);
assert(tiers.includes("summary") || tiers.includes("excluded"), "tight budget: some segments compressed");

// Very tight — active segment truncated
const budgetTiny = allocateBudgets(scored, 200, 100);
assert(budgetTiny[0].tier === "active", "tiny budget: active tier present");
assert(budgetTiny[0].allocatedTokens <= 200, "tiny budget: active respects budget");

// ── buildMessageArray ──
console.log("\n  buildMessageArray:");

const messages: Map<string, SimpleMessage> = new Map();
const msgA1: SimpleMessage = { id: "a1", role: "user", content: "Hello about topic A", timestamp: 1 };
const msgA2: SimpleMessage = { id: "a2", role: "assistant", content: "Sure, topic A response", timestamp: 2 };
const msgActive1: SimpleMessage = { id: "act1", role: "user", content: "Active topic message", timestamp: 3 };
messages.set("a1", msgA1);
messages.set("a2", msgA2);
messages.set("act1", msgActive1);

activeSeg.messageIds = ["act1"];
closedA.messageIds = ["a1", "a2"];

const allocations: BudgetAllocation[] = [
  { segment: activeSeg, tier: "active", allocatedTokens: 500, scored: scored[0] },
  { segment: closedA, tier: "summary", allocatedTokens: 20, scored: scored[1] },
];

const result = buildMessageArray(allocations, (ids) =>
  ids.map(id => messages.get(id)!).filter(Boolean)
);

// Should have a preamble system message + active messages
assert(result.length >= 2, "buildMessageArray: has preamble + active messages");

// First message should be the system preamble with summaries
const preamble = result[0];
assert(preamble.role === "system", "buildMessageArray: first message is system role");
assert(typeof preamble.content === "string" && preamble.content.includes("topic-a"), "buildMessageArray: preamble includes topic-a summary");

// Active messages should be present
const activeMessages = result.filter(m => m.role === "user" && typeof m.content === "string" && m.content.includes("Active topic"));
assert(activeMessages.length === 1, "buildMessageArray: active messages included");

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/test-assembler.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write assembler implementation**

Create `src/assembler.ts`:

```typescript
import type { Segment, SimpleMessage } from "./types.js";
import { estimateTokens } from "./types.js";
import type { ScoredSegment } from "./scorer.js";

export type Tier = "active" | "full" | "partial" | "summary" | "excluded";

export interface BudgetAllocation {
  segment: Segment;
  tier: Tier;
  allocatedTokens: number;
  scored: ScoredSegment;
}

/**
 * Allocate token budgets to scored segments.
 *
 * The caller should pass `totalBudget` as `contextWindow - reserveTokens`.
 * `reserveTokens` is the guaranteed floor for the active segment.
 * Active segment gets at least `reserveTokens` worth of its most recent messages.
 * Other segments compete for the remaining budget after the active segment.
 */
export function allocateBudgets(
  scored: ScoredSegment[],
  totalBudget: number,
  reserveTokens: number
): BudgetAllocation[] {
  const allocations: BudgetAllocation[] = [];

  // Active segment gets reserveTokens as a guaranteed floor, plus any
  // additional budget needed (up to its full size)
  const activeBudget = totalBudget + reserveTokens; // total available for active
  let remaining = totalBudget; // remaining for non-active segments

  for (const entry of scored) {
    const seg = entry.segment;

    if (seg.status === "active") {
      // Active segment: guaranteed at least reserveTokens, up to full size
      const tokens = Math.min(seg.tokenCount, activeBudget);
      // Any tokens beyond reserveTokens come from the shared budget
      const sharedUsed = Math.max(0, tokens - reserveTokens);
      remaining -= sharedUsed;
      allocations.push({ segment: seg, tier: "active", allocatedTokens: tokens, scored: entry });
      continue;
    }

    if (remaining <= 0) {
      allocations.push({ segment: seg, tier: "excluded", allocatedTokens: 0, scored: entry });
      continue;
    }

    // Try full expansion
    if (seg.tokenCount <= remaining) {
      allocations.push({ segment: seg, tier: "full", allocatedTokens: seg.tokenCount, scored: entry });
      remaining -= seg.tokenCount;
      continue;
    }

    // Try summary + partial (recent messages)
    const summaryTokens = seg.summary ? seg.summaryTokens : 0;
    if (summaryTokens > 0 && summaryTokens < remaining) {
      // Give summary + as many recent messages as fit
      const partialBudget = remaining - summaryTokens;
      if (partialBudget > 50) {
        allocations.push({ segment: seg, tier: "partial", allocatedTokens: summaryTokens + partialBudget, scored: entry });
        remaining -= summaryTokens + partialBudget;
        continue;
      }
    }

    // Summary only
    if (seg.summary && seg.summaryTokens <= remaining) {
      allocations.push({ segment: seg, tier: "summary", allocatedTokens: seg.summaryTokens, scored: entry });
      remaining -= seg.summaryTokens;
      continue;
    }

    // Excluded
    allocations.push({ segment: seg, tier: "excluded", allocatedTokens: 0, scored: entry });
  }

  return allocations;
}

/**
 * Lightweight message type returned by the assembler.
 * Converted to AgentMessage by the plugin layer.
 */
export interface AssembledMessage {
  role: "system" | "user" | "assistant" | "toolResult";
  content: string;
  timestamp: number;
}

/**
 * Build the final message array from budget allocations.
 *
 * @param allocations — sorted budget allocations (active first)
 * @param getMessages — function to retrieve messages by IDs
 */
export function buildMessageArray(
  allocations: BudgetAllocation[],
  getMessages: (ids: string[]) => SimpleMessage[]
): AssembledMessage[] {
  const result: AssembledMessage[] = [];

  // Collect summaries for the preamble
  const summaryBlocks: string[] = [];
  const partialSegments: { allocation: BudgetAllocation; messages: SimpleMessage[] }[] = [];
  let activeMessages: SimpleMessage[] = [];
  let fullSegmentMessages: { segment: Segment; messages: SimpleMessage[] }[] = [];

  for (const alloc of allocations) {
    switch (alloc.tier) {
      case "active": {
        activeMessages = getMessages(alloc.segment.messageIds);
        // If active exceeds budget, take most recent messages
        if (alloc.allocatedTokens < alloc.segment.tokenCount) {
          let tokens = 0;
          const trimmed: SimpleMessage[] = [];
          for (let i = activeMessages.length - 1; i >= 0; i--) {
            const msgTokens = estimateTokens(activeMessages[i].content);
            if (tokens + msgTokens > alloc.allocatedTokens) break;
            trimmed.unshift(activeMessages[i]);
            tokens += msgTokens;
          }
          activeMessages = trimmed;
        }
        break;
      }
      case "full": {
        const msgs = getMessages(alloc.segment.messageIds);
        fullSegmentMessages.push({ segment: alloc.segment, messages: msgs });
        break;
      }
      case "partial": {
        const msgs = getMessages(alloc.segment.messageIds);
        // Take summary + recent messages that fit
        summaryBlocks.push(`[Prior context — ${alloc.segment.topic}: ${alloc.segment.summary}]`);
        const recentBudget = alloc.allocatedTokens - (alloc.segment.summaryTokens || 0);
        let tokens = 0;
        const recent: SimpleMessage[] = [];
        for (let i = msgs.length - 1; i >= 0; i--) {
          const t = estimateTokens(msgs[i].content);
          if (tokens + t > recentBudget) break;
          recent.unshift(msgs[i]);
          tokens += t;
        }
        partialSegments.push({ allocation: alloc, messages: recent });
        break;
      }
      case "summary": {
        const text = alloc.segment.summary || `${alloc.segment.topic}: ~${alloc.segment.messageCount} messages`;
        summaryBlocks.push(`[Prior context — ${alloc.segment.topic}: ${text}]`);
        break;
      }
      // "excluded" — nothing added
    }
  }

  // Step 1: System preamble with all summaries
  if (summaryBlocks.length > 0) {
    result.push({
      role: "system",
      content: summaryBlocks.join("\n\n"),
      timestamp: 0,
    });
  }

  // Step 2: Full expansion segments (chronologically by first message timestamp)
  fullSegmentMessages.sort((a, b) => (a.messages[0]?.timestamp || 0) - (b.messages[0]?.timestamp || 0));
  for (const { messages } of fullSegmentMessages) {
    for (const msg of messages) {
      result.push({ role: msg.role, content: msg.content, timestamp: msg.timestamp });
    }
  }

  // Step 3: Partial segments (recent messages)
  for (const { messages } of partialSegments) {
    for (const msg of messages) {
      result.push({ role: msg.role, content: msg.content, timestamp: msg.timestamp });
    }
  }

  // Step 4: Active segment messages (always last, in full)
  for (const msg of activeMessages) {
    result.push({ role: msg.role, content: msg.content, timestamp: msg.timestamp });
  }

  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx src/test-assembler.ts`
Expected: all assertions pass

- [ ] **Step 5: Commit**

```bash
git add src/assembler.ts src/test-assembler.ts
git commit -m "feat(v2): assembler — token budget allocation, message array construction"
```

---

## Chunk 5: Plugin Entry Point + Integration

### Task 7: Plugin entry point

**Files:**
- Create: `src/plugin.ts`

This wires everything together as an OpenClaw context engine plugin. The `ContextEngine` interface types are imported as type-only — no runtime dependency on the OpenClaw SDK.

- [ ] **Step 1: Write plugin entry point**

Create `src/plugin.ts`:

```typescript
/**
 * Dendrite v2 — OpenClaw Context Engine Plugin
 *
 * Entry point. Registers the context engine with OpenClaw's plugin API.
 * Types are imported as type-only; no runtime dependency on the SDK.
 */

import { Segmenter, callDriftModel, buildDriftPrompt } from "./segmenter.js";
import { scoreSegments, getEmbedding } from "./scorer.js";
import { generateSummary } from "./summarizer.js";
import { allocateBudgets, buildMessageArray } from "./assembler.js";
import {
  DEFAULT_CONFIG,
  estimateTokens,
  extractTextContent,
  isUserMessage,
  type DendriteConfig,
  type SimpleMessage,
  type SegmentIndex,
} from "./types.js";

// ── AgentMessage <-> SimpleMessage conversion ──

function toSimpleMessage(msg: any, index: number): SimpleMessage | null {
  const role = msg.role;
  if (role !== "user" && role !== "assistant" && role !== "toolResult") return null;
  const content = extractTextContent(msg);
  if (!content) return null;
  return {
    id: msg.id || `msg_${index}_${msg.timestamp || Date.now()}`,
    role,
    content,
    timestamp: msg.timestamp || Date.now(),
  };
}

function toAgentMessage(msg: { role: string; content: string; timestamp: number }): any {
  if (msg.role === "system") {
    // System messages are injected via systemPromptAddition instead
    return null;
  }
  return {
    role: msg.role as "user" | "assistant",
    content: msg.content,
    timestamp: msg.timestamp,
  };
}

// ── Session state ──

interface SessionState {
  segmenter: Segmenter;
  config: DendriteConfig;
  queryEmbedding: number[];
  totalTurns: number;
  /** Track whether segment index has changed since last persistence */
  indexDirty: boolean;
  /** Track whether embeddings are available (for fallback detection) */
  embeddingsAvailable: boolean;
}

const sessions = new Map<string, SessionState>();

function createSessionState(config: DendriteConfig): SessionState {
  return {
    segmenter: new Segmenter({
      minMessagesBeforeDrift: config.minMessagesBeforeDrift,
      maxSegmentMessages: config.maxSegmentMessages,
      driftThreshold: config.driftThreshold,
    }),
    config,
    queryEmbedding: [],
    totalTurns: 0,
    indexDirty: false,
    embeddingsAvailable: true,
  };
}

function getSession(sessionId: string, config: DendriteConfig): SessionState {
  let state = sessions.get(sessionId);
  if (!state) {
    state = createSessionState(config);
    sessions.set(sessionId, state);
  }
  return state;
}

// ── Plugin export ──

export default function dendrite(api: any) {
  const pluginConfig: DendriteConfig = { ...DEFAULT_CONFIG, ...(api.config?.dendrite || {}) };

  api.registerContextEngine("dendrite", () => ({
    info: {
      id: "dendrite",
      name: "Dendrite",
      ownsCompaction: true,
    },

    async bootstrap(params: { sessionId: string; sessionFile: string }) {
      const state = getSession(params.sessionId, pluginConfig);

      // Try to restore segment index from transcript custom entries.
      // Scan the session transcript for the most recent "segment-index" entry.
      try {
        if (params.sessionFile) {
          const fs = await import("node:fs");
          const content = fs.readFileSync(params.sessionFile, "utf-8");
          const lines = content.split("\n").filter(Boolean);

          // Find last segment-index entry (scan backwards for efficiency)
          let lastIndex: SegmentIndex | null = null;
          const allSimpleMessages: SimpleMessage[] = [];

          for (let i = lines.length - 1; i >= 0; i--) {
            try {
              const entry = JSON.parse(lines[i]);
              if (entry.dendrite === "segment-index" && !lastIndex) {
                lastIndex = { version: entry.version, segments: entry.segments };
              }
            } catch { /* skip malformed lines */ }
          }

          // Also rebuild the SimpleMessage store from transcript messages
          let msgIndex = 0;
          for (const line of lines) {
            try {
              const entry = JSON.parse(line);
              if (entry.role === "user" || entry.role === "assistant" || entry.role === "toolResult") {
                const simple = toSimpleMessage(entry, msgIndex++);
                if (simple) allSimpleMessages.push(simple);
              }
            } catch { /* skip */ }
          }

          if (lastIndex) {
            state.segmenter.loadIndex(lastIndex, allSimpleMessages);
            state.totalTurns = allSimpleMessages.length;
            api.logger?.info?.(`dendrite: restored ${lastIndex.segments.length} segments from transcript`);
          }
        }
      } catch (err) {
        api.logger?.warn?.("dendrite: failed to restore from transcript, starting fresh", err);
      }

      return { bootstrapped: true };
    },

    async ingest(params: { sessionId: string; message: any; isHeartbeat?: boolean }) {
      if (params.isHeartbeat) return { ingested: false };

      const state = getSession(params.sessionId, pluginConfig);
      const simple = toSimpleMessage(params.message, state.totalTurns);
      if (!simple) return { ingested: false };

      state.totalTurns++;
      const result = state.segmenter.addMessage(simple);

      // Run drift detection if needed
      if (result.needsDriftCheck && result.pendingMessage) {
        try {
          const recent = state.segmenter.getRecentMessages(6);
          const { system, user } = buildDriftPrompt(recent, result.pendingMessage.content);
          const verdict = await callDriftModel(system, user, pluginConfig.driftModel);

          if (verdict.classification === "tangent" && verdict.confidence >= pluginConfig.driftThreshold) {
            const topic = verdict.suggested_topic || "tangent";
            state.segmenter.splitOnDrift(topic);
            state.indexDirty = true;

            // Compute embedding for the closed segment
            const closedSeg = state.segmenter.segments[state.segmenter.segments.length - 2];
            if (closedSeg) {
              const segText = state.segmenter.getMessages(closedSeg.messageIds)
                .map(m => m.content).join(" ");
              const embedding = await getEmbedding(segText, pluginConfig.embeddingModel);
              if (embedding.length > 0) {
                closedSeg.embedding = embedding;
              } else {
                state.embeddingsAvailable = false;
                api.logger?.warn?.("dendrite: embedding unavailable, falling back to recency-only scoring");
              }
            }
          }
        } catch (err) {
          // Fail open — message already added to current segment
          api.logger?.warn?.("dendrite: drift detection failed", err);
        }
      }

      // Force split also marks index dirty
      if (result.action === "force-split") {
        state.indexDirty = true;
      }

      // Periodically update query embedding (every 5 messages)
      if (state.totalTurns % 5 === 0) {
        const recentMsgs = state.segmenter.getRecentMessages(pluginConfig.queryWindowSize);
        const queryText = recentMsgs.map(m => m.content).join(" ");
        const embedding = await getEmbedding(queryText, pluginConfig.embeddingModel);
        if (embedding.length > 0) {
          state.queryEmbedding = embedding;
        } else {
          state.embeddingsAvailable = false;
        }

        // Also update active segment embedding periodically
        const active = state.segmenter.activeSegment;
        if (active) {
          const activeText = state.segmenter.getMessages(active.messageIds)
            .map(m => m.content).join(" ");
          const activeEmbed = await getEmbedding(activeText, pluginConfig.embeddingModel);
          if (activeEmbed.length > 0) active.embedding = activeEmbed;
        }
      }

      // Persist segment index as custom transcript entry when structure changes
      if (state.indexDirty && api.addTranscriptEntry) {
        try {
          const index = state.segmenter.toIndex();
          await api.addTranscriptEntry({
            type: "custom",
            dendrite: "segment-index",
            version: index.version,
            segments: index.segments,
          });
          state.indexDirty = false;
        } catch (err) {
          api.logger?.warn?.("dendrite: failed to persist segment index", err);
        }
      }

      return { ingested: true };
    },

    async assemble(params: { sessionId: string; messages: any[]; tokenBudget?: number }) {
      const state = getSession(params.sessionId, pluginConfig);
      const segments = state.segmenter.segments;

      // Pass-through if fewer than 2 segments
      if (segments.length < 2) {
        return {
          messages: params.messages,
          estimatedTokens: params.messages.reduce((sum: number, m: any) =>
            sum + estimateTokens(extractTextContent(m)), 0),
        };
      }

      const tokenBudget = params.tokenBudget || 32000;

      // If embeddings are unavailable, force recency-only scoring
      const effectiveAlpha = state.embeddingsAvailable ? pluginConfig.relevanceAlpha : 0;

      // Score segments
      const scored = scoreSegments(
        segments,
        state.queryEmbedding,
        state.totalTurns,
        effectiveAlpha
      );

      // Generate summaries for segments that need them (cap at 1 per assemble to limit latency)
      let summarizedThisTurn = 0;
      for (const entry of scored) {
        const seg = entry.segment;
        if (seg.status === "closed" && !seg.summary && summarizedThisTurn < 1) {
          const msgs = state.segmenter.getMessages(seg.messageIds);
          seg.summary = await generateSummary(seg.topic, msgs, pluginConfig.summaryModel);
          seg.summaryTokens = estimateTokens(seg.summary);
          summarizedThisTurn++;
        }
      }

      // Allocate budgets — subtract reserveTokens first (guaranteed floor for active segment)
      const budgets = allocateBudgets(scored, tokenBudget - pluginConfig.reserveTokens, pluginConfig.reserveTokens);

      // Build the assembled message array
      const assembled = buildMessageArray(budgets, (ids) => state.segmenter.getMessages(ids));

      // Separate system preamble from conversation messages
      const systemPreamble = assembled.filter(m => m.role === "system").map(m => m.content).join("\n\n");
      const conversationMessages = assembled
        .filter(m => m.role !== "system")
        .map(m => toAgentMessage(m))
        .filter(Boolean);

      const estimatedTokens = budgets.reduce((sum, b) => sum + b.allocatedTokens, 0);

      // Persist assembly log as custom transcript entry
      const fallbacks: string[] = [];
      if (!state.embeddingsAvailable) fallbacks.push("embedding-unavailable:recency-only");
      if (summarizedThisTurn > 0) fallbacks.push(`summaries-generated:${summarizedThisTurn}`);

      if (api.addTranscriptEntry) {
        try {
          await api.addTranscriptEntry({
            type: "custom",
            dendrite: "assembly-log",
            contextWindow: tokenBudget,
            budgetUsed: estimatedTokens,
            segments: budgets.map(b => ({
              id: b.segment.id,
              tier: b.tier,
              tokens: b.allocatedTokens,
            })),
            fallbacks,
          });
        } catch {
          // Non-critical — log and continue
        }
      }

      return {
        messages: conversationMessages,
        estimatedTokens,
        systemPromptAddition: systemPreamble || undefined,
      };
    },

    async compact() {
      return { ok: true, compacted: false };
    },

    async dispose() {
      // dispose() is called when the plugin is unloaded — clear all sessions.
      // Per-session cleanup would need a sessionId param (not in the SDK interface),
      // so we clear everything and rely on bootstrap() to re-initialize on next use.
      sessions.clear();
    },
  }));
}
```

- [ ] **Step 2: Verify type checking passes**

Run: `npx tsc --noEmit`
Expected: no errors (or only type errors from `any` usage for the API — which is expected since we don't have the SDK as a dependency)

- [ ] **Step 3: Commit**

```bash
git add src/plugin.ts
git commit -m "feat(v2): plugin entry point — registerContextEngine wiring"
```

---

### Task 8: Integration test

**Files:**
- Create: `src/test-integration.ts`

This tests the full pipeline without a live OpenClaw instance — simulates ingest + assemble with mock messages.

- [ ] **Step 1: Write integration test**

Create `src/test-integration.ts`:

```typescript
/**
 * Integration test: full dendrite pipeline without OpenClaw.
 *
 * Simulates: cold start → multi-topic conversation → assembly with budget pressure.
 * Does NOT call live LLMs — uses the Segmenter directly with manual splits.
 */

import { Segmenter } from "./segmenter.js";
import { scoreSegments } from "./scorer.js";
import { allocateBudgets, buildMessageArray } from "./assembler.js";
import { createSegment, estimateTokens, type SimpleMessage } from "./types.js";

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}

console.log("=== Integration ===\n");

// ── Simulate a conversation with topic changes ──

const segmenter = new Segmenter({
  minMessagesBeforeDrift: 2,
  maxSegmentMessages: 100,
  driftThreshold: 0.7,
});

// Phase 1: REST API discussion (6 messages)
const restMessages: SimpleMessage[] = [
  { id: "r1", role: "user", content: "Let's design the REST API for our task management system", timestamp: 1 },
  { id: "r2", role: "assistant", content: "Great idea. We need CRUD endpoints for tasks, users, and projects", timestamp: 2 },
  { id: "r3", role: "user", content: "Should we use JWT or session cookies for authentication?", timestamp: 3 },
  { id: "r4", role: "assistant", content: "JWT is better for mobile clients. I suggest 15-minute access tokens with refresh tokens", timestamp: 4 },
  { id: "r5", role: "user", content: "Agreed on JWT. What about rate limiting?", timestamp: 5 },
  { id: "r6", role: "assistant", content: "100 requests per minute per user, with burst allowance of 20", timestamp: 6 },
];
for (const msg of restMessages) segmenter.addMessage(msg);

// Simulate drift detection: topic change to Docker
segmenter.addMessage({ id: "d0", role: "user", content: "Wait, how does our Docker container networking work?", timestamp: 7 });
segmenter.splitOnDrift("docker-networking");

// Phase 2: Docker discussion (4 messages)
const dockerMessages: SimpleMessage[] = [
  { id: "d1", role: "assistant", content: "We use bridge networking with port mapping", timestamp: 8 },
  { id: "d2", role: "user", content: "Can we switch to host networking for better performance?", timestamp: 9 },
  { id: "d3", role: "assistant", content: "Host networking removes isolation. Bridge is safer for production", timestamp: 10 },
];
for (const msg of dockerMessages) segmenter.addMessage(msg);

// Another drift: K8s
segmenter.addMessage({ id: "k0", role: "user", content: "What about Kubernetes deployment strategy?", timestamp: 11 });
segmenter.splitOnDrift("kubernetes-deployment");

// Phase 3: K8s discussion (active)
const k8sMessages: SimpleMessage[] = [
  { id: "k1", role: "assistant", content: "We should use rolling deployments with health checks", timestamp: 12 },
  { id: "k2", role: "user", content: "Helm or Kustomize?", timestamp: 13 },
];
for (const msg of k8sMessages) segmenter.addMessage(msg);

// Verify segment structure
assert(segmenter.segments.length === 3, "3 segments created");
assert(segmenter.segments[0].topic === "conversation", "seg 0: REST API (default topic)");
assert(segmenter.segments[0].status === "closed", "seg 0: closed");
assert(segmenter.segments[1].topic === "docker-networking", "seg 1: docker");
assert(segmenter.segments[1].status === "closed", "seg 1: closed");
assert(segmenter.segments[2].topic === "kubernetes-deployment", "seg 2: k8s (active)");
assert(segmenter.segments[2].status === "active", "seg 2: active");

// Add mock embeddings and summaries
segmenter.segments[0].embedding = [1, 0, 0]; // REST API
segmenter.segments[0].summary = "Designed REST API for task management. Decided on JWT auth (15-min tokens). Rate limiting: 100 req/min with burst of 20.";
segmenter.segments[0].summaryTokens = estimateTokens(segmenter.segments[0].summary);

segmenter.segments[1].embedding = [0, 1, 0]; // Docker
segmenter.segments[1].summary = "Discussed Docker networking. Using bridge mode with port mapping. Host networking rejected for production (isolation concerns).";
segmenter.segments[1].summaryTokens = estimateTokens(segmenter.segments[1].summary);

segmenter.segments[2].embedding = [0, 0, 1]; // K8s

console.log("\n  Assembly with large budget:");

// Score with K8s-like query (active topic)
const queryEmbed = [0, 0, 1]; // K8s-similar
const scored = scoreSegments(segmenter.segments, queryEmbed, 13, 0.7);

assert(scored[0].segment.status === "active", "active segment ranked first");
assert(scored[0].segment.topic === "kubernetes-deployment", "active is K8s");

// Large budget — everything fits
const largeBudget = allocateBudgets(scored, 50000, 2000);
const fullCount = largeBudget.filter(b => b.tier === "full" || b.tier === "active").length;
assert(fullCount === 3, "large budget: all segments fully expanded");

const largeResult = buildMessageArray(largeBudget, (ids) => segmenter.getMessages(ids));
assert(largeResult.length >= 12, "large budget: all messages present");

console.log("\n  Assembly with tight budget:");

// Tight budget — forces compression
const tightBudget = allocateBudgets(scored, 800, 200);
const excluded = tightBudget.filter(b => b.tier === "excluded").length;
const summarized = tightBudget.filter(b => b.tier === "summary").length;
assert(excluded + summarized > 0, "tight budget: some segments compressed or excluded");
assert(tightBudget[0].tier === "active", "tight budget: active always present");

const tightResult = buildMessageArray(tightBudget, (ids) => segmenter.getMessages(ids));
assert(tightResult.length < largeResult.length, "tight budget: fewer messages than large");
assert(tightResult.some(m => m.role === "system"), "tight budget: has system preamble with summaries");

console.log("\n  Topic return simulation:");

// Now simulate the user returning to REST API topic
const returnQuery = [0.9, 0, 0.1]; // REST API-similar
const returnScored = scoreSegments(segmenter.segments, returnQuery, 15, 0.7);

// REST API segment should score higher than Docker
const restScore = returnScored.find(s => s.segment.topic === "conversation")!;
const dockerScore = returnScored.find(s => s.segment.topic === "docker-networking")!;
assert(restScore.score > dockerScore.score, "return: REST API scores higher than Docker when query is similar");

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 2: Run integration test**

Run: `npx tsx src/test-integration.ts`
Expected: all assertions pass

- [ ] **Step 3: Run all tests**

Run: `npm run test:all`
Expected: all test files pass

- [ ] **Step 4: Commit**

```bash
git add src/test-integration.ts
git commit -m "test(v2): integration test — full pipeline without live LLMs"
```

---

### Task 9: Inspection skill and final cleanup

**Files:**
- Create: `skills/dendrite-inspect.md`

- [ ] **Step 1: Create the agent-facing inspection skill**

Create `skills/dendrite-inspect.md`:

```markdown
---
name: dendrite-inspect
description: Inspect Dendrite's current conversation segmentation and context budget
---

# Dendrite Inspect

Show the current state of Dendrite's conversation segmentation.

For each segment, show:
- Topic name and status (active/closed)
- Message count and estimated token count
- Whether a summary is cached
- Current relevance score (if available)
- Context tier (active/full/partial/summary/excluded)

Also show:
- Total segments tracked
- Context budget usage (tokens used / total budget)
- Any recent errors or fallbacks
```

- [ ] **Step 2: Final commit and push**

```bash
git add skills/dendrite-inspect.md
git commit -m "feat(v2): dendrite-inspect skill + project ready for OpenClaw integration"
git push origin main
```

---

## Summary

| Task | What it produces | Tests |
|------|-----------------|-------|
| 1. Restructure | v1 moved, manifest created, package.json updated | — |
| 2. Types | Segment, SegmentIndex, DendriteConfig, message helpers | test-types.ts |
| 3. Segmenter | Drift prompt, response parsing, segment lifecycle | test-segmenter.ts |
| 4. Scorer | Cosine similarity, recency decay, segment ranking | test-scorer.ts |
| 5. Summarizer | Summary prompt, LLM call, fallback | test-summarizer.ts |
| 6. Assembler | Token budget allocation, message array builder | test-assembler.ts |
| 7. Plugin | Entry point, ContextEngine impl, session state | type-check only |
| 8. Integration | Full pipeline simulation | test-integration.ts |
| 9. Skill | dendrite-inspect.md | — |
