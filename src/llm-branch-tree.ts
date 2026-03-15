/**
 * Async-compatible BranchTree that uses LLM + embeddings for drift detection.
 *
 * Strategy:
 * - Gemini embeddings for fast semantic similarity scoring
 * - Moonshot LLM for topic naming when a fork is detected
 * - Falls back to embeddings-only or LLM-only if one API is unavailable
 */

import { BranchTree } from "./branch-tree.js";
import { LLMDriftDetector, LLMDetectorConfig } from "./llm-drift-detector.js";
import {
  EmbeddingDriftDetector,
  EmbeddingDetectorConfig,
} from "./embedding-detector.js";
import {
  BaseLayer,
  BranchNode,
  KnowledgeDiff,
  Message,
  emptyKnowledgeDiff,
} from "./types.js";
import { DriftDetection } from "./drift-detector.js";

export interface LLMBranchTreeOptions {
  /** Moonshot LLM config for drift classification + topic naming */
  llm?: LLMDetectorConfig;
  /** Gemini embedding config for semantic similarity */
  embedding?: EmbeddingDetectorConfig;
  /** Which detector to use: "llm", "embedding", or "both" (default) */
  mode?: "llm" | "embedding" | "both";
  auto_branch?: boolean;
}

export class LLMBranchTree {
  public tree: BranchTree;
  private llmDetector: LLMDriftDetector | null = null;
  private embeddingDetector: EmbeddingDriftDetector | null = null;
  private mode: "llm" | "embedding" | "both";
  private auto_branch: boolean;
  public last_detection: DriftDetection | null = null;

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
  }

  get currentBranch(): BranchNode {
    return this.tree.currentBranch;
  }

  get allBranches(): BranchNode[] {
    return this.tree.allBranches;
  }

  /**
   * Send a user message with smart drift detection.
   *
   * In "both" mode:
   * 1. Embeddings score the message for semantic drift (fast, cheap)
   * 2. If embeddings flag drift, LLM confirms and names the topic
   * 3. If embeddings say on-topic, skip the LLM call entirely
   */
  async chat(
    content: string,
    knowledge: KnowledgeDiff = emptyKnowledgeDiff()
  ): Promise<{
    message: Message;
    forked: boolean;
    fork_branch?: BranchNode;
    detection: DriftDetection;
  }> {
    const branch = this.tree.currentBranch;
    let detection: DriftDetection;

    if (this.mode === "both" && this.embeddingDetector && this.llmDetector) {
      // Two-stage: embeddings first, LLM to confirm
      const embeddingResult = await this.embeddingDetector.analyzeAsync(
        branch,
        content
      );

      if (embeddingResult.should_fork) {
        // Embeddings say drift — confirm with LLM and get topic name
        const llmResult = await this.llmDetector.analyzeAsync(branch, content);
        detection = {
          drift_score: embeddingResult.drift_score,
          should_fork: llmResult.should_fork, // LLM has final say
          suggested_topic: llmResult.suggested_topic,
          confidence: (embeddingResult.confidence + llmResult.confidence) / 2,
          reason: `Embedding: ${embeddingResult.reason} | LLM: ${llmResult.reason}`,
        };
      } else {
        // Embeddings say on-topic — trust it, skip LLM
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

    return { message, forked, fork_branch, detection };
  }

  /**
   * Add an agent response (no drift detection needed).
   */
  addResponse(
    content: string,
    knowledge: KnowledgeDiff = emptyKnowledgeDiff()
  ): Message {
    return this.tree.addMessage("agent", content, knowledge);
  }

  // Delegate to underlying tree
  fork(name: string, topic: string) { return this.tree.fork(name, topic); }
  switchTo(id: string) { return this.tree.switchTo(id); }
  merge(id: string) { return this.tree.merge(id); }
  prune(id: string, reason: string) { return this.tree.prune(id, reason); }
  buildWorkingContext(limit?: number) { return this.tree.buildWorkingContext(limit); }
  printTree() { return this.tree.printTree(); }
}
