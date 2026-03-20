import { parseConfigValue, validateConfigKey, rebuildSessions } from "./cli.js";
import { DEFAULT_CONFIG } from "./types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}

console.log("=== CLI helpers ===\n");

console.log("  validateConfigKey:");
assert(validateConfigKey("driftThreshold") === true, "accepts valid key");
assert(validateConfigKey("driftModel") === true, "accepts string key");
assert(validateConfigKey("nonexistent") === false, "rejects unknown key");
assert(validateConfigKey("") === false, "rejects empty string");

console.log("\n  parseConfigValue:");
assert(parseConfigValue("driftThreshold", "0.5") === 0.5, "parses number");
assert(parseConfigValue("reserveTokens", "4096") === 4096, "parses integer");
assert(parseConfigValue("driftModel", "some-model") === "some-model", "parses string");
assert(parseConfigValue("minMessagesBeforeDrift", "5") === 5, "parses integer config");

console.log("\n  rebuildSessions:");

// Create a mock transcript with segment-index
const rebuildDir = fs.mkdtempSync(path.join(os.tmpdir(), "dendrite-rebuild-"));
const sessionsDir = path.join(rebuildDir, "agents", "atlas", "sessions");
fs.mkdirSync(sessionsDir, { recursive: true });

const segOutDir = path.join(rebuildDir, "dendrite", "segments");

const mockTranscript = [
  JSON.stringify({ role: "user", content: [{ type: "text", text: "Hello" }], id: "msg_0", timestamp: 1000 }),
  JSON.stringify({ role: "assistant", content: [{ type: "text", text: "Hi there" }], id: "msg_1", timestamp: 2000 }),
  JSON.stringify({ role: "user", content: [{ type: "text", text: "New topic" }], id: "msg_2", timestamp: 3000 }),
  JSON.stringify({
    dendrite: "segment-index",
    version: 1,
    segments: [
      {
        id: "seg_aaa",
        topic: "greeting",
        embedding: [0.1, 0.2],
        messageIds: ["msg_0", "msg_1"],
        messageCount: 2,
        tokenCount: 50,
        summary: "Said hello",
        summaryTokens: 5,
        lastActiveAt: 2000,
        status: "closed",
      },
      {
        id: "seg_bbb",
        topic: "new-topic",
        embedding: [0.3, 0.4],
        messageIds: ["msg_2"],
        messageCount: 1,
        tokenCount: 30,
        summary: null,
        summaryTokens: 0,
        lastActiveAt: 3000,
        status: "active",
      },
    ],
  }),
].join("\n");

const sessionId = "test-rebuild-session";
fs.writeFileSync(path.join(sessionsDir, `${sessionId}.jsonl`), mockTranscript);

const result = await rebuildSessions({
  agentId: "atlas",
  configDir: rebuildDir,
  force: false,
  dryRun: false,
  summaryModel: "test",
  summaryApiKey: "",
  logger: { info: () => {}, warn: () => {}, error: () => {} },
});

assert(result.sessionsProcessed === 1, "rebuild: processed 1 session");
assert(result.segmentsTotal >= 1, "rebuild: found segments");
assert(fs.existsSync(path.join(segOutDir, `${sessionId}.json`)), "rebuild: created segment file");

// Verify segment file content
const segFile = JSON.parse(fs.readFileSync(path.join(segOutDir, `${sessionId}.json`), "utf-8"));
assert(segFile.segments.length === 1, "rebuild: only closed segments persisted");
assert(segFile.segments[0].topic === "greeting", "rebuild: correct topic");
assert(segFile.segments[0].summary === "Said hello", "rebuild: preserves existing summary");

// Skip if already exists
const result2 = await rebuildSessions({
  agentId: "atlas",
  configDir: rebuildDir,
  force: false,
  dryRun: false,
  summaryModel: "test",
  summaryApiKey: "",
  logger: { info: () => {}, warn: () => {}, error: () => {} },
});
assert(result2.sessionsProcessed === 0, "rebuild: skips existing segment files");

// Force mode
const result3 = await rebuildSessions({
  agentId: "atlas",
  configDir: rebuildDir,
  force: true,
  dryRun: false,
  summaryModel: "test",
  summaryApiKey: "",
  logger: { info: () => {}, warn: () => {}, error: () => {} },
});
assert(result3.sessionsProcessed === 1, "rebuild --force: reprocesses existing");

// Dry run
const result4 = await rebuildSessions({
  agentId: "atlas",
  configDir: rebuildDir,
  force: true,
  dryRun: true,
  summaryModel: "test",
  summaryApiKey: "",
  logger: { info: () => {}, warn: () => {}, error: () => {} },
});
assert(result4.sessionsProcessed === 1, "rebuild --dry-run: reports would process");

fs.rmSync(rebuildDir, { recursive: true });

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
