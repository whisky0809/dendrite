import { BranchTree } from "./branch-tree.js";
import { KnowledgeDiff } from "./types.js";
import { randomUUID } from "crypto";

// ── Helper to create knowledge diffs inline ──

function learned(content: string, msgId?: string): KnowledgeDiff {
  return {
    facts_learned: [
      {
        id: randomUUID(),
        content,
        confidence: 0.9,
        source_message: msgId ?? randomUUID(),
      },
    ],
    decisions_made: [],
    questions_resolved: [],
    questions_opened: [],
  };
}

function decided(
  description: string,
  reasoning: string
): KnowledgeDiff {
  return {
    facts_learned: [],
    decisions_made: [
      {
        id: randomUUID(),
        description,
        reasoning,
        source_message: randomUUID(),
      },
    ],
    questions_resolved: [],
    questions_opened: [],
  };
}

// ── Simulate a branching conversation ──

console.log("=== Branching Conversations Demo ===\n");

const tree = new BranchTree({
  agent_identity: "Atlas — Stoic Titan, Vault Librarian, Dungeon Master",
  user_profile: "Pedro — Embedded Systems student, OpenClaw platform operator",
  long_term_memory: [
    "Pedro prefers concise responses",
    "Working on OpenClaw agent platform",
  ],
});

// Main conversation: database schema design
console.log("--- Main thread: Database Schema Design ---\n");

tree.addMessage("user", "Let's design the schema for the quest system database.");
tree.addMessage(
  "agent",
  "We need tables for characters, quests, and quest_progress. Let me sketch the ERD.",
  learned("Quest system needs characters, quests, and quest_progress tables")
);
tree.addMessage("user", "Should we use JSON columns for the stats or normalized columns?");
tree.addMessage(
  "agent",
  "Normalized columns are better for querying — you'll want to filter by STR > 10, etc.",
  decided(
    "Use normalized columns for character stats",
    "Enables direct SQL queries on individual stats"
  )
);

console.log("Current tree:");
console.log(tree.printTree());

// Tangent: user asks about auth (different topic)
console.log("--- Tangent detected: Auth question ---\n");
console.log(
  'User asks: "Wait, how does the auth middleware work? I need to know for the API layer."\n'
);

// System detects this is a different topic → auto-fork
const authBranch = tree.fork("auth-investigation", "Understanding auth middleware for API design");

tree.addMessage("user", "How does the auth middleware work? I need to know for the API layer.");
tree.addMessage(
  "agent",
  "The auth uses JWT with 24h token expiry. Middleware validates on every request.",
  learned("Auth middleware uses JWT with 24h expiry, validates every request")
);
tree.addMessage("user", "Does it support refresh tokens?");
tree.addMessage(
  "agent",
  "Not currently — it's simple token-based. Adding refresh tokens would need a token_version column.",
  learned("No refresh token support yet; would need token_version column")
);

console.log("Current tree:");
console.log(tree.printTree());

// Agent-initiated branch: exploring two approaches
console.log("--- Agent branches: two approaches to refresh tokens ---\n");

const approach1 = tree.fork(
  "refresh-token-stateless",
  "Stateless refresh using rotating JWT pairs"
);
tree.addMessage(
  "agent",
  "Approach 1: Stateless — use rotating JWT pairs. Access token (15min) + refresh token (7d). No server-side storage needed.",
  decided(
    "Stateless refresh token approach",
    "No additional database tables, simpler infrastructure"
  )
);

// Switch back to auth branch to fork second approach
tree.switchTo(authBranch.id);

const approach2 = tree.fork(
  "refresh-token-stateful",
  "Stateful refresh using database-backed sessions"
);
tree.addMessage(
  "agent",
  "Approach 2: Stateful — store refresh tokens in DB with a sessions table. More control (can revoke individual sessions).",
  decided(
    "Stateful refresh token approach",
    "Enables session revocation and audit trail"
  )
);

console.log("Current tree:");
console.log(tree.printTree());

// Merge approach2 into auth branch (agent recommends stateful)
console.log("--- Agent merges: recommending stateful approach ---\n");

tree.switchTo(authBranch.id);
const mergeResult1 = tree.merge(approach2.id);
console.log("Merge result:", mergeResult1.merged_summary);
console.log("Conflicts:", mergeResult1.conflicts.length);

// Prune the other approach
tree.prune(approach1.id, "Stateless approach rejected — need revocation capability");
console.log("\nPruned stateless approach.\n");

// Now return to main conversation, merging auth knowledge back
console.log("--- Returning to main thread ---\n");

// Find the root (main) branch
const mainBranch = tree.allBranches.find((b) => b.name === "main")!;
tree.switchTo(mainBranch.id);
const mergeResult2 = tree.merge(authBranch.id);

console.log("Merge result:", mergeResult2.merged_summary);

// Agent continues main thread with merged knowledge
tree.addMessage(
  "agent",
  "So back to the schema — knowing that auth uses JWT and we'll need a sessions table for refresh tokens, I'd add a token_version column to the characters table and create a separate sessions table. The quest_progress table should reference the session for audit purposes.",
  learned(
    "Schema should include token_version on characters and a sessions table, quest_progress references session"
  )
);

console.log("\n=== Final Tree ===\n");
console.log(tree.printTree());

// Show the working context
console.log("=== Working Context for Active Branch ===\n");
const ctx = tree.buildWorkingContext();
console.log("Base layer:", ctx.base.agent_identity);
console.log("Branch topic:", ctx.branch.topic);
console.log("Recent messages:", ctx.recent_messages.length);
console.log("Merged context:", ctx.merged_context);
console.log(
  "\nKnowledge state:",
  JSON.stringify(
    {
      facts: ctx.branch.knowledge_state.facts_learned.map((f) => f.content),
      decisions: ctx.branch.knowledge_state.decisions_made.map(
        (d) => d.description
      ),
    },
    null,
    2
  )
);
