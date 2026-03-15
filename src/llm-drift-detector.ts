/**
 * LLM-based drift detector using Moonshot (Kimi) API.
 *
 * Instead of bag-of-words similarity, this asks an LLM:
 * "Is this message continuing the current topic, or is it a tangent?"
 *
 * Much more accurate than term frequency — the LLM understands semantic
 * meaning, not just word overlap.
 */

import { BranchNode } from "./types.js";
import {
  DriftDetector,
  DriftDetection,
  DriftDetectorConfig,
  DEFAULT_CONFIG,
} from "./drift-detector.js";

export interface LLMDetectorConfig {
  /** Moonshot API key. Defaults to MOONSHOT_API_KEY env var. */
  api_key?: string;
  /** Model to use. Default: moonshot-v1-8k (cheapest) */
  model?: string;
  /** Base URL. Default: https://api.moonshot.ai/v1 */
  base_url?: string;
  /** Max messages from branch history to include in the prompt. Default: 10 */
  max_history_messages?: number;
  /** Minimum messages before evaluating. Default: 3 */
  min_messages_before_fork?: number;
}

const LLM_DEFAULTS: Required<LLMDetectorConfig> = {
  api_key: "",
  model: "moonshot-v1-8k",
  base_url: "https://api.moonshot.ai/v1",
  max_history_messages: 10,
  min_messages_before_fork: 3,
};

interface MoonshotResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message: string;
  };
}

interface LLMVerdict {
  classification: "on_topic" | "tangent" | "uncertain";
  confidence: number;
  suggested_topic: string;
  reasoning: string;
}

export class LLMDriftDetector implements DriftDetector {
  private config: Required<LLMDetectorConfig>;

  constructor(config: LLMDetectorConfig = {}) {
    this.config = {
      ...LLM_DEFAULTS,
      ...config,
      api_key: config.api_key || process.env.MOONSHOT_API_KEY || "",
    };

    if (!this.config.api_key) {
      throw new Error(
        "Moonshot API key required. Set MOONSHOT_API_KEY env var or pass api_key in config."
      );
    }
  }

  analyze(branch: BranchNode, new_message: string): DriftDetection {
    // Can't use async in the interface, so we throw an error pointing to analyzeAsync
    throw new Error(
      "LLMDriftDetector requires async. Use analyzeAsync() instead, or use LLMBranchTree."
    );
  }

  async analyzeAsync(
    branch: BranchNode,
    new_message: string
  ): Promise<DriftDetection> {
    // Not enough history
    if (branch.messages.length < this.config.min_messages_before_fork) {
      return {
        drift_score: 0,
        should_fork: false,
        suggested_topic: "",
        confidence: 0.3,
        reason: `Branch has ${branch.messages.length}/${this.config.min_messages_before_fork} messages — topic not yet established`,
      };
    }

    // Build the conversation summary for the prompt
    const recentMessages = branch.messages
      .slice(-this.config.max_history_messages)
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n");

    const verdict = await this.callLLM(recentMessages, new_message);

    const drift_score =
      verdict.classification === "tangent"
        ? 0.9
        : verdict.classification === "uncertain"
          ? 0.5
          : 0.1;

    return {
      drift_score,
      should_fork: verdict.classification === "tangent",
      suggested_topic: verdict.suggested_topic,
      confidence: verdict.confidence,
      reason: verdict.reasoning,
    };
  }

  private async callLLM(
    conversation_history: string,
    new_message: string
  ): Promise<LLMVerdict> {
    const systemPrompt = `You are a conversation topic analyzer. Your job is to determine whether a new message continues the current conversation topic or diverges into a tangent that would benefit from a separate context.

Respond with ONLY a JSON object (no markdown, no code fences):
{
  "classification": "on_topic" or "tangent" or "uncertain",
  "confidence": 0.0 to 1.0,
  "suggested_topic": "short-topic-name if tangent, empty string if on_topic",
  "reasoning": "brief one-sentence explanation"
}

Rules:
- "on_topic": The message deepens, continues, or directly relates to the current discussion
- "tangent": The message shifts to a substantially different subject that would need different context to answer well
- "uncertain": Could go either way
- A question that RELATES to the current topic (e.g., asking about a dependency of what's being discussed) is still on_topic
- Phrases like "wait", "actually", "btw", "by the way" are hints but not proof of tangent — check if the actual content is related
- Be conservative: only classify as "tangent" when the topic genuinely shifts`;

    const userPrompt = `Current conversation:
${conversation_history}

New message:
user: ${new_message}

Is this new message on-topic or a tangent?`;

    const body = JSON.stringify({
      model: this.config.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 200,
      temperature: 0.1,
    });

    const response = await fetch(`${this.config.base_url}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.api_key}`,
      },
      body,
    });

    const data = (await response.json()) as MoonshotResponse;

    if (data.error) {
      throw new Error(`Moonshot API error: ${data.error.message}`);
    }

    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new Error("Empty response from Moonshot API");
    }

    try {
      // Strip markdown code fences if present
      const cleaned = content.replace(/```json?\s*/g, "").replace(/```\s*/g, "").trim();
      return JSON.parse(cleaned) as LLMVerdict;
    } catch {
      // If JSON parsing fails, try to extract classification from text
      const lower = content.toLowerCase();
      return {
        classification: lower.includes("tangent")
          ? "tangent"
          : lower.includes("on_topic")
            ? "on_topic"
            : "uncertain",
        confidence: 0.4,
        suggested_topic: "",
        reasoning: `Failed to parse LLM response, inferred from text: ${content.substring(0, 100)}`,
      };
    }
  }
}
