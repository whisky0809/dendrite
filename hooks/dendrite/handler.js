/**
 * Dendrite — OpenClaw conversation branching hook.
 *
 * Events:
 *   message:received  → detect drift/return, update branch state
 *   agent:bootstrap   → inject branch context into MEMORY.md
 *   command:new/reset  → archive branch state for the ending session
 */

import path from "node:path";
import fs from "node:fs";

// Import dendrite from compiled dist
const DENDRITE_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  ".."
);
const DIST = path.join(DENDRITE_ROOT, "dist");

// Dynamic imports from dendrite dist (ESM)
const { BranchTree } = await import(path.join(DIST, "branch-tree.js"));
const { LLMDriftDetector } = await import(
  path.join(DIST, "llm-drift-detector.js")
);
const { LLMReturnDetector } = await import(
  path.join(DIST, "return-detector.js")
);
const { composeSystemBlock } = await import(
  path.join(DIST, "context-composer.js")
);
const { saveState, loadState } = await import(path.join(DIST, "state.js"));
const { emptyKnowledgeDiff } = await import(path.join(DIST, "types.js"));

// ── State management ──

const STATE_DIR_NAME = ".dendrite";

function resolveStateDir(workspaceDir) {
  return path.join(workspaceDir || process.env.HOME || "/tmp", STATE_DIR_NAME);
}

function resolveStatePath(stateDir, sessionKey) {
  // Sanitize session key for filename
  const safe = sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 100);
  return path.join(stateDir, `${safe}.json`);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ── Config resolution ──

function resolveConfig(event) {
  // Try to get hook-specific config from openclaw.json
  const cfg = event.context?.cfg;
  const hookConfig = cfg?.hooks?.internal?.entries?.dendrite || {};

  return {
    mode: hookConfig.mode || "llm",
    model: hookConfig.model || "moonshot-v1-8k",
    min_messages_before_fork: hookConfig.min_messages_before_fork || 3,
    min_messages_before_return: hookConfig.min_messages_before_return || 2,
    max_recent_messages: hookConfig.max_recent_messages || 15,
  };
}

// ── Detector cache (avoid re-creating per event) ──

let cachedDriftDetector = null;
let cachedReturnDetector = null;

function getDriftDetector(config) {
  if (!cachedDriftDetector) {
    cachedDriftDetector = new LLMDriftDetector({
      model: config.model,
      min_messages_before_fork: config.min_messages_before_fork,
    });
  }
  return cachedDriftDetector;
}

function getReturnDetector(config) {
  if (!cachedReturnDetector) {
    cachedReturnDetector = new LLMReturnDetector({
      model: config.model,
      min_messages_before_return: config.min_messages_before_return,
    });
  }
  return cachedReturnDetector;
}

// ── Load or create branch tree ──

function loadOrCreateTree(statePath) {
  const base = {
    agent_identity: "",
    user_profile: "",
    long_term_memory: [],
  };

  const tree = loadState(statePath, base);
  if (tree) return tree;

  return new BranchTree(base, { auto_branch: false });
}

// ── Event: message:received ──

async function handleMessageReceived(event) {
  const content = event.context?.content;
  if (!content || typeof content !== "string") return;
  if (content.trim().length < 5) return;

  const config = resolveConfig(event);
  const workspaceDir = event.context?.workspaceDir || process.env.HOME;
  const stateDir = resolveStateDir(workspaceDir);
  ensureDir(stateDir);

  const statePath = resolveStatePath(stateDir, event.sessionKey);
  const tree = loadOrCreateTree(statePath);
  const branch = tree.currentBranch;

  try {
    // Step 1: Check return to previous branch
    const returnCandidates = tree.allBranches.filter(
      (b) =>
        b.id !== branch.id &&
        b.status !== "pruned" &&
        b.status !== "merged" &&
        b.messages.length > 0
    );

    if (
      returnCandidates.length > 0 &&
      branch.messages.length >= config.min_messages_before_return
    ) {
      const returnDetector = getReturnDetector(config);
      const returnResult = await returnDetector.analyze(
        branch,
        returnCandidates,
        content
      );

      if (returnResult.should_return && returnResult.target_branch_id) {
        tree.returnTo(returnResult.target_branch_id);
        tree.addMessage("user", content, emptyKnowledgeDiff());
        saveState(tree, statePath);
        return;
      }
    }

    // Step 2: Check drift (new tangent)
    if (branch.messages.length >= config.min_messages_before_fork) {
      const driftDetector = getDriftDetector(config);
      const drift = await driftDetector.analyzeAsync(branch, content);

      if (drift.should_fork) {
        const topic = drift.suggested_topic || "tangent";
        tree.fork(topic, topic);
      }
    }

    // Step 3: Add message to current branch
    tree.addMessage("user", content, emptyKnowledgeDiff());
    saveState(tree, statePath);
  } catch (err) {
    // Don't crash the hook on detection errors — just add the message
    tree.addMessage("user", content, emptyKnowledgeDiff());
    saveState(tree, statePath);
  }
}

// ── Event: agent:bootstrap ──

function handleBootstrap(event) {
  const context = event.context;
  if (!context?.bootstrapFiles) return;

  const workspaceDir = context.workspaceDir;
  const stateDir = resolveStateDir(workspaceDir);
  const statePath = resolveStatePath(stateDir, event.sessionKey);

  if (!fs.existsSync(statePath)) return;

  const tree = loadOrCreateTree(statePath);
  if (tree.allBranches.length <= 1 && tree.currentBranch.messages.length === 0) {
    return; // No branching state yet
  }

  const config = resolveConfig(event);
  const branchContext = composeSystemBlock(tree, {
    max_recent_messages: config.max_recent_messages,
    show_tree_overview: true,
    show_knowledge: true,
  });

  // Find MEMORY.md in bootstrap files and append branch context
  const memoryFile = context.bootstrapFiles.find(
    (f) => f.name === "MEMORY.md" || f.name === "memory.md"
  );

  if (memoryFile && !memoryFile.missing) {
    // Append to existing MEMORY.md content
    memoryFile.content =
      (memoryFile.content || "") +
      "\n\n## Dendrite — Active Conversation Branches\n\n" +
      branchContext;
  } else {
    // Create a MEMORY.md bootstrap file with branch context
    context.bootstrapFiles.push({
      name: "MEMORY.md",
      path: path.join(workspaceDir || "", "MEMORY.md"),
      content:
        "## Dendrite — Active Conversation Branches\n\n" + branchContext,
      missing: false,
    });
  }
}

// ── Event: command:new / command:reset ──

function handleSessionReset(event) {
  // When a session resets, archive the current branch state so the next
  // session starts fresh. The state file is renamed with a timestamp
  // so it can be reviewed later if needed.
  const context = event.context || {};
  const workspaceDir = context.workspaceDir || process.env.HOME;
  const stateDir = resolveStateDir(workspaceDir);
  const statePath = resolveStatePath(stateDir, event.sessionKey);

  if (!fs.existsSync(statePath)) return;

  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .slice(0, 19);
  const archivePath = statePath.replace(".json", `.archived-${timestamp}.json`);

  try {
    fs.renameSync(statePath, archivePath);
  } catch {
    // If rename fails, just delete — don't let stale state leak
    try {
      fs.unlinkSync(statePath);
    } catch {}
  }
}

// ── Main handler ──

const dendriteHook = async (event) => {
  if (event.type === "message" && event.action === "received") {
    await handleMessageReceived(event);
  } else if (event.type === "agent" && event.action === "bootstrap") {
    handleBootstrap(event);
  } else if (
    event.type === "command" &&
    (event.action === "new" || event.action === "reset")
  ) {
    handleSessionReset(event);
  }
};

export default dendriteHook;
