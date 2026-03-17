/**
 * Dendrite Inspector — view the current branch tree and recent events.
 *
 * Usage:
 *   npx tsx src/inspect.ts                    # auto-detect workspace state
 *   npx tsx src/inspect.ts --log              # tail the event log
 *   npx tsx src/inspect.ts --log --follow     # live follow the log
 *   npx tsx src/inspect.ts --state <file>     # inspect a specific state file
 *   npx tsx src/inspect.ts --dir <workspace>  # use a specific workspace
 */

import * as fs from "fs";
import * as path from "path";
import { loadState } from "./state.js";
import { composeSystemBlock } from "./context-composer.js";

const args = process.argv.slice(2);

const dirArg = args.find((_, i) => args[i - 1] === "--dir");
const WORKSPACE = dirArg || process.env.DENDRITE_WORKSPACE || "/home/whisky/.openclaw/workspace";
const STATE_DIR = path.join(WORKSPACE, ".dendrite");

const showLog = args.includes("--log");
const followLog = args.includes("--follow");
const stateFileArg = args.find((_, i) => args[i - 1] === "--state");

// ── Log viewer ──

if (showLog) {
  const logPath = path.join(STATE_DIR, "dendrite.log");

  if (!fs.existsSync(logPath)) {
    console.log("No dendrite log found yet. Start talking to Atlas first.\n");
    process.exit(0);
  }

  if (followLog) {
    console.log(`Following ${logPath} (Ctrl+C to stop)\n`);

    // Print existing content
    const existing = fs.readFileSync(logPath, "utf-8");
    if (existing.trim()) {
      for (const line of existing.trim().split("\n").slice(-20)) {
        printLogLine(line);
      }
    }

    // Watch for new lines
    let size = fs.statSync(logPath).size;
    fs.watchFile(logPath, { interval: 500 }, () => {
      const newSize = fs.statSync(logPath).size;
      if (newSize > size) {
        const fd = fs.openSync(logPath, "r");
        const buf = Buffer.alloc(newSize - size);
        fs.readSync(fd, buf, 0, buf.length, size);
        fs.closeSync(fd);
        const newContent = buf.toString("utf-8");
        for (const line of newContent.split("\n").filter(Boolean)) {
          printLogLine(line);
        }
        size = newSize;
      }
    });
  } else {
    const content = fs.readFileSync(logPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    console.log(`\n🌿 Dendrite Log (${lines.length} events)\n`);
    for (const line of lines.slice(-30)) {
      printLogLine(line);
    }
    if (lines.length > 30) {
      console.log(`  ... ${lines.length - 30} earlier events omitted`);
    }
    console.log();
  }
  if (!followLog) showState(stateFileArg);
  process.exit(0);
}

// ── State inspector ──

showState(stateFileArg);

function showState(specificFile?: string) {
  let statePath: string;

  if (specificFile) {
    statePath = specificFile;
  } else {
    // Find the most recent state file
    if (!fs.existsSync(STATE_DIR)) {
      console.log("\nNo dendrite state found. The hook hasn't processed any messages yet.\n");
      console.log(`Expected state at: ${STATE_DIR}/\n`);
      return;
    }

    const files = fs
      .readdirSync(STATE_DIR)
      .filter((f) => f.endsWith(".json") && !f.includes("archived"))
      .map((f) => ({
        name: f,
        path: path.join(STATE_DIR, f),
        mtime: fs.statSync(path.join(STATE_DIR, f)).mtime,
      }))
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    if (files.length === 0) {
      console.log("\nNo active branch state. Session may have been reset.\n");

      // Show archived files
      const archived = fs
        .readdirSync(STATE_DIR)
        .filter((f) => f.includes("archived"));
      if (archived.length > 0) {
        console.log(`Archived states (${archived.length}):`);
        for (const a of archived.slice(-5)) {
          console.log(`  ${a}`);
        }
        console.log(`\nUse --state <file> to inspect an archived state.\n`);
      }
      return;
    }

    statePath = files[0].path;
    console.log(`\nState file: ${files[0].name}`);
  }

  if (!fs.existsSync(statePath)) {
    console.log(`File not found: ${statePath}`);
    return;
  }

  const base = {
    agent_identity: "",
    user_profile: "",
    long_term_memory: [],
  };

  const tree = loadState(statePath, base);
  if (!tree) {
    console.log("Failed to load state.");
    return;
  }

  const branches = tree.allBranches;
  const current = tree.currentBranch;

  console.log(`\n╔══════════════════════════════════════════════════╗`);
  console.log(`║   🌿 Dendrite — Branch Tree Inspector            ║`);
  console.log(`╚══════════════════════════════════════════════════╝\n`);

  // Tree structure
  console.log(tree.printTree());

  // Branch details
  console.log(`Active: ${current.name}`);
  console.log(`Branches: ${branches.length} total`);

  const merged = branches.filter((b) => b.status === "merged").length;
  const pruned = branches.filter((b) => b.status === "pruned").length;
  if (merged > 0 || pruned > 0) {
    console.log(`  Merged: ${merged}, Pruned: ${pruned}`);
  }

  console.log(
    `Messages: ${branches.map((b) => `${b.name}(${b.messages.length})`).join(", ")}`
  );

  // What the agent would see
  console.log(`\n── Context that would be injected ──\n`);
  const block = composeSystemBlock(tree, { max_recent_messages: 10 });
  console.log(block);
  console.log();
}

function printLogLine(line: string) {
  const spaceIdx = line.indexOf(" ");
  if (spaceIdx === -1) return;

  const ts = line.substring(0, spaceIdx);
  const time = ts.substring(11, 19); // HH:MM:SS

  try {
    const data = JSON.parse(line.substring(spaceIdx + 1));
    const icon =
      data.event === "fork"
        ? "🔀"
        : data.event === "return"
          ? "↩ "
          : data.event === "stay"
            ? "│ "
            : data.event === "bootstrap"
              ? "📋"
              : data.event === "session_reset"
                ? "🔄"
                : data.event === "error"
                  ? "⚠ "
                  : "  ";

    const msg = data.message ? ` "${data.message.substring(0, 50)}..."` : "";
    const detail =
      data.event === "fork"
        ? `${data.from_branch} → ${data.new_branch}${msg}`
        : data.event === "return"
          ? `${data.from_branch} → ${data.to_branch}${msg}`
          : data.event === "stay"
            ? `[${data.branch}]${msg}`
            : data.event === "bootstrap"
              ? `${data.branches} branches, active: ${data.active}`
              : data.event === "session_reset"
                ? `action: ${data.action}`
                : data.event === "error"
                  ? `${data.error}`
                  : JSON.stringify(data);

    console.log(`  ${time} ${icon} ${detail}`);
  } catch {
    console.log(`  ${time}    ${line.substring(spaceIdx + 1)}`);
  }
}
