import type { Segment } from "./types.js";

export interface ScoredSegment {
  segment: Segment;
  score: number;
  semanticScore: number;
  recencyScoreValue: number;
}

/** Cosine similarity between two vectors. Returns 0 for empty/zero vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Recency score: exponential decay based on time since segment was last active.
 * Returns 1.0 for the most recent, decaying toward 0.
 */
export function recencyScore(msSinceActive: number, halfLifeMs: number): number {
  return Math.pow(0.5, msSinceActive / halfLifeMs);
}

/**
 * Score all segments for relevance.
 *
 * Active segment always gets score 1.0 (Infinity priority).
 * Others scored by: alpha * semantic + (1-alpha) * recency.
 *
 * Returns sorted array, highest score first.
 */
export function scoreSegments(
  segments: Segment[],
  queryEmbedding: number[],
  halfLifeMs: number,
  alpha: number
): ScoredSegment[] {
  const now = Date.now();
  const scored: ScoredSegment[] = segments.map((segment) => {
    if (segment.status === "active") {
      return { segment, score: 1.0, semanticScore: 1.0, recencyScoreValue: 1.0 };
    }

    const semantic = segment.embedding.length > 0
      ? Math.max(0, cosineSimilarity(segment.embedding, queryEmbedding))
      : 0;

    const msSinceActive = now - segment.lastActiveAt;
    const recency = recencyScore(msSinceActive, halfLifeMs);

    // If segment has no embedding, use recency only
    const effectiveAlpha = segment.embedding.length > 0 ? alpha : 0;
    const score = effectiveAlpha * semantic + (1 - effectiveAlpha) * recency;

    return { segment, score, semanticScore: semantic, recencyScoreValue: recency };
  });

  scored.sort((a, b) => {
    if (a.segment.status === "active") return -1;
    if (b.segment.status === "active") return 1;
    return b.score - a.score;
  });

  return scored;
}

/**
 * Call embedding model to get a vector for the given text.
 * Falls back to empty vector on failure.
 */
export async function getEmbedding(text: string, model: string, apiKey?: string, provider?: string): Promise<number[]> {
  const key = apiKey || "";
  if (!key) return [];

  try {
    // Route through OpenRouter for non-Google models
    if (provider === "openrouter" || model.includes("/")) {
      const resp = await fetch("https://openrouter.ai/api/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${key}`,
        },
        body: JSON.stringify({ model, input: text }),
      });
      if (!resp.ok) return [];
      const data = (await resp.json()) as any;
      return data.data?.[0]?.embedding || [];
    }

    // Google Generative AI API
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: `models/${model}`,
          content: { parts: [{ text }] },
        }),
      }
    );

    if (!resp.ok) return [];
    const data = (await resp.json()) as any;
    return data.embedding?.values || [];
  } catch {
    return [];
  }
}
