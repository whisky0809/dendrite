/**
 * Validate branching detection against real Atlas session JSONL files.
 *
 * Replays actual conversations through the LLM drift detector and
 * return detector, showing where forks/returns would have triggered.
 *
 * Usage:
 *   npx tsx src/validate-sessions.ts [session-file-or-dir]
 *
 * Defaults to Atlas sessions dir if no argument given.
 */

import { LLMDriftDetector } from "./llm-drift-detector.js";
import { LLMReturnDetector } from "./return-detector.js";
import { createBranch, createMessage, emptyKnowledgeDiff, BranchNode, Message } from "./types.js";
import * as fs from "fs";
import * as path from "path";

// ── Config ──

const ATLAS_SESSIONS_DIR =
  "/home/whisky/.openclaw/agents/atlas/sessions";

const LLM_CONFIG = {
  model: "moonshot-v1-8k",
  max_history_messages: 10,
  min_messages_before_fork: 3,
};

const RETURN_CONFIG = {
  ...LLM_CONFIG,
  min_messages_before_return: 2,
};

// Rate limiting — Moonshot free tier
const DELAY_MS = 800;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── JSONL parsing ──

interface SessionMessage {
  role: "user" | "assistant";
  content: string;
}

function extractUserText(raw: string): string {
  // Discord messages come wrapped in metadata JSON. Extract the actual content.
  const contentMatch = raw.match(/"content":\s*"((?:[^"\\]|\\.)*)"/);
  if (contentMatch) {
    try {
      // Unescape JSON string
      return JSON.parse(`"${contentMatch[1]}"`);
    } catch {
      return contentMatch[1];
    }
  }
  return raw;
}

function parseSessionFile(filePath: string): SessionMessage[] {
  const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
  const messages: SessionMessage[] = [];

  for (const line of lines) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type !== "message") continue;

    const msg = entry.message;
    if (!msg) continue;

    const role = msg.role as string;
    if (role !== "user" && role !== "assistant") continue;

    // Extract text content
    let text: string;
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = msg.content
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text)
        .join(" ");
    } else {
      continue;
    }

    if (!text.trim()) continue;

    // Skip heartbeat noise
    if (
      text.includes("Read HEARTBEAT.md if it exists") ||
      text.trim() === "HEARTBEAT_OK"
    ) {
      continue;
    }

    // For user messages, try to extract actual content from Discord metadata
    if (role === "user" && text.includes("Conversation info")) {
      text = extractUserText(text);
    }

    // Skip very short or system-like messages
    if (text.trim().length < 5) continue;

    // Truncate very long assistant messages (we only need them for context)
    if (role === "assistant" && text.length > 500) {
      text = text.substring(0, 500) + "…";
    }

    messages.push({ role: role as "user" | "assistant", content: text.trim() });
  }

  return messages;
}

// ── Branch simulation ──

interface BranchEvent {
  message_index: number;
  type: "fork" | "return" | "stay";
  message_preview: string;
  topic?: string;
  reason: string;
  confidence: number;
  branch_name: string;
  drift_score?: number;
}

async function analyzeSession(
  messages: SessionMessage[],
  driftDetector: LLMDriftDetector,
  returnDetector: LLMReturnDetector
): Promise<BranchEvent[]> {
  const events: BranchEvent[] = [];

  // Simulate a branch tree manually
  let branchCounter = 0;
  let currentBranch = createBranch("main", null, null, "main conversation");
  const allBranches: BranchNode[] = [currentBranch];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // Add assistant messages as context without analysis
    if (msg.role === "assistant") {
      const m = createMessage(
        currentBranch.id,
        "agent",
        msg.content,
        emptyKnowledgeDiff()
      );
      currentBranch.messages.push(m);
      continue;
    }

    // User messages get analyzed
    const preview =
      msg.content.length > 100
        ? msg.content.substring(0, 100) + "…"
        : msg.content;

    process.stdout.write(
      `  [${i + 1}/${messages.length}] Analyzing: "${preview.substring(0, 60)}…"\r`
    );

    // Step 1: Check return (if we're on a non-main branch with enough messages)
    const returnCandidates = allBranches.filter(
      (b) =>
        b.id !== currentBranch.id &&
        b.status !== "pruned" &&
        b.status !== "merged" &&
        b.messages.length > 0
    );

    if (
      returnCandidates.length > 0 &&
      currentBranch.messages.length >= RETURN_CONFIG.min_messages_before_return
    ) {
      await sleep(DELAY_MS);
      try {
        const returnResult = await returnDetector.analyze(
          currentBranch,
          returnCandidates,
          msg.content
        );

        if (returnResult.should_return && returnResult.target_branch_id) {
          const target = returnCandidates.find(
            (b) => b.id === returnResult.target_branch_id
          );
          if (target) {
            // Mark current branch as merged
            currentBranch.status = "merged";
            currentBranch = target;
            currentBranch.status = "active";

            const m = createMessage(
              currentBranch.id,
              "user",
              msg.content,
              emptyKnowledgeDiff()
            );
            currentBranch.messages.push(m);

            events.push({
              message_index: i,
              type: "return",
              message_preview: preview,
              reason: returnResult.reason,
              confidence: returnResult.confidence,
              branch_name: target.name,
            });
            continue;
          }
        }
      } catch (err: any) {
        console.error(`\n  ⚠ Return detection error: ${err.message}`);
      }
    }

    // Step 2: Check drift
    if (
      currentBranch.messages.length >= LLM_CONFIG.min_messages_before_fork
    ) {
      await sleep(DELAY_MS);
      try {
        const drift = await driftDetector.analyzeAsync(
          currentBranch,
          msg.content
        );

        if (drift.should_fork) {
          branchCounter++;
          const topicName =
            drift.suggested_topic || `tangent-${branchCounter}`;
          const newBranch = createBranch(
            topicName,
            currentBranch.id,
            null,
            topicName
          );
          currentBranch.children.push(newBranch.id);
          allBranches.push(newBranch);

          // Switch to new branch
          currentBranch.status = "warm";
          currentBranch = newBranch;

          const m = createMessage(
            currentBranch.id,
            "user",
            msg.content,
            emptyKnowledgeDiff()
          );
          currentBranch.messages.push(m);

          events.push({
            message_index: i,
            type: "fork",
            message_preview: preview,
            topic: topicName,
            reason: drift.reason,
            confidence: drift.confidence,
            branch_name: topicName,
            drift_score: drift.drift_score,
          });
          continue;
        }

        // On-topic — just add to current branch
        events.push({
          message_index: i,
          type: "stay",
          message_preview: preview,
          reason: drift.reason,
          confidence: drift.confidence,
          branch_name: currentBranch.name,
          drift_score: drift.drift_score,
        });
      } catch (err: any) {
        console.error(`\n  ⚠ Drift detection error: ${err.message}`);
        events.push({
          message_index: i,
          type: "stay",
          message_preview: preview,
          reason: `Error: ${err.message}`,
          confidence: 0,
          branch_name: currentBranch.name,
        });
      }
    } else {
      events.push({
        message_index: i,
        type: "stay",
        message_preview: preview,
        reason: `Branch too young (${currentBranch.messages.length}/${LLM_CONFIG.min_messages_before_fork} messages)`,
        confidence: 0.5,
        branch_name: currentBranch.name,
      });
    }

    // Add message to current branch
    const m = createMessage(
      currentBranch.id,
      "user",
      msg.content,
      emptyKnowledgeDiff()
    );
    currentBranch.messages.push(m);
  }

  return events;
}

// ── Display ──

function printResults(
  sessionName: string,
  messages: SessionMessage[],
  events: BranchEvent[]
) {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`  Session: ${sessionName}`);
  console.log(`  Messages: ${messages.length} (${messages.filter((m) => m.role === "user").length} user)`);
  console.log(`${"═".repeat(70)}\n`);

  const forks = events.filter((e) => e.type === "fork");
  const returns = events.filter((e) => e.type === "return");

  if (forks.length === 0 && returns.length === 0) {
    console.log("  No branching events detected — conversation stayed on topic.\n");
    return;
  }

  console.log(`  Branching events: ${forks.length} forks, ${returns.length} returns\n`);

  for (const event of events) {
    if (event.type === "stay") continue;

    const icon = event.type === "fork" ? "🔀 FORK" : "↩ RETURN";
    console.log(`  ${icon} [msg ${event.message_index + 1}]`);
    console.log(`    "${event.message_preview}"`);
    if (event.type === "fork") {
      console.log(`    → New branch: "${event.topic}"`);
    } else {
      console.log(`    → Back to: "${event.branch_name}"`);
    }
    console.log(`    Reason: ${event.reason}`);
    console.log(`    Confidence: ${event.confidence.toFixed(2)}`);
    console.log();
  }

  // Print branch timeline
  console.log("  Timeline:");
  let lastBranch = "";
  for (const event of events) {
    if (event.branch_name !== lastBranch) {
      const icon =
        event.type === "fork"
          ? "🔀"
          : event.type === "return"
            ? "↩"
            : "│";
      console.log(`    ${icon} [${event.branch_name}]`);
      lastBranch = event.branch_name;
    }
  }
  console.log();
}

// ── Main ──

async function main() {
  const target = process.argv[2] || ATLAS_SESSIONS_DIR;

  console.log(`\n╔══════════════════════════════════════════════════════════════════╗`);
  console.log(`║   Branching Conversations — Real Session Validation             ║`);
  console.log(`╚══════════════════════════════════════════════════════════════════╝\n`);

  const driftDetector = new LLMDriftDetector(LLM_CONFIG);
  const returnDetector = new LLMReturnDetector(RETURN_CONFIG);

  // Determine files to process
  let files: string[];
  const stat = fs.statSync(target);

  if (stat.isDirectory()) {
    files = fs
      .readdirSync(target)
      .filter((f) => f.endsWith(".jsonl") || f.includes(".jsonl.reset"))
      .sort()
      .map((f) => path.join(target, f));

    // Pick the richest sessions (most non-heartbeat messages)
    const scored = files.map((f) => {
      const msgs = parseSessionFile(f);
      const userMsgs = msgs.filter((m) => m.role === "user");
      return { file: f, total: msgs.length, user: userMsgs.length };
    });
    scored.sort((a, b) => b.user - a.user);

    // Analyze top 3 sessions
    files = scored
      .filter((s) => s.user >= 5)
      .slice(0, 3)
      .map((s) => s.file);

    console.log("Selected sessions (by user message count):");
    for (const f of files) {
      const msgs = parseSessionFile(f);
      console.log(`  ${path.basename(f)} — ${msgs.filter((m) => m.role === "user").length} user msgs`);
    }
    console.log();
  } else {
    files = [target];
  }

  for (const file of files) {
    const messages = parseSessionFile(file);
    if (messages.length < 5) {
      console.log(`Skipping ${path.basename(file)} — too few messages (${messages.length})\n`);
      continue;
    }

    console.log(`\nAnalyzing ${path.basename(file)}...`);
    const events = await analyzeSession(messages, driftDetector, returnDetector);
    process.stdout.write("                                                                          \r");
    printResults(path.basename(file), messages, events);
  }

  console.log("Done.\n");
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
