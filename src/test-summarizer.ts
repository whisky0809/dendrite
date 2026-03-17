import { buildSummaryPrompt, parseSummaryResponse, fallbackSummary } from "./summarizer.js";
import type { SimpleMessage } from "./types.js";

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}

console.log("=== Summarizer ===\n");

// buildSummaryPrompt
const messages: SimpleMessage[] = [
  { id: "1", role: "user", content: "Let's design a REST API", timestamp: 1 },
  { id: "2", role: "assistant", content: "Sure, starting with user endpoints", timestamp: 2 },
  { id: "3", role: "user", content: "We should use JWT for auth", timestamp: 3 },
  { id: "4", role: "assistant", content: "Agreed, JWT with 15min expiry", timestamp: 4 },
];

const prompt = buildSummaryPrompt("REST API design", messages);
assert(prompt.system.includes("summarize"), "prompt: system says summarize");
assert(prompt.user.includes("REST API"), "prompt: includes conversation content");
assert(prompt.user.includes("JWT"), "prompt: includes key decision");

// parseSummaryResponse
const goodResponse = "Discussed REST API design. Decided on JWT auth with 15-minute token expiry. Still need to define user endpoints and error handling.";
const summary = parseSummaryResponse(goodResponse);
assert(summary.length > 0, "parseSummaryResponse: non-empty");
assert(summary.length < 500, "parseSummaryResponse: reasonably short");

// parseSummaryResponse — strips code fences
const fenced = "```\nSome summary text here\n```";
assert(parseSummaryResponse(fenced) === "Some summary text here", "parseSummaryResponse: strips fences");

// fallbackSummary
const fallback = fallbackSummary("Docker networking", 12);
assert(fallback.includes("Docker networking"), "fallbackSummary: includes topic");
assert(fallback.includes("12"), "fallbackSummary: includes message count");

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
