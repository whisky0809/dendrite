/**
 * Async-compatible BranchTree that uses LLM + embeddings for drift detection
 * and LLM-based return detection.
 *
 * Chat flow:
 * 1. Check return — does message match a previous branch? → switch+merge
 * 2. Check drift — is message a new tangent? → fork
 * 3. Otherwise → add to current branch
 */

import { BranchTree } from "./branch-tree.js";
import { LLMDriftDetector, LLMDetectorConfig } from "./llm-drift-detector.js";
import {
  EmbeddingDriftDetector,
  EmbeddingDetectorConfig,
} from "./embedding-detector.js";
import {
  LLMReturnDetector,
  ReturnDetectorConfig,
  ReturnDetection,
} from "./return-detector.js";
import {
  BaseLayer,
  BranchNode,
  KnowledgeDiff,
  Message,
  MergeResult,
  emptyKnowledgeDiff,
} from "./types.js";
import { DriftDetection } from "./drift-detector.js";

export interface LLMBranchTreeOptions {
  /** Moonshot LLM config for drift classification + topic naming */
  llm?: LLMDetectorConfig;
  /** Gemini embedding config for semantic similarity */
  embedding?: EmbeddingDetectorConfig;
  /** Return detector config (uses Moonshot) */
  return_detector?: ReturnDetectorConfig;
  /** Which drift detector to use: "llm", "embedding", or "both" (default) */
  mode?: "llm" | "embedding" | "both";
  auto_branch?: boolean;
}

export interface ChatResult {
  message: Message;
  forked: boolean;
  fork_branch?: BranchNode;
  returned: boolean;
  returned_from?: BranchNode;
  merge_result?: MergeResult;
  detection: DriftDetection;
  return_detection?: ReturnDetection;
}

export class LLMBranchTree {
  public tree: BranchTree;
  private llmDetector: LLMDriftDetector | null = null;
  private embeddingDetector: EmbeddingDriftDetector | null = null;
  private returnDetector: LLMReturnDetector | null = null;
  private mode: "llm" | "embedding" | "both";
  private auto_branch: boolean;
  public last_detection: DriftDetection | null = null;
  public last_return_detection: ReturnDetection | null = null;

  constructor(base: BaseLayer, options: LLMBranchTreeOptions = {}) {
    this.tree = new BranchTree(base, { auto_branch: false });
    this.mode = options.mode ?? "both";
    this.auto_branch = options.auto_branch ?? true;

    if (this.mode === "llm" || this.mode === "both") {
      this.llmDetector = new LLMDriftDetector(options.llm);
    }
    if (this.mode === "embedding" || this.mode === "both") {
      this.embeddingDetector = new EmbeddingDriftDetector(options.embedding);
    }

    // Return detector always uses Moonshot
    this.returnDetector = new LLMReturnDetector(options.return_detector ?? options.llm);
  }

  get currentBranch(): BranchNode {
    return this.tree.currentBranch;
  }

  get allBranches(): BranchNode[] {
    return this.tree.allBranches;
  }

  /**
   * Send a user message with automatic return detection + drift detection.
   *
   * Flow:
   * 1. Check return — does this message belong on a previous branch?
   * 2. Check drift — is this a new tangent from the current branch?
   * 3. Otherwise — add to current branch
   */
  async chat(
    content: string,
    knowledge: KnowledgeDiff = emptyKnowledgeDiff()
  ): Promise<ChatResult> {
    const branch = this.tree.currentBranch;

    // ── Step 1: Check return to previous branch ──
    if (this.auto_branch && this.returnDetector) {
      const candidates = this.getReturnCandidates();
      if (candidates.length > 0) {
        const returnResult = await this.returnDetector.analyze(
          branch,
          candidates,
          content
        );
        this.last_return_detection = returnResult;

        if (returnResult.should_return && returnResult.target_branch_id) {
          const returning_from = branch;
          const mergeResult = this.tree.returnTo(
            returnResult.target_branch_id
          );
          const message = this.tree.addMessage("user", content, knowledge);

          return {
            message,
            forked: false,
            returned: true,
            returned_from: returning_from,
            merge_result: mergeResult,
            detection: {
              drift_score: 0,
              should_fork: false,
              suggested_topic: "",
              confidence: 1,
              reason: "Returned to previous branch",
            },
            return_detection: returnResult,
          };
        }
      }
    }

    // ── Step 2: Check drift (new tangent) ──
    let detection: DriftDetection;

    if (this.mode === "both" && this.embeddingDetector && this.llmDetector) {
      const embeddingResult = await this.embeddingDetector.analyzeAsync(
        branch,
        content
      );
      if (embeddingResult.should_fork) {
        const llmResult = await this.llmDetector.analyzeAsync(branch, content);
        detection = {
          drift_score: embeddingResult.drift_score,
          should_fork: llmResult.should_fork,
          suggested_topic: llmResult.suggested_topic,
          confidence: (embeddingResult.confidence + llmResult.confidence) / 2,
          reason: `Embedding: ${embeddingResult.reason} | LLM: ${llmResult.reason}`,
        };
      } else {
        detection = embeddingResult;
      }
    } else if (this.mode === "embedding" && this.embeddingDetector) {
      detection = await this.embeddingDetector.analyzeAsync(branch, content);
    } else if (this.llmDetector) {
      detection = await this.llmDetector.analyzeAsync(branch, content);
    } else {
      throw new Error("No detector configured");
    }

    this.last_detection = detection;

    let forked = false;
    let fork_branch: BranchNode | undefined;

    if (this.auto_branch && detection.should_fork) {
      const topic = detection.suggested_topic || "tangent";
      fork_branch = this.tree.fork(topic, topic);
      forked = true;
    }

    const message = this.tree.addMessage("user", content, knowledge);

    return {
      message,
      forked,
      fork_branch,
      returned: false,
      detection,
    };
  }

  /**
   * Add an agent response (no detection needed).
   */
  addResponse(
    content: string,
    knowledge: KnowledgeDiff = emptyKnowledgeDiff()
  ): Message {
    return this.tree.addMessage("agent", content, knowledge);
  }

  /**
   * Get branches that are valid return targets.
   * Excludes: current branch, pruned, already merged.
   */
  private getReturnCandidates(): BranchNode[] {
    const current = this.tree.currentBranch;
    return this.tree.allBranches.filter(
      (b) =>
        b.id !== current.id &&
        b.status !== "pruned" &&
        b.status !== "merged" &&
        b.messages.length > 0
    );
  }

  // Delegate to underlying tree
  fork(name: string, topic: string) { return this.tree.fork(name, topic); }
  switchTo(id: string) { return this.tree.switchTo(id); }
  merge(id: string) { return this.tree.merge(id); }
  returnTo(id: string) { return this.tree.returnTo(id); }
  prune(id: string, reason: string) { return this.tree.prune(id, reason); }
  buildWorkingContext(limit?: number) { return this.tree.buildWorkingContext(limit); }
  printTree() { return this.tree.printTree(); }
}
