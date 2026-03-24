import { Segmenter } from "./segmenter.js";
import { scoreSegments } from "./scorer.js";
import { allocateBudgets, buildMessageArray } from "./assembler.js";
import { extractTextContent, estimateTokens, type SimpleMessage } from "./types.js";

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}

// Copy of toSimpleMessage from plugin.ts (tested at the boundary)
function toSimpleMessage(msg: any, index: number): SimpleMessage | null {
  const role = msg.role;
  if (role !== "user" && role !== "assistant" && role !== "toolResult") return null;
  let content = extractTextContent(msg);
  if (!content && role === "assistant" && Array.isArray(msg.content)) {
    const toolCalls = msg.content.filter((b: any) => b.type === "toolCall");
    if (toolCalls.length > 0) {
      const names = toolCalls.map((t: any) => t.name || "unknown").join(", ");
      content = `[Tool calls: ${names}]`;
    }
  }
  if (!content) return null;
  return {
    id: msg.id || `msg_${index}_${msg.timestamp || Date.now()}`,
    role,
    content,
    timestamp: msg.timestamp || Date.now(),
  };
}

console.log("=== Assemble Boundary Integration ===\n");

// Test: full round-trip with tool calls
console.log("  round-trip with tool calls:");
{
  const agentMessages: any[] = [
    { role: "user", content: [{ type: "text", text: "Read /tmp/test.txt" }], timestamp: 1000 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "tc_1", name: "read", arguments: '{"path":"/tmp/test.txt"}' }],
      timestamp: 1001,
    },
    {
      role: "toolResult",
      toolCallId: "tc_1",
      toolName: "read",
      content: [{ type: "text", text: "file contents" }],
      timestamp: 1002,
    },
    { role: "assistant", content: [{ type: "text", text: "The file contains: file contents" }], timestamp: 1003 },
    { role: "user", content: [{ type: "text", text: "Thanks!" }], timestamp: 1004 },
  ];

  // Step 1: Convert to SimpleMessages (ingest)
  const simples: SimpleMessage[] = [];
  for (let i = 0; i < agentMessages.length; i++) {
    const s = toSimpleMessage(agentMessages[i], i);
    if (s) simples.push(s);
  }
  assert(simples.length === 5, `all 5 messages converted (got ${simples.length})`);
  assert(simples[1].content === "[Tool calls: read]", "tool-call-only assistant gets placeholder");
  assert(simples[2].role === "toolResult", "toolResult preserved in SimpleMessage");

  // Step 2: Feed into segmenter (single segment, no drift)
  const segmenter = new Segmenter({ minMessagesBeforeDrift: 999, maxSegmentMessages: 100, driftThreshold: 0.9 });
  for (const s of simples) segmenter.addMessage(s);
  assert(segmenter.segments.length === 1, "single segment");
  assert(segmenter.segments[0].messageCount === 5, "all 5 messages in segment");

  // Step 3: Score and allocate (single segment = passthrough-like)
  const scored = scoreSegments(segmenter.segments, [], 86400000, 0.7);
  const budgets = allocateBudgets(scored, 100000, 16384, { currentSessionId: undefined, pinRecentSegments: 0, maxCrossSessionBudgetRatio: 1.0, pinnedSegmentIds: [] });
  assert(budgets[0].tier === "active", "segment is active tier");

  // Step 4: Build assembled message array
  const assembled = buildMessageArray(budgets, (ids) => segmenter.getMessages(ids));
  assert(assembled.length === 5, `assembled has 5 messages (got ${assembled.length})`);

  // Step 5: Lookup back to originals
  const originalByTs = new Map<number, any[]>();
  for (const msg of agentMessages) {
    const arr = originalByTs.get(msg.timestamp);
    if (arr) arr.push(msg);
    else originalByTs.set(msg.timestamp, [msg]);
  }

  const output = assembled
    .filter(m => m.role !== "system")
    .map(m => {
      const arr = originalByTs.get(m.timestamp);
      if (arr) {
        const idx = arr.findIndex(orig => orig.role === m.role);
        if (idx >= 0) return arr.splice(idx, 1)[0];
      }
      return null; // miss
    })
    .filter(Boolean);

  assert(output.length === 5, `all 5 originals resolved (got ${output.length})`);

  // Verify tool structure is intact
  const toolAssistant = output[1];
  assert(toolAssistant.role === "assistant", "tool assistant preserved");
  assert(toolAssistant.content[0].type === "toolCall", "toolCall content block preserved");
  assert(toolAssistant.content[0].id === "tc_1", "toolCall ID preserved");

  const toolResult = output[2];
  assert(toolResult.role === "toolResult", "toolResult role preserved");
  assert(toolResult.toolCallId === "tc_1", "toolCallId preserved");
}

// Test: tool-call-only assistant without text doesn't get dropped
console.log("\n  tool-call-only assistant:");
{
  const msg = {
    role: "assistant",
    content: [
      { type: "toolCall", id: "tc_a", name: "exec", arguments: '{}' },
      { type: "toolCall", id: "tc_b", name: "read", arguments: '{}' },
    ],
    timestamp: 5000,
  };

  const simple = toSimpleMessage(msg, 0);
  assert(simple !== null, "tool-call-only assistant not dropped");
  assert(simple!.content === "[Tool calls: exec, read]", "placeholder lists tool names");
  assert(simple!.role === "assistant", "role preserved as assistant");
}

// Test: messages with same timestamp but different roles resolve correctly
console.log("\n  same-timestamp different roles:");
{
  const user = { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 9000 };
  const assistant = { role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: 9000 };
  const paramsMessages = [user, assistant];

  const originalByTs = new Map<number, any[]>();
  for (const msg of paramsMessages) {
    const arr = originalByTs.get(msg.timestamp);
    if (arr) arr.push(msg);
    else originalByTs.set(msg.timestamp, [msg]);
  }

  // Lookup user
  const arr1 = originalByTs.get(9000)!;
  const userIdx = arr1.findIndex(m => m.role === "user");
  assert(userIdx >= 0, "user found in same-ts bucket");
  const resolvedUser = arr1.splice(userIdx, 1)[0];
  assert(resolvedUser.role === "user", "correct user resolved");

  // Lookup assistant
  const arr2 = originalByTs.get(9000)!;
  const asstIdx = arr2.findIndex(m => m.role === "assistant");
  assert(asstIdx >= 0, "assistant found in same-ts bucket after user consumed");
  const resolvedAsst = arr2.splice(asstIdx, 1)[0];
  assert(resolvedAsst.role === "assistant", "correct assistant resolved");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
