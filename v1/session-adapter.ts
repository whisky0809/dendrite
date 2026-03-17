/**
 * Session Adapter — parses OpenClaw JSONL session files into dendrite format.
 *
 * Handles the Discord metadata wrapping, heartbeat filtering, and content
 * extraction that's specific to OpenClaw's session format.
 */

import * as fs from "fs";

export interface ParsedMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  message_id?: string;
}

export interface ParsedSession {
  session_id: string;
  messages: ParsedMessage[];
  metadata: {
    total_events: number;
    filtered_heartbeats: number;
    model?: string;
    provider?: string;
  };
}

/**
 * Parse an OpenClaw JSONL session file into clean conversation messages.
 */
export function parseSessionFile(filePath: string): ParsedSession {
  const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);

  let session_id = "";
  let model: string | undefined;
  let provider: string | undefined;
  let total_events = 0;
  let filtered_heartbeats = 0;
  const messages: ParsedMessage[] = [];

  for (const line of lines) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    total_events++;

    // Extract session metadata
    if (entry.type === "session") {
      session_id = entry.id || "";
      continue;
    }
    if (entry.type === "model_change") {
      model = entry.modelId;
      provider = entry.provider;
      continue;
    }

    if (entry.type !== "message") continue;

    const msg = entry.message;
    if (!msg) continue;

    const role = msg.role as string;
    if (role !== "user" && role !== "assistant") continue;

    // Extract text content (can be string or content array)
    let text: string;
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = msg.content
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text)
        .join(" ");
    } else {
      continue;
    }

    if (!text.trim()) continue;

    // Filter heartbeat noise
    if (
      text.includes("Read HEARTBEAT.md if it exists") ||
      text.trim() === "HEARTBEAT_OK"
    ) {
      filtered_heartbeats++;
      continue;
    }

    // Extract actual user content from Discord metadata wrapper
    if (role === "user" && text.includes("Conversation info")) {
      text = extractDiscordContent(text);
    }

    // Skip very short messages (reactions, acks)
    if (text.trim().length < 3) continue;

    messages.push({
      role: role as "user" | "assistant",
      content: text.trim(),
      timestamp: entry.timestamp || "",
      message_id: entry.id,
    });
  }

  return {
    session_id,
    messages,
    metadata: { total_events, filtered_heartbeats, model, provider },
  };
}

/**
 * Extract the actual user message from Discord metadata wrapping.
 *
 * OpenClaw wraps Discord messages like:
 * ```
 * Conversation info (untrusted metadata): ```json { ... "content": "actual message" } ```
 * ```
 */
function extractDiscordContent(raw: string): string {
  // Try to find the "content" field in the JSON metadata
  const contentMatch = raw.match(/"content":\s*"((?:[^"\\]|\\.)*)"/);
  if (contentMatch) {
    try {
      return JSON.parse(`"${contentMatch[1]}"`);
    } catch {
      return contentMatch[1];
    }
  }
  return raw;
}

/**
 * List available session files in an OpenClaw sessions directory.
 * Returns them sorted by modification time (most recent first).
 */
export function listSessions(
  sessionsDir: string
): Array<{ path: string; name: string; size: number; mtime: Date }> {
  const entries = fs.readdirSync(sessionsDir);
  return entries
    .filter((f) => f.endsWith(".jsonl") || f.includes(".jsonl.reset"))
    .map((f) => {
      const fullPath = `${sessionsDir}/${f}`;
      const stat = fs.statSync(fullPath);
      return { path: fullPath, name: f, size: stat.size, mtime: stat.mtime };
    })
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}
