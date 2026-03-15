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
import { fileURLToPath } from "node:url";

// ── Lazy module loading (avoids top-level await) ──

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, "..", "..", "dist");

let _modules = null;

async function modules() {
  if (_modules) return _modules;
  const [btMod, driftMod, returnMod, composerMod, stateMod, typesMod] =
    await Promise.all([
      import(path.join(DIST, "branch-tree.js")),
      import(path.join(DIST, "llm-drift-detector.js")),
      import(path.join(DIST, "return-detector.js")),
      import(path.join(DIST, "context-composer.js")),
      import(path.join(DIST, "state.js")),
      import(path.join(DIST, "types.js")),
    ]);
  _modules = {
    BranchTree: btMod.BranchTree,
    LLMDriftDetector: driftMod.LLMDriftDetector,
    LLMReturnDetector: returnMod.LLMReturnDetector,
    composeSystemBlock: composerMod.composeSystemBlock,
    saveState: stateMod.saveState,
    loadState: stateMod.loadState,
    emptyKnowledgeDiff: typesMod.emptyKnowledgeDiff,
  };
  return _modules;
}

// ── State management ──

const STATE_DIR_NAME = ".dendrite";

function resolveStateDir(workspaceDir) {
  return path.join(workspaceDir || process.env.HOME || "/tmp", STATE_DIR_NAME);
}

function resolveStatePath(stateDir, sessionKey) {
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

// ── Detector cache ──

let cachedDriftDetector = null;
let cachedReturnDetector = null;

function getDriftDetector(mods, config) {
  if (!cachedDriftDetector) {
    cachedDriftDetector = new mods.LLMDriftDetector({
      model: config.model,
      min_messages_before_fork: config.min_messages_before_fork,
    });
  }
  return cachedDriftDetector;
}

function getReturnDetector(mods, config) {
  if (!cachedReturnDetector) {
    cachedReturnDetector = new mods.LLMReturnDetector({
      model: config.model,
      min_messages_before_return: config.min_messages_before_return,
    });
  }
  return cachedReturnDetector;
}

// ── Load or create branch tree ──

function loadOrCreateTree(mods, statePath) {
  const base = {
    agent_identity: "",
    user_profile: "",
    long_term_memory: [],
  };

  const tree = mods.loadState(statePath, base);
  if (tree) return tree;

  return new mods.BranchTree(base, { auto_branch: false });
}

// ── Event: message:received ──

async function handleMessageReceived(event) {
  const content = event.context?.content;
  if (!content || typeof content !== "string") return;
  if (content.trim().length < 5) return;

  const mods = await modules();
  const config = resolveConfig(event);
  const workspaceDir = event.context?.workspaceDir || process.env.HOME;
  const stateDir = resolveStateDir(workspaceDir);
  ensureDir(stateDir);

  const statePath = resolveStatePath(stateDir, event.sessionKey);
  const tree = loadOrCreateTree(mods, statePath);
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
      const returnDetector = getReturnDetector(mods, config);
      const returnResult = await returnDetector.analyze(
        branch,
        returnCandidates,
        content
      );

      if (returnResult.should_return && returnResult.target_branch_id) {
        tree.returnTo(returnResult.target_branch_id);
        tree.addMessage("user", content, mods.emptyKnowledgeDiff());
        mods.saveState(tree, statePath);
        return;
      }
    }

    // Step 2: Check drift (new tangent)
    if (branch.messages.length >= config.min_messages_before_fork) {
      const driftDetector = getDriftDetector(mods, config);
      const drift = await driftDetector.analyzeAsync(branch, content);

      if (drift.should_fork) {
        const topic = drift.suggested_topic || "tangent";
        tree.fork(topic, topic);
      }
    }

    // Step 3: Add message to current branch
    tree.addMessage("user", content, mods.emptyKnowledgeDiff());
    mods.saveState(tree, statePath);
  } catch (err) {
    // Don't crash the hook on detection errors — just add the message
    tree.addMessage("user", content, mods.emptyKnowledgeDiff());
    mods.saveState(tree, statePath);
  }
}

// ── Event: agent:bootstrap ──

async function handleBootstrap(event) {
  const context = event.context;
  if (!context?.bootstrapFiles) return;

  const workspaceDir = context.workspaceDir;
  const stateDir = resolveStateDir(workspaceDir);
  const statePath = resolveStatePath(stateDir, event.sessionKey);

  if (!fs.existsSync(statePath)) return;

  const mods = await modules();
  const tree = loadOrCreateTree(mods, statePath);
  if (tree.allBranches.length <= 1 && tree.currentBranch.messages.length === 0) {
    return;
  }

  const config = resolveConfig(event);
  const branchContext = mods.composeSystemBlock(tree, {
    max_recent_messages: config.max_recent_messages,
    show_tree_overview: true,
    show_knowledge: true,
  });

  // Find MEMORY.md in bootstrap files and append branch context
  const memoryFile = context.bootstrapFiles.find(
    (f) => f.name === "MEMORY.md" || f.name === "memory.md"
  );

  if (memoryFile && !memoryFile.missing) {
    memoryFile.content =
      (memoryFile.content || "") +
      "\n\n## Dendrite — Active Conversation Branches\n\n" +
      branchContext;
  } else {
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
    await handleBootstrap(event);
  } else if (
    event.type === "command" &&
    (event.action === "new" || event.action === "reset")
  ) {
    handleSessionReset(event);
  }
};

export default dendriteHook;
