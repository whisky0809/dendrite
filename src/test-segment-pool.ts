import { SegmentPool } from "./segment-pool.js";
import { createSegment, type Segment, type SimpleMessage } from "./types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dendrite-pool-test-"));
const segmentsDir = path.join(tmpDir, "dendrite", "segments");

console.log("=== SegmentPool ===\n");

// ── Construction with empty directory ──
console.log("  empty pool:");
const emptyPool = new SegmentPool(tmpDir);
assert(emptyPool.poolSegments.length === 0, "empty dir → no pool segments");

// ── persistSession ──
console.log("\n  persistSession:");

const seg1 = createSegment("topic-one");
seg1.status = "closed";
seg1.embedding = [0.1, 0.2, 0.3];
seg1.summary = "Summary of topic one";
seg1.summaryTokens = 10;
seg1.messageIds = ["msg_1", "msg_2"];
seg1.messageCount = 2;
seg1.tokenCount = 100;
seg1.lastActiveAt = Date.now() - 60000;

const seg2 = createSegment("topic-two");
seg2.status = "closed";
seg2.embedding = [0.4, 0.5, 0.6];
seg2.summary = "Summary of topic two";
seg2.summaryTokens = 12;
seg2.messageIds = ["msg_3", "msg_4", "msg_5"];
seg2.messageCount = 3;
seg2.tokenCount = 200;
seg2.lastActiveAt = Date.now() - 30000;

const activeSeg = createSegment("active-topic");
activeSeg.status = "active";

const transcriptPath = path.join(tmpDir, "session-abc.jsonl");

emptyPool.persistSession("session-abc", [seg1, seg2, activeSeg], "agent-1", transcriptPath);

assert(fs.existsSync(path.join(segmentsDir, "session-abc.json")), "segment file created");

// Verify file content
const fileContent = JSON.parse(fs.readFileSync(path.join(segmentsDir, "session-abc.json"), "utf-8"));
assert(fileContent.sessionId === "session-abc", "file has correct sessionId");
assert(fileContent.agentId === "agent-1", "file has correct agentId");
assert(fileContent.transcriptPath === transcriptPath, "file has correct transcriptPath");
assert(fileContent.segments.length === 2, "only closed segments are persisted (not active)");
assert(fileContent.segments[0].topic === "topic-one", "first segment topic correct");

// Pool should now have segments in memory
assert(emptyPool.poolSegments.length === 2, "pool has 2 segments after persist");
assert(emptyPool.poolSegments[0].sessionId === "session-abc", "pool segments have sessionId");
assert(emptyPool.poolSegments[0].transcriptPath === transcriptPath, "pool segments have transcriptPath");

// ── Loading from disk ──
console.log("\n  load from disk:");

const loadedPool = new SegmentPool(tmpDir);
assert(loadedPool.poolSegments.length === 2, "loaded pool has 2 segments from file");
assert(loadedPool.poolSegments[0].sessionId === "session-abc", "loaded segments have sessionId");
assert(loadedPool.poolSegments[0].embedding.length === 3, "loaded segments have embeddings");

// ── getCombinedSegments ──
console.log("\n  getCombinedSegments:");

const currentSeg = createSegment("current-topic");
currentSeg.status = "active";

const currentClosed = createSegment("current-closed");
currentClosed.status = "closed";

const combined = loadedPool.getCombinedSegments([currentSeg, currentClosed], "current-session");
assert(combined.length === 4, "combined = 2 current + 2 pool segments");
// Current session segments should NOT have sessionId set
assert(combined[0].sessionId === undefined, "current segments: no sessionId");
// Pool segments should have sessionId
const poolInCombined = combined.filter(s => s.sessionId !== undefined);
assert(poolInCombined.length === 2, "pool segments have sessionId in combined array");

// Should exclude segments from the same sessionId as current
const selfPool = new SegmentPool(tmpDir);
const selfCombined = selfPool.getCombinedSegments([currentSeg], "session-abc");
assert(selfCombined.length === 1, "getCombinedSegments excludes same-session segments");

// ── loadMessages ──
console.log("\n  loadMessages:");

// Create a transcript JSONL
const transcriptLines = [
  JSON.stringify({ role: "user", content: [{ type: "text", text: "Hello topic one" }], id: "msg_1", timestamp: 1000 }),
  JSON.stringify({ role: "assistant", content: [{ type: "text", text: "Response to topic one" }], id: "msg_2", timestamp: 2000 }),
  JSON.stringify({ role: "user", content: [{ type: "text", text: "Hello topic two" }], id: "msg_3", timestamp: 3000 }),
  JSON.stringify({ role: "assistant", content: [{ type: "text", text: "Response to topic two" }], id: "msg_4", timestamp: 4000 }),
  JSON.stringify({ role: "user", content: [{ type: "text", text: "More on topic two" }], id: "msg_5", timestamp: 5000 }),
];
fs.writeFileSync(transcriptPath, transcriptLines.join("\n"));

const msgs = loadedPool.loadMessages(transcriptPath, ["msg_1", "msg_3"]);
assert(msgs.length === 2, "loadMessages returns requested messages");
assert(msgs[0].id === "msg_1", "first message ID correct");
assert(msgs[0].content === "Hello topic one", "first message content correct");
assert(msgs[1].id === "msg_3", "second message ID correct");

// loadMessages with missing transcript
const missingMsgs = loadedPool.loadMessages("/nonexistent/path.jsonl", ["msg_1"]);
assert(missingMsgs.length === 0, "missing transcript returns empty array");

// loadMessages with IDs not found
const notFoundMsgs = loadedPool.loadMessages(transcriptPath, ["msg_999"]);
assert(notFoundMsgs.length === 0, "not-found IDs returns empty array");

// ── Corrupt file handling ──
console.log("\n  corrupt file handling:");

fs.writeFileSync(path.join(segmentsDir, "corrupt-session.json"), "not valid json{{{");
const poolWithCorrupt = new SegmentPool(tmpDir);
assert(poolWithCorrupt.poolSegments.length === 2, "corrupt file skipped, valid segments loaded");

// ── Multiple sessions ──
console.log("\n  multiple sessions:");

const seg3 = createSegment("other-topic");
seg3.status = "closed";
seg3.embedding = [0.7, 0.8, 0.9];
seg3.summary = "Other session topic";
seg3.summaryTokens = 8;
seg3.messageIds = ["msg_10"];
seg3.messageCount = 1;
seg3.tokenCount = 50;
seg3.lastActiveAt = Date.now() - 120000;

loadedPool.persistSession("session-def", [seg3], "agent-1", "/tmp/session-def.jsonl");
assert(loadedPool.poolSegments.length === 3, "pool grows with new session");
assert(fs.existsSync(path.join(segmentsDir, "session-def.json")), "second session file created");

// Cleanup
fs.rmSync(tmpDir, { recursive: true });

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
