/**
 * Embedding-based drift detector using Google's Gemini embedding model.
 *
 * Uses real semantic embeddings instead of bag-of-words, so it understands
 * that "database index" and "query optimization" are related even though
 * they share no words.
 */

import { BranchNode } from "./types.js";
import {
  DriftDetector,
  DriftDetection,
} from "./drift-detector.js";

export interface EmbeddingDetectorConfig {
  /** Gemini API key. Defaults to GEMINI_API_KEY env var. */
  api_key?: string;
  /** Embedding model. Default: gemini-embedding-001 */
  model?: string;
  /** Minimum messages before evaluating. Default: 3 */
  min_messages_before_fork?: number;
  /**
   * How many standard deviations below the mean similarity
   * a message must be to trigger a fork. Default: 1.8
   */
  sigma_threshold?: number;
  /**
   * Absolute drift floor. Default: 0.15
   * (Embedding cosine distance, not bag-of-words — scale is different)
   */
  absolute_drift_floor?: number;
}

const DEFAULTS: Required<EmbeddingDetectorConfig> = {
  api_key: "",
  model: "gemini-embedding-001",
  min_messages_before_fork: 3,
  sigma_threshold: 1.8,
  absolute_drift_floor: 0.15,
};

export class EmbeddingDriftDetector implements DriftDetector {
  private config: Required<EmbeddingDetectorConfig>;
  // Cache embeddings to avoid redundant API calls
  private cache: Map<string, number[]> = new Map();

  constructor(config: EmbeddingDetectorConfig = {}) {
    this.config = {
      ...DEFAULTS,
      ...config,
      api_key: config.api_key || process.env.GEMINI_API_KEY || "",
    };

    if (!this.config.api_key) {
      throw new Error(
        "Gemini API key required. Set GEMINI_API_KEY env var or pass api_key in config."
      );
    }
  }

  analyze(_branch: BranchNode, _new_message: string): DriftDetection {
    throw new Error(
      "EmbeddingDriftDetector requires async. Use analyzeAsync() instead."
    );
  }

  async analyzeAsync(
    branch: BranchNode,
    new_message: string
  ): Promise<DriftDetection> {
    if (branch.messages.length < this.config.min_messages_before_fork) {
      return {
        drift_score: 0,
        should_fork: false,
        suggested_topic: "",
        confidence: 0.3,
        reason: `Branch has ${branch.messages.length}/${this.config.min_messages_before_fork} messages — topic not yet established`,
      };
    }

    // Get embeddings for all branch messages and the new message
    const branchTexts = branch.messages.map((m) => m.content);
    const allTexts = [...branchTexts, new_message];
    const embeddings = await this.getEmbeddings(allTexts);

    const branchEmbeddings = embeddings.slice(0, branchTexts.length);
    const newEmbedding = embeddings[embeddings.length - 1];

    // Compute centroid of branch embeddings
    const centroid = this.computeCentroid(branchEmbeddings);

    // Compute similarity of new message to centroid
    const newSimilarity = this.cosineSimilarity(newEmbedding, centroid);

    // Compute baseline: each branch message's similarity to centroid
    const baselineSimilarities = branchEmbeddings.map((emb) =>
      this.cosineSimilarity(emb, centroid)
    );

    const mean =
      baselineSimilarities.reduce((a, b) => a + b, 0) /
      baselineSimilarities.length;
    const variance =
      baselineSimilarities.reduce((sum, s) => sum + (s - mean) ** 2, 0) /
      baselineSimilarities.length;
    const stddev = Math.sqrt(variance);

    // Drift = 1 - similarity (so higher = more different)
    const drift_score = 1 - newSimilarity;
    const sigmasBelow =
      stddev > 0.001 ? (mean - newSimilarity) / stddev : 0;

    const isOutlier = sigmasBelow >= this.config.sigma_threshold;
    const aboveFloor = drift_score >= this.config.absolute_drift_floor;
    const should_fork = isOutlier && aboveFloor;

    const confidence = Math.min(
      0.4 + 0.5 * Math.min(branch.messages.length / 8, 1),
      0.95
    );

    let reason: string;
    if (should_fork) {
      reason = `Embedding drift ${drift_score.toFixed(3)}, ${sigmasBelow.toFixed(1)}σ below mean (baseline: ${mean.toFixed(3)}±${stddev.toFixed(3)})`;
    } else if (isOutlier && !aboveFloor) {
      reason = `Outlier (${sigmasBelow.toFixed(1)}σ) but drift ${drift_score.toFixed(3)} below floor ${this.config.absolute_drift_floor}`;
    } else {
      reason = `On topic: drift ${drift_score.toFixed(3)}, ${sigmasBelow.toFixed(1)}σ from mean (baseline: ${mean.toFixed(3)}±${stddev.toFixed(3)})`;
    }

    return {
      drift_score,
      should_fork,
      suggested_topic: "", // LLM detector handles naming
      confidence,
      reason,
    };
  }

  /**
   * Get embeddings for multiple texts, using cache where possible.
   */
  private async getEmbeddings(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    const uncachedIndices: number[] = [];
    const uncachedTexts: string[] = [];

    for (let i = 0; i < texts.length; i++) {
      const cached = this.cache.get(texts[i]);
      if (cached) {
        results[i] = cached;
      } else {
        uncachedIndices.push(i);
        uncachedTexts.push(texts[i]);
      }
    }

    if (uncachedTexts.length > 0) {
      // Batch embed uncached texts
      const embeddings = await this.batchEmbed(uncachedTexts);
      for (let j = 0; j < uncachedIndices.length; j++) {
        const idx = uncachedIndices[j];
        results[idx] = embeddings[j];
        this.cache.set(texts[idx], embeddings[j]);
      }
    }

    return results;
  }

  /**
   * Call Gemini batch embedding API.
   */
  private async batchEmbed(texts: string[]): Promise<number[][]> {
    const requests = texts.map((text) => ({
      model: `models/${this.config.model}`,
      content: { parts: [{ text }] },
    }));

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.config.model}:batchEmbedContents`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": this.config.api_key,
        },
        body: JSON.stringify({ requests }),
      }
    );

    const data = (await response.json()) as {
      embeddings?: Array<{ values: number[] }>;
      error?: { message: string };
    };

    if (data.error) {
      throw new Error(`Gemini API error: ${data.error.message}`);
    }

    if (!data.embeddings || data.embeddings.length !== texts.length) {
      throw new Error("Unexpected response from Gemini batch embedding API");
    }

    return data.embeddings.map((e) => e.values);
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  private computeCentroid(embeddings: number[][]): number[] {
    const dim = embeddings[0].length;
    const centroid = new Array(dim).fill(0);
    for (const emb of embeddings) {
      for (let i = 0; i < dim; i++) {
        centroid[i] += emb[i];
      }
    }
    for (let i = 0; i < dim; i++) {
      centroid[i] /= embeddings.length;
    }
    return centroid;
  }
}
