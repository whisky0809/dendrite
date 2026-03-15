/**
 * Demo: LLM-powered automatic branching with return detection.
 *
 * Shows the full loop: fork → explore → return → merge
 *
 * Run: npx tsx src/demo-llm.ts --mode llm
 */

import { LLMBranchTree } from "./llm-branch-tree.js";

// Parse mode from CLI args
const modeArg = process.argv.find((_, i) => process.argv[i - 1] === "--mode");
const mode = (modeArg as "llm" | "embedding" | "both") || "both";

console.log(`\n╔══════════════════════════════════════════════════════════╗`);
console.log(`║   Branching Conversations — Full Loop Demo               ║`);
console.log(`║   (mode: ${mode.padEnd(9)})                                      ║`);
console.log(`╚══════════════════════════════════════════════════════════╝\n`);

const tree = new LLMBranchTree(
  {
    agent_identity: "Atlas — development assistant",
    user_profile: "Pedro — Embedded Systems student, OpenClaw developer",
    long_term_memory: [],
  },
  {
    mode,
    auto_branch: true,
    llm: { model: "moonshot-v1-8k" },
  }
);

// Conversation script — shows fork, continue, return, and fork again
const script: Array<{
  role: "user" | "agent";
  content: string;
  note?: string;
}> = [
  // ── Phase 1: Establish API design topic ──
  {
    role: "user",
    content: "I want to design the REST API endpoints for the quest system. Players need to create characters, accept quests, and track progress.",
    note: "Establishing topic: API design",
  },
  {
    role: "agent",
    content: "For the quest system API, I'd suggest: POST /characters, GET /quests, POST /quests/:id/accept, and PATCH /quests/:id/progress. We should use JSON:API format.",
  },
  {
    role: "user",
    content: "Good. Should each endpoint require a bearer token for authentication?",
    note: "Deepening same topic — should NOT fork",
  },
  {
    role: "agent",
    content: "Yes, all quest endpoints should require bearer tokens. The POST /characters endpoint could double as registration, returning the token on creation.",
  },
  {
    role: "user",
    content: "What status codes should we return for quest acceptance? What if a player already accepted it?",
    note: "Still on topic — should NOT fork",
  },
  {
    role: "agent",
    content: "201 Created on first accept, 409 Conflict if already accepted, 410 Gone for completed quests. Add an idempotency key for retries.",
  },

  // ── Phase 2: Docker tangent ──
  {
    role: "user",
    content: "Wait, how is our Docker deployment set up? I need to understand the container networking before deciding on service discovery.",
    note: "TANGENT → Docker/infra (should FORK)",
  },
  {
    role: "agent",
    content: "Docker uses a bridge network with three containers: API server, PostgreSQL, and Redis. Service discovery via Docker DNS — containers reference each other by service name.",
  },
  {
    role: "user",
    content: "Is there a reverse proxy handling TLS termination?",
    note: "Continuing Docker tangent — should NOT fork",
  },
  {
    role: "agent",
    content: "Yes, Nginx handles TLS and routes /api/* to the API container on port 3000.",
  },

  // ── Phase 3: Return to API design ──
  {
    role: "user",
    content: "Okay great, so Nginx handles routing. Back to the API — given that setup, should we version our quest endpoints like /api/v1/quests?",
    note: "RETURN → back to API design (should RETURN to main)",
  },
  {
    role: "agent",
    content: "Since Nginx handles routing, go with /api/v1/quests. The config can map /api/v1/* to the same backend without changes.",
  },

  // ── Phase 4: XP formula tangent ──
  {
    role: "user",
    content: "By the way, I've been thinking about the XP calculation formula. Should defeating harder quests give exponentially more XP or linear with a multiplier?",
    note: "TANGENT → game design / math (should FORK)",
  },
  {
    role: "agent",
    content: "Hybrid: base XP scales linearly, difficulty multiplier grows with the level gap. XP = base * quest_level * (1 + 0.5 * max(0, quest_level - player_level)).",
  },
];

// Run it
async function main() {
  for (const turn of script) {
    console.log("─".repeat(60));
    if (turn.note) {
      console.log(`  📌 ${turn.note}`);
    }

    const preview = turn.content.length > 80
      ? turn.content.substring(0, 80) + "..."
      : turn.content;

    if (turn.role === "user") {
      console.log(`  Pedro: "${preview}"`);
      const result = await tree.chat(turn.content);

      if (result.returned) {
        console.log(`  ↩ AUTO-RETURN → "${tree.currentBranch.name}" (from "${result.returned_from!.name}")`);
        console.log(`    ${result.return_detection!.reason}`);
      } else if (result.forked) {
        console.log(`  🔀 AUTO-FORK → "${result.fork_branch!.name}"`);
        console.log(`    ${result.detection.reason}`);
      } else {
        console.log(`  → ${result.detection.reason}`);
      }
    } else {
      console.log(`  Atlas: "${preview}"`);
      tree.addResponse(turn.content);
    }
  }

  console.log("─".repeat(60));

  console.log(`\n╔══════════════════════════════════════════════════════════╗`);
  console.log(`║     Final Branch Tree                                    ║`);
  console.log(`╚══════════════════════════════════════════════════════════╝\n`);
  console.log(tree.printTree());
  console.log("Active branch:", tree.currentBranch.name);
  console.log("Total branches:", tree.allBranches.length);
  console.log(
    "Messages per branch:",
    tree.allBranches
      .map((b) => `${b.name}(${b.status}): ${b.messages.length}`)
      .join(", ")
  );
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
