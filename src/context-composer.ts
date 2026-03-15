/**
 * Context Composer — turns a WorkingContext into injectable prompt text.
 *
 * This is the bridge between dendrite's branch tree and actual LLM context.
 * The composed text gets injected into the agent's system prompt so the LLM
 * sees only the relevant branch's context + merged summaries from returned
 * tangents.
 */

import { WorkingContext, Message, BranchNode } from "./types.js";
import { BranchTree } from "./branch-tree.js";

export interface ComposerOptions {
  /** Max recent messages to include verbatim. Default: 15 */
  max_recent_messages?: number;
  /** Max characters for merged context summaries. Default: 2000 */
  max_merged_chars?: number;
  /** Include branch tree overview. Default: true */
  show_tree_overview?: boolean;
  /** Include knowledge summary (facts, decisions). Default: true */
  show_knowledge?: boolean;
}

const DEFAULTS: Required<ComposerOptions> = {
  max_recent_messages: 15,
  max_merged_chars: 2000,
  show_tree_overview: true,
  show_knowledge: true,
};

/**
 * Compose a full context block from a WorkingContext.
 * Returns text suitable for injection into a system prompt.
 */
export function composeContext(
  ctx: WorkingContext,
  options: ComposerOptions = {}
): string {
  const opts = { ...DEFAULTS, ...options };
  const sections: string[] = [];

  // ── Branch status ──
  sections.push(
    `[Active Branch: "${ctx.branch.topic || "main"}"]`
  );

  // ── Merged knowledge from returned tangents ──
  if (ctx.merged_context.length > 0) {
    let merged = ctx.merged_context.join("\n");
    if (merged.length > opts.max_merged_chars) {
      merged = merged.substring(0, opts.max_merged_chars) + "…";
    }
    sections.push(`[Merged from tangents]\n${merged}`);
  }

  // ── Knowledge state ──
  if (opts.show_knowledge) {
    const k = ctx.branch.knowledge_state;
    const parts: string[] = [];

    if (k.facts_learned.length > 0) {
      parts.push(
        "Facts: " + k.facts_learned.map((f) => f.content).join("; ")
      );
    }
    if (k.decisions_made.length > 0) {
      parts.push(
        "Decisions: " +
          k.decisions_made
            .map((d) => `${d.description} (${d.reasoning})`)
            .join("; ")
      );
    }
    if (k.questions_opened.length > 0) {
      const unresolved = k.questions_opened.filter((q) => !q.resolved);
      if (unresolved.length > 0) {
        parts.push(
          "Open questions: " + unresolved.map((q) => q.content).join("; ")
        );
      }
    }

    if (parts.length > 0) {
      sections.push(`[Branch knowledge]\n${parts.join("\n")}`);
    }
  }

  // ── Recent conversation ──
  const messages = ctx.recent_messages.slice(-opts.max_recent_messages);
  if (messages.length > 0) {
    const convo = messages
      .map((m) => `${formatRole(m.role)}: ${m.content}`)
      .join("\n");
    sections.push(`[Conversation]\n${convo}`);
  }

  return sections.join("\n\n");
}

/**
 * Compose a lightweight branch tree overview.
 * Shows all branches with status and message counts.
 */
export function composeTreeOverview(tree: BranchTree): string {
  const branches = tree.allBranches;
  const current = tree.currentBranch;

  if (branches.length === 1) {
    return "[Single conversation thread — no branches]";
  }

  const lines = ["[Conversation branches]"];
  for (const b of branches) {
    const marker = b.id === current.id ? " ← you are here" : "";
    const status =
      b.status === "merged"
        ? " (merged)"
        : b.status === "pruned"
          ? " (pruned)"
          : "";
    lines.push(
      `  ${b.name}: ${b.messages.length} msgs${status}${marker}`
    );
  }
  return lines.join("\n");
}

/**
 * Compose a complete injectable block for an agent's system prompt.
 * Combines tree overview + branch context.
 */
export function composeSystemBlock(
  tree: BranchTree,
  options: ComposerOptions = {}
): string {
  const opts = { ...DEFAULTS, ...options };
  const ctx = tree.buildWorkingContext(opts.max_recent_messages);

  const parts: string[] = [];

  if (opts.show_tree_overview && tree.allBranches.length > 1) {
    parts.push(composeTreeOverview(tree));
  }

  parts.push(composeContext(ctx, opts));

  return parts.join("\n\n");
}

function formatRole(role: string): string {
  switch (role) {
    case "user":
      return "User";
    case "agent":
      return "Assistant";
    case "system":
      return "System";
    default:
      return role;
  }
}
