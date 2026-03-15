# Auto-Return Detection Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect when a user's message matches a previous branch's topic better than the current branch, auto-switch back, merge the tangent's knowledge, and add the message to the returned-to branch — completing the fork→explore→return→merge loop.

**Architecture:** Add an LLM-based return detector that, before checking for drift, compares the new message against all non-current branch topics. If a match is found, `BranchTree.returnTo()` handles the switch+merge atomically. The `LLMBranchTree.chat()` flow becomes: check return → check drift → add message.

**Tech Stack:** TypeScript, Moonshot API (moonshot-v1-8k)

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/return-detector.ts` | Create | LLM-based return detection — compares message against branch topics |
| `src/branch-tree.ts` | Modify | Add `returnTo()` method (switch + merge in one operation) |
| `src/llm-branch-tree.ts` | Modify | Integrate return detection into `chat()` flow |
| `src/test.ts` | Modify | Add return detection + returnTo tests |
| `src/demo-llm.ts` | Modify | Extend script with return-to-main scenario |

---

## Chunk 1: Core return-to operation in BranchTree

### Task 1: Add `returnTo()` to BranchTree

**Files:**
- Modify: `src/branch-tree.ts:88-107` (after `switchTo`)
- Test: `src/test.ts` (append new test block)

- [ ] **Step 1: Write the failing test for returnTo**

Add to `src/test.ts` before the summary section:

```typescript
{
  console.log("\n  Return-to operations:");
  const tree = new BranchTree(
    {
      agent_identity: "test agent",
      user_profile: "test user",
      long_term_memory: [],
    },
    { auto_branch: false }
  );

  // Build: main → tangent with some messages
  tree.addMessage("user", "Main topic discussion about APIs");
  tree.addMessage("agent", "Let's design the REST endpoints");
  tree.addMessage("user", "What about authentication?");
  tree.addMessage("agent", "We should use bearer tokens");

  const tangent = tree.fork("docker-tangent", "Docker deployment");
  tree.addMessage("user", "How does Docker networking work?");
  tree.addMessage("agent", "Bridge network with three containers");

  // Return to main — should switch + merge
  const main = tree.allBranches.find((b) => b.name === "main")!;
  const result = tree.returnTo(main.id);

  assert(tree.currentBranch.name === "main", "returnTo: switched to main");
  assert(tangent.status === "merged", "returnTo: tangent merged");
  assert(
    tree.currentBranch.merge_sources.includes(tangent.id),
    "returnTo: main records tangent as merge source"
  );
  assert(result.merged_summary.length > 0, "returnTo: produced merge summary");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/branching-conversations && npm test`
Expected: FAIL — `tree.returnTo is not a function`

- [ ] **Step 3: Implement `returnTo()` in BranchTree**

Add after the `switchTo` method in `src/branch-tree.ts`:

```typescript
/**
 * Return to a previous branch, merging the current branch's knowledge into it.
 * Combines switchTo + merge in one atomic operation.
 * Used when the user returns from a tangent to a previous topic.
 */
returnTo(target_id: BranchId): MergeResult {
  const current = this.currentBranch;
  const current_id = current.id;

  if (current_id === target_id) {
    throw new Error("Already on target branch");
  }

  // Switch to target
  this.switchTo(target_id);

  // Merge the branch we just left
  return this.merge(current_id);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/branching-conversations && npm test`
Expected: All tests PASS including new returnTo tests

- [ ] **Step 5: Commit**

```bash
cd ~/branching-conversations
git add src/branch-tree.ts src/test.ts
git commit -m "feat: add returnTo() for atomic switch+merge on branch return"
```

---

### Task 2: Test returnTo edge cases

**Files:**
- Test: `src/test.ts` (append to return-to block)

- [ ] **Step 1: Write edge case tests**

Add inside the return-to test block:

```typescript
{
  console.log("\n  Return-to edge cases:");
  const tree = new BranchTree(
    {
      agent_identity: "test agent",
      user_profile: "test user",
      long_term_memory: [],
    },
    { auto_branch: false }
  );

  // Can't return to self
  let threwSelf = false;
  try {
    tree.returnTo(tree.currentBranch.id);
  } catch {
    threwSelf = true;
  }
  assert(threwSelf, "returnTo: throws when target is current branch");

  // Can't return to pruned branch
  tree.addMessage("user", "Main content");
  const pruned = tree.fork("pruned-branch", "will be pruned");
  tree.addMessage("user", "Dead end content");
  const main = tree.allBranches.find((b) => b.name === "main")!;
  tree.switchTo(main.id);
  tree.prune(pruned.id, "dead end");

  let threwPruned = false;
  try {
    tree.returnTo(pruned.id);
  } catch {
    threwPruned = true;
  }
  assert(threwPruned, "returnTo: throws when target is pruned");
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd ~/branching-conversations && npm test`
Expected: All PASS (returnTo delegates to switchTo which already handles these)

- [ ] **Step 3: Commit**

```bash
cd ~/branching-conversations
git add src/test.ts
git commit -m "test: add returnTo edge case coverage"
```

---

## Chunk 2: LLM return detector

### Task 3: Create the return detector

**Files:**
- Create: `src/return-detector.ts`

- [ ] **Step 1: Create `src/return-detector.ts`**

```typescript
/**
 * LLM-based return detector.
 *
 * Before checking for drift (new tangent), checks if the message
 * matches a PREVIOUS branch's topic better than the current one.
 *
 * Uses Moonshot to compare the message against branch topic summaries
 * and make a routing decision.
 */

import { BranchNode, BranchId } from "./types.js";

export interface ReturnDetection {
  /** Whether the message should return to a previous branch */
  should_return: boolean;
  /** The branch ID to return to, if any */
  target_branch_id: BranchId | null;
  /** The branch name to return to */
  target_branch_name: string;
  /** Confidence in the decision */
  confidence: number;
  /** Explanation */
  reason: string;
}

export interface ReturnDetectorConfig {
  api_key?: string;
  model?: string;
  base_url?: string;
  max_history_messages?: number;
  /** Minimum messages on current branch before considering return. Default: 2 */
  min_messages_before_return?: number;
}

const DEFAULTS: Required<ReturnDetectorConfig> = {
  api_key: "",
  model: "moonshot-v1-8k",
  base_url: "https://api.moonshot.ai/v1",
  max_history_messages: 10,
  min_messages_before_return: 2,
};

interface MoonshotResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message: string };
}

interface LLMReturnVerdict {
  action: "stay" | "return";
  target_branch: string;
  confidence: number;
  reasoning: string;
}

export class LLMReturnDetector {
  private config: Required<ReturnDetectorConfig>;

  constructor(config: ReturnDetectorConfig = {}) {
    this.config = {
      ...DEFAULTS,
      ...config,
      api_key: config.api_key || process.env.MOONSHOT_API_KEY || "",
    };

    if (!this.config.api_key) {
      throw new Error(
        "Moonshot API key required. Set MOONSHOT_API_KEY env var or pass api_key."
      );
    }
  }

  /**
   * Check if a message should return to a previous branch.
   *
   * @param current - The currently active branch
   * @param candidates - Other branches that could be returned to (non-pruned ancestors/siblings)
   * @param new_message - The user's new message
   */
  async analyze(
    current: BranchNode,
    candidates: BranchNode[],
    new_message: string
  ): Promise<ReturnDetection> {
    // No candidates to return to
    if (candidates.length === 0) {
      return {
        should_return: false,
        target_branch_id: null,
        target_branch_name: "",
        confidence: 1,
        reason: "No other branches to return to",
      };
    }

    // Current branch too young — haven't explored the tangent enough
    if (current.messages.length < this.config.min_messages_before_return) {
      return {
        should_return: false,
        target_branch_id: null,
        target_branch_name: "",
        confidence: 0.5,
        reason: `Current branch has ${current.messages.length}/${this.config.min_messages_before_return} messages — tangent not yet explored`,
      };
    }

    const verdict = await this.callLLM(current, candidates, new_message);

    if (verdict.action === "return" && verdict.target_branch) {
      const target = candidates.find((b) => b.name === verdict.target_branch);
      if (target) {
        return {
          should_return: true,
          target_branch_id: target.id,
          target_branch_name: target.name,
          confidence: verdict.confidence,
          reason: verdict.reasoning,
        };
      }
    }

    return {
      should_return: false,
      target_branch_id: null,
      target_branch_name: "",
      confidence: verdict.confidence,
      reason: verdict.reasoning,
    };
  }

  private async callLLM(
    current: BranchNode,
    candidates: BranchNode[],
    new_message: string
  ): Promise<LLMReturnVerdict> {
    const currentSummary = this.branchSummary(current);
    const candidateSummaries = candidates
      .map((b) => `- "${b.name}": ${this.branchSummary(b)}`)
      .join("\n");

    const systemPrompt = `You are a conversation router. Given a current conversation branch, a list of previous branches, and a new message, determine if the user is returning to a previous topic.

Respond with ONLY a JSON object (no markdown, no code fences):
{
  "action": "stay" or "return",
  "target_branch": "branch-name if returning, empty string if staying",
  "confidence": 0.0 to 1.0,
  "reasoning": "brief one-sentence explanation"
}

Rules:
- "return": The message clearly relates to a previous branch's topic, not the current one
- "stay": The message continues the current branch, or is a new tangent (not a return)
- Look for explicit return signals: "back to", "anyway", "so about", "returning to", "as I was saying"
- Also detect implicit returns: the message's content matches a previous branch better than the current one
- If the message is a NEW tangent (unrelated to both current and previous), choose "stay" — drift detection handles new tangents separately
- Be conservative: only return when clearly matching a previous branch`;

    const userPrompt = `Current branch "${current.name}":
${currentSummary}

Previous branches:
${candidateSummaries}

New message:
user: ${new_message}

Is this message returning to a previous branch, or staying on the current topic?`;

    const body = JSON.stringify({
      model: this.config.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 200,
      temperature: 0.1,
    });

    const response = await fetch(
      `${this.config.base_url}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.api_key}`,
        },
        body,
      }
    );

    const data = (await response.json()) as MoonshotResponse;

    if (data.error) {
      throw new Error(`Moonshot API error: ${data.error.message}`);
    }

    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new Error("Empty response from Moonshot API");
    }

    try {
      const cleaned = content
        .replace(/```json?\s*/g, "")
        .replace(/```\s*/g, "")
        .trim();
      return JSON.parse(cleaned) as LLMReturnVerdict;
    } catch {
      return {
        action: "stay",
        target_branch: "",
        confidence: 0.3,
        reasoning: `Failed to parse LLM response: ${content.substring(0, 100)}`,
      };
    }
  }

  private branchSummary(branch: BranchNode): string {
    const recent = branch.messages
      .slice(-this.config.max_history_messages)
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n  ");
    return recent || branch.topic_summary || "(empty branch)";
  }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd ~/branching-conversations && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
cd ~/branching-conversations
git add src/return-detector.ts
git commit -m "feat: add LLM-based return detector"
```

---

## Chunk 3: Integrate into LLMBranchTree

### Task 4: Wire return detection into chat() flow

**Files:**
- Modify: `src/llm-branch-tree.ts`

- [ ] **Step 1: Update LLMBranchTree to use return detector**

The new `chat()` flow is:
1. Check return (does message match a previous branch?) → switch+merge
2. Check drift (is message a new tangent?) → fork
3. Otherwise → add to current branch

Update `src/llm-branch-tree.ts`:

```typescript
// Add import at top:
import { LLMReturnDetector, ReturnDetection } from "./return-detector.js";

// Update chat() return type to include return info:
async chat(
  content: string,
  knowledge: KnowledgeDiff = emptyKnowledgeDiff()
): Promise<{
  message: Message;
  forked: boolean;
  fork_branch?: BranchNode;
  returned: boolean;
  returned_from?: BranchNode;
  merge_result?: MergeResult;
  detection: DriftDetection;
  return_detection?: ReturnDetection;
}>

// New chat() body:
// 1. Check return first
if (this.auto_branch && this.returnDetector) {
  const candidates = this.getReturnCandidates();
  if (candidates.length > 0) {
    const returnResult = await this.returnDetector.analyze(
      branch, candidates, content
    );
    if (returnResult.should_return && returnResult.target_branch_id) {
      const returning_from = branch;
      const mergeResult = this.tree.returnTo(returnResult.target_branch_id);
      const message = this.tree.addMessage("user", content, knowledge);
      return {
        message, forked: false, returned: true,
        returned_from: returning_from,
        merge_result: mergeResult,
        detection: { drift_score: 0, should_fork: false, suggested_topic: "", confidence: 1, reason: "Returned to previous branch" },
        return_detection: returnResult,
      };
    }
  }
}
// 2. Then check drift (existing logic)
// 3. Add message
```

Add helper to find return candidates:

```typescript
private getReturnCandidates(): BranchNode[] {
  const current = this.tree.currentBranch;
  return this.tree.allBranches.filter(
    (b) =>
      b.id !== current.id &&
      b.status !== "pruned" &&
      b.status !== "merged" &&
      b.messages.length > 0
  );
}
```

Also add `returnDetector` to constructor, initialized alongside `llmDetector`.

- [ ] **Step 2: Verify it compiles**

Run: `cd ~/branching-conversations && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
cd ~/branching-conversations
git add src/llm-branch-tree.ts
git commit -m "feat: integrate return detection into LLMBranchTree.chat()"
```

---

### Task 5: Add returnTo delegate to LLMBranchTree

**Files:**
- Modify: `src/llm-branch-tree.ts`

- [ ] **Step 1: Add returnTo to delegate methods**

Add to the delegate section at bottom of `LLMBranchTree`:

```typescript
returnTo(id: string) { return this.tree.returnTo(id); }
```

- [ ] **Step 2: Commit**

```bash
cd ~/branching-conversations
git add src/llm-branch-tree.ts
git commit -m "feat: expose returnTo on LLMBranchTree"
```

---

## Chunk 4: Demo and end-to-end validation

### Task 6: Extend LLM demo with return scenario

**Files:**
- Modify: `src/demo-llm.ts`

- [ ] **Step 1: Add return-to-main messages to the demo script**

Add after the Docker tangent messages in the script, before the XP tangent:

```typescript
{
  role: "user",
  content: "Okay cool, so the Nginx proxy handles routing. Back to the API — given that setup, should we version our quest endpoints like /api/v1/quests?",
  note: "RETURN → back to API design (should return to main)",
},
{
  role: "agent",
  content: "Since Nginx handles routing, go with /api/v1/quests. The config can map /api/v1/* to the same backend.",
},
```

Update the output logging to show return events:

```typescript
if (result.returned) {
  console.log(`  ↩ AUTO-RETURN → "${tree.currentBranch.name}" (from "${result.returned_from!.name}")`);
}
```

- [ ] **Step 2: Run the demo**

Run: `source ~/.bashrc && cd ~/branching-conversations && npx tsx src/demo-llm.ts --mode llm`
Expected: Docker tangent forks, "Back to the API" returns to main, XP question forks

- [ ] **Step 3: Commit**

```bash
cd ~/branching-conversations
git add src/demo-llm.ts
git commit -m "feat: demo shows full fork→explore→return→merge loop"
```

---

### Task 7: Run full test suite

**Files:**
- Test: `src/test.ts`

- [ ] **Step 1: Run all tests**

Run: `cd ~/branching-conversations && npm test`
Expected: All tests PASS

- [ ] **Step 2: Run LLM demo end-to-end**

Run: `source ~/.bashrc && cd ~/branching-conversations && npx tsx src/demo-llm.ts --mode llm`
Expected: Output shows fork, return, and fork events in correct sequence

- [ ] **Step 3: Final commit**

```bash
cd ~/branching-conversations
git add -A
git commit -m "feat: complete auto-return detection — fork→explore→return→merge loop"
```
