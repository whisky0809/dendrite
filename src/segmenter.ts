import { createSegment, estimateTokens, type Segment, type SegmentIndex, type SimpleMessage, type DendriteConfig } from "./types.js";

// ── Drift detection prompt (extracted from v1 llm-drift-detector.ts) ──

export interface DriftVerdict {
  classification: "on_topic" | "tangent" | "uncertain";
  confidence: number;
  suggested_topic: string;
  reasoning: string;
}

export function buildDriftPrompt(
  recentMessages: SimpleMessage[],
  newMessage: string
): { system: string; user: string } {
  // Prompt faithfully extracted from v1 llm-drift-detector.ts (lines 125-141),
  // validated against 14/14 real Atlas session boundaries.
  const system = `You are a conversation topic analyzer. Your job is to determine whether a new message continues the current conversation topic or diverges into a tangent that would benefit from a separate context.

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

  const history = recentMessages
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  const user = `Current conversation:\n${history}\n\nNew message:\nuser: ${newMessage}\n\nIs this new message on-topic or a tangent?`;

  return { system, user };
}

export function parseDriftResponse(raw: string): DriftVerdict {
  // Strip code fences (v1-style aggressive approach for robustness)
  let cleaned = raw.replace(/```json?\s*/g, "").replace(/```\s*/g, "").trim();

  try {
    const parsed = JSON.parse(cleaned);
    return {
      classification: parsed.classification || "on_topic",
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      suggested_topic: parsed.suggested_topic || "",
      reasoning: parsed.reasoning || "",
    };
  } catch {
    // Fallback: keyword detection
    const lower = raw.toLowerCase();
    if (lower.includes("tangent")) {
      return { classification: "tangent", confidence: 0.4, suggested_topic: "", reasoning: raw.slice(0, 100) };
    }
    return { classification: "on_topic", confidence: 0.4, suggested_topic: "", reasoning: raw.slice(0, 100) };
  }
}

export async function callDriftModel(
  system: string,
  user: string,
  model: string,
  apiKey: string = process.env.OPENROUTER_API_KEY || ""
): Promise<DriftVerdict> {
  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: 200,
      temperature: 0.1,
    }),
  });

  if (!resp.ok) {
    throw new Error(`Drift model error: ${resp.status} ${resp.statusText}`);
  }

  const data = (await resp.json()) as any;
  const content = data.choices?.[0]?.message?.content || "";
  return parseDriftResponse(content);
}

// ── Segmenter class ──

export interface AddMessageResult {
  action: "added" | "force-split";
  needsDriftCheck: boolean;
  /** The message that needs a drift check (only set when needsDriftCheck=true) */
  pendingMessage?: SimpleMessage;
}

interface SegmenterOptions {
  minMessagesBeforeDrift: number;
  maxSegmentMessages: number;
  driftThreshold: number;
}

export class Segmenter {
  segments: Segment[] = [];
  /** All messages indexed by ID for retrieval */
  private messageStore = new Map<string, SimpleMessage>();

  private opts: SegmenterOptions;

  constructor(opts: SegmenterOptions) {
    this.opts = opts;
  }

  get activeSegment(): Segment | null {
    return this.segments.find((s) => s.status === "active") || null;
  }

  /** Add a message. Returns whether the caller needs to run drift detection. */
  addMessage(msg: SimpleMessage): AddMessageResult {
    this.messageStore.set(msg.id, msg);

    // Cold start
    if (this.segments.length === 0) {
      const seg = createSegment("conversation");
      seg.messageIds.push(msg.id);
      seg.messageCount = 1;
      seg.tokenCount += estimateTokens(msg.content);
      seg.lastActiveAt = msg.timestamp;
      this.segments.push(seg);
      return { action: "added", needsDriftCheck: false };
    }

    const active = this.activeSegment!;

    // Force split if max size exceeded
    if (active.messageCount >= this.opts.maxSegmentMessages) {
      active.status = "closed";
      const newSeg = createSegment(active.topic);
      newSeg.messageIds.push(msg.id);
      newSeg.messageCount = 1;
      newSeg.tokenCount = estimateTokens(msg.content);
      newSeg.lastActiveAt = msg.timestamp;
      this.segments.push(newSeg);
      return { action: "force-split", needsDriftCheck: false };
    }

    // Add to active segment
    active.messageIds.push(msg.id);
    active.messageCount++;
    active.tokenCount += estimateTokens(msg.content);
    active.lastActiveAt = msg.timestamp;

    // Check if drift detection is needed
    const needsDriftCheck =
      msg.role === "user" &&
      active.messageCount > this.opts.minMessagesBeforeDrift;

    return {
      action: "added",
      needsDriftCheck,
      pendingMessage: needsDriftCheck ? msg : undefined,
    };
  }

  /** Split the active segment: close it, move the last message to a new segment with given topic. */
  splitOnDrift(topic: string): void {
    const active = this.activeSegment;
    if (!active || active.messageCount === 0) return;

    // The last message (the one that triggered drift) moves to the new segment
    const lastMsgId = active.messageIds.pop()!;
    const lastMsg = this.messageStore.get(lastMsgId);
    active.messageCount--;
    if (lastMsg) active.tokenCount -= estimateTokens(lastMsg.content);
    active.status = "closed";

    const newSeg = createSegment(topic);
    newSeg.messageIds.push(lastMsgId);
    newSeg.messageCount = 1;
    newSeg.tokenCount = lastMsg ? estimateTokens(lastMsg.content) : 0;
    newSeg.lastActiveAt = lastMsg?.timestamp || Date.now();
    this.segments.push(newSeg);
  }

  /** Get recent messages from the active segment for building the drift prompt. */
  getRecentMessages(n: number): SimpleMessage[] {
    const active = this.activeSegment;
    if (!active) return [];
    const ids = active.messageIds.slice(-n);
    return ids
      .map((id) => this.messageStore.get(id))
      .filter((m): m is SimpleMessage => m !== undefined);
  }

  /** Get messages by IDs (for assembler). */
  getMessages(ids: string[]): SimpleMessage[] {
    return ids
      .map((id) => this.messageStore.get(id))
      .filter((m): m is SimpleMessage => m !== undefined);
  }

  /** Load from a persisted SegmentIndex. */
  loadIndex(index: SegmentIndex, messages: SimpleMessage[]): void {
    this.segments = index.segments.map((s) => ({
      ...s,
      messageIds: [...s.messageIds],
      embedding: [...s.embedding],
    }));
    this.messageStore.clear();
    for (const msg of messages) {
      this.messageStore.set(msg.id, msg);
    }
  }

  /** Export current state as a SegmentIndex. */
  toIndex(): SegmentIndex {
    return {
      version: 1,
      segments: this.segments.map((s) => ({
        ...s,
        messageIds: [...s.messageIds],
        embedding: [...s.embedding],
      })),
    };
  }
}
