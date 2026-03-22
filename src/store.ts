import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_CONFIG, type DendriteConfig, type TurnSnapshot } from "./types.js";

export interface TurnListEntry {
  filename: string;
  turnIndex: number;
  timestamp: number;
}

export class DendriteStore {
  private baseDir: string;
  private configPath: string;

  constructor(baseDir: string, configPath: string) {
    this.baseDir = baseDir;
    this.configPath = configPath;
  }

  private turnsDir(sessionId: string): string {
    return path.join(this.baseDir, "dendrite", "turns", sessionId);
  }

  persistTurn(snapshot: TurnSnapshot): void {
    const dir = this.turnsDir(snapshot.sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const filename = `${snapshot.timestamp}_${snapshot.turnIndex}.json`;
    fs.writeFileSync(path.join(dir, filename), JSON.stringify(snapshot, null, 2));
  }

  listTurns(sessionId: string): TurnListEntry[] {
    const dir = this.turnsDir(sessionId);
    if (!fs.existsSync(dir)) return [];

    return fs.readdirSync(dir)
      .filter(f => f.endsWith(".json"))
      .map(f => {
        const parts = f.replace(".json", "").split("_");
        return {
          filename: f,
          timestamp: parseInt(parts[0], 10),
          turnIndex: parseInt(parts[1], 10),
        };
      })
      .sort((a, b) => a.timestamp - b.timestamp || a.turnIndex - b.turnIndex);
  }

  getTurn(sessionId: string, filename: string): TurnSnapshot | null {
    const filePath = path.join(this.turnsDir(sessionId), filename);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  }

  listSessions(): string[] {
    const turnsRoot = path.join(this.baseDir, "dendrite", "turns");
    if (!fs.existsSync(turnsRoot)) return [];
    return fs.readdirSync(turnsRoot).filter(entry => {
      try {
        return fs.statSync(path.join(turnsRoot, entry)).isDirectory();
      } catch {
        return false;
      }
    });
  }

  resolveSessionId(partial: string): string | null {
    const sessions = this.listSessions();
    const matches = sessions.filter(s => s.startsWith(partial));
    if (matches.length === 1) return matches[0];
    return null;
  }

  getSessionLabel(sessionId: string): string {
    const turns = this.listTurns(sessionId);
    if (turns.length === 0) return "(no topic)";
    const lastTurn = turns[turns.length - 1];
    const snapshot = this.getTurn(sessionId, lastTurn.filename);
    if (!snapshot || snapshot.segments.length === 0) return "(no topic)";

    // Prefer most recent active segment's topic
    const active = snapshot.segments.filter(s => s.status === "active");
    if (active.length > 0) return active[active.length - 1].topic;

    // Fall back to most recent closed segment
    return snapshot.segments[snapshot.segments.length - 1].topic;
  }

  getConfig(): Partial<DendriteConfig> | null {
    if (!fs.existsSync(this.configPath)) return null;
    const raw = JSON.parse(fs.readFileSync(this.configPath, "utf-8"));
    return raw?.plugins?.entries?.dendrite?.config ?? null;
  }

  setConfig(key: string, value: unknown): void {
    const raw = fs.existsSync(this.configPath)
      ? JSON.parse(fs.readFileSync(this.configPath, "utf-8"))
      : {};

    if (!raw.plugins) raw.plugins = {};
    if (!raw.plugins.entries) raw.plugins.entries = {};
    if (!raw.plugins.entries.dendrite) raw.plugins.entries.dendrite = {};
    if (!raw.plugins.entries.dendrite.config) raw.plugins.entries.dendrite.config = {};

    raw.plugins.entries.dendrite.config[key] = value;
    fs.writeFileSync(this.configPath, JSON.stringify(raw, null, 2));
  }

  removeConfig(key: string): void {
    if (!fs.existsSync(this.configPath)) return;
    const raw = JSON.parse(fs.readFileSync(this.configPath, "utf-8"));
    if (raw?.plugins?.entries?.dendrite?.config) {
      delete raw.plugins.entries.dendrite.config[key];
      fs.writeFileSync(this.configPath, JSON.stringify(raw, null, 2));
    }
  }

  getEffectiveConfig(): DendriteConfig {
    const userConfig = this.getConfig() || {};
    return { ...DEFAULT_CONFIG, ...userConfig } as DendriteConfig;
  }
}
