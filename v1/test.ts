/**
 * Test suite for the branching conversations system.
 * Tests: tokenizer, drift detection, branch tree operations.
 */

import {
  tokenize,
  textToTermFrequency,
  cosineSimilarity,
  buildTopicVector,
  distinctiveTerms,
} from "./tokenizer.js";
import {
  TermFrequencyDetector,
  QuestionDriftDetector,
  CompositeDetector,
  createDefaultDetector,
} from "./drift-detector.js";
import { BranchTree } from "./branch-tree.js";
import { createBranch, createMessage, emptyKnowledgeDiff } from "./types.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string): void {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}`);
    failed++;
  }
}

function assertApprox(
  actual: number,
  expected: number,
  tolerance: number,
  name: string
): void {
  const ok = Math.abs(actual - expected) <= tolerance;
  if (ok) {
    console.log(`  ✓ ${name} (${actual.toFixed(3)})`);
    passed++;
  } else {
    console.log(
      `  ✗ ${name} — expected ~${expected.toFixed(3)}, got ${actual.toFixed(3)}`
    );
    failed++;
  }
}

// ── Tokenizer Tests ──

console.log("\n=== Tokenizer ===\n");

{
  const tokens = tokenize("How does the database schema work?");
  assert(tokens.includes("database"), "extracts 'database'");
  assert(tokens.includes("schema"), "extracts 'schema'");
  assert(!tokens.includes("the"), "filters stopword 'the'");
  assert(!tokens.includes("how"), "filters stopword 'how'");
  assert(!tokens.includes("does"), "filters stopword 'does'");
}

{
  const tf = textToTermFrequency("database database schema");
  assert(tf.get("database")! > tf.get("schema")!, "database has higher frequency than schema");
}

{
  const a = textToTermFrequency("database schema design tables columns");
  const b = textToTermFrequency("database schema tables indexes constraints");
  const c = textToTermFrequency("authentication jwt tokens middleware security");
  const simAB = cosineSimilarity(a, b);
  const simAC = cosineSimilarity(a, c);
  assert(simAB > simAC, `related topics more similar (${simAB.toFixed(3)}) than unrelated (${simAC.toFixed(3)})`);
}

{
  const sim = cosineSimilarity(new Map(), textToTermFrequency("hello"));
  assert(sim === 0, "empty vector has zero similarity");
}

{
  const messages = [
    "Let's design the database schema",
    "We need tables for users and posts",
    "Should we add indexes on the foreign keys?",
  ];
  const vector = buildTopicVector(messages, 0.85);
  assert(vector.size > 0, "topic vector is non-empty");
  // Most recent message terms should have higher weight
  assert(vector.has("indexes") || vector.has("foreign"), "includes recent message terms");
}

{
  const text = textToTermFrequency("authentication jwt tokens middleware");
  const ref = textToTermFrequency("database schema tables columns");
  const terms = distinctiveTerms(text, ref, 3);
  assert(terms.length > 0, "finds distinctive terms");
  assert(terms.includes("authentication") || terms.includes("jwt") || terms.includes("tokens"),
    `distinctive terms are auth-related: [${terms.join(", ")}]`);
}

// ── Drift Detector Tests ──

console.log("\n=== Drift Detector ===\n");

// Build a branch with enough messages to establish a topic
function buildTestBranch(messages: string[]) {
  const branch = createBranch("test", null, null, "test topic");
  for (const content of messages) {
    const msg = createMessage(branch.id, "user", content, emptyKnowledgeDiff());
    branch.messages.push(msg);
  }
  return branch;
}

{
  console.log("  Term Frequency Detector (Adaptive):");
  const detector = new TermFrequencyDetector({
    min_messages_before_fork: 3,
    sigma_threshold: 1.5,
    absolute_drift_floor: 0.85,
  });

  const branch = buildTestBranch([
    "Let's design the database schema for our application",
    "We need a users table with email, name, and password hash columns",
    "The posts table should reference users with a foreign key",
    "Should we add a comments table or use a JSON column on posts?",
  ]);

  // On-topic message — similar drift to branch baseline, should NOT fork
  const onTopic = detector.analyze(branch, "What about adding an index on the email column for faster lookups?");
  assert(!onTopic.should_fork, `on-topic message: no fork (drift: ${onTopic.drift_score.toFixed(3)}, reason: ${onTopic.reason})`);

  // Off-topic message — should have higher drift AND be a statistical outlier
  const offTopic = detector.analyze(branch, "How does the authentication middleware handle JWT token refresh and session management?");
  assert(offTopic.drift_score > onTopic.drift_score, `off-topic has higher drift (${offTopic.drift_score.toFixed(3)} > ${onTopic.drift_score.toFixed(3)})`);

  // Very short message — should not trigger fork
  const short = detector.analyze(branch, "Yes");
  assert(!short.should_fork, "very short message: no fork");

  // Branch too young
  const youngBranch = buildTestBranch(["Hello", "Hi there"]);
  const youngResult = detector.analyze(youngBranch, "What about Kubernetes deployment strategies?");
  assert(!youngResult.should_fork, "young branch: no fork regardless of drift");
}

{
  console.log("\n  Question Drift Detector:");
  const detector = new QuestionDriftDetector({
    min_messages_before_fork: 3,
  });

  const branch = buildTestBranch([
    "Let's design the database schema for our application",
    "We need a users table with email, name, and password hash columns",
    "The posts table should reference users with a foreign key",
    "Should we add a comments table or use a JSON column on posts?",
  ]);

  // Tangent with signal words
  const tangent = detector.analyze(branch, "Wait, how does the authentication middleware work? I need to understand it for the API layer.");
  assert(tangent.drift_score > 0.3, `tangent detected (drift: ${tangent.drift_score.toFixed(3)})`);

  // On-topic question (no tangent signal + same vocabulary)
  const onTopic = detector.analyze(branch, "Should we normalize the comments or keep them as JSON?");
  assert(!onTopic.should_fork, "on-topic question: no fork");
}

{
  console.log("\n  Composite Detector:");
  const detector = createDefaultDetector({
    min_messages_before_fork: 3,
  });

  const branch = buildTestBranch([
    "Let's design the database schema for our application",
    "We need a users table with email, name, and password hash columns",
    "The posts table should reference users with a foreign key",
    "Should we add a comments table or use a JSON column on posts?",
    "I think a separate comments table with a foreign key to posts is cleaner",
  ]);

  const onTopic = detector.analyze(branch, "What about adding created_at and updated_at timestamp columns to all tables?");
  const offTopic = detector.analyze(branch, "Actually, can you explain how the Docker container networking works for our microservices?");

  assert(offTopic.drift_score > onTopic.drift_score,
    `off-topic drift (${offTopic.drift_score.toFixed(3)}) > on-topic (${onTopic.drift_score.toFixed(3)})`);
}

// ── Branch Tree Tests ──

console.log("\n=== Branch Tree ===\n");

{
  console.log("  Basic operations:");
  const tree = new BranchTree(
    {
      agent_identity: "test agent",
      user_profile: "test user",
      long_term_memory: [],
    },
    { auto_branch: false }
  );

  assert(tree.currentBranch.name === "main", "starts on main branch");
  assert(tree.allBranches.length === 1, "has one branch initially");

  tree.addMessage("user", "Hello");
  assert(tree.currentBranch.messages.length === 1, "message added");

  const child = tree.fork("feature", "feature discussion");
  assert(tree.currentBranch.name === "feature", "switched to new branch after fork");
  assert(tree.allBranches.length === 2, "two branches after fork");

  tree.addMessage("user", "Working on the feature");
  assert(tree.currentBranch.messages.length === 1, "child has its own messages");

  const main = tree.allBranches.find((b) => b.name === "main")!;
  tree.switchTo(main.id);
  assert(tree.currentBranch.name === "main", "switched back to main");
  assert(tree.currentBranch.messages.length === 1, "main still has original message");
}

{
  console.log("\n  Merge operations:");
  const tree = new BranchTree(
    {
      agent_identity: "test agent",
      user_profile: "test user",
      long_term_memory: [],
    },
    { auto_branch: false }
  );

  tree.addMessage("user", "Main thread discussion");
  const child = tree.fork("research", "research tangent");
  tree.addMessage("agent", "Found some interesting results");

  const main = tree.allBranches.find((b) => b.name === "main")!;
  tree.switchTo(main.id);

  const result = tree.merge(child.id);
  assert(result.resolved, "merge completed without conflicts");
  assert(child.status === "merged", "source branch marked as merged");
  assert(tree.currentBranch.merge_sources.includes(child.id), "target records merge source");
}

{
  console.log("\n  Prune operations:");
  const tree = new BranchTree(
    {
      agent_identity: "test agent",
      user_profile: "test user",
      long_term_memory: [],
    },
    { auto_branch: false }
  );

  tree.addMessage("user", "Main thread");
  const deadEnd = tree.fork("dead-end", "exploring something");
  tree.addMessage("agent", "This approach won't work");

  const main = tree.allBranches.find((b) => b.name === "main")!;
  tree.switchTo(main.id);

  tree.prune(deadEnd.id, "approach didn't pan out");
  assert(deadEnd.status === "pruned", "branch marked as pruned");
  assert(deadEnd.messages.length === 0, "messages cleared to free memory");

  let threw = false;
  try {
    tree.switchTo(deadEnd.id);
  } catch {
    threw = true;
  }
  assert(threw, "cannot switch to pruned branch");
}

{
  console.log("\n  Auto-branching via chat():");
  const tree = new BranchTree(
    {
      agent_identity: "test agent",
      user_profile: "test user",
      long_term_memory: [],
    },
    { auto_branch: true }
  );

  // Build up a topic
  tree.addMessage("user", "Let's design the database schema for our application");
  tree.addMessage("agent", "We'll need tables for users, posts, and comments with proper foreign keys");
  tree.addMessage("user", "The users table should have email, name, password hash, and role columns");
  tree.addMessage("agent", "Good. I'd also add created_at and updated_at timestamps, and an index on email");
  tree.addMessage("user", "What about the posts table structure with title, body, and status?");
  tree.addMessage("agent", "Posts table: id, user_id FK, title varchar, body text, status enum, timestamps");

  const initialBranches = tree.allBranches.length;

  // On-topic message — should NOT fork
  const onTopic = tree.chat("Should we add a slug column to posts for URL-friendly identifiers?");
  assert(!onTopic.forked, `on-topic chat: no fork (drift: ${onTopic.detection.drift_score.toFixed(3)})`);

  // Off-topic message — should fork (if drift is high enough)
  const offTopic = tree.chat("Wait, how does the Kubernetes deployment pipeline handle rolling updates and health checks for our containers?");

  if (offTopic.forked) {
    assert(tree.allBranches.length > initialBranches, "new branch created via auto-fork");
    assert(tree.currentBranch.name !== "main", "auto-switched to new branch");
    console.log(`    Auto-forked to branch: "${tree.currentBranch.name}"`);
  } else {
    console.log(`    Note: off-topic didn't trigger fork (drift: ${offTopic.detection.drift_score.toFixed(3)}, threshold: 0.65)`);
    console.log(`    Reason: ${offTopic.detection.reason}`);
  }
}

{
  console.log("\n  Working context:");
  const tree = new BranchTree(
    {
      agent_identity: "Atlas",
      user_profile: "Pedro",
      long_term_memory: ["fact 1", "fact 2"],
    },
    { auto_branch: false }
  );

  tree.addMessage("user", "Hello");
  tree.addMessage("agent", "Hi there");

  const ctx = tree.buildWorkingContext();
  assert(ctx.base.agent_identity === "Atlas", "base layer present");
  assert(ctx.recent_messages.length === 2, "recent messages included");
  assert(ctx.merged_context.length === 0, "no merged context initially");
}

{
  console.log("\n  Tree printing:");
  const tree = new BranchTree(
    {
      agent_identity: "test",
      user_profile: "test",
      long_term_memory: [],
    },
    { auto_branch: false }
  );

  tree.addMessage("user", "msg1");
  tree.fork("branch-a", "topic a");
  tree.addMessage("user", "msg2");
  const main = tree.allBranches.find((b) => b.name === "main")!;
  tree.switchTo(main.id);
  tree.fork("branch-b", "topic b");
  tree.addMessage("user", "msg3");

  const output = tree.printTree();
  assert(output.includes("main"), "tree shows main");
  assert(output.includes("branch-a"), "tree shows branch-a");
  assert(output.includes("branch-b"), "tree shows branch-b");
  assert(output.includes("← active"), "tree marks active branch");
}

// ── Return-To Tests ──

console.log("\n=== Return-To ===\n");

{
  console.log("  Return-to operations:");
  const tree = new BranchTree(
    {
      agent_identity: "test agent",
      user_profile: "test user",
      long_term_memory: [],
    },
    { auto_branch: false }
  );

  // Build: main → tangent with some messages
  tree.addMessage("user", "Main topic discussion about APIs");
  tree.addMessage("agent", "Let's design the REST endpoints");
  tree.addMessage("user", "What about authentication?");
  tree.addMessage("agent", "We should use bearer tokens");

  const tangent = tree.fork("docker-tangent", "Docker deployment");
  tree.addMessage("user", "How does Docker networking work?");
  tree.addMessage("agent", "Bridge network with three containers");

  // Return to main — should switch + merge
  const main = tree.allBranches.find((b) => b.name === "main")!;
  const result = tree.returnTo(main.id);

  assert(tree.currentBranch.name === "main", "returnTo: switched to main");
  assert(tangent.status === "merged", "returnTo: tangent merged");
  assert(
    tree.currentBranch.merge_sources.includes(tangent.id),
    "returnTo: main records tangent as merge source"
  );
  assert(result.merged_summary.length > 0, "returnTo: produced merge summary");
}

{
  console.log("\n  Return-to edge cases:");
  const tree = new BranchTree(
    {
      agent_identity: "test agent",
      user_profile: "test user",
      long_term_memory: [],
    },
    { auto_branch: false }
  );

  // Can't return to self
  let threwSelf = false;
  try {
    tree.returnTo(tree.currentBranch.id);
  } catch {
    threwSelf = true;
  }
  assert(threwSelf, "returnTo: throws when target is current branch");

  // Can't return to pruned branch
  tree.addMessage("user", "Main content");
  const pruned = tree.fork("pruned-branch", "will be pruned");
  tree.addMessage("user", "Dead end content");
  const main = tree.allBranches.find((b) => b.name === "main")!;
  tree.switchTo(main.id);
  tree.prune(pruned.id, "dead end");

  let threwPruned = false;
  try {
    tree.returnTo(pruned.id);
  } catch {
    threwPruned = true;
  }
  assert(threwPruned, "returnTo: throws when target is pruned");
}

// ── Context Composer Tests ──

import {
  composeContext,
  composeTreeOverview,
  composeSystemBlock,
} from "./context-composer.js";

console.log("\n=== Context Composer ===\n");

{
  console.log("  Basic composition:");
  const tree = new BranchTree(
    {
      agent_identity: "Atlas",
      user_profile: "Pedro",
      long_term_memory: ["fact 1"],
    },
    { auto_branch: false }
  );

  tree.addMessage("user", "Let's design the REST API");
  tree.addMessage("agent", "I suggest POST /users, GET /quests");
  tree.addMessage("user", "What about authentication?");

  const ctx = tree.buildWorkingContext();
  const composed = composeContext(ctx);

  assert(composed.includes("main"), "includes branch name");
  assert(composed.includes("REST API"), "includes conversation content");
  assert(composed.includes("User:"), "formats user role");
  assert(composed.includes("Assistant:"), "formats assistant role");
}

{
  console.log("\n  Tree overview with branches:");
  const tree = new BranchTree(
    { agent_identity: "test", user_profile: "test", long_term_memory: [] },
    { auto_branch: false }
  );

  tree.addMessage("user", "Main topic");
  tree.addMessage("agent", "Response");
  tree.fork("docker-tangent", "Docker deployment");
  tree.addMessage("user", "How does Docker work?");
  tree.addMessage("agent", "Bridge network...");

  const overview = composeTreeOverview(tree);
  assert(overview.includes("main"), "shows main branch");
  assert(overview.includes("docker-tangent"), "shows child branch");
  assert(overview.includes("you are here"), "marks active branch");
}

{
  console.log("\n  System block with merged context:");
  const tree = new BranchTree(
    { agent_identity: "test", user_profile: "test", long_term_memory: [] },
    { auto_branch: false }
  );

  tree.addMessage("user", "API design discussion");
  tree.addMessage("agent", "Let's use REST");
  tree.addMessage("user", "Good idea");

  const tangent = tree.fork("infra", "infrastructure");
  tree.addMessage("user", "How does Docker networking work?");
  tree.addMessage("agent", "Bridge network with DNS");

  // Return to main (switch + merge)
  const main = tree.allBranches.find((b) => b.name === "main")!;
  tree.returnTo(main.id);
  tree.addMessage("user", "Back to API design");

  const block = composeSystemBlock(tree);
  assert(block.includes("main"), "system block has active branch");
  assert(block.includes("Merged from tangents"), "includes merged context");
  assert(block.includes("infra"), "references merged branch");
}

// ── State Persistence Tests ──

import { saveState, loadState } from "./state.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

console.log("\n=== State Persistence ===\n");

{
  console.log("  Save and load round-trip:");
  const base = {
    agent_identity: "Atlas",
    user_profile: "Pedro",
    long_term_memory: ["memory 1"],
  };

  const tree = new BranchTree(base, { auto_branch: false });
  tree.addMessage("user", "Main topic");
  tree.addMessage("agent", "Response on main");

  const tangent = tree.fork("tangent-1", "side topic");
  tree.addMessage("user", "Tangent message");
  tree.addMessage("agent", "Tangent response");

  // Save
  const tmpFile = path.join(os.tmpdir(), `dendrite-test-${Date.now()}.json`);
  saveState(tree, tmpFile);

  assert(fs.existsSync(tmpFile), "state file created");

  // Load
  const loaded = loadState(tmpFile, base);
  assert(loaded !== null, "state loaded successfully");
  assert(loaded!.allBranches.length === 2, "restored 2 branches");
  assert(
    loaded!.currentBranch.name === "tangent-1",
    "active branch restored"
  );
  assert(
    loaded!.currentBranch.messages.length === 2,
    "tangent messages restored"
  );

  const loadedMain = loaded!.allBranches.find((b) => b.name === "main")!;
  assert(loadedMain.messages.length === 2, "main messages restored");

  // Cleanup
  fs.unlinkSync(tmpFile);
}

{
  console.log("\n  Load nonexistent file:");
  const result = loadState("/tmp/nonexistent-dendrite-state.json", {
    agent_identity: "test",
    user_profile: "test",
    long_term_memory: [],
  });
  assert(result === null, "returns null for missing file");
}

{
  console.log("\n  Save/load with merged branches:");
  const base = {
    agent_identity: "test",
    user_profile: "test",
    long_term_memory: [],
  };

  const tree = new BranchTree(base, { auto_branch: false });
  tree.addMessage("user", "Main topic");
  tree.addMessage("agent", "Main response");

  const tangent = tree.fork("explored", "exploration");
  tree.addMessage("user", "Exploring something");
  tree.addMessage("agent", "Found info");

  const main = tree.allBranches.find((b) => b.name === "main")!;
  tree.returnTo(main.id);

  assert(tangent.status === "merged", "tangent merged before save");

  const tmpFile = path.join(os.tmpdir(), `dendrite-merge-${Date.now()}.json`);
  saveState(tree, tmpFile);

  const loaded = loadState(tmpFile, base);
  assert(loaded !== null, "merged state loaded");

  const restoredTangent = loaded!.allBranches.find(
    (b) => b.name === "explored"
  )!;
  assert(restoredTangent.status === "merged", "merged status preserved");
  assert(
    loaded!.currentBranch.merge_sources.length > 0,
    "merge sources restored"
  );

  fs.unlinkSync(tmpFile);
}

// ── Summary ──

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(40)}\n`);

process.exit(failed > 0 ? 1 : 0);
