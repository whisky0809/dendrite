import { Segmenter } from "./segmenter.js";
import { scoreSegments } from "./scorer.js";
import { allocateBudgets, buildSelectionPlan } from "./assembler.js";
import { extractTextContent, estimateTokens, type SimpleMessage } from "./types.js";

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}

const defaultOpts = { currentSessionId: undefined, pinRecentSegments: 0, maxCrossSessionBudgetRatio: 1.0, pinnedSegmentIds: [] as string[] };

function toSimpleMessage(msg: any, index: number): SimpleMessage | null {
  const role = msg.role;
  if (role !== "user" && role !== "assistant" && role !== "toolResult") return null;
  let content = extractTextContent(msg);
  if (!content && role === "assistant" && Array.isArray(msg.content)) {
    const toolCalls = msg.content.filter((b: any) => b.type === "toolCall");
    if (toolCalls.length > 0) {
      content = `[Tool calls: ${toolCalls.map((t: any) => t.name || "unknown").join(", ")}]`;
    }
  }
  if (!content) return null;
  return { id: `msg_${index}_${msg.timestamp}`, role, content, timestamp: msg.timestamp };
}

console.log("=== Assemble Boundary (v3 index-based) ===\n");

// Test: full round-trip with tool calls — reference equality
console.log("  round-trip reference equality:");
{
  const agentMessages: any[] = [
    { role: "user", content: [{ type: "text", text: "Read /tmp/test.txt" }], timestamp: 1000 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "tc_1", name: "read", arguments: '{"path":"/tmp/test.txt"}' }],
      timestamp: 1001,
    },
    {
      role: "toolResult", toolCallId: "tc_1", toolName: "read",
      content: [{ type: "text", text: "file contents" }], timestamp: 1002,
    },
    { role: "assistant", content: [{ type: "text", text: "The file contains: file contents" }], timestamp: 1003 },
    { role: "user", content: [{ type: "text", text: "Thanks!" }], timestamp: 1004 },
  ];

  // Ingest
  const segmenter = new Segmenter({ minMessagesBeforeDrift: 999, maxSegmentMessages: 100, driftThreshold: 0.9 });
  for (let i = 0; i < agentMessages.length; i++) {
    const s = toSimpleMessage(agentMessages[i], i);
    if (s) segmenter.addMessage(s);
  }

  // Reconcile
  for (const seg of segmenter.segments) {
    for (const msgId of seg.messageIds) {
      const simple = segmenter.getMessage(msgId);
      if (simple) {
        const idx = agentMessages.findIndex(m => m.timestamp === simple.timestamp && m.role === simple.role);
        simple.originalIndex = idx >= 0 ? idx : undefined;
      }
    }
  }

  // Score + allocate + plan
  const scored = scoreSegments(segmenter.segments, [], 86400000, 0.7);
  const budgets = allocateBudgets(scored, 100000, 16384, defaultOpts);
  const plan = buildSelectionPlan(budgets, (seg) => {
    return seg.messageIds
      .map(id => segmenter.getMessage(id)?.originalIndex)
      .filter((i): i is number => i !== undefined);
  }, agentMessages, (msg) => estimateTokens(extractTextContent(msg)));

  const output = plan.indices.map(i => agentMessages[i]);

  assert(output.length === 5, `all 5 messages selected (got ${output.length})`);

  // Reference equality
  for (let i = 0; i < output.length; i++) {
    assert(output[i] === agentMessages[i], `message ${i} is same object reference`);
  }

  // Tool structure intact
  assert(output[1].content[0].type === "toolCall", "toolCall preserved");
  assert(output[2].toolCallId === "tc_1", "toolCallId preserved");
}

// Test: consecutive toolResults survive (the v2 bug)
console.log("\n  consecutive toolResults preserved:");
{
  const agentMessages: any[] = [
    { role: "user", content: [{ type: "text", text: "Do two things" }], timestamp: 2000 },
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "tc_a", name: "exec", arguments: "{}" },
        { type: "toolCall", id: "tc_b", name: "read", arguments: "{}" },
      ],
      timestamp: 2001,
    },
    { role: "toolResult", toolCallId: "tc_a", toolName: "exec", content: [{ type: "text", text: "out A" }], timestamp: 2002 },
    { role: "toolResult", toolCallId: "tc_b", toolName: "read", content: [{ type: "text", text: "out B" }], timestamp: 2003 },
    { role: "assistant", content: [{ type: "text", text: "Both done" }], timestamp: 2004 },
  ];

  const segmenter = new Segmenter({ minMessagesBeforeDrift: 999, maxSegmentMessages: 100, driftThreshold: 0.9 });
  for (let i = 0; i < agentMessages.length; i++) {
    const s = toSimpleMessage(agentMessages[i], i);
    if (s) {
      s.originalIndex = i;
      segmenter.addMessage(s);
    }
  }

  const scored = scoreSegments(segmenter.segments, [], 86400000, 0.7);
  const budgets = allocateBudgets(scored, 100000, 16384, defaultOpts);
  const plan = buildSelectionPlan(budgets, (seg) => {
    return seg.messageIds
      .map(id => segmenter.getMessage(id)?.originalIndex)
      .filter((i): i is number => i !== undefined);
  }, agentMessages, (msg) => estimateTokens(extractTextContent(msg)));

  const output = plan.indices.map(i => agentMessages[i]);

  assert(output.length === 5, "all messages present");
  assert(output[2].role === "toolResult" && output[3].role === "toolResult",
    "consecutive toolResults both present (was the v2 bug)");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
