import type { SimpleMessage } from "./types.js";

export function buildSummaryPrompt(
  topic: string,
  messages: SimpleMessage[]
): { system: string; user: string } {
  const system = `You summarize conversation segments concisely. Include:
- Topic and what was discussed
- Key decisions made
- Open questions or unfinished items
- Any code or technical artifacts referenced

Keep it under 150 words. Write in plain text, no markdown headers.`;

  const conversation = messages
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  const user = `Summarize this conversation segment about "${topic}":\n\n${conversation}`;

  return { system, user };
}

export function parseSummaryResponse(raw: string): string {
  return raw
    .replace(/^```(?:\w+)?\s*/m, "")
    .replace(/\s*```\s*$/m, "")
    .trim();
}

export function fallbackSummary(topic: string, messageCount: number): string {
  return `${topic}: ~${messageCount} messages, summary unavailable`;
}

export async function callSummaryModel(
  system: string,
  user: string,
  model: string
): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY || "";
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
      max_tokens: 300,
      temperature: 0.2,
    }),
  });

  if (!resp.ok) {
    throw new Error(`Summary model error: ${resp.status} ${resp.statusText}`);
  }

  const data = (await resp.json()) as any;
  return parseSummaryResponse(data.choices?.[0]?.message?.content || "");
}

/**
 * Generate a summary for a segment. Handles errors with fallback.
 */
export async function generateSummary(
  topic: string,
  messages: SimpleMessage[],
  model: string
): Promise<string> {
  try {
    const { system, user } = buildSummaryPrompt(topic, messages);
    return await callSummaryModel(system, user, model);
  } catch {
    return fallbackSummary(topic, messages.length);
  }
}
