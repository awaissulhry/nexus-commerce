#!/usr/bin/env node
/**
 * F1 — no-touch guard. Factory OS must never import from apps/web or apps/api
 * (workspace packages @nexus/shared / @nexus/database are legitimate npm
 * imports — though @nexus/database is unused by design; factory has its own
 * DB). Fails (exit 1) on any cross-app import so the rule is mechanical, not
 * aspirational. See docs/factory/F0-DESIGN-BRIDGE.md §No-touch.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, "..");
const ROOTS = ["src", "worker", "scripts"].map((d) => path.join(APP, d));
const BAD = [/from\s+['"][^'"]*apps\/web\//, /from\s+['"][^'"]*apps\/api\//, /require\(\s*['"][^'"]*apps\/(web|api)\//];
const EXT = new Set([".ts", ".tsx", ".mts", ".mjs", ".js", ".jsx"]);

function walk(dir) {
  let out = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "generated") continue;
    const abs = path.join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) out.push(...walk(abs));
    else if (EXT.has(path.extname(name))) out.push(abs);
  }
  return out;
}

const offenders = [];
for (const root of ROOTS) {
  let files = [];
  try { files = walk(root); } catch { continue; }
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const re of BAD) {
      if (re.test(text)) { offenders.push(path.relative(APP, file)); break; }
    }
  }
}

if (offenders.length) {
  console.error(`no-touch: ${offenders.length} file(s) import from apps/web or apps/api:`);
  for (const f of offenders) console.error(`  ${f}`);
  process.exit(1);
}
console.log("no-touch: clean — zero imports from apps/web or apps/api");
