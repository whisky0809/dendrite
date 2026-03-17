/**
 * Persistent state — save/load dendrite branch tree to disk.
 *
 * Serializes the full branch tree (branches, messages, knowledge state)
 * to a JSON file so it survives across agent sessions.
 */

import * as fs from "fs";
import {
  BranchNode,
  BranchId,
  Message,
  KnowledgeDiff,
  BaseLayer,
  emptyKnowledgeDiff,
} from "./types.js";
import { BranchTree } from "./branch-tree.js";

// ── Serializable types (Dates → ISO strings) ──

interface SerializedMessage {
  id: string;
  branch_id: string;
  role: "user" | "agent" | "system";
  content: string;
  knowledge_delta: KnowledgeDiff;
  timestamp: string;
}

interface SerializedBranch {
  id: string;
  parent_id: string | null;
  name: string;
  fork_point: string | null;
  status: string;
  topic_summary: string;
  messages: SerializedMessage[];
  context: {
    branch_id: string;
    topic: string;
    accumulated_context: string;
    knowledge_state: KnowledgeDiff;
  };
  created_at: string;
  last_active: string;
  children: string[];
  merged_into: string | null;
  merge_sources: string[];
}

interface SerializedState {
  version: 1;
  saved_at: string;
  active_branch_id: string;
  base: BaseLayer;
  branches: SerializedBranch[];
}

/**
 * Save a BranchTree's state to a JSON file.
 */
export function saveState(tree: BranchTree, filePath: string): void {
  const state: SerializedState = {
    version: 1,
    saved_at: new Date().toISOString(),
    active_branch_id: tree.currentBranch.id,
    base: {
      agent_identity: "",
      user_profile: "",
      long_term_memory: [],
    },
    branches: tree.allBranches.map(serializeBranch),
  };

  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
}

/**
 * Load a BranchTree from a saved state file.
 * Returns null if file doesn't exist.
 */
export function loadState(
  filePath: string,
  base: BaseLayer
): BranchTree | null {
  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath, "utf-8");
  const state = JSON.parse(raw) as SerializedState;

  if (state.version !== 1) {
    throw new Error(`Unsupported state version: ${state.version}`);
  }

  // Create tree with auto_branch disabled — we manage branching externally
  const tree = new BranchTree(base, { auto_branch: false });

  // The constructor creates a "main" branch. We need to replace it with
  // our saved branches. Access internal state via the public API.
  // We'll rebuild by forking from scratch.

  // First, find the root branch
  const rootBranch = state.branches.find((b) => b.parent_id === null);
  if (!rootBranch) throw new Error("No root branch in saved state");

  // Replace the auto-created main branch's messages
  const main = tree.currentBranch;
  const deserialized = deserializeBranch(rootBranch);

  // Copy messages into main
  for (const msg of deserialized.messages) {
    tree.addMessage(msg.role, msg.content, msg.knowledge_delta);
  }
  // Restore metadata
  main.topic_summary = deserialized.topic_summary;
  main.status = deserialized.status as any;
  main.context.accumulated_context = deserialized.context.accumulated_context;
  main.context.knowledge_state = deserialized.context.knowledge_state;

  // Build ID mapping: saved ID → tree ID
  const idMap = new Map<string, string>();
  idMap.set(rootBranch.id, main.id);

  // Rebuild child branches in tree order (BFS)
  const queue = [rootBranch];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    const parentTreeId = idMap.get(parent.id)!;

    for (const childId of parent.children) {
      const childData = state.branches.find((b) => b.id === childId);
      if (!childData) continue;

      // Switch to parent, fork child
      tree.switchTo(parentTreeId);
      const child = tree.fork(childData.name, childData.topic_summary);
      idMap.set(childData.id, child.id);

      // Add messages
      const childDeserialized = deserializeBranch(childData);
      for (const msg of childDeserialized.messages) {
        tree.addMessage(msg.role, msg.content, msg.knowledge_delta);
      }

      // Restore metadata
      child.status = childDeserialized.status as any;
      child.context.accumulated_context =
        childDeserialized.context.accumulated_context;
      child.context.knowledge_state =
        childDeserialized.context.knowledge_state;
      child.merged_into = childDeserialized.merged_into
        ? idMap.get(childDeserialized.merged_into) || null
        : null;

      queue.push(childData);
    }
  }

  // Restore merge_sources using ID mapping
  for (const saved of state.branches) {
    const treeId = idMap.get(saved.id);
    if (!treeId) continue;
    const branch = tree.getBranch(treeId);
    if (!branch) continue;

    branch.merge_sources = saved.merge_sources
      .map((id) => idMap.get(id))
      .filter((id): id is string => id !== undefined);
  }

  // Switch to the saved active branch
  const activeTreeId = idMap.get(state.active_branch_id);
  if (activeTreeId) {
    tree.switchTo(activeTreeId);
  }

  return tree;
}

// ── Serialization helpers ──

function serializeBranch(branch: BranchNode): SerializedBranch {
  return {
    id: branch.id,
    parent_id: branch.parent_id,
    name: branch.name,
    fork_point: branch.fork_point,
    status: branch.status,
    topic_summary: branch.topic_summary,
    messages: branch.messages.map(serializeMessage),
    context: {
      branch_id: branch.context.branch_id,
      topic: branch.context.topic,
      accumulated_context: branch.context.accumulated_context,
      knowledge_state: branch.context.knowledge_state,
    },
    created_at: branch.created_at.toISOString(),
    last_active: branch.last_active.toISOString(),
    children: branch.children,
    merged_into: branch.merged_into,
    merge_sources: branch.merge_sources,
  };
}

function serializeMessage(msg: Message): SerializedMessage {
  return {
    id: msg.id,
    branch_id: msg.branch_id,
    role: msg.role,
    content: msg.content,
    knowledge_delta: msg.knowledge_delta,
    timestamp: msg.timestamp.toISOString(),
  };
}

function deserializeBranch(data: SerializedBranch): BranchNode {
  return {
    id: data.id,
    parent_id: data.parent_id,
    name: data.name,
    fork_point: data.fork_point,
    status: data.status as any,
    topic_summary: data.topic_summary,
    messages: data.messages.map(deserializeMessage),
    context: {
      branch_id: data.context.branch_id,
      topic: data.context.topic,
      accumulated_context: data.context.accumulated_context,
      knowledge_state: data.context.knowledge_state,
    },
    created_at: new Date(data.created_at),
    last_active: new Date(data.last_active),
    children: [...data.children],
    merged_into: data.merged_into,
    merge_sources: [...data.merge_sources],
  };
}

function deserializeMessage(data: SerializedMessage): Message {
  return {
    id: data.id,
    branch_id: data.branch_id,
    role: data.role,
    content: data.content,
    knowledge_delta: data.knowledge_delta,
    timestamp: new Date(data.timestamp),
  };
}
