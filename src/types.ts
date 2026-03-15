import { randomUUID } from "crypto";

// ── Identifiers ──

export type BranchId = string;
export type MessageId = string;

// ── Branch status lifecycle ──

export type BranchStatus =
  | "active"   // currently being used
  | "warm"     // recently used, compressed context
  | "cold"     // inactive, archived to summary
  | "merged"   // merged into another branch
  | "pruned";  // dead end, collapsed to one-liner

// ── Knowledge tracking ──

export interface Fact {
  id: string;
  content: string;
  confidence: number; // 0-1
  source_message: MessageId;
}

export interface Decision {
  id: string;
  description: string;
  reasoning: string;
  source_message: MessageId;
}

export interface Question {
  id: string;
  content: string;
  resolved: boolean;
  answer?: string;
}

export interface KnowledgeDiff {
  facts_learned: Fact[];
  decisions_made: Decision[];
  questions_resolved: Question[];
  questions_opened: Question[];
}

export function emptyKnowledgeDiff(): KnowledgeDiff {
  return {
    facts_learned: [],
    decisions_made: [],
    questions_resolved: [],
    questions_opened: [],
  };
}

// ── Messages ──

export type MessageRole = "user" | "agent" | "system";

export interface Message {
  id: MessageId;
  branch_id: BranchId;
  role: MessageRole;
  content: string;
  knowledge_delta: KnowledgeDiff;
  timestamp: Date;
}

export function createMessage(
  branch_id: BranchId,
  role: MessageRole,
  content: string,
  knowledge_delta: KnowledgeDiff = emptyKnowledgeDiff()
): Message {
  return {
    id: randomUUID(),
    branch_id,
    role,
    content,
    knowledge_delta,
    timestamp: new Date(),
  };
}

// ── Context layers ──

export interface BaseLayer {
  agent_identity: string;
  user_profile: string;
  long_term_memory: string[];
}

export interface BranchLayer {
  branch_id: BranchId;
  topic: string;
  accumulated_context: string;    // compressed summary of the branch so far
  knowledge_state: KnowledgeDiff; // aggregate of all diffs on this branch
}

export interface WorkingContext {
  base: BaseLayer;
  branch: BranchLayer;
  recent_messages: Message[];
  merged_context: string[];       // summaries injected from merged branches
}

// ── Branch node ──

export interface BranchNode {
  id: BranchId;
  parent_id: BranchId | null;
  name: string;
  fork_point: MessageId | null;   // the message that triggered the fork
  status: BranchStatus;

  topic_summary: string;
  messages: Message[];
  context: BranchLayer;

  created_at: Date;
  last_active: Date;

  children: BranchId[];
  merged_into: BranchId | null;
  merge_sources: BranchId[];
}

export function createBranch(
  name: string,
  parent_id: BranchId | null = null,
  fork_point: MessageId | null = null,
  topic: string = ""
): BranchNode {
  const id = randomUUID();
  return {
    id,
    parent_id,
    name,
    fork_point,
    status: "active",
    topic_summary: topic,
    messages: [],
    context: {
      branch_id: id,
      topic,
      accumulated_context: "",
      knowledge_state: emptyKnowledgeDiff(),
    },
    created_at: new Date(),
    last_active: new Date(),
    children: [],
    merged_into: null,
    merge_sources: [],
  };
}

// ── Merge result ──

export interface MergeConflict {
  type: "decision" | "fact";
  branch_a: { branch_id: BranchId; item: Decision | Fact };
  branch_b: { branch_id: BranchId; item: Decision | Fact };
  resolution?: "a" | "b" | "both" | string;
}

export interface MergeResult {
  merged_summary: string;
  combined_knowledge: KnowledgeDiff;
  conflicts: MergeConflict[];
  resolved: boolean;
}
