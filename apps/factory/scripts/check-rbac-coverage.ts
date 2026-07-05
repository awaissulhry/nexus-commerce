/**
 * F1 — deny-by-default coverage proof (S2 pattern, file-walk variant): every
 * src/app/api/&#42;&#42;/route.ts must (a) export `permission` and (b) wrap every
 * exported HTTP method in guarded(). Fails with a list of offenders — a new
 * endpoint cannot ship unmapped.
 */
import fs from "node:fs";
import path from "node:path";

const API_ROOT = path.join(process.cwd(), "src", "app", "api");
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap((name) => {
    const abs = path.join(dir, name);
    if (fs.statSync(abs).isDirectory()) return walk(abs);
    return name === "route.ts" || name === "route.tsx" ? [abs] : [];
  });
}

const offenders: string[] = [];
const files = walk(API_ROOT);
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  const rel = path.relative(process.cwd(), file);
  if (!/export const permissions?\s*[:=]/.test(text)) {
    offenders.push(`${rel} — missing \`export const permission\``);
    continue;
  }
  for (const method of METHODS) {
    const exportRe = new RegExp(`export const ${method}\\b`);
    if (exportRe.test(text)) {
      const guardedRe = new RegExp(`export const ${method}\\s*=\\s*guarded\\(`);
      if (!guardedRe.test(text)) offenders.push(`${rel} — ${method} is not wrapped in guarded()`);
    }
  }
}

if (offenders.length) {
  console.error(`rbac-coverage: ${offenders.length} problem(s):`);
  for (const o of offenders) console.error("  " + o);
  process.exit(1);
}
console.log(`rbac-coverage: ${files.length} route file(s), all export permission + guarded handlers`);
