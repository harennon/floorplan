/**
 * Structural invariant — "no await in a mutator handler" (LLD 47, item 1).
 *
 * The concurrency contract (LLD 32 State model) requires that every mutator
 * handler is fully synchronous: no `await` before or during the core mutation,
 * so no two handlers can interleave over the module-level singletons.
 *
 * Only two handlers are legitimately async (they snapshot BEFORE awaiting and
 * never mutate post-await): tool_save_plan and tool_get_share_url. All other
 * exported tool_* functions must contain no `await` token.
 *
 * NOTE: this test scans the SOURCE TEXT for the token `\bawait\b`. A comment or
 * string literal containing "await" inside a non-allowlisted function body would
 * also fail — this is intentional (keep the word out of those bodies entirely,
 * which they do today). If a future async mutator is genuinely needed, its
 * author must either make it synchronous or add it to ASYNC_ALLOWLIST AND
 * re-satisfy the concurrency contract (snapshot-before-await, or a mutex);
 * see LLD 32 State model.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Two handlers that legitimately await (they snapshot before any await and
// never mutate post-await — the contract's documented exception).
const ASYNC_ALLOWLIST = new Set(["tool_save_plan", "tool_get_share_url"]);

const TOOLS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/tools.js"
);

const src = readFileSync(TOOLS_PATH, "utf8");

/**
 * Slice the source into per-function bodies using brace counting.
 * Finds each `export function <name>(` or `export async function <name>(` and
 * returns { name, body } where body is the text from the opening brace to the
 * matching closing brace (inclusive).
 *
 * This is a best-effort structural scan, not a full parser. It relies on the
 * convention that function bodies are delimited by matching braces and that
 * there are no naked unmatched braces in string literals inside these functions
 * (which is true of tools.js today). Template literals containing `{` would
 * confuse the counter if they were present, but tools.js uses none.
 */
function sliceFunctions(source) {
  const fn = [];
  // Match exported functions (sync or async).
  const RE = /export\s+(?:async\s+)?function\s+(tool_\w+)\s*\(/g;
  let m;
  while ((m = RE.exec(source)) !== null) {
    const name = m[1];
    const start = source.indexOf("{", m.index);
    if (start === -1) continue;
    let depth = 0;
    let end = start;
    for (let i = start; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    fn.push({ name, body: source.slice(start, end + 1) });
  }
  return fn;
}

test("ASYNC_ALLOWLIST names actually exist as exports in tools.js (rename guard)", () => {
  for (const name of ASYNC_ALLOWLIST) {
    // Look for the export declaration.
    const present =
      src.includes(`export async function ${name}(`) ||
      src.includes(`export function ${name}(`);
    assert.ok(present, `${name} must be an exported function in tools.js — update ASYNC_ALLOWLIST if renamed`);
  }
});

test("no non-allowlisted tool_* handler contains an await token", () => {
  const fns = sliceFunctions(src);
  assert.ok(fns.length >= 1, "should find at least one tool_* function");

  const violations = [];
  for (const { name, body } of fns) {
    if (ASYNC_ALLOWLIST.has(name)) continue;
    if (/\bawait\b/.test(body)) {
      violations.push(name);
    }
  }

  assert.deepEqual(
    violations,
    [],
    `Mutator contract violated — these tool_* handlers contain await but are not in ASYNC_ALLOWLIST: ${violations.join(", ")}. ` +
    "Either make them synchronous, or add to ASYNC_ALLOWLIST and satisfy the snapshot-before-await contract (LLD 32 State model)."
  );
});
