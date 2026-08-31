#!/usr/bin/env node
/**
 * PH.4a — business logic leaves the HTTP layer. A ratchet, not a rewrite.
 *
 * WHY
 * You cannot extract a service whose logic lives inside a Fastify handler, and
 * today most of it does: first MEASURED at 3,540 direct DB call sites across
 * 127 files in apps/api/src/routes/ (advertising.routes.ts 504,
 * fulfillment.routes.ts 485). PH.5 moved the bidding-engine bridge into a
 * service, taking it to 3,534 / advertising 498 — the current baseline is
 * whatever route-prisma-baseline.json says, and it only falls.
 *
 * (A `grep prisma\.` puts it at 3,231. The AST counts `tx.` and `db.` too —
 * a transaction client is the same coupling by another name.)
 *
 * Rewriting 135k lines of handler is not a task anyone can schedule. Stopping
 * the pile from growing is, and every page rebuilt on the way past ratchets the
 * number down. That is exactly the bargain check-raw-primitives-ratchet.mjs
 * struck for the design system, and this is deliberately the same shape so it
 * behaves the way people here already expect.
 *
 * THE RULE
 * A route file may keep the DB calls it has. It may not gain one. A NEW route
 * file is held at ZERO — new logic goes in a service, and the route calls it.
 *
 * WHAT IT COUNTS (TypeScript AST, not a regex — a regex counts `prisma.` in a
 * comment or a string, and this number is a gate)
 * Property access on the file's database-client identifiers — the base access
 * only, so `prisma.product.findMany()` counts ONCE. See clientNames().
 *
 * EXEMPT
 *   __tests__/**, *.vitest.test.ts   not shipped code
 *
 *   node scripts/check-route-prisma-ratchet.mjs            # census
 *   node scripts/check-route-prisma-ratchet.mjs --check    # exit 1 if any file rose
 *   node scripts/check-route-prisma-ratchet.mjs --baseline
 */
import ts from 'typescript'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE = join(ROOT, 'scripts/route-prisma-baseline.json')
const DIR = 'apps/api/src/routes/'
/**
 * Which identifiers in THIS file are actually the database client.
 *
 * `prisma` and `tx` are the conventions (an import and a $transaction callback
 * parameter). `db` is NOT assumed: it is a common local variable name — in
 * advertising.routes.ts alone, `const db = campaign.dynamicBidding ?? {}`
 * produced 26 false hits, which inflated the baseline and would have failed a
 * push for naming a local variable. It counts only when the file really
 * imports the client under that name.
 *
 * A false positive here is worse than a miss: it makes someone change correct
 * code to satisfy a guard that was wrong.
 */
function clientNames(sf) {
  const names = new Set(['prisma', 'tx'])
  for (const st of sf.statements) {
    if (
      ts.isImportDeclaration(st) &&
      ts.isStringLiteralLike(st.moduleSpecifier) &&
      /(^|\/)db\.(js|ts)$/.test(st.moduleSpecifier.text) &&
      st.importClause?.name
    ) {
      names.add(st.importClause.name.text)
    }
  }
  return names
}
const EXEMPT = [/__tests__\//, /\.vitest\.test\.ts$/, /\.test\.ts$/]

function files() {
  const list = (cmd) => {
    try { return execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean) } catch { return [] }
  }
  // Untracked files are what a fresh session writes; a `git ls-files` guard is
  // blind to them, which is how a ratchet goes green while the pile grows.
  // A DIRECTORY pathspec, not a `**/*.ts` glob. git's `routes/**/*.ts` matches
  // only files at least one directory DEEP — it silently skipped all 173 files
  // sitting directly in routes/ and reported 3 files / 37 calls instead of
  // 173 / 3,231. A ratchet that green-lights the whole surface it is meant to
  // hold is worse than no ratchet at all.
  return [...new Set([...list(`git ls-files "${DIR}"`), ...list(`git ls-files --others --exclude-standard "${DIR}"`)])]
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => !EXEMPT.some((re) => re.test(f)))
}

function countDbCalls(rel) {
  const abs = join(ROOT, rel)
  if (!existsSync(abs)) return 0
  const sf = ts.createSourceFile(rel, readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const CLIENTS = clientNames(sf)
  let n = 0
  const visit = (node) => {
    // Base access only: `prisma.product` counts, the `.findMany` on top of it
    // does not, so one query is one point.
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      CLIENTS.has(node.expression.text)
    ) {
      n++
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return n
}

const counts = {}
for (const rel of files()) {
  const n = countDbCalls(rel)
  if (n) counts[rel] = n
}
const total = Object.values(counts).reduce((a, b) => a + b, 0)
const mode = process.argv[2] ?? '--census'

if (mode === '--baseline') {
  writeFileSync(
    BASELINE,
    JSON.stringify(
      {
        note: 'Direct DB calls per route file. This may only FALL. A file absent here is held at ZERO — new logic belongs in a service that the route calls. See the script header.',
        updatedAt: new Date().toISOString().slice(0, 10),
        total,
        files: counts,
      },
      null,
      2,
    ) + '\n',
  )
  console.log(`baseline written: ${Object.keys(counts).length} route file(s), ${total} direct DB call(s)`)
  process.exit(0)
}

if (mode === '--census') {
  console.log(`${Object.keys(counts).length} route file(s) hold ${total} direct DB call(s)\n`)
  for (const [f, n] of Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`  ${String(n).padStart(4)}  ${f}`)
  }
  process.exit(0)
}

if (!existsSync(BASELINE)) {
  console.error(`\n❌ route-prisma ratchet: no baseline at ${BASELINE}\n\n   Run: node scripts/check-route-prisma-ratchet.mjs --baseline\n`)
  process.exit(1)
}
const base = JSON.parse(readFileSync(BASELINE, 'utf8'))
const risen = Object.entries(counts).filter(([f, n]) => n > (base.files[f] ?? 0))
if (risen.length) {
  console.error(`❌ route-prisma ratchet: ${risen.length} route file(s) gained direct DB access:`)
  for (const [f, n] of risen) {
    const was = base.files[f] ?? 0
    console.error(`   ${f}: ${was} → ${n}`)
    if (!was) console.error(`     This file had NONE — its logic belongs in a service the route calls.`)
  }
  console.error(
    `\n   Business logic in an HTTP handler cannot be extracted into a service later —\n` +
      `   the handler IS the coupling. Put the query in a service and call it from the route.\n`,
  )
  process.exit(1)
}
console.log(`✓ route-prisma ratchet: ${total} direct DB call(s) across ${Object.keys(counts).length} route file(s) (baseline ${base.total}) — no file rose`)
