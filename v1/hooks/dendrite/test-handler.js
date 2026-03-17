/**
 * Smoke test for the dendrite hook handler.
 * Run: npx tsx hooks/dendrite/test-handler.js
 */

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const TEST_WORKSPACE = path.join(os.tmpdir(), `dendrite-hook-test-${Date.now()}`);
fs.mkdirSync(TEST_WORKSPACE, { recursive: true });

const SESSION_KEY = "agent:test:discord:direct:test-user";
let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) { console.log(`  ✓ ${name}`); passed++; }
  else { console.log(`  ✗ ${name}`); failed++; }
}

async function main() {

// ── Load handler ──

console.log("\n=== Handler Loading ===\n");

let dendriteHook;
try {
  const mod = await import(path.join(__dirname, "handler.js"));
  // CJS→ESM interop may double-wrap default
  dendriteHook = typeof mod.default === "function" ? mod.default : mod.default?.default;
  assert(typeof dendriteHook === "function", "handler exports a function");
} catch (err) {
  console.error("FATAL: Handler failed to load:", err.message);
  console.error(err.stack);
  process.exit(1);
}

// ── Short message (ignored) ──

console.log("\n=== Short Message (ignored) ===\n");

await dendriteHook({
  type: "message", action: "received", sessionKey: SESSION_KEY,
  timestamp: new Date(), messages: [],
  context: { from: "user", content: "hi", channelId: "discord", workspaceDir: TEST_WORKSPACE },
});

const stateDir = path.join(TEST_WORKSPACE, ".dendrite");
assert(!fs.existsSync(stateDir), "no state created for short message");

// ── Build up messages ──

console.log("\n=== Building Branch Context ===\n");

const msgs = [
  "Let's design the REST API for our project",
  "We need endpoints for users and authentication",
  "Should we use JWT or session cookies for auth?",
  "I think JWT is better for mobile clients",
];

for (const content of msgs) {
  await dendriteHook({
    type: "message", action: "received", sessionKey: SESSION_KEY,
    timestamp: new Date(), messages: [],
    context: { from: "user", content, channelId: "discord", workspaceDir: TEST_WORKSPACE },
  });
}

assert(fs.existsSync(stateDir), "state directory created");

const stateFiles = fs.readdirSync(stateDir).filter((f) => f.endsWith(".json") && !f.includes("archived"));
assert(stateFiles.length === 1, `state file created (${stateFiles.length})`);

if (stateFiles.length > 0) {
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, stateFiles[0]), "utf-8"));
  assert(state.version === 1, "state version is 1");
  assert(state.branches.length >= 1, `has ${state.branches.length} branch(es)`);
  const totalMsgs = state.branches.reduce((s, b) => s + b.messages.length, 0);
  assert(totalMsgs === msgs.length, `${totalMsgs}/${msgs.length} messages stored`);
}

// ── Tangent detection ──

console.log("\n=== Tangent Detection (LLM call) ===\n");

await dendriteHook({
  type: "message", action: "received", sessionKey: SESSION_KEY,
  timestamp: new Date(), messages: [],
  context: {
    from: "user",
    content: "Wait, how does our Docker container networking work? I need to understand the deployment setup.",
    channelId: "discord",
    workspaceDir: TEST_WORKSPACE,
  },
});

{
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, stateFiles[0]), "utf-8"));
  console.log(`  Branches: ${state.branches.map((b) => `${b.name}(${b.messages.length}msgs)`).join(", ")}`);
  assert(state.branches.length >= 1, "handler survived tangent detection");
  if (state.branches.length > 1) {
    console.log(`  Fork detected! New branch: "${state.branches[state.branches.length - 1].name}"`);
  } else {
    console.log(`  (no fork — LLM classified as on-topic)`);
  }
}

// ── Bootstrap injection ──

console.log("\n=== Bootstrap Context Injection ===\n");

{
  const bootstrapFiles = [
    { name: "MEMORY.md", path: path.join(TEST_WORKSPACE, "MEMORY.md"), content: "# Existing Memory\n\nSome facts.", missing: false },
    { name: "AGENTS.md", path: path.join(TEST_WORKSPACE, "AGENTS.md"), content: "# Agent Config", missing: false },
  ];

  await dendriteHook({
    type: "agent", action: "bootstrap", sessionKey: SESSION_KEY,
    timestamp: new Date(), messages: [],
    context: { workspaceDir: TEST_WORKSPACE, bootstrapFiles, cfg: {} },
  });

  const memory = bootstrapFiles.find((f) => f.name === "MEMORY.md");
  assert(memory.content.includes("Dendrite"), "MEMORY.md has dendrite section");
  assert(memory.content.includes("Existing Memory"), "original content preserved");
  assert(!bootstrapFiles.find((f) => f.name === "AGENTS.md").content.includes("Dendrite"), "AGENTS.md untouched");

  // Show what would be injected
  const dendSection = memory.content.split("## Dendrite")[1];
  if (dendSection) {
    console.log("\n  Injected into MEMORY.md:");
    dendSection.split("\n").slice(0, 20).forEach((l) => console.log(`    ${l}`));
  }
}

// ── Session reset ──

console.log("\n=== Session Reset (archive) ===\n");

await dendriteHook({
  type: "command", action: "new", sessionKey: SESSION_KEY,
  timestamp: new Date(), messages: [],
  context: { workspaceDir: TEST_WORKSPACE },
});

{
  const remaining = fs.readdirSync(stateDir).filter((f) => f.endsWith(".json") && !f.includes("archived"));
  const archived = fs.readdirSync(stateDir).filter((f) => f.includes("archived"));
  assert(remaining.length === 0, "active state removed");
  assert(archived.length === 1, `state archived (${archived[0] || "none"})`);
}

// ── Cleanup ──
fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true });

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(40)}\n`);

process.exit(failed > 0 ? 1 : 0);

} // end main

main().catch((err) => { console.error("Error:", err); process.exit(1); });
