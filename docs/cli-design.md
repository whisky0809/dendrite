# Dendrite CLI Tool — Design Spec

## Overview

CLI tooling for the Dendrite context engine plugin, registered via OpenClaw's `registerCli` API. Provides settings management, filtered log viewing, and context window inspection.

## Architecture

```
plugin.ts (runtime)
  ├── DendriteStore (shared module)
  │     ├── persistTurn(sessionId, turnData) → writes JSON to disk
  │     ├── listTurns(sessionId) → lists available turns
  │     ├── getTurn(sessionId, turnId) → reads single turn snapshot
  │     └── getConfig() / setConfig() → reads/writes openclaw.json
  └── registerCli(registrar) → registers Commander.js subcommands

CLI subcommands (openclaw dendrite ...)
  ├── config list          — show all settings with defaults highlighted
  ├── config get <key>     — get single value
  ├── config set <key> <value> — set single value
  ├── config edit          — open in $EDITOR
  ├── logs [-f] [-n N] [--level LEVEL] — filtered log viewer
  └── peek [--session ID]  — interactive turn picker + context viewer
```

## Storage

```
~/.openclaw/dendrite/
  └── turns/
      └── <sessionId>/
          └── <timestamp>-<turnIndex>.json
```

Each turn snapshot:
- `timestamp`, `turnIndex`, `sessionId`
- `segments` — current segment state (count, topic summaries, message counts)
- `assembledContext` — the exact context block sent to the model
- `scoring` — relevance scores per segment
- `stats` — token counts, segments included/excluded, drift detection result

## Subcommands

### `openclaw dendrite config list`

Shows all config keys with current effective value and whether default or user-set.

### `openclaw dendrite config get <key>`

Prints single config value.

### `openclaw dendrite config set <key> <value>`

Writes to `openclaw.json` → `plugins.entries.dendrite.<key>`. Validates key exists in `openclaw.plugin.json` configSchema and value matches type.

### `openclaw dendrite config edit`

Extracts dendrite config to temp file, opens `$EDITOR`, validates on save, writes back to `openclaw.json`.

### `openclaw dendrite logs`

Filters `/tmp/openclaw/openclaw-*.log` for dendrite entries.

- Default: show last 50 entries
- `-f` / `--follow`: tail mode
- `-n <N>`: number of recent entries
- `--level <level>`: filter by debug/info/warn/error

### `openclaw dendrite peek`

Interactive turn inspector.

- Lists recent turns for current or specified session (`--session ID`)
- User selects a turn
- Displays:
  - Token budget breakdown
  - Segments included/excluded with reasons
  - Relevance scores
  - Drift detection result
  - The actual assembled context text

## New Files

| File | Purpose |
|------|---------|
| `src/store.ts` | `DendriteStore` — persistence and config read/write |
| `src/cli.ts` | CLI subcommand registration and handlers |

## Runtime Integration

After `assemble()` in `plugin.ts`, call `store.persistTurn()` with the assembly result. Minimal overhead — single JSON write.

## Future Gateway Methods (not built now)

- `dendrite.peek` → `store.getTurn()`
- `dendrite.status` → `store.listTurns()` + current session stats
- `dendrite.config` → `store.getConfig()`

These become trivial to add since `DendriteStore` already encapsulates all data access.
