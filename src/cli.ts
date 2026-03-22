import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CONFIG, type DendriteConfig, type TurnSnapshot, type TurnSnapshotMessage, type SimpleMessage } from "./types.js";
import { DendriteStore, type TurnListEntry } from "./store.js";
import { generateSummary } from "./summarizer.js";

// ── Turn resolution ──

export function resolveTurn(turns: TurnListEntry[], index: number): TurnListEntry | null {
  if (index < 0) {
    const pos = turns.length + index;
    return pos >= 0 ? turns[pos] : null;
  }
  return turns.find(t => t.turnIndex === index) ?? null;
}

// ── Config schema info (derived from openclaw.plugin.json) ──

const CONFIG_TYPES: Record<keyof DendriteConfig, "string" | "number" | "integer"> = {
  driftModel: "string",
  summaryModel: "string",
  embeddingModel: "string",
  driftThreshold: "number",
  minMessagesBeforeDrift: "integer",
  relevanceAlpha: "number",
  reserveTokens: "integer",
  maxSegmentMessages: "integer",
  queryWindowSize: "integer",
  pinRecentSegments: "integer",
  maxCrossSessionBudgetRatio: "number",
  recencyHalfLifeMs: "integer",
};

export function validateConfigKey(key: string): boolean {
  return key in CONFIG_TYPES;
}

export function parseConfigValue(key: string, value: string): string | number {
  const type = CONFIG_TYPES[key as keyof DendriteConfig];
  if (type === "number") return parseFloat(value);
  if (type === "integer") return parseInt(value, 10);
  return value;
}

// ── Log filtering ──

export interface LogEntry {
  timestamp?: string;
  level?: string;
  message?: string;
  subsystem?: string;
  [key: string]: unknown;
}

export function parseDendriteLogLine(line: string): LogEntry | null {
  try {
    const entry = JSON.parse(line);
    // OpenClaw logs use numeric keys ("0", "1", ...) for arguments,
    // with _meta.logLevelName for level and "time" for timestamp.
    const msg = entry.message || entry.msg || entry["1"] || "";
    if (typeof msg === "string" && msg.includes("dendrite:")) {
      // Normalize to our LogEntry shape
      return {
        ...entry,
        message: msg,
        level: entry.level || entry._meta?.logLevelName || "info",
        timestamp: entry.timestamp || entry.time || "",
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function matchesLogLevel(entry: LogEntry, level: string): boolean {
  const levels = ["debug", "info", "warn", "error"];
  const entryLevel = (entry.level || "info").toLowerCase();
  const filterIdx = levels.indexOf(level.toLowerCase());
  const entryIdx = levels.indexOf(entryLevel);
  if (filterIdx === -1 || entryIdx === -1) return true;
  return entryIdx >= filterIdx;
}

// ── Format helpers ──

function formatLogEntry(entry: LogEntry): string {
  const time = entry.timestamp || entry.time || "";
  const level = (entry.level || "info").toUpperCase().padEnd(5);
  const msg = entry.message || entry.msg || JSON.stringify(entry);
  return `${time} ${level} ${msg}`;
}

function formatConfigList(effective: DendriteConfig, userConfig: Partial<DendriteConfig> | null): string {
  const lines: string[] = [];
  for (const [key, defaultVal] of Object.entries(DEFAULT_CONFIG)) {
    const effectiveVal = (effective as any)[key];
    const isUserSet = userConfig && key in userConfig;
    const marker = isUserSet ? "" : " (default)";
    lines.push(`  ${key.padEnd(26)} = ${effectiveVal}${marker}`);
  }
  return lines.join("\n");
}

export function formatPeekDashboard(snapshot: TurnSnapshot, opts: { full: boolean; segmentsOnly: boolean }): string {
  const lines: string[] = [];
  const shortId = snapshot.sessionId.slice(0, 8);
  const timeStr = new Date(snapshot.timestamp).toISOString().replace("T", " ").slice(0, 19);
  const budget = snapshot.stats.tokenBudget;
  const used = snapshot.stats.tokensUsed;
  const pct = budget > 0 ? Math.round(used / budget * 100) : 0;

  // Budget bar: 20 chars wide
  const filled = Math.round(pct / 5);
  const bar = "\u2588".repeat(filled) + "\u2591".repeat(20 - filled);

  const fallbackStr = snapshot.stats.fallbacks.length > 0
    ? snapshot.stats.fallbacks.join(", ")
    : "none";

  // Header
  lines.push(`Session: ${shortId}  |  Turn #${snapshot.turnIndex}  |  ${timeStr}`);
  lines.push(`Budget: ${used.toLocaleString("en-US")} / ${budget.toLocaleString("en-US")} tokens (${pct}%)  ${bar}`);
  lines.push(`Embeddings: ${snapshot.stats.embeddingsAvailable ? "\u2713" : "\u2717"}  |  Drift: ${snapshot.stats.driftAvailable ? "\u2713" : "\u2717"}  |  Fallbacks: ${fallbackStr}`);
  lines.push("");

  // Segment table
  lines.push(` ${"TIER".padEnd(10)}${"TOPIC".padEnd(30)}${"MSGS".padStart(6)}${"TOKENS".padStart(9)}${"SCORE".padStart(9)}  ${"(sem".padStart(5)} / ${"rec)".padEnd(4)}`);
  for (const seg of snapshot.segments) {
    const tier = seg.tier.padEnd(10);
    const topic = seg.topic.length > 28 ? seg.topic.slice(0, 27) + "\u2026" : seg.topic.padEnd(30);
    const msgs = seg.messageCount.toString().padStart(6);
    const tokens = seg.allocatedTokens.toLocaleString("en-US").padStart(9);
    if (seg.tier === "active") {
      lines.push(` ${tier}${topic}${msgs}${tokens}${"—".padStart(9)}  ${"—".padStart(5)}   ${"—".padEnd(4)}`);
    } else {
      lines.push(` ${tier}${topic}${msgs}${tokens}${seg.compositeScore.toFixed(2).padStart(9)}  ${seg.semanticScore.toFixed(2).padStart(5)}  ${seg.recencyScore.toFixed(2).padEnd(4)}`);
    }
  }

  if (opts.segmentsOnly) {
    return lines.join("\n");
  }

  // Legacy fallback
  if (!snapshot.messages && snapshot.assembledContext != null) {
    lines.push("");
    lines.push("(legacy snapshot \u2014 showing raw assembled context)");
    lines.push("\u2500".repeat(48));
    lines.push(snapshot.assembledContext);
    return lines.join("\n");
  }

  // Message list grouped by segmentId
  const messages = snapshot.messages || [];
  if (messages.length === 0 && !snapshot.systemPreamble) {
    return lines.join("\n");
  }

  lines.push("");

  // Group messages by segmentId (preserving order)
  const groups: { segmentId: string | null; msgs: TurnSnapshotMessage[] }[] = [];
  const groupMap = new Map<string | null, TurnSnapshotMessage[]>();

  for (const m of messages) {
    const key = m.segmentId;
    let arr = groupMap.get(key);
    if (!arr) {
      arr = [];
      groupMap.set(key, arr);
      groups.push({ segmentId: key, msgs: arr });
    }
    arr.push(m);
  }

  // System group first (null segmentId)
  const systemGroup = groups.find(g => g.segmentId === null);
  const segmentGroups = groups.filter(g => g.segmentId !== null);

  // Show system preamble in system group
  if (systemGroup || snapshot.systemPreamble) {
    lines.push(`\u2500\u2500 (system) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`);
    if (snapshot.systemPreamble) {
      if (opts.full) {
        lines.push(`  system    ${snapshot.systemPreamble.length}t`);
        lines.push(`    ${snapshot.systemPreamble}`);
      } else {
        const preview = snapshot.systemPreamble.slice(0, 200);
        lines.push(`  system    ${snapshot.systemPreamble.length}t  "${preview}${snapshot.systemPreamble.length > 200 ? "..." : ""}"`);
      }
    }
    if (systemGroup) {
      renderMessages(systemGroup.msgs, lines, opts.full);
    }
  }

  // Segment groups
  for (const group of segmentGroups) {
    const seg = snapshot.segments.find(s => s.id === group.segmentId);
    const topic = seg ? seg.topic : group.segmentId;
    const tier = seg ? seg.tier : "?";
    const tokens = seg ? seg.allocatedTokens.toLocaleString("en-US") : "?";
    lines.push(`\u2500\u2500 ${topic} (${tier}, ${tokens} tokens) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`);
    renderMessages(group.msgs, lines, opts.full);
  }

  return lines.join("\n");
}

function renderMessages(msgs: TurnSnapshotMessage[], lines: string[], full: boolean): void {
  if (msgs.length <= 6 || full) {
    for (const m of msgs) {
      appendMessage(m, lines, full);
    }
  } else {
    // Show first 2, ellipsis, last 2
    for (let i = 0; i < 2; i++) appendMessage(msgs[i], lines, full);
    lines.push(`  ... ${msgs.length - 4} more messages ...`);
    for (let i = msgs.length - 2; i < msgs.length; i++) appendMessage(msgs[i], lines, full);
  }
}

function appendMessage(m: TurnSnapshotMessage, lines: string[], full: boolean): void {
  const role = m.role.padEnd(12);
  const tokens = `${m.tokenCount}t`;
  if (full) {
    lines.push(`  ${role}${tokens}`);
    // Indent full content
    for (const line of m.contentFull.split("\n")) {
      lines.push(`    ${line}`);
    }
  } else {
    const preview = m.contentPreview.slice(0, 80);
    lines.push(`  ${role}${tokens.padEnd(6)}  "${preview}${m.contentPreview.length > 80 ? "..." : ""}"`);
  }
}

// ── Rebuild ──

export interface RebuildOptions {
  agentId: string;
  configDir: string;
  force: boolean;
  dryRun: boolean;
  summaryModel: string;
  summaryApiKey: string;
  logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}

export interface RebuildResult {
  sessionsProcessed: number;
  segmentsTotal: number;
  summariesGenerated: number;
}

export async function rebuildSessions(opts: RebuildOptions): Promise<RebuildResult> {
  const sessionsDir = path.join(opts.configDir, "agents", opts.agentId, "sessions");
  const segmentsDir = path.join(opts.configDir, "dendrite", "segments");

  if (!fs.existsSync(sessionsDir)) {
    opts.logger.warn(`No sessions directory found: ${sessionsDir}`);
    return { sessionsProcessed: 0, segmentsTotal: 0, summariesGenerated: 0 };
  }

  const transcriptFiles = fs.readdirSync(sessionsDir).filter(f => f.endsWith(".jsonl"));
  let sessionsProcessed = 0;
  let segmentsTotal = 0;
  let summariesGenerated = 0;

  for (const file of transcriptFiles) {
    const sessionId = file.replace(".jsonl", "");
    const segmentFile = path.join(segmentsDir, `${sessionId}.json`);

    if (!opts.force && fs.existsSync(segmentFile)) {
      continue;
    }

    const transcriptPath = path.join(sessionsDir, file);
    const content = fs.readFileSync(transcriptPath, "utf-8");
    const lines = content.split("\n").filter(Boolean);

    // Find last segment-index entry
    let lastIndex: { segments: any[] } | null = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.dendrite === "segment-index") {
          lastIndex = { segments: entry.segments };
          break;
        }
      } catch { /* skip */ }
    }

    if (!lastIndex || lastIndex.segments.length === 0) {
      continue;
    }

    const closedSegments = lastIndex.segments.filter((s: any) => s.status === "closed");
    if (closedSegments.length === 0) continue;

    // Generate summaries for segments missing them
    for (const seg of closedSegments) {
      if (!seg.summary && opts.summaryApiKey && !opts.dryRun) {
        try {
          // Load messages for this segment from transcript
          const idSet = new Set(seg.messageIds as string[]);
          const msgs: SimpleMessage[] = [];
          for (const line of lines) {
            try {
              const entry = JSON.parse(line);
              // JSONL entries wrap the message: {type:"message", id:"...", message:{role, content, ...}}
              const msg = entry.type === "message" && entry.message ? entry.message : entry;
              const msgId = msg.id || entry.id;
              if (msgId && idSet.has(msgId)) {
                const role = msg.role;
                if (role !== "user" && role !== "assistant" && role !== "toolResult") continue;
                const text = typeof msg.content === "string"
                  ? msg.content
                  : Array.isArray(msg.content)
                    ? msg.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("")
                    : "";
                if (text) msgs.push({ id: msgId, role, content: text, timestamp: msg.timestamp || entry.timestamp || 0 });
              }
            } catch { /* skip */ }
          }
          if (msgs.length > 0) {
            // Retry with exponential backoff for rate limits
            let lastErr: any;
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                seg.summary = await generateSummary(seg.topic, msgs, opts.summaryModel, opts.summaryApiKey);
                seg.summaryTokens = Math.ceil(seg.summary.length / 4);
                summariesGenerated++;
                lastErr = null;
                break;
              } catch (err: any) {
                lastErr = err;
                if (attempt < 2) {
                  const delay = 1000 * Math.pow(2, attempt); // 1s, 2s
                  await new Promise(r => setTimeout(r, delay));
                }
              }
            }
            if (lastErr) {
              opts.logger.warn(`Failed to generate summary for ${seg.id} after 3 attempts: ${lastErr?.message || lastErr}`);
            }
          }
        } catch (err: any) {
          opts.logger.warn(`Failed to process segment ${seg.id}: ${err?.message || err}`);
        }
      }
    }

    sessionsProcessed++;
    segmentsTotal += closedSegments.length;

    if (opts.dryRun) continue;

    fs.mkdirSync(segmentsDir, { recursive: true });
    const fileData = {
      sessionId,
      agentId: opts.agentId,
      transcriptPath,
      exportedAt: Date.now(),
      segments: closedSegments,
    };
    fs.writeFileSync(segmentFile, JSON.stringify(fileData, null, 2));
  }

  return { sessionsProcessed, segmentsTotal, summariesGenerated };
}

// ── CLI registration ──

/** Minimal shape of commander.Command — avoids runtime dependency on commander. */
interface CommandLike {
  command(name: string): CommandLike;
  description(desc: string): CommandLike;
  argument(name: string, desc: string): CommandLike;
  option(flags: string, desc: string, defaultValue?: string): CommandLike;
  action(fn: (...args: any[]) => void | Promise<void>): CommandLike;
}

export function registerDendriteCli(ctx: {
  program: CommandLike;
  config: any;
  logger: { debug?: (msg: string) => void; info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}): void {
  const { program, config } = ctx;

  const configDir = process.env.HOME + "/.openclaw";
  const configPath = configDir + "/openclaw.json";
  const store = new DendriteStore(configDir, configPath);

  const root = program
    .command("dendrite")
    .description("Dendrite context engine tools");

  // ── config ──
  const configCmd = root
    .command("config")
    .description("Manage Dendrite configuration");

  configCmd
    .command("list")
    .description("Show all configuration values")
    .action(() => {
      const effective = store.getEffectiveConfig();
      const userConfig = store.getConfig();
      console.log("Dendrite configuration:\n");
      console.log(formatConfigList(effective, userConfig));
    });

  configCmd
    .command("get")
    .description("Get a configuration value")
    .argument("<key>", "Configuration key")
    .action((key: string) => {
      if (!validateConfigKey(key)) {
        console.error(`Unknown config key: ${key}`);
        console.error(`Valid keys: ${Object.keys(DEFAULT_CONFIG).join(", ")}`);
        process.exit(1);
      }
      const effective = store.getEffectiveConfig();
      console.log((effective as any)[key]);
    });

  configCmd
    .command("set")
    .description("Set a configuration value")
    .argument("<key>", "Configuration key")
    .argument("<value>", "New value")
    .action((key: string, value: string) => {
      if (!validateConfigKey(key)) {
        console.error(`Unknown config key: ${key}`);
        console.error(`Valid keys: ${Object.keys(DEFAULT_CONFIG).join(", ")}`);
        process.exit(1);
      }
      const parsed = parseConfigValue(key, value);
      if (typeof parsed === "number" && isNaN(parsed)) {
        console.error(`Invalid value for ${key}: expected a number`);
        process.exit(1);
      }
      store.setConfig(key, parsed);
      console.log(`Set ${key} = ${parsed}`);
    });

  configCmd
    .command("edit")
    .description("Open Dendrite config in $EDITOR")
    .action(async () => {
      const editor = process.env.EDITOR || process.env.VISUAL || "vi";
      const userConfig = store.getConfig() || {};

      const tmpPath = path.join(os.tmpdir(), `dendrite-config-${Date.now()}.json`);
      fs.writeFileSync(tmpPath, JSON.stringify(userConfig, null, 2));

      const { execFileSync } = await import("node:child_process");
      try {
        execFileSync(editor, [tmpPath], { stdio: "inherit" });

        const edited = JSON.parse(fs.readFileSync(tmpPath, "utf-8"));
        const previousConfig = store.getConfig() || {};
        for (const key of Object.keys(previousConfig)) {
          if (!(key in edited) && validateConfigKey(key)) {
            store.removeConfig(key);
          }
        }
        for (const key of Object.keys(edited)) {
          if (!validateConfigKey(key)) {
            console.error(`Unknown config key: ${key} — skipping`);
            continue;
          }
          store.setConfig(key, edited[key]);
        }
        console.log("Configuration updated.");
      } finally {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      }
    });

  // ── logs ──
  root
    .command("logs")
    .description("View Dendrite log entries")
    .option("-f, --follow", "Follow log output (tail -f)")
    .option("-n, --lines <n>", "Number of recent entries to show", "50")
    .option("--level <level>", "Minimum log level (debug, info, warn, error)", "debug")
    .action(async (opts: { follow?: boolean; lines: string; level: string }) => {
      const logDir = "/tmp/openclaw";
      const today = new Date().toISOString().slice(0, 10);
      const logFile = path.join(logDir, `openclaw-${today}.log`);

      if (!fs.existsSync(logFile)) {
        console.error(`No log file found: ${logFile}`);
        process.exit(1);
      }

      const content = fs.readFileSync(logFile, "utf-8");
      const lines = content.split("\n").filter(Boolean);

      const entries: { entry: LogEntry; raw: string }[] = [];
      for (const line of lines) {
        const entry = parseDendriteLogLine(line);
        if (entry && matchesLogLevel(entry, opts.level)) {
          entries.push({ entry, raw: line });
        }
      }

      const limit = parseInt(opts.lines, 10) || 50;
      const recent = entries.slice(-limit);
      for (const { entry } of recent) {
        console.log(formatLogEntry(entry));
      }

      if (opts.follow) {
        let lineCount = lines.length;
        fs.watchFile(logFile, { interval: 1000 }, () => {
          try {
            const newContent = fs.readFileSync(logFile, "utf-8");
            const newLines = newContent.split("\n").filter(Boolean);
            if (newLines.length < lineCount) {
              lineCount = 0;
            }
            for (let i = lineCount; i < newLines.length; i++) {
              const entry = parseDendriteLogLine(newLines[i]);
              if (entry && matchesLogLevel(entry, opts.level)) {
                console.log(formatLogEntry(entry));
              }
            }
            lineCount = newLines.length;
          } catch {
            // File temporarily unavailable
          }
        });

        process.on("SIGINT", () => {
          fs.unwatchFile(logFile);
          process.exit(0);
        });

        console.log("\n--- Following (Ctrl+C to stop) ---\n");
        await new Promise(() => {});
      }
    });

  // ── peek ──
  root
    .command("peek")
    .description("Inspect the assembled context for a specific turn")
    .option("-s, --session <id>", "Session ID (or prefix)")
    .option("-t, --turn <n>", "Turn index (negative counts from end)")
    .option("-l, --last", "Show the most recent turn across all sessions")
    .option("--full", "Show full message content")
    .option("--json", "Output raw snapshot as JSON")
    .option("--segments-only", "Show only the segment table")
    .action(async (opts: { session?: string; turn?: string; last?: boolean; full?: boolean; json?: boolean; segmentsOnly?: boolean }) => {
      // --last is mutually exclusive with -s/-t
      if (opts.last && (opts.session || opts.turn)) {
        console.error("--last cannot be combined with --session or --turn");
        process.exit(1);
      }

      // ── --last: find most recent turn across all sessions ──
      if (opts.last) {
        const sessions = store.listSessions();
        if (sessions.length === 0) {
          console.error("No turn snapshots found. Run a conversation with Dendrite enabled first.");
          process.exit(1);
        }
        let bestSession = "";
        let bestEntry: TurnListEntry | null = null;
        for (const s of sessions) {
          const turns = store.listTurns(s);
          const last = turns[turns.length - 1];
          if (last && (!bestEntry || last.timestamp > bestEntry.timestamp)) {
            bestEntry = last;
            bestSession = s;
          }
        }
        if (!bestEntry) { console.error("No turns found."); process.exit(1); }
        const snapshot = store.getTurn(bestSession, bestEntry.filename);
        if (!snapshot) { console.error("Failed to load turn."); process.exit(1); }
        if (opts.json) { console.log(JSON.stringify(snapshot, null, 2)); return; }
        console.log(formatPeekDashboard(snapshot, { full: !!opts.full, segmentsOnly: !!opts.segmentsOnly }));
        return;
      }

      // ── No session: list sessions ──
      if (!opts.session) {
        const sessions = store.listSessions();
        if (sessions.length === 0) {
          console.error("No turn snapshots found. Run a conversation with Dendrite enabled first.");
          process.exit(1);
        }
        console.log(`${"SESSIONS".padEnd(50)}${"TURNS".padStart(5)}  LAST ACTIVE`);
        for (const s of sessions) {
          const turns = store.listTurns(s);
          const label = store.getSessionLabel(s);
          const shortId = s.slice(0, 8);
          const lastTurn = turns[turns.length - 1];
          const lastTime = lastTurn
            ? new Date(lastTurn.timestamp).toISOString().replace("T", " ").slice(0, 16)
            : "—";
          const entry = `${shortId}  ${label}`;
          console.log(`${entry.padEnd(50)}${turns.length.toString().padStart(5)}  ${lastTime}`);
        }
        console.log(`\nUsage: dendrite peek -s <id> [-t <turn>]`);
        return;
      }

      // ── Resolve session ID ──
      const sessionId = store.resolveSessionId(opts.session);
      if (!sessionId) {
        console.error(`No unique session matching "${opts.session}". Use a longer prefix.`);
        process.exit(1);
      }

      const turns = store.listTurns(sessionId);
      if (turns.length === 0) {
        console.error(`No turns found for session: ${sessionId}`);
        process.exit(1);
      }

      // ── Session only (no turn): list turns ──
      if (opts.turn == null) {
        const label = store.getSessionLabel(sessionId);
        const shortId = sessionId.slice(0, 8);
        console.log(`SESSION ${shortId} \u2014 ${label}\n`);
        console.log(` ${"TURN".padEnd(8)}${"TIME".padEnd(22)}${"SEGS".padStart(4)}${"TOKENS".padStart(9)}${"BUDGET%".padStart(10)}`);
        for (const t of turns) {
          const snapshot = store.getTurn(sessionId, t.filename);
          if (!snapshot) continue;
          const time = new Date(t.timestamp).toISOString().replace("T", " ").slice(0, 16);
          const segs = snapshot.stats.segmentsTotal.toString().padStart(4);
          const tokens = snapshot.stats.tokensUsed.toLocaleString("en-US").padStart(9);
          const pct = snapshot.stats.tokenBudget > 0
            ? Math.round(snapshot.stats.tokensUsed / snapshot.stats.tokenBudget * 100)
            : 0;
          console.log(` ${"#" + t.turnIndex}${" ".repeat(Math.max(1, 8 - ("#" + t.turnIndex).length))}${time.padEnd(22)}${segs}${tokens}${(pct + "%").padStart(10)}`);
        }
        return;
      }

      // ── Session + turn: show dashboard ──
      const turnIdx = parseInt(opts.turn, 10);
      if (isNaN(turnIdx)) {
        console.error(`Invalid turn index: ${opts.turn}`);
        process.exit(1);
      }

      const entry = resolveTurn(turns, turnIdx);
      if (!entry) {
        console.error(`Turn ${turnIdx} not found in session ${sessionId.slice(0, 8)}`);
        process.exit(1);
      }

      const snapshot = store.getTurn(sessionId, entry.filename);
      if (!snapshot) { console.error("Failed to load turn."); process.exit(1); }
      if (opts.json) { console.log(JSON.stringify(snapshot, null, 2)); return; }
      console.log(formatPeekDashboard(snapshot, { full: !!opts.full, segmentsOnly: !!opts.segmentsOnly }));
    });

  // ── rebuild ──
  root
    .command("rebuild")
    .description("Backfill per-session segment files from existing transcripts")
    .option("--dry-run", "Report what would be processed without writing")
    .option("--force", "Reprocess sessions even if segment files exist")
    .option("--agent <id>", "Agent ID (defaults to agent with default: true)")
    .action(async (opts: { dryRun?: boolean; force?: boolean; agent?: string }) => {
      let agentId = opts.agent;

      if (!agentId) {
        // Find default agent from openclaw.json
        try {
          const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
          const agents = raw?.agents?.list || [];
          const defaultAgent = agents.find((a: any) => a.default === true);
          agentId = defaultAgent?.id;
        } catch { /* */ }
      }

      if (!agentId) {
        console.error("No agent specified and no default agent found in openclaw.json");
        process.exit(1);
      }

      console.log(`Rebuilding segment files for agent: ${agentId}`);
      if (opts.dryRun) console.log("(dry run — no files will be written)\n");

      const effective = store.getEffectiveConfig();

      const result = await rebuildSessions({
        agentId,
        configDir,
        force: !!opts.force,
        dryRun: !!opts.dryRun,
        summaryModel: effective.summaryModel,
        summaryApiKey: process.env.OPENROUTER_API_KEY || "",
        logger: { info: console.log, warn: console.warn, error: console.error },
      });

      console.log(`\nProcessed ${result.sessionsProcessed} sessions, ${result.segmentsTotal} segments, generated ${result.summariesGenerated} summaries`);
    });
}
