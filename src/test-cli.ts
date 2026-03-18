import { parseConfigValue, validateConfigKey } from "./cli.js";
import { DEFAULT_CONFIG } from "./types.js";

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}

console.log("=== CLI helpers ===\n");

console.log("  validateConfigKey:");
assert(validateConfigKey("driftThreshold") === true, "accepts valid key");
assert(validateConfigKey("driftModel") === true, "accepts string key");
assert(validateConfigKey("nonexistent") === false, "rejects unknown key");
assert(validateConfigKey("") === false, "rejects empty string");

console.log("\n  parseConfigValue:");
assert(parseConfigValue("driftThreshold", "0.5") === 0.5, "parses number");
assert(parseConfigValue("reserveTokens", "4096") === 4096, "parses integer");
assert(parseConfigValue("driftModel", "some-model") === "some-model", "parses string");
assert(parseConfigValue("minMessagesBeforeDrift", "5") === 5, "parses integer config");

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
