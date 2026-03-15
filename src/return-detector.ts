/**
 * LLM-based return detector.
 *
 * Before checking for drift (new tangent), checks if the message
 * matches a PREVIOUS branch's topic better than the current one.
 *
 * Uses Moonshot to compare the message against branch topic summaries
 * and make a routing decision.
 */

import { BranchNode, BranchId } from "./types.js";

export interface ReturnDetection {
  should_return: boolean;
  target_branch_id: BranchId | null;
  target_branch_name: string;
  confidence: number;
  reason: string;
}

export interface ReturnDetectorConfig {
  api_key?: string;
  model?: string;
  base_url?: string;
  max_history_messages?: number;
  /** Minimum messages on current branch before considering return. Default: 2 */
  min_messages_before_return?: number;
}

const DEFAULTS: Required<ReturnDetectorConfig> = {
  api_key: "",
  model: "moonshot-v1-8k",
  base_url: "https://api.moonshot.ai/v1",
  max_history_messages: 10,
  min_messages_before_return: 2,
};

interface MoonshotResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message: string };
}

interface LLMReturnVerdict {
  action: "stay" | "return";
  target_branch: string;
  confidence: number;
  reasoning: string;
}

export class LLMReturnDetector {
  private config: Required<ReturnDetectorConfig>;

  constructor(config: ReturnDetectorConfig = {}) {
    this.config = {
      ...DEFAULTS,
      ...config,
      api_key: config.api_key || process.env.MOONSHOT_API_KEY || "",
    };

    if (!this.config.api_key) {
      throw new Error(
        "Moonshot API key required. Set MOONSHOT_API_KEY env var or pass api_key."
      );
    }
  }

  /**
   * Check if a message should return to a previous branch.
   */
  async analyze(
    current: BranchNode,
    candidates: BranchNode[],
    new_message: string
  ): Promise<ReturnDetection> {
    if (candidates.length === 0) {
      return {
        should_return: false,
        target_branch_id: null,
        target_branch_name: "",
        confidence: 1,
        reason: "No other branches to return to",
      };
    }

    if (current.messages.length < this.config.min_messages_before_return) {
      return {
        should_return: false,
        target_branch_id: null,
        target_branch_name: "",
        confidence: 0.5,
        reason: `Current branch has ${current.messages.length}/${this.config.min_messages_before_return} messages — tangent not yet explored`,
      };
    }

    const verdict = await this.callLLM(current, candidates, new_message);

    if (verdict.action === "return" && verdict.target_branch) {
      const target = candidates.find((b) => b.name === verdict.target_branch);
      if (target) {
        return {
          should_return: true,
          target_branch_id: target.id,
          target_branch_name: target.name,
          confidence: verdict.confidence,
          reason: verdict.reasoning,
        };
      }
    }

    return {
      should_return: false,
      target_branch_id: null,
      target_branch_name: "",
      confidence: verdict.confidence,
      reason: verdict.reasoning,
    };
  }

  private async callLLM(
    current: BranchNode,
    candidates: BranchNode[],
    new_message: string
  ): Promise<LLMReturnVerdict> {
    const currentSummary = this.branchSummary(current);
    const candidateSummaries = candidates
      .map((b) => `- "${b.name}": ${this.branchSummary(b)}`)
      .join("\n");

    const systemPrompt = `You are a conversation router. Given a current conversation branch, a list of previous branches, and a new message, determine if the user is returning to a previous topic.

Respond with ONLY a JSON object (no markdown, no code fences):
{
  "action": "stay" or "return",
  "target_branch": "branch-name if returning, empty string if staying",
  "confidence": 0.0 to 1.0,
  "reasoning": "brief one-sentence explanation"
}

Rules:
- "return": The message clearly relates to a previous branch's topic, not the current one
- "stay": The message continues the current branch, or is a new tangent (not a return)
- Look for explicit return signals: "back to", "anyway", "so about", "returning to", "as I was saying"
- Also detect implicit returns: the message's content matches a previous branch better than the current one
- If the message is a NEW tangent (unrelated to both current and previous), choose "stay" — drift detection handles new tangents separately
- Be conservative: only return when clearly matching a previous branch`;

    const userPrompt = `Current branch "${current.name}":
${currentSummary}

Previous branches:
${candidateSummaries}

New message:
user: ${new_message}

Is this message returning to a previous branch, or staying on the current topic?`;

    const body = JSON.stringify({
      model: this.config.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 200,
      temperature: 0.1,
    });

    const response = await fetch(
      `${this.config.base_url}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.api_key}`,
        },
        body,
      }
    );

    const data = (await response.json()) as MoonshotResponse;

    if (data.error) {
      throw new Error(`Moonshot API error: ${data.error.message}`);
    }

    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new Error("Empty response from Moonshot API");
    }

    try {
      const cleaned = content
        .replace(/```json?\s*/g, "")
        .replace(/```\s*/g, "")
        .trim();
      return JSON.parse(cleaned) as LLMReturnVerdict;
    } catch {
      return {
        action: "stay",
        target_branch: "",
        confidence: 0.3,
        reasoning: `Failed to parse LLM response: ${content.substring(0, 100)}`,
      };
    }
  }

  private branchSummary(branch: BranchNode): string {
    const recent = branch.messages
      .slice(-this.config.max_history_messages)
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n  ");
    return recent || branch.topic_summary || "(empty branch)";
  }
}
