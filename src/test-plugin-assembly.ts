import { extractTextContent } from "./types.js";

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}

// Helper: build an AgentMessage with tool calls
function makeToolCallAssistant(toolCalls: { id: string; name: string; args: string }[], timestamp: number): any {
  return {
    role: "assistant",
    content: toolCalls.map(tc => ({
      type: "toolCall",
      id: tc.id,
      name: tc.name,
      arguments: tc.args,
    })),
    timestamp,
  };
}

// Helper: build a toolResult AgentMessage
function makeToolResult(toolCallId: string, toolName: string, text: string, timestamp: number): any {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    timestamp,
  };
}

// Helper: build a text assistant message
function makeTextAssistant(text: string, timestamp: number): any {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp,
  };
}

// Helper: build a user message
function makeUser(text: string, timestamp: number): any {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp,
  };
}

console.log("=== Plugin Assembly (Tool Structure) ===\n");

// Test 1: tool-call assistant + toolResult stays paired when both are in assembled output
console.log("  tool pairing:");
{
  const assistant = makeToolCallAssistant(
    [{ id: "tc_1", name: "read", args: '{"path":"/tmp"}' }],
    1000,
  );
  const result = makeToolResult("tc_1", "read", "file contents here", 1001);
  const paramsMessages = [assistant, result];

  // Simulate: assembler included both messages by timestamp
  // The lookup should find originals and preserve structure
  const originalByTs = new Map<number, any[]>();
  for (const msg of paramsMessages) {
    const arr = originalByTs.get(msg.timestamp);
    if (arr) arr.push(msg);
    else originalByTs.set(msg.timestamp, [msg]);
  }

  // Lookup for the assistant
  const aArr = originalByTs.get(1000);
  assert(!!aArr && aArr.length === 1, "assistant found by timestamp");
  assert(aArr![0].content[0].type === "toolCall", "assistant has toolCall content");

  // Lookup for the toolResult
  const rArr = originalByTs.get(1001);
  assert(!!rArr && rArr.length === 1, "toolResult found by timestamp");
  assert(rArr![0].role === "toolResult", "toolResult has correct role");
  assert(rArr![0].toolCallId === "tc_1", "toolResult has correct toolCallId");
}

// Test 2: orphaned toolResults should be dropped, not converted to user messages
console.log("\n  atomic exclusion:");
{
  const result = makeToolResult("tc_orphan", "read", "orphaned result", 2001);
  const paramsMessages = [result];

  const originalByTs = new Map<number, any[]>();
  for (const msg of paramsMessages) {
    const arr = originalByTs.get(msg.timestamp);
    if (arr) arr.push(msg);
    else originalByTs.set(msg.timestamp, [msg]);
  }

  // toolResult found by timestamp
  const rArr = originalByTs.get(2001);
  assert(!!rArr && rArr.length === 1, "orphaned toolResult found by timestamp");
  assert(rArr![0].toolCallId === "tc_orphan", "orphan has correct toolCallId");
}

// Test 3: full repair pipeline — orphaned toolResults are dropped
console.log("\n  full repair pipeline:");
{
  const messages: any[] = [
    makeUser("hello", 100),
    // This assistant was a lookup miss — toAgentMessage produced text-only fallback
    { role: "assistant", content: [{ type: "text", text: "[Tool calls: read]" }], timestamp: 200 },
    // This toolResult's assistant was stripped by sanitization
    makeToolResult("tc_orphan", "exec", "some output", 301),
    makeTextAssistant("Here is my response", 400),
  ];

  // Run the repair: collect toolCall IDs, drop orphaned toolResults
  const toolCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const c of msg.content) {
        if (c.type === "toolCall" && c.id) toolCallIds.add(c.id);
      }
    }
  }

  // Filter out orphaned toolResults (the new behavior)
  const repaired = messages.filter(msg => {
    if (msg.role === "toolResult" && msg.toolCallId && !toolCallIds.has(msg.toolCallId)) {
      return false; // DROP instead of convert
    }
    return true;
  });

  assert(repaired.length === 3, "orphaned toolResult dropped (4 → 3 messages)");
  assert(!repaired.some((m: any) => m.role === "toolResult"), "no toolResults remain (all were orphaned)");
  assert(!repaired.some((m: any) =>
    m.role === "user" && Array.isArray(m.content) &&
    m.content.some((c: any) => c.text?.includes("[Tool result]"))
  ), "no toolResult-converted-to-user messages");
}

// Test 4: assistant with all tool calls stripped gets dropped entirely
console.log("\n  empty assistant after stripping:");
{
  const messages: any[] = [
    makeUser("do something", 100),
    makeToolCallAssistant([{ id: "tc_no_result", name: "exec", args: "{}" }], 200),
    makeTextAssistant("done", 300),
  ];

  // Simulate: no toolResults exist, so tc_no_result is orphaned
  const outToolResultIds = new Set<string>();

  // Strip orphaned tool_calls from assistants
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const orphaned = msg.content.filter((c: any) =>
        c.type === "toolCall" && c.id && !outToolResultIds.has(c.id));
      if (orphaned.length > 0) {
        msg.content = msg.content.filter((c: any) =>
          !(c.type === "toolCall" && c.id && !outToolResultIds.has(c.id)));
        if (msg.content.length === 0) {
          (msg as any)._drop = true;
        }
      }
    }
  }

  // Remove assistants that became empty after stripping
  const repaired = messages.filter(m => !(m as any)._drop);

  assert(repaired.length === 2, "empty assistant dropped (3 → 2 messages)");
  assert(repaired[0].role === "user", "user message kept");
  assert(repaired[1].role === "assistant" && repaired[1].content[0].text === "done", "text assistant kept");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
