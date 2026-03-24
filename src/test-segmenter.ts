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

// ── getMessage ──
console.log("\n  getMessage:");

const getMsgSegmenter = new Segmenter({ minMessagesBeforeDrift: 3, maxSegmentMessages: 100, driftThreshold: 0.7 });
const getMsgMsg: SimpleMessage = { id: "gm1", role: "user", content: "test", timestamp: 1 };
getMsgSegmenter.addMessage(getMsgMsg);
assert(getMsgSegmenter.getMessage("gm1")?.content === "test", "getMessage returns stored message");
assert(getMsgSegmenter.getMessage("nonexistent") === undefined, "getMessage returns undefined for missing");

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
