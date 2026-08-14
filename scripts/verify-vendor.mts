/**
 * Prove the vendored code is the frozen core's code.
 *
 * Vendoring is a liability unless it is checkable, so this re-reads each file
 * from the core repository **at the pinned commit** (`git show <sha>:<path>`,
 * so a dirty working tree cannot mask a difference), applies the one documented
 * rewrite, and compares.
 *
 * The rewrite: `@stellar-bazaar/catalog` → `../catalog/index.js`. The workspace
 * specifier cannot resolve outside the core's pnpm workspace. Nothing else is
 * altered, and this script fails if anything else is.
 *
 * Usage: pnpm verify:vendor [--core ../facilitador-stellar]
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const coreArg = process.argv.indexOf("--core");
const CORE = resolve(
  coreArg === -1 ? join(ROOT, "..", "facilitador-stellar") : process.argv[coreArg + 1]!,
);

const PINNED = JSON.parse(readFileSync(join(ROOT, "data", "snapshot.json"), "utf8")).coreCommit as string;

const FILES: Array<{ vendored: string; source: string }> = [
  { vendored: "vendor/catalog/types.ts", source: "packages/catalog/src/types.ts" },
  { vendored: "vendor/catalog/wire.ts", source: "packages/catalog/src/wire.ts" },
  { vendored: "vendor/catalog/search-document.ts", source: "packages/catalog/src/search-document.ts" },
  { vendored: "vendor/catalog/canonical.ts", source: "packages/catalog/src/canonical.ts" },
  { vendored: "vendor/search/embedder.ts", source: "packages/search/src/embedder.ts" },
  { vendored: "vendor/search/engine.ts", source: "packages/search/src/engine.ts" },
  { vendored: "vendor/search/ranking.ts", source: "packages/search/src/ranking.ts" },
];

/** The single permitted transformation. */
const rewrite = (text: string) => text.replaceAll('"@stellar-bazaar/catalog"', '"../catalog/index.js"');

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

let failures = 0;
console.log(`verifying vendored source against ${CORE} at ${PINNED.slice(0, 12)}`);

for (const { vendored, source } of FILES) {
  let original: string;
  try {
    original = execFileSync("git", ["show", `${PINNED}:${source}`], {
      cwd: CORE,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    console.error(`  ?  ${vendored} — cannot read ${source} at ${PINNED.slice(0, 12)}`);
    failures += 1;
    continue;
  }

  const expected = rewrite(original);
  const actual = readFileSync(join(ROOT, vendored), "utf8");

  if (expected === actual) {
    console.log(`  ok ${vendored}  sha256:${sha(original).slice(0, 12)} (pristine)`);
  } else {
    console.error(`  FAIL ${vendored} differs from ${source} beyond the documented rewrite`);
    failures += 1;
  }
}

if (failures > 0) {
  console.error(`\nFAIL: ${failures} file(s) diverge from the frozen core.`);
  process.exit(1);
}
console.log("\nPASS: every vendored file matches the frozen core at the pinned commit.");
