---
name: dendrite
description: "Git-like conversation branching — automatic topic detection, forking, and merging"
metadata:
  openclaw:
    emoji: "🌿"
    events: ["message:received", "agent:bootstrap", "command:new", "command:reset"]
    requires:
      env: ["MOONSHOT_API_KEY"]
---

# Dendrite — Conversation Branching Hook

Automatically detects topic drift in conversations and manages a branch tree.
When the user goes on a tangent, dendrite forks a new branch. When they return
to a previous topic, it merges the tangent's knowledge back.

The agent sees only the current branch's context plus summaries from merged
tangents — keeping the working context focused and relevant.

## How it works

1. **`message:received`** — Runs LLM-based drift detection on each incoming
   user message. If a tangent is detected, forks a new branch. If the message
   matches a previous branch better, returns to it and merges.

2. **`agent:bootstrap`** — Injects the current branch's context into the
   agent's MEMORY.md, including conversation history, merged summaries,
   and a branch tree overview.

## Configuration

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "dendrite": {
          "enabled": true,
          "mode": "llm",
          "model": "moonshot-v1-8k",
          "min_messages_before_fork": 3,
          "min_messages_before_return": 2,
          "max_recent_messages": 15
        }
      }
    }
  }
}
```

## Options

- `mode` (`"llm"` | `"embedding"` | `"both"`): Detection mode. Default: `"llm"`
- `model` (string): Moonshot model for detection. Default: `"moonshot-v1-8k"`
- `min_messages_before_fork` (number): Messages needed before considering forks. Default: `3`
- `min_messages_before_return` (number): Messages on tangent before allowing return. Default: `2`
- `max_recent_messages` (number): Recent messages to include in branch context. Default: `15`

## Requirements

- `MOONSHOT_API_KEY` environment variable must be set
