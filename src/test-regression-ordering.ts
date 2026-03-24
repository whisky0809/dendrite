/**
 * Regression test: "Message ordering conflict" bug.
 *
 * Verifies that index-based assembly never produces consecutive
 * same-role messages when returning original AgentMessages.
 */
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

function toSimple(msg: any, i: number): SimpleMessage | null {
  const role = msg.role;
  if (role !== "user" && role !== "assistant" && role !== "toolResult") return null;
  let content = extractTextContent(msg);
  if (!content && role === "assistant" && Array.isArray(msg.content)) {
    const tc = msg.content.filter((b: any) => b.type === "toolCall");
    if (tc.length > 0) content = `[Tool calls: ${tc.map((t: any) => t.name).join(", ")}]`;
  }
  if (!content) return null;
  return { id: `msg_${i}_${msg.timestamp}`, role, content, timestamp: msg.timestamp, originalIndex: i };
}

console.log("=== Regression: Message Ordering ===\n");

// Reproduce the exact scenario from the bug: heartbeat session with
// multi-tool assistant turns producing consecutive toolResults
console.log("  multi-tool heartbeat scenario:");
{
  const now = Date.now();
  const paramsMessages: any[] = [
    // Turn 1: heartbeat
    { role: "user", content: [{ type: "text", text: "HEARTBEAT" }], timestamp: now - 10000 },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Checking..." },
        { type: "toolCall", id: "tc_read", name: "read", arguments: "{}" },
      ],
      timestamp: now - 9999,
    },
    { role: "toolResult", toolCallId: "tc_read", toolName: "read", content: [{ type: "text", text: "state data" }], timestamp: now - 9000 },
    { role: "toolResult", toolCallId: "tc_cal", toolName: "exec", content: [{ type: "text", text: "calendar" }], timestamp: now - 8999 },
    { role: "assistant", content: [{ type: "text", text: "HEARTBEAT_OK" }], timestamp: now - 8998 },

    // Turn 2: another heartbeat with even more tool calls
    { role: "user", content: [{ type: "text", text: "HEARTBEAT" }], timestamp: now - 5000 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "tc_r2", name: "read", arguments: "{}" }],
      timestamp: now - 4999,
    },
    { role: "toolResult", toolCallId: "tc_r2", toolName: "read", content: [{ type: "text", text: "data" }], timestamp: now - 4000 },
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "tc_edit", name: "edit", arguments: "{}" },
        { type: "toolCall", id: "tc_write", name: "write", arguments: "{}" },
      ],
      timestamp: now - 3999,
    },
    { role: "toolResult", toolCallId: "tc_edit", toolName: "edit", content: [{ type: "text", text: "ok" }], timestamp: now - 3000 },
    { role: "toolResult", toolCallId: "tc_write", toolName: "write", content: [{ type: "text", text: "ok" }], timestamp: now - 2999 },
    { role: "assistant", content: [{ type: "text", text: "Evening routine complete." }], timestamp: now - 2998 },

    // Turn 3: user message (this is where v2 would fail)
    { role: "user", content: [{ type: "text", text: "So, I just woke up again" }], timestamp: now },
  ];

  // Ingest all
  const segmenter = new Segmenter({ minMessagesBeforeDrift: 999, maxSegmentMessages: 100, driftThreshold: 0.9 });
  for (let i = 0; i < paramsMessages.length; i++) {
    const s = toSimple(paramsMessages[i], i);
    if (s) segmenter.addMessage(s);
  }

  // Score and assemble
  const scored = scoreSegments(segmenter.segments, [], 86400000, 0.7);
  const budgets = allocateBudgets(scored, 100000, 16384, defaultOpts);
  const plan = buildSelectionPlan(budgets, (seg) => {
    return seg.messageIds
      .map(id => segmenter.getMessage(id)?.originalIndex)
      .filter((i): i is number => i !== undefined);
  }, paramsMessages, (msg) => estimateTokens(extractTextContent(msg)));

  const output = plan.indices.map(i => paramsMessages[i]);

  assert(output.length === paramsMessages.length, `all ${paramsMessages.length} messages included`);

  // THE KEY ASSERTION: output messages are the originals, not reconstructions
  for (let i = 0; i < output.length; i++) {
    assert(output[i] === paramsMessages[i], `message ${i} is reference-equal`);
  }

  // Verify the consecutive toolResults are still there (valid in OpenClaw with toolCallId binding)
  const roles = output.map(m => m.role);
  let consecutiveToolResults = 0;
  for (let i = 1; i < roles.length; i++) {
    if (roles[i] === "toolResult" && roles[i - 1] === "toolResult") {
      consecutiveToolResults++;
    }
  }
  // Consecutive toolResults ARE valid when they have toolCallIds binding them to an assistant.
  // The v2 bug was that reconstruction LOST the toolCallId, making them invalid.
  // With pass-through, they keep their toolCallId.
  assert(consecutiveToolResults > 0, "consecutive toolResults exist (valid with toolCallId binding)");

  // Verify all toolResults have toolCallIds
  for (const msg of output) {
    if (msg.role === "toolResult") {
      assert(typeof msg.toolCallId === "string" && msg.toolCallId.length > 0,
        `toolResult at ts=${msg.timestamp} has toolCallId`);
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
