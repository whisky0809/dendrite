/**
 * Dendrite — git-like branching conversations for AI agents.
 *
 * Core exports for using dendrite as a library.
 */

// Data model
export {
  BranchId,
  MessageId,
  BranchStatus,
  Fact,
  Decision,
  Question,
  KnowledgeDiff,
  Message,
  MessageRole,
  BaseLayer,
  BranchLayer,
  WorkingContext,
  BranchNode,
  MergeConflict,
  MergeResult,
  createBranch,
  createMessage,
  emptyKnowledgeDiff,
} from "./types.js";

// Branch tree (core DAG)
export { BranchTree, BranchTreeOptions } from "./branch-tree.js";

// Drift detection
export {
  DriftDetector,
  DriftDetection,
  DriftDetectorConfig,
  TermFrequencyDetector,
  QuestionDriftDetector,
  CompositeDetector,
  createDefaultDetector,
} from "./drift-detector.js";

// LLM-based detection
export { LLMDriftDetector, LLMDetectorConfig } from "./llm-drift-detector.js";
export {
  LLMReturnDetector,
  ReturnDetection,
  ReturnDetectorConfig,
} from "./return-detector.js";

// LLM branch tree (async wrapper)
export {
  LLMBranchTree,
  LLMBranchTreeOptions,
  ChatResult,
} from "./llm-branch-tree.js";

// Context composition
export {
  composeContext,
  composeTreeOverview,
  composeSystemBlock,
  ComposerOptions,
} from "./context-composer.js";

// Session adapter (OpenClaw JSONL)
export {
  parseSessionFile,
  listSessions,
  ParsedMessage,
  ParsedSession,
} from "./session-adapter.js";

// Persistent state
export { saveState, loadState } from "./state.js";
