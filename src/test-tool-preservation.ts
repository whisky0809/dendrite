import { allocateBudgets, buildMessageArray } from "./assembler.js";
import { createSegment, estimateTokens, extractTextContent, type SimpleMessage } from "./types.js";
import type { ScoredSegment } from "./scorer.js";

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}

console.log("=== Tool Structure Preservation ===\n");

// ── Helpers matching plugin.ts logic ──

function buildOriginalLookup(messages: any[]): Map<string, any[]> {
  const map = new Map<string, any[]>();
  for (const msg of messages) {
    const key = `${msg.role}:${msg.timestamp}`;
    const arr = map.get(key);
    if (arr) arr.push(msg);
    else map.set(key, [msg]);
  }
  return map;
}

function lookupOriginal(map: Map<string, any[]>, role: string, timestamp: number): any | null {
  const key = `${role}:${timestamp}`;
  const arr = map.get(key);
  if (!arr || arr.length === 0) return null;
  return arr.shift()!;
}

function toAgentMessageSafe(msg: { role: string; content: string; timestamp: number }): any {
  if (msg.role === "system") return null;
  const safeRole = msg.role === "toolResult" ? "user" : msg.role;
  const prefix = msg.role === "toolResult" ? "[Tool result] " : "";
  return {
    role: safeRole,
    content: [{ type: "text", text: prefix + msg.content }],
    timestamp: msg.timestamp,
  };
}

// ── Test: originals preserved for current-session full/active tiers ──
console.log("  original message lookup:");

// Mock AgentMessages with tool structure
const agentMessages: any[] = [
  {
    role: "user",
    content: [{ type: "text", text: "Run ls for me" }],
    timestamp: 100,
  },
  {
    role: "assistant",
    content: [
      { type: "text", text: "Sure, running ls." },
      { type: "toolCall", id: "exec:1", name: "exec", arguments: { command: "ls" } },
    ],
    stopReason: "toolUse",
    model: "kimi-k2.5",
    provider: "moonshot",
    timestamp: 101,
  },
  {
    role: "toolResult",
    toolCallId: "exec:1",
    toolName: "exec",
    content: [{ type: "text", text: "file1.txt\nfile2.txt" }],
    isError: false,
    timestamp: 102,
  },
  {
    role: "assistant",
    content: [{ type: "text", text: "Here are your files: file1.txt, file2.txt" }],
    timestamp: 103,
  },
  {
    role: "user",
    content: [{ type: "text", text: "Thanks!" }],
    timestamp: 104,
  },
];

// Build SimpleMessages (as dendrite's segmenter would)
const simpleMessages: SimpleMessage[] = agentMessages
  .filter(m => ["user", "assistant", "toolResult"].includes(m.role))
  .map((m, i) => ({
    id: `msg_${i}`,
    role: m.role as "user" | "assistant" | "toolResult",
    content: extractTextContent(m),
    timestamp: m.timestamp,
  }));

// Create two segments to trigger the non-passthrough path
const seg1 = createSegment("setup");
seg1.status = "closed";
seg1.messageIds = [simpleMessages[0].id];
seg1.messageCount = 1;
seg1.tokenCount = estimateTokens(simpleMessages[0].content);
seg1.summary = "User asked to run ls";
seg1.summaryTokens = 10;

const seg2 = createSegment("tool-interaction");
seg2.status = "active";
seg2.messageIds = simpleMessages.slice(1).map(m => m.id);
seg2.messageCount = 4;
seg2.tokenCount = simpleMessages.slice(1).reduce((s, m) => s + estimateTokens(m.content), 0);

const msgMap = new Map(simpleMessages.map(m => [m.id, m]));

const scored: ScoredSegment[] = [
  { segment: seg2, score: 1.0, semanticScore: 1, recencyScoreValue: 1 },
  { segment: seg1, score: 0.5, semanticScore: 0.3, recencyScoreValue: 0.2 },
];

const budgets = allocateBudgets(scored, 10000, 2000, { currentSessionId: undefined, pinRecentSegments: 0, maxCrossSessionBudgetRatio: 1.0, pinnedSegmentIds: [] });
const assembled = buildMessageArray(budgets, (ids) =>
  ids.map(id => msgMap.get(id)!).filter(Boolean)
);

// Now simulate what fixed assemble() does: lookup originals
const lookup = buildOriginalLookup(agentMessages);
const conversationMessages = assembled
  .filter(m => m.role !== "system")
  .map(m => {
    const original = lookupOriginal(lookup, m.role, m.timestamp);
    return original || toAgentMessageSafe(m);
  })
  .filter(Boolean);

// The assistant with toolCall should preserve its structure
const assistantWithTool = conversationMessages.find(
  (m: any) => m.role === "assistant" && Array.isArray(m.content) &&
    m.content.some((c: any) => c.type === "toolCall")
);
assert(assistantWithTool !== undefined, "assistant with toolCall preserved");
assert(assistantWithTool?.content.some((c: any) => c.id === "exec:1"), "toolCall id preserved");

// The toolResult should preserve toolCallId
const toolResultMsg = conversationMessages.find((m: any) => m.role === "toolResult");
assert(toolResultMsg !== undefined, "toolResult message preserved");
assert(toolResultMsg?.toolCallId === "exec:1", "toolCallId preserved");
assert(toolResultMsg?.toolName === "exec", "toolName preserved");

// ── Test: cross-session fallback converts toolResult to user ──
console.log("\n  cross-session fallback:");

// Simulate a cross-session message where no original exists
const crossSessionToolResult = { role: "toolResult" as const, content: "some output", timestamp: 999 };
const fallback = toAgentMessageSafe(crossSessionToolResult);
assert(fallback.role === "user", "cross-session toolResult becomes user role");
assert(fallback.content[0].text.startsWith("[Tool result]"), "cross-session toolResult has prefix");

// ── Test: multiple toolResults at same timestamp consumed in order ──
console.log("\n  timestamp collision handling:");

const collisionMessages: any[] = [
  { role: "toolResult", toolCallId: "r:1", toolName: "read", content: [{ type: "text", text: "first" }], timestamp: 200 },
  { role: "toolResult", toolCallId: "r:2", toolName: "read", content: [{ type: "text", text: "second" }], timestamp: 200 },
];
const collisionLookup = buildOriginalLookup(collisionMessages);
const first = lookupOriginal(collisionLookup, "toolResult", 200);
const second = lookupOriginal(collisionLookup, "toolResult", 200);
const third = lookupOriginal(collisionLookup, "toolResult", 200);
assert(first?.toolCallId === "r:1", "first collision match is r:1");
assert(second?.toolCallId === "r:2", "second collision match is r:2");
assert(third === null, "third lookup returns null (exhausted)");

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
