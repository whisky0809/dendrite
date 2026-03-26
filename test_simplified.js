import * as path from "node:path";

const SAFE_EDITORS = new Set([
  "vi", "vim", "nvim", "nano", "emacs", "emacsclient",
  "code", "code-insiders", "subl", "mate", "gedit",
  "notepad", "notepad++", "micro", "helix", "hx", "joe", "kak"
]);

export function isSafeEditor(editor) {
  if (!editor || /[;&|`$]/.test(editor)) return false;
  const name = path.basename(editor).toLowerCase().replace(".exe", "");
  return SAFE_EDITORS.has(name);
}

let passed = 0;
let failed = 0;
function assert(condition, name) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}

console.log("=== Security tests: Simplified isSafeEditor ===\n");

assert(isSafeEditor("vi") === true, "accepts 'vi'");
assert(isSafeEditor("/usr/bin/vi") === true, "accepts '/usr/bin/vi'");
assert(isSafeEditor("C:\\Windows\\notepad.exe") === true, "accepts 'C:\\Windows\\notepad.exe'");
assert(isSafeEditor("/tmp/vi") === true, "accepts '/tmp/vi' (allowed now as per feedback)");

assert(isSafeEditor("whoami") === false, "rejects 'whoami'");
assert(isSafeEditor("vi; whoami") === false, "rejects command chaining");

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
