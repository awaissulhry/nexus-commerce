/**
 * FS1 — the query-bounds regression fence. Every `findMany(` in an API route
 * or the worker must be bounded (a `take:` or `cursor:` within the call) or
 * carry an explicit `// bounded: <reason>` annotation on or above the call.
 * Unbounded row reads are how FS0's cliffs happened (materials/stock scanned
 * the whole 1.2M-row ledger per page view); this keeps them extinct.
 * Static + heuristic by design — the FS0 harness is the empirical fence.
 */
import fs from "node:fs";
import path from "node:path";

const ROOTS = ["src/app/api", "worker"];
const files = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.tsx?$/.test(e.name)) files.push(p);
  }
}
for (const r of ROOTS) if (fs.existsSync(r)) walk(r);

const offenders = [];
for (const file of files) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes("findMany(")) continue;
    // annotation on the call line, the line above, or anywhere in the call window
    const windowText = lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 25)).join("\n");
    const annotated = /\/\/\s*bounded:/.test(windowText);
    // bounded if take/cursor appears within the call window (balanced-paren
    // scan would be sturdier; the window heuristic + harness suffices)
    const bounded = /\btake\s*[:=]/.test(windowText) || /\bcursor\s*:/.test(windowText);
    if (!bounded && !annotated) offenders.push(`${file}:${i + 1}`);
  }
}

if (offenders.length) {
  console.error("query-bounds: UNBOUNDED findMany without `// bounded:` annotation —");
  for (const o of offenders) console.error(`  ${o}`);
  console.error("Bound it (take/cursor), aggregate it (groupBy/$queryRaw), or annotate why it is safe.");
  process.exit(1);
}
console.log(`query-bounds: clean — ${files.length} files scanned, every findMany bounded or annotated`);
