---
name: dendrite-inspect
description: Inspect Dendrite's current conversation segmentation and context budget
---

# Dendrite Inspect

Show the current state of Dendrite's conversation segmentation.

For each segment, show:
- Topic name and status (active/closed)
- Message count and estimated token count
- Whether a summary is cached
- Current relevance score (if available)
- Context tier (active/full/partial/summary/excluded)

Also show:
- Total segments tracked
- Context budget usage (tokens used / total budget)
- Any recent errors or fallbacks
