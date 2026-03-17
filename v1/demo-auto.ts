/**
 * Demo: Automatic branching based on semantic drift detection.
 *
 * Simulates a realistic conversation where the user naturally drifts
 * between topics. The system automatically detects these shifts and
 * forks/merges branches — all invisible to the user experience.
 */

import { BranchTree } from "./branch-tree.js";
import { emptyKnowledgeDiff } from "./types.js";
import { randomUUID } from "crypto";

// ── Helpers ──

function log(msg: string) {
  console.log(msg);
}

function hr() {
  console.log("─".repeat(60));
}

function showDetection(tree: BranchTree) {
  const d = tree.last_detection;
  if (!d) return;
  const bar = "█".repeat(Math.round(d.drift_score * 20)).padEnd(20, "░");
  console.log(`  drift: [${bar}] ${d.drift_score.toFixed(3)}  ${d.reason}`);
}

// ── Simulate the conversation ──

console.log("\n╔══════════════════════════════════════════════════════════╗");
console.log("║     Automatic Branching Conversation Demo               ║");
console.log("╚══════════════════════════════════════════════════════════╝\n");

const tree = new BranchTree(
  {
    agent_identity: "Atlas — development assistant",
    user_profile: "Pedro — working on OpenClaw",
    long_term_memory: [],
  },
  { auto_branch: true }
);

// Conversation script: a natural back-and-forth that drifts between topics
const script: Array<{
  role: "user" | "agent";
  content: string;
  note?: string;
}> = [
  // ── Phase 1: Establish a topic (API design) ──
  {
    role: "user",
    content:
      "I want to design the REST API endpoints for the quest system. Players need to create characters, accept quests, and track progress.",
    note: "Establishing topic: API design for quest system",
  },
  {
    role: "agent",
    content:
      "For the quest system API, I'd suggest these endpoints: POST /characters for creation, GET /quests for listing available quests, POST /quests/:id/accept for accepting, and PATCH /quests/:id/progress for updates. We should use JSON:API format for consistency.",
  },
  {
    role: "user",
    content:
      "Good. What about authentication on these endpoints? Should each one require a bearer token?",
    note: "Deepening the same topic (not a tangent)",
  },
  {
    role: "agent",
    content:
      "Yes, all quest endpoints should require authentication. Use bearer tokens in the Authorization header. The POST /characters endpoint could also serve as the initial registration flow, returning the token on creation.",
  },
  {
    role: "user",
    content:
      "What status codes should we return for quest acceptance? Can a player accept a quest they already have?",
  },
  {
    role: "agent",
    content:
      "Return 201 Created on first accept, 409 Conflict if already accepted. For completed quests, return 410 Gone. Add an idempotency key header to handle retries safely.",
  },

  // ── Phase 2: Topic drift — Docker deployment question ──
  {
    role: "user",
    content:
      "Actually, wait — how is our Docker deployment configured? I need to understand the container networking before I decide on service discovery for these API endpoints.",
    note: "TANGENT: Docker/deployment is a different domain",
  },
  {
    role: "agent",
    content:
      "The Docker setup uses a bridge network with three containers: the API server, PostgreSQL, and Redis for caching. Service discovery is handled through Docker DNS — containers reference each other by service name in docker-compose.",
  },
  {
    role: "user",
    content:
      "Is there a reverse proxy in front? I want to make sure the quest API routing works with whatever proxy we have.",
    note: "Still on Docker tangent",
  },
  {
    role: "agent",
    content:
      "Yes, Nginx sits in front as a reverse proxy. It handles TLS termination and routes /api/* to the API container on port 3000. Quest endpoints would automatically be available under /api/quests/* without additional config.",
  },

  // ── Phase 3: Return to API design with merged knowledge ──
  {
    role: "user",
    content:
      "Okay cool, so the Nginx proxy handles routing. Back to the API design — given that setup, should we version our quest endpoints like /api/v1/quests or just /api/quests?",
    note: "RETURN: Back to API design, carrying Docker knowledge",
  },
  {
    role: "agent",
    content:
      "Since Nginx handles the routing and we might need backwards compatibility later, go with /api/v1/quests. It costs nothing now and saves a painful migration later. The Nginx config can easily map /api/v1/* to the same backend.",
  },

  // ── Phase 4: Completely different topic ──
  {
    role: "user",
    content:
      "By the way, I've been thinking about the XP calculation formula for the quest system gamification. Should defeating a higher-level quest give exponentially more XP, or should it be linear with a difficulty multiplier?",
    note: "TANGENT: Game design / math, not API design",
  },
  {
    role: "agent",
    content:
      "A hybrid approach works best: base XP scales linearly with quest level, but apply a difficulty multiplier that grows with the gap between player level and quest level. Something like: XP = base * quest_level * (1 + 0.5 * max(0, quest_level - player_level)). This rewards challenge without making easy quests worthless.",
  },
];

// ── Run the conversation ──

for (const turn of script) {
  hr();
  if (turn.note) {
    log(`  📌 ${turn.note}`);
  }
  log(`  ${turn.role === "user" ? "Pedro" : "Atlas"}: "${turn.content.substring(0, 80)}${turn.content.length > 80 ? "..." : ""}"`);

  if (turn.role === "user") {
    const result = tree.chat(turn.content);
    showDetection(tree);
    if (result.forked) {
      log(`\n  🔀 AUTO-FORK → branch "${result.fork_branch!.name}"`);
    }
  } else {
    tree.addMessage("agent", turn.content);
  }
}

hr();

// ── Show final state ──

console.log("\n╔══════════════════════════════════════════════════════════╗");
console.log("║     Final Branch Tree                                    ║");
console.log("╚══════════════════════════════════════════════════════════╝\n");
console.log(tree.printTree());

console.log("Active branch:", tree.currentBranch.name);
console.log("Total branches:", tree.allBranches.length);
console.log(
  "Messages per branch:",
  tree.allBranches.map((b) => `${b.name}: ${b.messages.length}`).join(", ")
);

// Show what the context looks like
console.log("\n╔══════════════════════════════════════════════════════════╗");
console.log("║     Working Context Snapshot                             ║");
console.log("╚══════════════════════════════════════════════════════════╝\n");
const ctx = tree.buildWorkingContext();
console.log("Branch topic:", ctx.branch.topic);
console.log("Recent messages:", ctx.recent_messages.length);
if (ctx.merged_context.length > 0) {
  console.log("Merged context from other branches:");
  for (const mc of ctx.merged_context) {
    console.log(`  • ${mc}`);
  }
}
