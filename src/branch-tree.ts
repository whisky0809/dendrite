import {
  BranchNode,
  BranchId,
  Message,
  MessageRole,
  KnowledgeDiff,
  MergeResult,
  MergeConflict,
  WorkingContext,
  BaseLayer,
  createBranch,
  createMessage,
  emptyKnowledgeDiff,
} from "./types.js";
import {
  DriftDetector,
  DriftDetection,
  createDefaultDetector,
} from "./drift-detector.js";

export interface BranchTreeOptions {
  /** Custom drift detector. Uses composite TF + question detector by default. */
  detector?: DriftDetector;
  /** Enable automatic branching on detected drift. Default: true */
  auto_branch?: boolean;
}

export class BranchTree {
  private branches: Map<BranchId, BranchNode> = new Map();
  private active_branch: BranchId;
  private base: BaseLayer;
  private detector: DriftDetector;
  private auto_branch: boolean;

  /** Last drift detection result, for inspection/debugging */
  public last_detection: DriftDetection | null = null;

  constructor(base: BaseLayer, options: BranchTreeOptions = {}) {
    this.base = base;
    this.detector = options.detector ?? createDefaultDetector();
    this.auto_branch = options.auto_branch ?? true;
    const root = createBranch("main", null, null, "main conversation");
    this.branches.set(root.id, root);
    this.active_branch = root.id;
  }

  // ── Branch operations ──

  get currentBranch(): BranchNode {
    return this.branches.get(this.active_branch)!;
  }

  getBranch(id: BranchId): BranchNode | undefined {
    return this.branches.get(id);
  }

  get allBranches(): BranchNode[] {
    return Array.from(this.branches.values());
  }

  /**
   * Fork a new branch from the current branch at the latest message.
   */
  fork(name: string, topic: string): BranchNode {
    const parent = this.currentBranch;
    const fork_point =
      parent.messages.length > 0
        ? parent.messages[parent.messages.length - 1].id
        : null;

    const child = createBranch(name, parent.id, fork_point, topic);

    // Inherit parent's accumulated knowledge up to the fork point
    child.context.accumulated_context = parent.context.accumulated_context;
    child.context.knowledge_state = cloneKnowledge(
      parent.context.knowledge_state
    );

    parent.children.push(child.id);
    this.branches.set(child.id, child);
    this.active_branch = child.id;

    return child;
  }

  /**
   * Switch to an existing branch.
   */
  switchTo(branch_id: BranchId): BranchNode {
    const branch = this.branches.get(branch_id);
    if (!branch) throw new Error(`Branch ${branch_id} not found`);
    if (branch.status === "pruned")
      throw new Error(`Branch ${branch.name} has been pruned`);

    // Demote current branch
    const current = this.currentBranch;
    if (current.status === "active") {
      current.status = "warm";
    }

    // Activate target
    branch.status = "active";
    branch.last_active = new Date();
    this.active_branch = branch_id;

    return branch;
  }

  /**
   * Add a message to the current branch (no drift detection).
   */
  addMessage(
    role: MessageRole,
    content: string,
    knowledge: KnowledgeDiff = emptyKnowledgeDiff()
  ): Message {
    const branch = this.currentBranch;
    const msg = createMessage(branch.id, role, content, knowledge);
    branch.messages.push(msg);
    branch.last_active = new Date();

    // Accumulate knowledge
    mergeKnowledgeInto(branch.context.knowledge_state, knowledge);

    return msg;
  }

  /**
   * Chat: add a user message with automatic drift detection.
   * If drift is detected and auto_branch is enabled, forks a new branch
   * before adding the message.
   *
   * Returns the message and whether a fork occurred.
   */
  chat(
    content: string,
    knowledge: KnowledgeDiff = emptyKnowledgeDiff()
  ): { message: Message; forked: boolean; fork_branch?: BranchNode; detection: DriftDetection } {
    const branch = this.currentBranch;
    const detection = this.detector.analyze(branch, content);
    this.last_detection = detection;

    let forked = false;
    let fork_branch: BranchNode | undefined;

    if (this.auto_branch && detection.should_fork) {
      fork_branch = this.fork(detection.suggested_topic, detection.suggested_topic);
      forked = true;
    }

    const message = this.addMessage("user", content, knowledge);

    return { message, forked, fork_branch, detection };
  }

  /**
   * Analyze a message for drift without adding it.
   * Useful for preview / debugging.
   */
  analyzeDrift(content: string): DriftDetection {
    return this.detector.analyze(this.currentBranch, content);
  }

  /**
   * Merge a source branch into the current branch.
   * Returns a MergeResult describing what was combined and any conflicts.
   */
  merge(source_id: BranchId): MergeResult {
    const source = this.branches.get(source_id);
    const target = this.currentBranch;

    if (!source) throw new Error(`Source branch ${source_id} not found`);
    if (source.id === target.id) throw new Error("Cannot merge branch into itself");

    // Detect conflicts between the two knowledge states
    const conflicts = detectConflicts(
      target.id,
      target.context.knowledge_state,
      source.id,
      source.context.knowledge_state
    );

    // Combine knowledge (non-conflicting items)
    const combined = combineKnowledge(
      target.context.knowledge_state,
      source.context.knowledge_state
    );

    // Generate merge summary
    const merged_summary = generateMergeSummary(source, target);

    // Apply to target
    mergeKnowledgeInto(target.context.knowledge_state, combined);
    target.merge_sources.push(source.id);

    // Mark source as merged
    source.status = "merged";
    source.merged_into = target.id;

    // Inject merge context as a system message
    const mergeMsg = createMessage(
      target.id,
      "system",
      `[Merged from "${source.name}"] ${merged_summary}`
    );
    target.messages.push(mergeMsg);

    return {
      merged_summary,
      combined_knowledge: combined,
      conflicts,
      resolved: conflicts.length === 0,
    };
  }

  /**
   * Prune a branch (dead end — collapse to summary).
   */
  prune(branch_id: BranchId, reason: string): void {
    const branch = this.branches.get(branch_id);
    if (!branch) throw new Error(`Branch ${branch_id} not found`);
    if (branch_id === this.active_branch)
      throw new Error("Cannot prune the active branch");

    branch.status = "pruned";
    branch.topic_summary = `[Pruned] ${reason}. Original topic: ${branch.topic_summary}`;
    branch.messages = []; // free memory
  }

  /**
   * Build the working context for the current branch.
   */
  buildWorkingContext(recent_message_limit: number = 20): WorkingContext {
    const branch = this.currentBranch;

    // Collect merge summaries from any branches that were merged in
    const merged_context = branch.merge_sources
      .map((id) => this.branches.get(id))
      .filter((b): b is BranchNode => b !== undefined)
      .map(
        (b) =>
          `[From "${b.name}"] ${b.topic_summary}`
      );

    return {
      base: this.base,
      branch: branch.context,
      recent_messages: branch.messages.slice(-recent_message_limit),
      merged_context,
    };
  }

  /**
   * Get a visual representation of the tree structure.
   */
  printTree(node_id?: BranchId, indent: string = ""): string {
    const id = node_id ?? this.findRoot();
    const branch = this.branches.get(id);
    if (!branch) return "";

    const marker = id === this.active_branch ? " ← active" : "";
    const status =
      branch.status !== "active" && branch.status !== "warm"
        ? ` (${branch.status})`
        : "";
    let line = `${indent}${branch.name} [${branch.messages.length} msgs]${status}${marker}\n`;

    for (const child_id of branch.children) {
      line += this.printTree(child_id, indent + "  ");
    }

    return line;
  }

  private findRoot(): BranchId {
    for (const [id, branch] of this.branches) {
      if (branch.parent_id === null) return id;
    }
    throw new Error("No root branch found");
  }
}

// ── Knowledge helpers ──

function cloneKnowledge(k: KnowledgeDiff): KnowledgeDiff {
  return {
    facts_learned: [...k.facts_learned],
    decisions_made: [...k.decisions_made],
    questions_resolved: [...k.questions_resolved],
    questions_opened: [...k.questions_opened],
  };
}

function mergeKnowledgeInto(
  target: KnowledgeDiff,
  source: KnowledgeDiff
): void {
  const existingFactIds = new Set(target.facts_learned.map((f) => f.id));
  const existingDecisionIds = new Set(target.decisions_made.map((d) => d.id));

  for (const fact of source.facts_learned) {
    if (!existingFactIds.has(fact.id)) {
      target.facts_learned.push(fact);
    }
  }
  for (const decision of source.decisions_made) {
    if (!existingDecisionIds.has(decision.id)) {
      target.decisions_made.push(decision);
    }
  }
  for (const q of source.questions_resolved) {
    target.questions_resolved.push(q);
    // Remove from opened if it was resolved
    target.questions_opened = target.questions_opened.filter(
      (oq) => oq.id !== q.id
    );
  }
  for (const q of source.questions_opened) {
    const alreadyResolved = target.questions_resolved.some(
      (rq) => rq.id === q.id
    );
    if (!alreadyResolved) {
      target.questions_opened.push(q);
    }
  }
}

function combineKnowledge(
  a: KnowledgeDiff,
  b: KnowledgeDiff
): KnowledgeDiff {
  const combined = cloneKnowledge(a);
  mergeKnowledgeInto(combined, b);
  return combined;
}

function detectConflicts(
  id_a: BranchId,
  a: KnowledgeDiff,
  id_b: BranchId,
  b: KnowledgeDiff
): MergeConflict[] {
  const conflicts: MergeConflict[] = [];

  // Check for contradictory decisions (same question, different answer)
  for (const dec_a of a.decisions_made) {
    for (const dec_b of b.decisions_made) {
      // Simple heuristic: decisions with similar descriptions but different reasoning
      if (
        dec_a.description === dec_b.description &&
        dec_a.reasoning !== dec_b.reasoning
      ) {
        conflicts.push({
          type: "decision",
          branch_a: { branch_id: id_a, item: dec_a },
          branch_b: { branch_id: id_b, item: dec_b },
        });
      }
    }
  }

  // Check for contradictory facts (same topic, different content)
  for (const fact_a of a.facts_learned) {
    for (const fact_b of b.facts_learned) {
      if (
        fact_a.content !== fact_b.content &&
        fact_a.id === fact_b.id
      ) {
        conflicts.push({
          type: "fact",
          branch_a: { branch_id: id_a, item: fact_a },
          branch_b: { branch_id: id_b, item: fact_b },
        });
      }
    }
  }

  return conflicts;
}

function generateMergeSummary(
  source: BranchNode,
  target: BranchNode
): string {
  const facts = source.context.knowledge_state.facts_learned;
  const decisions = source.context.knowledge_state.decisions_made;

  const parts: string[] = [];
  if (facts.length > 0) {
    parts.push(
      `Learned: ${facts.map((f) => f.content).join("; ")}`
    );
  }
  if (decisions.length > 0) {
    parts.push(
      `Decided: ${decisions.map((d) => `${d.description} (${d.reasoning})`).join("; ")}`
    );
  }

  return parts.length > 0
    ? parts.join(". ")
    : `Explored "${source.topic_summary}" — no new conclusions.`;
}
