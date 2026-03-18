# Dendrite CLI Tool Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add CLI subcommands to the Dendrite plugin for config management, filtered log viewing, and context window inspection.

**Architecture:** Three CLI subcommands registered via OpenClaw's `registerCli` API under `openclaw dendrite`. A shared `DendriteStore` class handles persistence (turn snapshots to disk, config read/write to `openclaw.json`). The plugin runtime calls `store.persistTurn()` after each assembly. CLI commands read the persisted data directly from disk — no gateway dependency.

**Tech Stack:** TypeScript (ES2022, Node16 modules), Commander.js (via OpenClaw plugin SDK), node:fs, node:path, node:readline (for interactive peek selection)

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/store.ts` | `DendriteStore` class — turn snapshot persistence, config read/write, turn listing/retrieval |
| `src/cli.ts` | CLI subcommand registration and handlers (config, logs, peek) |
| `src/plugin.ts` | Modified: import store, call `persistTurn()` after assemble, call `registerCli` |
| `src/types.ts` | Modified: add `TurnSnapshot` type |
| `src/test-store.ts` | Tests for DendriteStore |
| `src/test-cli.ts` | Tests for CLI command logic (config parsing, log filtering) |

---

## Chunk 1: DendriteStore and Turn Persistence

### Task 1: Add TurnSnapshot type

**Files:**
- Modify: `src/types.ts` (after `DEFAULT_CONFIG` block, before line 71 "Message helpers" section)

- [ ] **Step 1: Write the TurnSnapshot type**

Add after the `DEFAULT_CONFIG` block (after line 69) in `src/types.ts`:

```typescript
// ── Turn snapshot (persisted by CLI store) ──

import type { Tier } from "./assembler.js";

export interface TurnSnapshotSegment {
  id: string;
  topic: string;
  status: "active" | "closed";
  messageCount: number;
  tokenCount: number;
  summary: string | null;
  tier: Tier;
  allocatedTokens: number;
  compositeScore: number;  // alpha * semantic + (1-alpha) * recency
  semanticScore: number;
  recencyScore: number;
}

export interface TurnSnapshot {
  timestamp: number;
  turnIndex: number;
  sessionId: string;
  segments: TurnSnapshotSegment[];
  assembledContext: string;
  stats: {
    tokenBudget: number;
    tokensUsed: number;
    segmentsTotal: number;
    segmentsIncluded: number;
    segmentsExcluded: number;
    embeddingsAvailable: boolean;
    driftAvailable: boolean;
    fallbacks: string[];
  };
}
```

- [ ] **Step 2: Verify types compile**

Run: `cd /home/whisky/dendrite && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(cli): add TurnSnapshot type for context inspection"
```

---

### Task 2: Implement DendriteStore

**Files:**
- Create: `src/store.ts`

- [ ] **Step 1: Write the failing test**

Create `src/test-store.ts`:

```typescript
import { DendriteStore } from "./store.js";
import { DEFAULT_CONFIG, type TurnSnapshot } from "./types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dendrite-test-"));
const configPath = path.join(tmpDir, "openclaw.json");

// Write a minimal openclaw.json for config tests
// Note: user config lives at plugins.entries.dendrite.config (not top-level entry)
const minimalConfig = {
  plugins: {
    entries: {
      dendrite: {
        enabled: true,
        config: {
          driftThreshold: 0.5,
        },
      },
    },
  },
};
fs.writeFileSync(configPath, JSON.stringify(minimalConfig, null, 2));

const store = new DendriteStore(tmpDir, configPath);

console.log("=== DendriteStore ===\n");

// ── persistTurn + getTurn ──
console.log("  persistTurn / getTurn:");

const snapshot: TurnSnapshot = {
  timestamp: Date.now(),
  turnIndex: 1,
  sessionId: "test-session",
  segments: [
    {
      id: "seg1",
      topic: "greeting",
      status: "active",
      messageCount: 5,
      tokenCount: 200,
      summary: null,
      tier: "active",
      allocatedTokens: 200,
      compositeScore: 1.0,
      semanticScore: 1.0,
      recencyScore: 1.0,
    },
  ],
  assembledContext: "Hello, this is the assembled context",
  stats: {
    tokenBudget: 32000,
    tokensUsed: 200,
    segmentsTotal: 1,
    segmentsIncluded: 1,
    segmentsExcluded: 0,
    embeddingsAvailable: true,
    driftAvailable: true,
    fallbacks: [],
  },
};

store.persistTurn(snapshot);

const turns = store.listTurns("test-session");
assert(turns.length === 1, "listTurns returns 1 turn after persist");
assert(turns[0].turnIndex === 1, "listed turn has correct turnIndex");

const retrieved = store.getTurn("test-session", turns[0].filename);
assert(retrieved !== null, "getTurn returns the snapshot");
assert(retrieved!.assembledContext === snapshot.assembledContext, "getTurn preserves assembledContext");
assert(retrieved!.segments.length === 1, "getTurn preserves segments");

// ── listTurns ordering ──
console.log("\n  listTurns ordering:");

const snapshot2: TurnSnapshot = { ...snapshot, turnIndex: 2, timestamp: Date.now() + 1000 };
store.persistTurn(snapshot2);

const allTurns = store.listTurns("test-session");
assert(allTurns.length === 2, "listTurns returns 2 turns");
assert(allTurns[0].turnIndex < allTurns[1].turnIndex, "turns are ordered chronologically");

// ── getConfig ──
console.log("\n  getConfig:");

const config = store.getConfig();
assert(config !== null, "getConfig returns config");
assert(config!.driftThreshold === 0.5, "getConfig reads user-set value");

// ── setConfig ──
console.log("\n  setConfig:");

store.setConfig("reserveTokens", 4096);
const updated = store.getConfig();
assert(updated!.reserveTokens === 4096, "setConfig persists new value");

// Verify it was written to the file under .config sub-object
const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
assert(raw.plugins.entries.dendrite.config.reserveTokens === 4096, "setConfig writes to openclaw.json under .config");

// ── listSessions ──
console.log("\n  listSessions:");

const snapshot3: TurnSnapshot = { ...snapshot, sessionId: "other-session", turnIndex: 1 };
store.persistTurn(snapshot3);

const sessions = store.listSessions();
assert(sessions.length === 2, "listSessions returns 2 sessions");
assert(sessions.includes("test-session"), "listSessions includes test-session");
assert(sessions.includes("other-session"), "listSessions includes other-session");

// Cleanup
fs.rmSync(tmpDir, { recursive: true });

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/whisky/dendrite && npx tsx src/test-store.ts`
Expected: FAIL — `Cannot find module './store.js'`

- [ ] **Step 3: Implement DendriteStore**

Create `src/store.ts`:

```typescript
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

  // Config lives at plugins.entries.dendrite.config (not top-level entry)
  // This matches how api.pluginConfig is populated by the SDK.
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/whisky/dendrite && npx tsx src/test-store.ts`
Expected: All tests PASS

- [ ] **Step 5: Run all existing tests**

Run: `cd /home/whisky/dendrite && npm test`
Expected: All tests still pass (no regressions)

- [ ] **Step 6: Commit**

```bash
git add src/store.ts src/test-store.ts
git commit -m "feat(cli): implement DendriteStore for turn persistence and config access"
```

---

### Task 3: Wire persistTurn into plugin runtime

**Files:**
- Modify: `src/plugin.ts:234-308` (assemble method)

- [ ] **Step 1: Write the failing test**

Create a manual verification approach — add a temporary test in `src/test-store.ts` that verifies the snapshot shape matches what assemble produces. Since assemble is tightly coupled to the runtime, we verify the integration via the shape:

Add to end of `src/test-store.ts` (before cleanup):

```typescript
// ── Verify snapshot shape matches assembler output ──
console.log("\n  snapshot shape validation:");

const fullSnapshot: TurnSnapshot = {
  timestamp: Date.now(),
  turnIndex: 5,
  sessionId: "shape-test",
  segments: [
    {
      id: "seg_abc",
      topic: "coding",
      status: "active",
      messageCount: 10,
      tokenCount: 500,
      summary: null,
      tier: "active",
      allocatedTokens: 500,
      compositeScore: 1.0,
      semanticScore: 1.0,
      recencyScore: 1.0,
    },
    {
      id: "seg_def",
      topic: "architecture",
      status: "closed",
      messageCount: 20,
      tokenCount: 1200,
      summary: "Discussed system architecture",
      tier: "summary",
      allocatedTokens: 30,
      compositeScore: 0.6,
      semanticScore: 0.5,
      recencyScore: 0.8,
    },
  ],
  assembledContext: "[Prior context — architecture: Discussed system architecture]\n\nuser: Current message",
  stats: {
    tokenBudget: 32000,
    tokensUsed: 530,
    segmentsTotal: 2,
    segmentsIncluded: 2,
    segmentsExcluded: 0,
    embeddingsAvailable: true,
    driftAvailable: true,
    fallbacks: [],
  },
};

store.persistTurn(fullSnapshot);
const retrieved2 = store.getTurn("shape-test", store.listTurns("shape-test")[0].filename);
assert(retrieved2!.segments.length === 2, "full snapshot preserves all segments");
assert(retrieved2!.segments[1].tier === "summary", "full snapshot preserves tier info");
assert(retrieved2!.stats.tokensUsed === 530, "full snapshot preserves stats");
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd /home/whisky/dendrite && npx tsx src/test-store.ts`
Expected: PASS

- [ ] **Step 3: Wire store into plugin.ts**

In `src/plugin.ts`, add these changes:

**Import** (add near top):
```typescript
import { DendriteStore } from "./store.js";
```

**Create store instance** (inside the `dendrite()` function, after `pluginConfig` declaration):
```typescript
// OpenClawConfig doesn't expose configDir/configPath — use standard ~/.openclaw location.
const configDir = process.env.HOME + "/.openclaw";
const configPath = configDir + "/openclaw.json";
const store = new DendriteStore(configDir, configPath);
```

**After the assembly-log transcript entry** (inside `assemble()`, after the `api.addTranscriptEntry` block around line 300), add:
```typescript
// Persist turn snapshot for CLI peek tool
try {
  const assembledText = [
    systemPreamble || "",
    ...conversationMessages.map((m: any) => `${m.role}: ${typeof m.content === "string" ? m.content : ""}`),
  ].filter(Boolean).join("\n\n");

  store.persistTurn({
    timestamp: Date.now(),
    turnIndex: state.totalTurns,
    sessionId: params.sessionId,
    segments: budgets.map(b => ({
      id: b.segment.id,
      topic: b.segment.topic,
      status: b.segment.status,
      messageCount: b.segment.messageCount,
      tokenCount: b.segment.tokenCount,
      summary: b.segment.summary,
      tier: b.tier,
      allocatedTokens: b.allocatedTokens,
      compositeScore: b.scored.score,
      semanticScore: b.scored.semanticScore,
      recencyScore: b.scored.recencyScoreValue,
    })),
    assembledContext: assembledText,
    stats: {
      tokenBudget,
      tokensUsed: estimatedTokens,
      segmentsTotal: segments.length,
      segmentsIncluded: budgets.filter(b => b.tier !== "excluded").length,
      segmentsExcluded: budgets.filter(b => b.tier === "excluded").length,
      embeddingsAvailable: state.embeddingsAvailable,
      driftAvailable: state.driftAvailable,
      fallbacks,
    },
  });
} catch (err) {
  debug("failed to persist turn snapshot", { error: String(err) });
}
```

- [ ] **Step 4: Verify types compile**

Run: `cd /home/whisky/dendrite && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Run all tests**

Run: `cd /home/whisky/dendrite && npm test`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add src/plugin.ts src/test-store.ts
git commit -m "feat(cli): wire turn snapshot persistence into assemble()"
```

---

## Chunk 2: CLI Subcommands

### Task 4: Implement config subcommands

**Files:**
- Create: `src/cli.ts`
- Create: `src/test-cli.ts`

- [ ] **Step 1: Write the failing test**

Create `src/test-cli.ts`:

```typescript
import { parseConfigValue, validateConfigKey } from "./cli.js";
import { DEFAULT_CONFIG } from "./types.js";

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}

console.log("=== CLI helpers ===\n");

// ── validateConfigKey ──
console.log("  validateConfigKey:");
assert(validateConfigKey("driftThreshold") === true, "accepts valid key");
assert(validateConfigKey("driftModel") === true, "accepts string key");
assert(validateConfigKey("nonexistent") === false, "rejects unknown key");
assert(validateConfigKey("") === false, "rejects empty string");

// ── parseConfigValue ──
console.log("\n  parseConfigValue:");
assert(parseConfigValue("driftThreshold", "0.5") === 0.5, "parses number");
assert(parseConfigValue("reserveTokens", "4096") === 4096, "parses integer");
assert(parseConfigValue("driftModel", "some-model") === "some-model", "parses string");
assert(parseConfigValue("minMessagesBeforeDrift", "5") === 5, "parses integer config");

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/whisky/dendrite && npx tsx src/test-cli.ts`
Expected: FAIL — `Cannot find module './cli.js'`

- [ ] **Step 3: Implement cli.ts with config subcommands and helper exports**

Create `src/cli.ts`:

```typescript
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { DEFAULT_CONFIG, type DendriteConfig, type TurnSnapshot } from "./types.js";
import { DendriteStore } from "./store.js";

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
    // Match lines where the message contains "dendrite:" or subsystem is plugins
    const msg = entry.message || entry.msg || "";
    if (typeof msg === "string" && msg.includes("dendrite:")) {
      return entry;
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

function formatPeekSummary(snapshot: TurnSnapshot): string {
  const lines: string[] = [];
  lines.push(`Turn #${snapshot.turnIndex} at ${new Date(snapshot.timestamp).toISOString()}`);
  lines.push(`Session: ${snapshot.sessionId}`);
  lines.push("");
  lines.push(`Token budget: ${snapshot.stats.tokenBudget} | Used: ${snapshot.stats.tokensUsed} (${Math.round(snapshot.stats.tokensUsed / snapshot.stats.tokenBudget * 100)}%)`);
  lines.push(`Segments: ${snapshot.stats.segmentsIncluded} included, ${snapshot.stats.segmentsExcluded} excluded (${snapshot.stats.segmentsTotal} total)`);
  lines.push(`Embeddings: ${snapshot.stats.embeddingsAvailable ? "available" : "unavailable"} | Drift: ${snapshot.stats.driftAvailable ? "available" : "disabled"}`);

  if (snapshot.stats.fallbacks.length > 0) {
    lines.push(`Fallbacks: ${snapshot.stats.fallbacks.join(", ")}`);
  }

  lines.push("");
  lines.push("Segments:");
  for (const seg of snapshot.segments) {
    const scoreStr = seg.tier === "active" ? "active" : `score=${seg.compositeScore.toFixed(2)} sem=${seg.semanticScore.toFixed(2)} rec=${seg.recencyScore.toFixed(2)}`;
    const summaryStr = seg.summary ? ` — "${seg.summary.slice(0, 60)}${seg.summary.length > 60 ? "..." : ""}"` : "";
    lines.push(`  [${seg.tier.padEnd(8)}] ${seg.topic} (${seg.messageCount} msgs, ${seg.allocatedTokens}/${seg.tokenCount} tokens) ${scoreStr}${summaryStr}`);
  }

  lines.push("");
  lines.push("─".repeat(60));
  lines.push("Assembled context:");
  lines.push("─".repeat(60));
  lines.push(snapshot.assembledContext);

  return lines.join("\n");
}

// ── CLI registration ──

export function registerDendriteCli(ctx: {
  program: import("commander").Command;
  config: any;
  logger: { debug?: (msg: string) => void; info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}): void {
  const { program, config } = ctx;

  // OpenClawConfig doesn't expose configDir/configPath directly.
  // Use standard ~/.openclaw location (matches all current deployments).
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
      const effective = store.getEffectiveConfig();
      const userConfig = store.getConfig() || {};

      // Write current dendrite config to temp file (use os.tmpdir to avoid polluting config dir)
      const tmpPath = path.join(os.tmpdir(), `dendrite-config-${Date.now()}.json`);
      fs.writeFileSync(tmpPath, JSON.stringify(userConfig, null, 2));

      const { execFileSync } = await import("node:child_process");
      try {
        execFileSync(editor, [tmpPath], { stdio: "inherit" });

        // Read back and validate
        const edited = JSON.parse(fs.readFileSync(tmpPath, "utf-8"));
        // Detect deleted keys: remove config entries the user deleted from the file
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

      // Filter to dendrite entries
      const entries: { entry: LogEntry; raw: string }[] = [];
      for (const line of lines) {
        const entry = parseDendriteLogLine(line);
        if (entry && matchesLogLevel(entry, opts.level)) {
          entries.push({ entry, raw: line });
        }
      }

      // Show last N entries
      const limit = parseInt(opts.lines, 10) || 50;
      const recent = entries.slice(-limit);
      for (const { entry } of recent) {
        console.log(formatLogEntry(entry));
      }

      if (opts.follow) {
        // Poll-based watch (more reliable than fs.watch on Linux)
        let lineCount = lines.length;
        const watcher = fs.watchFile(logFile, { interval: 1000 }, () => {
          try {
            const newContent = fs.readFileSync(logFile, "utf-8");
            const newLines = newContent.split("\n").filter(Boolean);
            if (newLines.length < lineCount) {
              // File was rotated; reset baseline
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
            // File temporarily unavailable (rotation); skip this tick
          }
        });

        process.on("SIGINT", () => {
          fs.unwatchFile(logFile);
          process.exit(0);
        });

        console.log("\n--- Following (Ctrl+C to stop) ---\n");
        await new Promise(() => {}); // block forever
      }
    });

  // ── peek ──
  root
    .command("peek")
    .description("Inspect the assembled context for a specific turn")
    .option("-s, --session <id>", "Session ID (shows picker if omitted)")
    .option("-l, --last", "Show the most recent turn (no picker)")
    .action(async (opts: { session?: string; last?: boolean }) => {
      let sessionId = opts.session;

      // If no session specified, list available sessions
      if (!sessionId) {
        const sessions = store.listSessions();
        if (sessions.length === 0) {
          console.error("No turn snapshots found. Run a conversation with Dendrite enabled first.");
          process.exit(1);
        }

        // --last without --session: auto-select the session with the most recent turn
        if (opts.last) {
          let latestSession = sessions[0];
          let latestTimestamp = 0;
          for (const s of sessions) {
            const turns = store.listTurns(s);
            const last = turns[turns.length - 1];
            if (last && last.timestamp > latestTimestamp) {
              latestTimestamp = last.timestamp;
              latestSession = s;
            }
          }
          sessionId = latestSession;
        } else if (sessions.length === 1) {
          sessionId = sessions[0];
        } else {
          console.log("Available sessions:");
          sessions.forEach((s, i) => {
            const turns = store.listTurns(s);
            console.log(`  ${i + 1}. ${s} (${turns.length} turns)`);
          });

          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const answer = await new Promise<string>(resolve => {
            rl.question("\nSelect session (number): ", resolve);
          });
          rl.close();

          const idx = parseInt(answer, 10) - 1;
          if (idx < 0 || idx >= sessions.length) {
            console.error("Invalid selection.");
            process.exit(1);
          }
          sessionId = sessions[idx];
        }
      }

      const turns = store.listTurns(sessionId);
      if (turns.length === 0) {
        console.error(`No turns found for session: ${sessionId}`);
        process.exit(1);
      }

      // --last: show most recent turn
      if (opts.last) {
        const last = turns[turns.length - 1];
        const snapshot = store.getTurn(sessionId, last.filename);
        if (!snapshot) { console.error("Failed to load turn."); process.exit(1); }
        console.log(formatPeekSummary(snapshot));
        return;
      }

      // Interactive turn picker
      console.log(`\nTurns for session ${sessionId}:\n`);
      for (let i = 0; i < turns.length; i++) {
        const t = turns[i];
        const time = new Date(t.timestamp).toLocaleTimeString();
        console.log(`  ${(i + 1).toString().padStart(3)}. Turn #${t.turnIndex} at ${time}`);
      }

      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>(resolve => {
        rl.question("\nSelect turn (number): ", resolve);
      });
      rl.close();

      const idx = parseInt(answer, 10) - 1;
      if (idx < 0 || idx >= turns.length) {
        console.error("Invalid selection.");
        process.exit(1);
      }

      const snapshot = store.getTurn(sessionId, turns[idx].filename);
      if (!snapshot) { console.error("Failed to load turn."); process.exit(1); }
      console.log("\n" + formatPeekSummary(snapshot));
    });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/whisky/dendrite && npx tsx src/test-cli.ts`
Expected: All tests PASS

- [ ] **Step 5: Verify types compile**

Run: `cd /home/whisky/dendrite && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts src/test-cli.ts
git commit -m "feat(cli): implement config, logs, and peek subcommands"
```

---

### Task 5: Register CLI in plugin.ts

**Files:**
- Modify: `src/plugin.ts` (add `registerCli` call)

- [ ] **Step 1: Add registerCli call to plugin.ts**

After the `api.registerContextEngine(...)` block, add:

```typescript
// ── CLI registration ──
// OpenClawPluginCliRegistrar supports async (returns void | Promise<void>)
api.registerCli(
  async ({ program, config, logger }) => {
    const { registerDendriteCli } = await import("./cli.js");
    registerDendriteCli({ program, config, logger });
  },
  { commands: ["dendrite"] }
);
```

- [ ] **Step 2: Verify types compile**

Run: `cd /home/whisky/dendrite && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Run all tests**

Run: `cd /home/whisky/dendrite && npm test`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add src/plugin.ts
git commit -m "feat(cli): register dendrite CLI subcommands with OpenClaw"
```

---

### Task 6: Add test-cli and test-store to test runner

**Files:**
- Modify: `package.json:11` (test script)

- [ ] **Step 1: Update test script**

In `package.json`, update the `test` script to include the new test files:

```json
"test": "tsx src/test-types.ts && tsx src/test-segmenter.ts && tsx src/test-scorer.ts && tsx src/test-summarizer.ts && tsx src/test-assembler.ts && tsx src/test-store.ts && tsx src/test-cli.ts"
```

- [ ] **Step 2: Run full test suite**

Run: `cd /home/whisky/dendrite && npm test`
Expected: All tests pass including new store and CLI tests

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: add store and CLI tests to test runner"
```

---

## Chunk 3: Integration and Polish

### Task 7: End-to-end manual verification

- [ ] **Step 1: Verify `openclaw dendrite --help` shows all subcommands**

Run: `openclaw dendrite --help`
Expected: Lists `config`, `logs`, `peek` subcommands

- [ ] **Step 2: Verify `openclaw dendrite config list`**

Run: `openclaw dendrite config list`
Expected: Shows all config values with default markers

- [ ] **Step 3: Verify `openclaw dendrite config get driftThreshold`**

Run: `openclaw dendrite config get driftThreshold`
Expected: Prints `0.7`

- [ ] **Step 4: Verify `openclaw dendrite config set driftThreshold 0.8`**

Run: `openclaw dendrite config set driftThreshold 0.8`
Expected: Prints `Set driftThreshold = 0.8`

Then verify: `openclaw dendrite config get driftThreshold` → `0.8`
Then reset: `openclaw dendrite config set driftThreshold 0.7`

- [ ] **Step 5: Verify `openclaw dendrite logs`**

Run: `openclaw dendrite logs -n 10`
Expected: Shows last 10 dendrite log entries

- [ ] **Step 6: Send a test message to Atlas and verify peek data**

After a conversation turn, run: `openclaw dendrite peek --last`
Expected: Shows turn snapshot with segments, token budget, assembled context

- [ ] **Step 7: Final commit with any fixes**

```bash
git add -A
git commit -m "feat(cli): dendrite CLI tool complete — config, logs, peek"
```

---

### Task 8: Update design doc

**Files:**
- Modify: `docs/cli-design.md`

- [ ] **Step 1: Add implementation notes**

Add a section noting actual file paths, any deviations from the original design, and the test commands.

- [ ] **Step 2: Commit**

```bash
git add docs/
git commit -m "docs: update CLI design doc with implementation notes"
```
