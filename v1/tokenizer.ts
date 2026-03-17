/**
 * Simple text processing utilities for drift detection.
 * No external dependencies — works standalone.
 */

// Common English stopwords to filter out
const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "must",
  "i", "me", "my", "we", "our", "you", "your", "he", "she", "it",
  "they", "them", "their", "this", "that", "these", "those",
  "what", "which", "who", "whom", "where", "when", "why", "how",
  "in", "on", "at", "to", "for", "of", "with", "by", "from", "as",
  "into", "through", "during", "before", "after", "above", "below",
  "between", "out", "off", "over", "under", "again", "further",
  "and", "but", "or", "nor", "not", "so", "yet", "both", "either",
  "neither", "each", "every", "all", "any", "few", "more", "most",
  "other", "some", "such", "no", "only", "own", "same", "than",
  "too", "very", "just", "about", "also", "then", "here", "there",
  "if", "because", "until", "while",
  // Conversational filler
  "let", "lets", "like", "think", "know", "want", "get", "make",
  "go", "see", "look", "way", "use", "well", "also", "back",
  "okay", "right", "yeah", "yes", "no", "sure", "got", "going",
  "thing", "things", "really", "actually", "maybe", "probably",
]);

/**
 * Tokenize text into normalized terms, filtering stopwords.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, " ")  // strip punctuation
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word));
}

/**
 * Term frequency map: how often each term appears, normalized by total terms.
 */
export type TermFrequency = Map<string, number>;

export function termFrequency(tokens: string[]): TermFrequency {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  // Normalize by total count
  const total = tokens.length || 1;
  const tf = new Map<string, number>();
  for (const [term, count] of counts) {
    tf.set(term, count / total);
  }
  return tf;
}

/**
 * Compute term frequency from a block of text.
 */
export function textToTermFrequency(text: string): TermFrequency {
  return termFrequency(tokenize(text));
}

/**
 * Cosine similarity between two term frequency vectors.
 * Returns 0 (completely different) to 1 (identical distribution).
 */
export function cosineSimilarity(a: TermFrequency, b: TermFrequency): number {
  if (a.size === 0 || b.size === 0) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  // All unique terms from both vectors
  const allTerms = new Set([...a.keys(), ...b.keys()]);

  for (const term of allTerms) {
    const va = a.get(term) ?? 0;
    const vb = b.get(term) ?? 0;
    dotProduct += va * vb;
    normA += va * va;
    normB += vb * vb;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

/**
 * Extract the N most distinctive terms from a text relative to a reference.
 * "Distinctive" = high frequency in text, low frequency in reference.
 */
export function distinctiveTerms(
  text: TermFrequency,
  reference: TermFrequency,
  n: number = 5
): string[] {
  const scored: Array<[string, number]> = [];

  for (const [term, freq] of text) {
    const refFreq = reference.get(term) ?? 0;
    // Score: high in text, low in reference
    const distinctiveness = freq * (1 - refFreq);
    scored.push([term, distinctiveness]);
  }

  return scored
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([term]) => term);
}

/**
 * Build a combined term frequency from multiple texts.
 * Uses exponential decay to weight recent messages more heavily.
 */
export function buildTopicVector(
  messages: string[],
  decay: number = 0.9
): TermFrequency {
  if (messages.length === 0) return new Map();

  const combined = new Map<string, number>();
  let weight = 1;
  let totalWeight = 0;

  // Process from most recent to oldest
  for (let i = messages.length - 1; i >= 0; i--) {
    const tokens = tokenize(messages[i]);
    const tf = termFrequency(tokens);

    for (const [term, freq] of tf) {
      combined.set(term, (combined.get(term) ?? 0) + freq * weight);
    }

    totalWeight += weight;
    weight *= decay;
  }

  // Normalize by total weight
  for (const [term, value] of combined) {
    combined.set(term, value / totalWeight);
  }

  return combined;
}
