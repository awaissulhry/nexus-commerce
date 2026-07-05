#!/usr/bin/env node
/**
 * F1 — design-system parity check (FD12). READ-ONLY on apps/web.
 * Diffs the factory's verbatim DS copy against the canonical
 * apps/web/src/design-system and reports drift per file. Exit 0 always unless
 * --strict: drift is information (upstream moved), not automatically an error.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..", "..");
const CANON = path.join(repo, "apps/web/src/design-system");
const COPY = path.join(repo, "apps/factory/src/design-system");
const SUBTREES = ["styles", "tokens", "primitives", "components", "patterns", "lib", "tools", "docs", "README.md"];
const strict = process.argv.includes("--strict");

function walk(root, rel = "") {
  const abs = path.join(root, rel);
  const st = statSync(abs);
  if (st.isFile()) return [rel];
  return readdirSync(abs).flatMap((name) => walk(root, path.join(rel, name)));
}
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

let drifted = [], missingInCopy = [], extraInCopy = [], same = 0;
for (const sub of SUBTREES) {
  const canonSub = path.join(CANON, sub);
  const copySub = path.join(COPY, sub);
  if (!existsSync(canonSub)) { console.log(`~ canonical ${sub} no longer exists upstream`); continue; }
  const canonFiles = walk(CANON, sub);
  const copyFiles = existsSync(copySub) ? walk(COPY, sub) : [];
  const copySet = new Set(copyFiles);
  for (const f of canonFiles) {
    if (!copySet.has(f)) { missingInCopy.push(f); continue; }
    copySet.delete(f);
    if (sha(path.join(CANON, f)) === sha(path.join(COPY, f))) same++;
    else drifted.push(f);
  }
  extraInCopy.push(...copySet);
}

console.log(`ds-parity: ${same} identical · ${drifted.length} drifted · ${missingInCopy.length} new upstream · ${extraInCopy.length} local-only`);
for (const f of drifted) console.log(`  DRIFT  ${f}`);
for (const f of missingInCopy) console.log(`  NEW-UPSTREAM  ${f}`);
for (const f of extraInCopy) console.log(`  LOCAL-ONLY  ${f}`);
if (drifted.length + missingInCopy.length + extraInCopy.length === 0) console.log("copy is byte-identical to canonical — full parity");
else console.log("review drift above; re-sync deliberately (see src/design-system/PROVENANCE.md)");
process.exit(strict && (drifted.length || missingInCopy.length) ? 1 : 0);
