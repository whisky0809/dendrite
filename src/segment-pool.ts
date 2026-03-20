import * as fs from "node:fs";
import * as path from "node:path";
import type { Segment, SimpleMessage } from "./types.js";

export interface SessionSegmentFile {
  sessionId: string;
  agentId: string;
  transcriptPath: string;
  exportedAt: number;
  segments: Segment[];
}

export class SegmentPool {
  poolSegments: Segment[] = [];
  private segmentsDir: string;

  constructor(baseDir: string) {
    this.segmentsDir = path.join(baseDir, "dendrite", "segments");
    this.loadAll();
  }

  private loadAll(): void {
    if (!fs.existsSync(this.segmentsDir)) return;

    const files = fs.readdirSync(this.segmentsDir).filter(f => f.endsWith(".json"));
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(this.segmentsDir, file), "utf-8");
        const data: SessionSegmentFile = JSON.parse(raw);
        for (const seg of data.segments) {
          seg.sessionId = data.sessionId;
          seg.transcriptPath = data.transcriptPath;
          this.poolSegments.push(seg);
        }
      } catch {
        // Skip corrupt files
      }
    }
  }

  getCombinedSegments(currentSegments: Segment[], currentSessionId: string): Segment[] {
    const poolFiltered = this.poolSegments.filter(s => s.sessionId !== currentSessionId);
    return [...currentSegments, ...poolFiltered];
  }

  persistSession(sessionId: string, segments: Segment[], agentId: string, transcriptPath: string): void {
    fs.mkdirSync(this.segmentsDir, { recursive: true });

    const closedSegments = segments.filter(s => s.status === "closed");
    const file: SessionSegmentFile = {
      sessionId,
      agentId,
      transcriptPath,
      exportedAt: Date.now(),
      segments: closedSegments.map(s => ({
        ...s,
        sessionId: undefined,
        transcriptPath: undefined,
        messageIds: [...s.messageIds],
        embedding: [...s.embedding],
      })),
    };

    fs.writeFileSync(
      path.join(this.segmentsDir, `${sessionId}.json`),
      JSON.stringify(file, null, 2)
    );

    // Remove old pool segments for this session and add new ones
    this.poolSegments = this.poolSegments.filter(s => s.sessionId !== sessionId);
    for (const seg of closedSegments) {
      this.poolSegments.push({
        ...seg,
        sessionId,
        transcriptPath,
        messageIds: [...seg.messageIds],
        embedding: [...seg.embedding],
      });
    }
  }

  loadMessages(transcriptPath: string, messageIds: string[]): SimpleMessage[] {
    try {
      if (!fs.existsSync(transcriptPath)) return [];
      const content = fs.readFileSync(transcriptPath, "utf-8");
      const idSet = new Set(messageIds);
      const result: SimpleMessage[] = [];

      for (const line of content.split("\n").filter(Boolean)) {
        try {
          const entry = JSON.parse(line);
          if (entry.id && idSet.has(entry.id)) {
            const role = entry.role;
            if (role !== "user" && role !== "assistant" && role !== "toolResult") continue;
            const text = typeof entry.content === "string"
              ? entry.content
              : Array.isArray(entry.content)
                ? entry.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("")
                : "";
            if (text) {
              result.push({ id: entry.id, role, content: text, timestamp: entry.timestamp || 0 });
            }
            if (result.length === messageIds.length) break; // found all
          }
        } catch { /* skip malformed line */ }
      }

      // Return in the order requested
      const byId = new Map(result.map(m => [m.id, m]));
      return messageIds.map(id => byId.get(id)).filter((m): m is SimpleMessage => m !== undefined);
    } catch {
      return [];
    }
  }
}
