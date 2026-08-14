/**
 * Licence audit for the x402Seek preview.
 *
 * This service is deployed publicly and separately from the SCF core, so it
 * carries its own audit and reports its own numbers. It deliberately does not
 * inherit, extend or restate the core's "244 resolved / 238 runtime" figure:
 * that number describes a different dependency graph, and blurring the two
 * would weaken a claim the frozen proposal makes precisely.
 *
 * Scope is the **resolved production graph** — what actually ships in the
 * container — walked from the installed tree rather than from the declared
 * direct dependencies, so transitive packages cannot hide.
 *
 * Failure conditions, in order of seriousness:
 *   1. any strong copyleft (AGPL/GPL/SSPL/EUPL/CPAL, and LGPL flagged too)
 *   2. any licence we cannot classify, including a missing one
 *
 * Failing on "unknown" and not only on "forbidden" is the point. An audit that
 * passes because it could not read a manifest has told you nothing.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "artifacts", "compliance");

/** Permissive and accepted without review. */
const PERMISSIVE = new Set([
  "MIT",
  "ISC",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "Unlicense",
  "CC0-1.0",
  "BlueOak-1.0.0",
  "MIT-0",
  "Python-2.0",
  "(MIT OR CC0-1.0)",
  "(MIT OR Apache-2.0)",
  "(Apache-2.0 OR MIT)",
  "(MIT AND BSD-3-Clause)",
]);

/** Strong copyleft, plus LGPL which we refuse rather than argue about. */
const FORBIDDEN = [
  /\bAGPL\b/i,
  /\bSSPL\b/i,
  /\bEUPL\b/i,
  /\bCPAL\b/i,
  /\bGPL-[123]/i,
  /\bLGPL\b/i,
  /^GPL/i,
];

interface Node {
  version?: string;
  path?: string;
  dependencies?: Record<string, Node>;
}

interface Record_ {
  name: string;
  version: string;
  license: string;
  source: "package.json" | "license-file" | "unresolved";
  native: boolean;
}

/** Walk the installed production tree. */
function resolvedGraph(): Map<string, string> {
  const raw = execFileSync(
    "pnpm",
    ["list", "--prod", "--depth", "Infinity", "--json"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const roots = JSON.parse(raw) as Array<{ dependencies?: Record<string, Node> }>;
  const found = new Map<string, string>();

  const walk = (deps: Record<string, Node> | undefined) => {
    for (const [name, node] of Object.entries(deps ?? {})) {
      const key = `${name}@${node.version ?? "?"}`;
      if (found.has(key)) continue;
      found.set(key, node.path ?? "");
      walk(node.dependencies);
    }
  };
  for (const root of roots) walk(root.dependencies);
  return found;
}

/** A package containing a prebuilt binary is called out explicitly. */
function isNative(dir: string): boolean {
  if (!dir || !existsSync(dir)) return false;
  const stack = [dir];
  let visited = 0;
  while (stack.length > 0 && visited < 400) {
    const current = stack.pop()!;
    visited += 1;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== "node_modules") {
        stack.push(join(current, entry.name));
      } else if (/\.(node|dylib|so|dll|wasm)$/.test(entry.name)) {
        return true;
      }
    }
  }
  return false;
}

function licenseOf(dir: string): { license: string; source: Record_["source"] } {
  if (!dir || !existsSync(dir)) return { license: "UNKNOWN", source: "unresolved" };

  try {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      license?: unknown;
      licenses?: unknown;
    };
    if (typeof manifest.license === "string" && manifest.license.trim()) {
      return { license: manifest.license.trim(), source: "package.json" };
    }
    if (typeof manifest.license === "object" && manifest.license !== null) {
      const type = (manifest.license as { type?: string }).type;
      if (type) return { license: type, source: "package.json" };
    }
    if (Array.isArray(manifest.licenses)) {
      const types = (manifest.licenses as Array<{ type?: string }>)
        .map((l) => l.type)
        .filter(Boolean);
      if (types.length > 0) return { license: types.join(" OR "), source: "package.json" };
    }
  } catch {
    /* falls through to the licence-file probe */
  }

  for (const candidate of ["LICENSE", "LICENSE.md", "LICENCE", "LICENSE.txt"]) {
    const path = join(dir, candidate);
    if (!existsSync(path)) continue;
    const head = readFileSync(path, "utf8").slice(0, 400);
    if (/MIT License/i.test(head)) return { license: "MIT", source: "license-file" };
    if (/Apache License/i.test(head)) return { license: "Apache-2.0", source: "license-file" };
    if (/ISC License/i.test(head)) return { license: "ISC", source: "license-file" };
    if (/BSD/i.test(head)) return { license: "BSD-3-Clause", source: "license-file" };
  }

  return { license: "UNKNOWN", source: "unresolved" };
}

const records: Record_[] = [];
for (const [key, dir] of resolvedGraph()) {
  const at = key.lastIndexOf("@");
  const { license, source } = licenseOf(dir);
  records.push({
    name: key.slice(0, at),
    version: key.slice(at + 1),
    license,
    source,
    native: isNative(dir),
  });
}
records.sort((a, b) => a.name.localeCompare(b.name));

const forbidden = records.filter((r) => FORBIDDEN.some((re) => re.test(r.license)));
const unknown = records.filter((r) => r.license === "UNKNOWN" || !PERMISSIVE.has(r.license));
const native = records.filter((r) => r.native);

const byLicense = new Map<string, number>();
for (const r of records) byLicense.set(r.license, (byLicense.get(r.license) ?? 0) + 1);

/**
 * The embedding model is a runtime artifact, not an npm package, so a
 * dependency walk would never see it. Recorded here on purpose.
 */
const MODEL = {
  id: "Xenova/all-MiniLM-L6-v2",
  license: "Apache-2.0",
  note: "ONNX export of sentence-transformers/all-MiniLM-L6-v2; fetched from the Hugging Face CDN at runtime and cached on disk.",
};

const artifact = {
  generatedAt: new Date().toISOString(),
  scope: "resolved production dependency graph of x402seek-web",
  independentOf:
    "The SCF core's audit covers a different graph. This report does not extend or restate its numbers.",
  totals: {
    resolvedPackages: records.length,
    forbidden: forbidden.length,
    unknownOrUnclassified: unknown.length,
    nativeBinaries: native.length,
  },
  byLicense: Object.fromEntries([...byLicense].sort((a, b) => b[1] - a[1])),
  model: MODEL,
  native: native.map((r) => ({ name: r.name, version: r.version, license: r.license })),
  packages: records,
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "licenses.json"), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

console.log("x402seek-web licence audit");
console.log(`  resolved packages : ${records.length}`);
for (const [license, count] of [...byLicense].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${license.padEnd(28)} ${count}`);
}
console.log(`  native binaries   : ${native.length}`);
for (const r of native) console.log(`    ${r.name}@${r.version} (${r.license})`);
console.log(`  model             : ${MODEL.id} — ${MODEL.license}`);

if (forbidden.length > 0) {
  console.error("\nFAIL: copyleft licences in the production graph:");
  for (const r of forbidden) console.error(`  ${r.name}@${r.version} — ${r.license}`);
  process.exit(1);
}
if (unknown.length > 0) {
  console.error("\nFAIL: unclassified licences (an unreadable licence is not a pass):");
  for (const r of unknown) console.error(`  ${r.name}@${r.version} — ${r.license} (${r.source})`);
  process.exit(1);
}

console.log("\nPASS: zero copyleft, zero unclassified.");
