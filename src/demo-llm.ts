/**
 * Demo: LLM-powered automatic branching.
 *
 * Uses Gemini embeddings for semantic similarity scoring
 * and Moonshot LLM for drift classification + topic naming.
 *
 * Run: GEMINI_API_KEY=... MOONSHOT_API_KEY=... npx tsx src/demo-llm.ts
 * Or: npx tsx src/demo-llm.ts --mode llm       (Moonshot only)
 *     npx tsx src/demo-llm.ts --mode embedding  (Gemini only)
 */

import { LLMBranchTree } from "./llm-branch-tree.js";

// Parse mode from CLI args
const modeArg = process.argv.find((_, i) => process.argv[i - 1] === "--mode");
const mode = (modeArg as "llm" | "embedding" | "both") || "both";

console.log(`\n╔══════════════════════════════════════════════════════════╗`);
console.log(`║     LLM-Powered Branching Demo (mode: ${mode.padEnd(9)})          ║`);
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

// Conversation script
const script: Array<{
  role: "user" | "agent";
  content: string;
  note?: string;
}> = [
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
  {
    role: "user",
    content: "Wait, how is our Docker deployment set up? I need to understand the container networking before deciding on service discovery.",
    note: "TANGENT → Docker/infra (should fork)",
  },
  {
    role: "agent",
    content: "Docker uses a bridge network with three containers: API server, PostgreSQL, and Redis. Service discovery via Docker DNS — containers reference each other by service name.",
  },
  {
    role: "user",
    content: "Is there a reverse proxy handling TLS termination?",
    note: "Continuing Docker tangent — should NOT fork again",
  },
  {
    role: "agent",
    content: "Yes, Nginx handles TLS and routes /api/* to the API container on port 3000.",
  },
  {
    role: "user",
    content: "By the way, I've been thinking about the XP formula. Should defeating harder quests give exponentially more XP or linear with a multiplier?",
    note: "TANGENT → game design / math (should fork)",
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
      console.log(`  → ${result.detection.reason}`);
      if (result.forked) {
        console.log(`  🔀 AUTO-FORK → "${result.fork_branch!.name}"`);
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
    tree.allBranches.map((b) => `${b.name}: ${b.messages.length}`).join(", ")
  );
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
