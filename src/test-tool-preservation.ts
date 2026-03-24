import { allocateBudgets, buildSelectionPlan, selectPartialIndices } from "./assembler.js";
import { createSegment, estimateTokens, extractTextContent, type SimpleMessage } from "./types.js";
import { Segmenter } from "./segmenter.js";
import type { ScoredSegment } from "./scorer.js";

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}

const defaultOpts = { currentSessionId: undefined, pinRecentSegments: 0, maxCrossSessionBudgetRatio: 1.0, pinnedSegmentIds: [] as string[] };

console.log("=== Tool Structure Preservation (v3 index-based) ===\n");

// Helper to build mock AgentMessages
function makeUser(text: string, ts: number): any {
  return { role: "user", content: [{ type: "text", text }], timestamp: ts };
}
function makeAssistantText(text: string, ts: number): any {
  return { role: "assistant", content: [{ type: "text", text }], timestamp: ts };
}
function makeAssistantToolCall(calls: { id: string; name: string }[], ts: number): any {
  return {
    role: "assistant",
    content: calls.map(c => ({ type: "toolCall", id: c.id, name: c.name, arguments: "{}" })),
    timestamp: ts,
  };
}
function makeToolResult(toolCallId: string, text: string, ts: number): any {
  return { role: "toolResult", toolCallId, toolName: "exec", content: [{ type: "text", text }], timestamp: ts };
}

// ── Test 1: Full assembly preserves tool calls via reference equality ──
console.log("  reference equality:");
{
  const paramsMessages = [
    makeUser("Run ls", 100),
    makeAssistantToolCall([{ id: "tc1", name: "exec" }], 101),
    makeToolResult("tc1", "file1.txt\nfile2.txt", 102),
    makeAssistantText("Here are the files.", 103),
    makeUser("Thanks!", 104),
  ];

  // Ingest into segmenter
  const segmenter = new Segmenter({ minMessagesBeforeDrift: 999, maxSegmentMessages: 100, driftThreshold: 0.9 });
  const simples: SimpleMessage[] = [];
  for (let i = 0; i < paramsMessages.length; i++) {
    const role = paramsMessages[i].role;
    const text = extractTextContent(paramsMessages[i]) ||
      (role === "assistant" ? "[Tool calls]" : "");
    if (!text) continue;
    const s: SimpleMessage = {
      id: `msg_${i}`, role, content: text, timestamp: paramsMessages[i].timestamp,
    };
    simples.push(s);
    segmenter.addMessage(s);
  }

  // Reconcile: set originalIndex
  for (const s of simples) {
    const idx = paramsMessages.findIndex(m => m.timestamp === s.timestamp && m.role === s.role);
    s.originalIndex = idx >= 0 ? idx : undefined;
  }

  const scored: ScoredSegment[] = [
    { segment: segmenter.segments[0], score: 1.0, semanticScore: 1, recencyScoreValue: 1 },
  ];
  const budgets = allocateBudgets(scored, 100000, 16384, defaultOpts);
  const plan = buildSelectionPlan(budgets, (seg) => {
    return seg.messageIds
      .map(id => segmenter.getMessage(id)?.originalIndex)
      .filter((i): i is number => i !== undefined);
  }, paramsMessages, (msg) => estimateTokens(extractTextContent(msg)));

  const output = plan.indices.map(i => paramsMessages[i]);

  // Reference equality — exact same objects
  assert(output[0] === paramsMessages[0], "user message is same object");
  assert(output[1] === paramsMessages[1], "toolCall assistant is same object");
  assert(output[2] === paramsMessages[2], "toolResult is same object");

  // Tool structure intact
  assert(output[1].content[0].type === "toolCall", "toolCall content preserved");
  assert(output[1].content[0].id === "tc1", "toolCall ID preserved");
  assert(output[2].toolCallId === "tc1", "toolCallId preserved");
}

// ── Test 2: Multi-tool assistant with consecutive toolResults ──
console.log("\n  multi-tool consecutive results:");
{
  const paramsMessages = [
    makeUser("Run two commands", 200),
    makeAssistantToolCall([{ id: "tc_a", name: "exec" }, { id: "tc_b", name: "read" }], 201),
    makeToolResult("tc_a", "output A", 202),
    makeToolResult("tc_b", "output B", 203),
    makeAssistantText("Both done.", 204),
  ];

  const segmenter = new Segmenter({ minMessagesBeforeDrift: 999, maxSegmentMessages: 100, driftThreshold: 0.9 });
  for (let i = 0; i < paramsMessages.length; i++) {
    const role = paramsMessages[i].role;
    const text = extractTextContent(paramsMessages[i]) ||
      (role === "assistant" ? "[Tool calls]" : "");
    if (!text) continue;
    const s: SimpleMessage = {
      id: `msg_${i}`, role, content: text,
      timestamp: paramsMessages[i].timestamp, originalIndex: i,
    };
    segmenter.addMessage(s);
  }

  const scored: ScoredSegment[] = [
    { segment: segmenter.segments[0], score: 1.0, semanticScore: 1, recencyScoreValue: 1 },
  ];
  const budgets = allocateBudgets(scored, 100000, 16384, defaultOpts);
  const plan = buildSelectionPlan(budgets, (seg) => {
    return seg.messageIds
      .map(id => segmenter.getMessage(id)?.originalIndex)
      .filter((i): i is number => i !== undefined);
  }, paramsMessages, (msg) => estimateTokens(extractTextContent(msg)));

  const output = plan.indices.map(i => paramsMessages[i]);

  assert(output.length === 5, "all 5 messages included");
  // Check consecutive toolResults are present (the v2 bug)
  assert(output[2].role === "toolResult" && output[2].toolCallId === "tc_a", "first toolResult present");
  assert(output[3].role === "toolResult" && output[3].toolCallId === "tc_b", "second toolResult present");
  // No role alternation violation because originals are returned as-is
  assert(output[1].role === "assistant", "assistant before toolResults");
  assert(output[4].role === "assistant", "assistant after toolResults");
}

// ── Test 3: No orphan repair needed ──
console.log("\n  no orphan repair needed:");
{
  // With index-based assembly, tool groups are never broken within a segment.
  // This test verifies there's no toolResult without its assistant in output.
  const paramsMessages = [
    makeUser("hello", 300),
    makeAssistantToolCall([{ id: "tc1", name: "read" }], 301),
    makeToolResult("tc1", "data", 302),
    makeAssistantText("Got it", 303),
    makeUser("new topic", 304),
    makeAssistantText("Sure", 305),
  ];

  // Two segments with a drift split between msg 3 and 4
  const seg1 = createSegment("topic-1");
  seg1.status = "closed";
  seg1.messageIds = ["m0", "m1", "m2", "m3"];
  seg1.messageCount = 4;
  seg1.tokenCount = 100;
  seg1.summary = "First topic.";
  seg1.summaryTokens = 10;

  const seg2 = createSegment("topic-2");
  seg2.status = "active";
  seg2.messageIds = ["m4", "m5"];
  seg2.messageCount = 2;
  seg2.tokenCount = 50;

  const scored: ScoredSegment[] = [
    { segment: seg2, score: 1.0, semanticScore: 1, recencyScoreValue: 1 },
    { segment: seg1, score: 0.2, semanticScore: 0.1, recencyScoreValue: 0.3 },
  ];

  // Tight budget: only active segment fits, seg1 gets summary-only
  const budgets = allocateBudgets(scored, 60, 50, defaultOpts);

  // Map: seg1 messages have indices 0-3, seg2 has 4-5
  const indexMap = new Map([["m0", 0], ["m1", 1], ["m2", 2], ["m3", 3], ["m4", 4], ["m5", 5]]);

  const plan = buildSelectionPlan(budgets, (seg) => {
    return seg.messageIds.map(id => indexMap.get(id)).filter((i): i is number => i !== undefined);
  }, paramsMessages, (msg) => estimateTokens(extractTextContent(msg)));

  const output = plan.indices.map(i => paramsMessages[i]);

  // seg1 should be summary-only, so its messages (incl toolResult) should NOT be in output
  assert(!output.some(m => m.timestamp === 302), "toolResult from summarized segment not in output");
  // seg2 messages should be present
  assert(output.some(m => m.timestamp === 304), "active segment user present");
  assert(output.some(m => m.timestamp === 305), "active segment assistant present");
  // Summary should be in summaryBlocks
  assert(plan.summaryBlocks.length > 0, "summarized segment has summary block");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
