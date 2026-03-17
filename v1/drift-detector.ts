/**
 * Semantic drift detection for automatic conversation branching.
 *
 * Detects when a new message diverges from the current branch's topic
 * enough that it would benefit from a separate context window.
 *
 * Pluggable architecture: swap in embeddings or LLM-based detection later
 * by implementing the DriftDetector interface.
 */

import { BranchNode, Message } from "./types.js";
import {
  buildTopicVector,
  cosineSimilarity,
  distinctiveTerms,
  textToTermFrequency,
  TermFrequency,
} from "./tokenizer.js";

// ── Interface ──

export interface DriftDetection {
  /** 0 = perfectly on topic, 1 = completely unrelated */
  drift_score: number;

  /** Whether this message should trigger a fork */
  should_fork: boolean;

  /** Auto-generated topic name for the potential new branch */
  suggested_topic: string;

  /** How confident we are in this detection (0-1) */
  confidence: number;

  /** Human-readable explanation of why we did/didn't fork */
  reason: string;
}

export interface DriftDetectorConfig {
  /**
   * How many standard deviations below the branch's mean similarity
   * a message must be to trigger a fork.
   * Higher = more tolerant. Default: 1.5
   */
  sigma_threshold: number;

  /**
   * Minimum messages on a branch before we consider forking.
   * Prevents forking on the very first exchanges while topic is still forming.
   * Default: 3
   */
  min_messages_before_fork: number;

  /**
   * Minimum message length (in tokens) to evaluate for drift.
   * Very short messages ("yes", "ok") shouldn't trigger forks.
   * Default: 4
   */
  min_tokens_for_evaluation: number;

  /**
   * Decay factor for topic vector computation.
   * Higher = recent messages weigh more. 1.0 = all messages equal.
   * Default: 0.85
   */
  topic_decay: number;

  /**
   * Number of consecutive drifting messages required before forking.
   * Prevents forking on a single off-topic remark.
   * Default: 1
   */
  consecutive_drift_required: number;

  /**
   * Absolute drift floor — never fork if drift is below this,
   * even if it's many sigmas from the mean.
   * Prevents forking in very homogeneous conversations where any
   * slight variation looks like an outlier.
   * Default: 0.85
   */
  absolute_drift_floor: number;
}

export const DEFAULT_CONFIG: DriftDetectorConfig = {
  sigma_threshold: 1.5,
  min_messages_before_fork: 3,
  min_tokens_for_evaluation: 4,
  topic_decay: 0.85,
  consecutive_drift_required: 1,
  absolute_drift_floor: 0.85,
};

// ── Drift Detector Interface ──

export interface DriftDetector {
  analyze(branch: BranchNode, new_message: string): DriftDetection;
}

// ── Term Frequency Based Detector (Adaptive) ──

/**
 * Detects drift using RELATIVE term frequency similarity.
 * No external dependencies. Works offline.
 *
 * Instead of a fixed drift threshold (which breaks with bag-of-words
 * because even on-topic messages have low cosine similarity), this
 * detector learns the branch's baseline similarity distribution and
 * flags messages that are statistical outliers.
 *
 * Approach:
 * 1. For each existing message, compute its similarity to the topic vector
 *    built from all OTHER messages (leave-one-out). This gives us the
 *    branch's natural similarity distribution.
 * 2. For the new message, compute its similarity to the full topic vector.
 * 3. If the new message's similarity is significantly below the branch's
 *    mean (by N standard deviations), it's drifting.
 * 4. Also require the raw drift score to exceed an absolute floor,
 *    to prevent false positives in very homogeneous conversations.
 */
export class TermFrequencyDetector implements DriftDetector {
  private config: DriftDetectorConfig;
  private consecutive_drift_count: Map<string, number> = new Map();

  constructor(config: Partial<DriftDetectorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  analyze(branch: BranchNode, new_message: string): DriftDetection {
    const messageTokens = textToTermFrequency(new_message);

    // Too short to evaluate meaningfully
    if (messageTokens.size < this.config.min_tokens_for_evaluation) {
      return {
        drift_score: 0,
        should_fork: false,
        suggested_topic: "",
        confidence: 0.3,
        reason: "Message too short to evaluate for drift",
      };
    }

    // Not enough history to establish a topic
    if (branch.messages.length < this.config.min_messages_before_fork) {
      return {
        drift_score: 0,
        should_fork: false,
        suggested_topic: "",
        confidence: 0.3,
        reason: `Branch has ${branch.messages.length}/${this.config.min_messages_before_fork} messages — topic not yet established`,
      };
    }

    const branchMessages = branch.messages.map((m) => m.content);

    // Compute the baseline: how similar is each existing message to the rest?
    const baselineSimilarities = this.computeBaseline(branchMessages);

    // Compute the new message's similarity to the full topic vector
    const topicVector = buildTopicVector(branchMessages, this.config.topic_decay);
    const newSimilarity = cosineSimilarity(topicVector, messageTokens);
    const drift_score = 1 - newSimilarity;

    // Statistical comparison: is this message an outlier?
    const mean = baselineSimilarities.reduce((a, b) => a + b, 0) / baselineSimilarities.length;
    const variance = baselineSimilarities.reduce((sum, s) => sum + (s - mean) ** 2, 0) / baselineSimilarities.length;
    const stddev = Math.sqrt(variance);

    // How many standard deviations below the mean?
    const sigmasBelow = stddev > 0.001 ? (mean - newSimilarity) / stddev : 0;

    // Extract distinctive terms for topic suggestion
    const distinctive = distinctiveTerms(messageTokens, topicVector, 3);
    const suggested_topic =
      distinctive.length > 0 ? distinctive.join("-") : "tangent";

    // Confidence scales with data quantity and variance
    const dataConfidence = Math.min(branch.messages.length / 10, 1);
    const varianceConfidence = stddev > 0.01 ? 0.8 : 0.4; // low variance = less confident in outlier detection
    const confidence = Math.min(dataConfidence * varianceConfidence + 0.3, 1);

    // Fork decision: statistical outlier AND above absolute drift floor
    const isStatisticalOutlier = sigmasBelow >= this.config.sigma_threshold;
    const aboveFloor = drift_score >= this.config.absolute_drift_floor;
    const wouldFork = isStatisticalOutlier && aboveFloor;

    // Track consecutive drifts
    const branchKey = branch.id;
    if (wouldFork) {
      const count = (this.consecutive_drift_count.get(branchKey) ?? 0) + 1;
      this.consecutive_drift_count.set(branchKey, count);
    } else {
      this.consecutive_drift_count.set(branchKey, 0);
    }

    const consecutiveCount = this.consecutive_drift_count.get(branchKey) ?? 0;
    const meetsConsecutiveRequirement =
      consecutiveCount >= this.config.consecutive_drift_required;

    const should_fork = wouldFork && meetsConsecutiveRequirement;

    // Build reason string
    let reason: string;
    if (should_fork) {
      reason = `Drift ${drift_score.toFixed(2)}, ${sigmasBelow.toFixed(1)}σ below mean (baseline: ${mean.toFixed(2)}±${stddev.toFixed(2)}). Distinctive terms: [${distinctive.join(", ")}]`;
    } else if (wouldFork && !meetsConsecutiveRequirement) {
      reason = `Outlier detected (${sigmasBelow.toFixed(1)}σ) but needs ${this.config.consecutive_drift_required - consecutiveCount} more consecutive drifting message(s)`;
    } else if (isStatisticalOutlier && !aboveFloor) {
      reason = `Statistical outlier (${sigmasBelow.toFixed(1)}σ) but drift ${drift_score.toFixed(2)} below absolute floor ${this.config.absolute_drift_floor}`;
    } else {
      reason = `On topic: drift ${drift_score.toFixed(2)}, ${sigmasBelow.toFixed(1)}σ from mean (baseline: ${mean.toFixed(2)}±${stddev.toFixed(2)})`;
    }

    return {
      drift_score,
      should_fork,
      suggested_topic,
      confidence,
      reason,
    };
  }

  /**
   * Compute baseline similarity distribution for a branch.
   * For each message, compute its similarity to the topic vector
   * built from all other messages (leave-one-out).
   */
  private computeBaseline(messages: string[]): number[] {
    const similarities: number[] = [];

    for (let i = 0; i < messages.length; i++) {
      const others = messages.filter((_, j) => j !== i);
      if (others.length === 0) continue;

      const otherVector = buildTopicVector(others, this.config.topic_decay);
      const msgVector = textToTermFrequency(messages[i]);
      similarities.push(cosineSimilarity(otherVector, msgVector));
    }

    return similarities;
  }
}

// ── Question-Type Detector ──

/**
 * A heuristic detector that identifies messages that are questions
 * about a different domain than the current conversation.
 *
 * Complements the TF-based detector — catches cases where the vocabulary
 * overlap is low but the question structure signals a topic change.
 */
export class QuestionDriftDetector implements DriftDetector {
  private config: DriftDetectorConfig;

  constructor(config: Partial<DriftDetectorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  analyze(branch: BranchNode, new_message: string): DriftDetection {
    const lower = new_message.toLowerCase();

    // Detect "wait, how does X work?" / "actually, can you explain Y?" patterns
    // "what about" is excluded — too common in on-topic deepening questions
    const tangentPatterns = [
      /(?:wait|hold on|btw|by the way|sidebar|quick question)[,.]?\s/i,
      /(?:actually)[,.]?\s+(?:how|what|can you|could you|do we|is there)/i,
      /(?:can you explain|remind me how|remind me what)\s/i,
      /(?:unrelated|off.?topic|different question|separate thing|before i forget)/i,
    ];

    const hasTangentSignal = tangentPatterns.some((p) => p.test(lower));

    if (!hasTangentSignal) {
      return {
        drift_score: 0,
        should_fork: false,
        suggested_topic: "",
        confidence: 0.2,
        reason: "No tangent language patterns detected",
      };
    }

    if (branch.messages.length < this.config.min_messages_before_fork) {
      return {
        drift_score: 0,
        should_fork: false,
        suggested_topic: "",
        confidence: 0.3,
        reason: "Tangent signal detected but branch too young",
      };
    }

    // Check if the message vocabulary is actually different from the branch
    const branchMessages = branch.messages.map((m) => m.content);
    const topicVector = buildTopicVector(branchMessages, this.config.topic_decay);
    const messageVector = textToTermFrequency(new_message);
    const similarity = cosineSimilarity(topicVector, messageVector);
    const drift_score = 1 - similarity;

    // Tangent signal + vocabulary drift = high confidence fork
    // Use a lower bar than the TF detector since the tangent signal is itself evidence
    const boosted_score = Math.min(drift_score * 1.3, 1);
    const distinctive = distinctiveTerms(messageVector, topicVector, 3);
    const should_fork = boosted_score >= this.config.absolute_drift_floor * 0.85;

    return {
      drift_score: boosted_score,
      should_fork,
      suggested_topic:
        distinctive.length > 0 ? distinctive.join("-") : "tangent",
      confidence: 0.7,
      reason: hasTangentSignal
        ? `Tangent language detected + drift ${boosted_score.toFixed(2)} (boosted from ${drift_score.toFixed(2)})`
        : "No tangent signal",
    };
  }
}

// ── Composite Detector ──

/**
 * Combines multiple detectors. Forks if ANY detector recommends forking,
 * using the highest-confidence detection as the result.
 */
export class CompositeDetector implements DriftDetector {
  private detectors: DriftDetector[];

  constructor(detectors: DriftDetector[]) {
    this.detectors = detectors;
  }

  analyze(branch: BranchNode, new_message: string): DriftDetection {
    const results = this.detectors.map((d) => d.analyze(branch, new_message));

    // If any detector says fork, use the highest-confidence fork recommendation
    const forkResults = results.filter((r) => r.should_fork);
    if (forkResults.length > 0) {
      return forkResults.reduce((best, r) =>
        r.confidence > best.confidence ? r : best
      );
    }

    // Otherwise return the highest-confidence non-fork result
    return results.reduce((best, r) =>
      r.confidence > best.confidence ? r : best
    );
  }
}

/**
 * Create a default drift detector with sensible settings.
 */
export function createDefaultDetector(
  config: Partial<DriftDetectorConfig> = {}
): DriftDetector {
  return new CompositeDetector([
    new TermFrequencyDetector(config),
    new QuestionDriftDetector(config),
  ]);
}
