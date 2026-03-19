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
 * Recency score: exponential decay based on turns since segment was last active.
 * Returns 1.0 for the most recent, decaying toward 0.
 * Half-life of ~10 turns.
 */
export function recencyScore(turnsSinceActive: number): number {
  const halfLife = 10;
  return Math.pow(0.5, turnsSinceActive / halfLife);
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
  totalTurns: number,
  alpha: number
): ScoredSegment[] {
  const scored: ScoredSegment[] = segments.map((segment) => {
    // Active segment always wins
    if (segment.status === "active") {
      return { segment, score: 1.0, semanticScore: 1.0, recencyScoreValue: 1.0 };
    }

    const semantic = segment.embedding.length > 0
      ? Math.max(0, cosineSimilarity(segment.embedding, queryEmbedding))
      : 0;

    // Calculate turns since last active using actual timestamps.
    // We estimate the average turn duration from totalTurns and the time span,
    // then derive turnsSince from the segment's lastActiveAt.
    const now = Date.now();
    const oldestSegment = segments.reduce((oldest, s) =>
      s.lastActiveAt < oldest.lastActiveAt ? s : oldest, segments[0]);
    const timeSpan = now - oldestSegment.lastActiveAt;
    const avgTurnDuration = totalTurns > 1 ? timeSpan / totalTurns : 60000; // fallback: 1 min
    const timeSinceActive = now - segment.lastActiveAt;
    const turnsSince = avgTurnDuration > 0 ? timeSinceActive / avgTurnDuration : 0;

    const recency = recencyScore(turnsSince);

    const score = alpha * semantic + (1 - alpha) * recency;

    return { segment, score, semanticScore: semantic, recencyScoreValue: recency };
  });

  // Sort: active first, then by score descending
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
export async function getEmbedding(text: string, model: string, apiKey?: string): Promise<number[]> {
  const key = apiKey || process.env.GEMINI_API_KEY || "";
  if (!key) return [];

  try {
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
