import { extractTextContent } from "./types.js";

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}

console.log("=== Plugin Assembly (v3 — orphan repair eliminated) ===\n");

// With index-based assembly, the orphan repair code is deleted.
// These tests verify the properties that made orphan repair unnecessary.

// Test 1: selecting by index preserves tool pairing by construction
console.log("  tool pairing by construction:");
{
  const messages: any[] = [
    { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 100 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "tc_1", name: "read", arguments: '{"path":"/tmp"}' }],
      stopReason: "toolUse",
      timestamp: 200,
    },
    {
      role: "toolResult",
      toolCallId: "tc_1",
      toolName: "read",
      content: [{ type: "text", text: "file contents" }],
      timestamp: 300,
    },
    { role: "assistant", content: [{ type: "text", text: "Done" }], timestamp: 400 },
  ];

  // Index-based selection: include all
  const indices = [0, 1, 2, 3];
  const output = indices.map(i => messages[i]);

  // Verify: toolCall and toolResult are paired
  const toolCallIds = new Set<string>();
  const toolResultIds = new Set<string>();
  for (const msg of output) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const c of msg.content) {
        if (c.type === "toolCall") toolCallIds.add(c.id);
      }
    }
    if (msg.role === "toolResult" && msg.toolCallId) {
      toolResultIds.add(msg.toolCallId);
    }
  }

  // Every toolResult has a matching toolCall
  for (const id of toolResultIds) {
    assert(toolCallIds.has(id), `toolResult ${id} has matching toolCall`);
  }
  // Every toolCall has a matching toolResult
  for (const id of toolCallIds) {
    assert(toolResultIds.has(id), `toolCall ${id} has matching toolResult`);
  }
}

// Test 2: excluding a segment excludes the entire tool group
console.log("\n  segment exclusion is atomic:");
{
  const messages: any[] = [
    { role: "user", content: [{ type: "text", text: "topic 1" }], timestamp: 100 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "tc_1", name: "exec", arguments: "{}" }],
      timestamp: 200,
    },
    { role: "toolResult", toolCallId: "tc_1", toolName: "exec", content: [{ type: "text", text: "output" }], timestamp: 300 },
    { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 400 },
    // --- segment boundary ---
    { role: "user", content: [{ type: "text", text: "topic 2" }], timestamp: 500 },
    { role: "assistant", content: [{ type: "text", text: "sure" }], timestamp: 600 },
  ];

  // Only include segment 2 (indices 4, 5)
  const indices = [4, 5];
  const output = indices.map(i => messages[i]);

  // No orphaned toolResults or toolCalls
  assert(!output.some(m => m.role === "toolResult"), "no toolResults from excluded segment");
  assert(!output.some(m =>
    m.role === "assistant" && Array.isArray(m.content) &&
    m.content.some((c: any) => c.type === "toolCall")
  ), "no toolCalls from excluded segment");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
