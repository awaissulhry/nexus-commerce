#!/usr/bin/env node
/**
 * AE.1 — every write to StockLevel happens under the product stock lock.
 *
 * WHY
 * Every stock writer reads a StockLevel row, computes the next value in JavaScript and writes it
 * back. Without a lock two writers read the same value and one update is lost. Measured on a real
 * multi-connection PostgreSQL on 2026-09-16, before the lock existed: 20 simultaneous sales on 20
 * units left 19 units; 25 buyers all reserved 20 units; one reservation consumed twice took the
 * stock twice; a bulk import overwrote a sale. `apps/api/src/services/stock-lock.ts` fixed it for
 * every writer that existed that day. This check keeps it fixed: a NEW writer that forgets the
 * lock brings the race back silently, and no functional test would notice.
 *
 * THE RULE
 * Only the files listed in scripts/stock-writer-lock.json may write StockLevel, each with EXACTLY
 * the number of write sites listed. A file listed with `"lock": true` must call
 * `lockProductStock(`. A file listed with `"lock": false` must say why (the threshold-only
 * writes in stock.routes.ts never touch quantity, reserved or available).
 *
 * Adding a write site means editing the list, which is the review moment: say where the lock is.
 * A listed count that FELL, or a listed file that no longer writes, also fails — the list must
 * describe the tree, or it stops meaning anything.
 *
 * WHAT COUNTS AS A WRITE (TypeScript AST, so comments never count)
 *   <anything>.stockLevel.update / updateMany / upsert / create / createMany / delete / deleteMany (
 *   a string or template literal containing  UPDATE "StockLevel"  /  INSERT INTO "StockLevel"  /
 *   DELETE FROM "StockLevel"
 * Not caught: a table name assembled at runtime, or the delegate reached through a variable
 * (`const { stockLevel } = tx`). Neither pattern exists in the tree today.
 *
 * SCOPE
 * Runtime code: apps/*\/src and packages/*\/src. Tests (*.test.*, __tests__/, test-support/) and
 * one-off scripts are out of scope — they seed fixtures, they do not serve orders.
 *
 *   node scripts/check-stock-writer-lock.mjs            # census
 *   node scripts/check-stock-writer-lock.mjs --check    # exit 1 on any violation
 *   node scripts/check-stock-writer-lock.mjs --check --root <dir>   # scan another tree (mutation tests)
 */
import ts from 'typescript'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const rootFlag = args.indexOf('--root')
const ROOT = rootFlag >= 0 ? args[rootFlag + 1] : fileURLToPath(new URL('..', import.meta.url))
const CHECK = args.includes('--check')
const LIST = JSON.parse(readFileSync(fileURLToPath(new URL('./stock-writer-lock.json', import.meta.url)), 'utf8'))

const WRITE_METHODS = new Set(['update', 'updateMany', 'upsert', 'create', 'createMany', 'delete', 'deleteMany'])
const RAW_WRITE = /\b(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+"StockLevel"/gi
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.turbo'])
const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/
const NOT_RUNTIME = /(\.test\.|\.spec\.|[\\/]__tests__[\\/]|[\\/]test-support[\\/]|\.d\.ts$)/

function sourceRoots() {
  const roots = []
  for (const group of ['apps', 'packages']) {
    const base = join(ROOT, group)
    if (!existsSync(base)) continue
    for (const name of readdirSync(base)) {
      const src = join(base, name, 'src')
      if (existsSync(src) && statSync(src).isDirectory()) roots.push(src)
    }
  }
  return roots
}

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith('.next')) continue
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) walk(full, out)
    else if (SOURCE.test(name) && !NOT_RUNTIME.test(full)) out.push(full)
  }
  return out
}

/** Write sites and lock calls in one file, from its AST. */
function inspect(file) {
  const text = readFileSync(file, 'utf8')
  const result = { writes: [], lockCalls: 0 }
  // Cheap pre-filter; the AST decides.
  if (!/stockLevel|StockLevel|lockProductStock/.test(text)) return result
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const line = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      if (ts.isPropertyAccessExpression(callee) && WRITE_METHODS.has(callee.name.text)) {
        const owner = callee.expression
        if (ts.isPropertyAccessExpression(owner) && owner.name.text === 'stockLevel') {
          result.writes.push({ line: line(node), kind: `stockLevel.${callee.name.text}` })
        }
      }
      if (ts.isIdentifier(callee) && callee.text === 'lockProductStock') result.lockCalls++
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)
      || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      for (const match of node.text.matchAll(RAW_WRITE)) {
        result.writes.push({ line: line(node), kind: `raw ${match[1].replace(/\s+/g, ' ').toUpperCase()} "StockLevel"` })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return result
}

const roots = sourceRoots()
const files = roots.flatMap((dir) => walk(dir, []))
const found = new Map()
for (const file of files) {
  const r = inspect(file)
  if (r.writes.length > 0 || r.lockCalls > 0) found.set(relative(ROOT, file).split(sep).join('/'), r)
}

const failures = []
if (files.length === 0) failures.push(`scanned ZERO source files under ${ROOT} — the check measured nothing`)

let totalWrites = 0
for (const [path, r] of found) {
  if (r.writes.length === 0) continue
  totalWrites += r.writes.length
  const entry = LIST.files[path]
  const sites = r.writes.map((w) => `${path}:${w.line} ${w.kind}`).join('\n      ')
  if (!entry) {
    failures.push(`${path} writes StockLevel but is not an approved stock writer:\n      ${sites}\n    Route the write through applyStockMovement / the reservation service, or take lockProductStock(tx, [productId]) FIRST in the same transaction and add the file to scripts/stock-writer-lock.json.`)
    continue
  }
  if (r.writes.length !== entry.writes) {
    failures.push(`${path} has ${r.writes.length} StockLevel write site(s); the list approves ${entry.writes}:\n      ${sites}\n    ${r.writes.length > entry.writes ? 'A new write site needs review: show it takes the lock, then update the count.' : 'A write site was removed: lower the count so the list describes the tree.'}`)
  }
  if (entry.lock === true && r.lockCalls === 0) {
    failures.push(`${path} is listed as a LOCKED writer but no longer calls lockProductStock( — every stock write in it must take the lock first.`)
  }
  if (entry.lock === false && !(typeof entry.why === 'string' && entry.why.trim().length > 20)) {
    failures.push(`${path} is listed as writing WITHOUT the lock but gives no reason ("why").`)
  }
}
for (const path of Object.keys(LIST.files)) {
  if (!found.get(path)?.writes.length) failures.push(`${path} is in scripts/stock-writer-lock.json but writes no StockLevel — remove it from the list.`)
}
// Positive control: the approved list is non-empty, so a scanner that finds nothing is broken.
if (Object.keys(LIST.files).length > 0 && totalWrites === 0) failures.push('found ZERO StockLevel write sites although approved writers exist — the scanner is not seeing them')

if (!CHECK || failures.length === 0) {
  console.log(`stock-writer lock: ${files.length} runtime files scanned, ${totalWrites} StockLevel write site(s) in ${[...found.values()].filter((r) => r.writes.length).length} file(s)`)
  for (const [path, r] of found) if (r.writes.length) console.log(`  ${String(r.writes.length).padStart(2)}  ${path}${r.lockCalls ? `  (lockProductStock ×${r.lockCalls})` : ''}`)
}
if (CHECK && failures.length > 0) {
  console.error(`❌ stock-writer lock: ${failures.length} problem(s)`)
  for (const f of failures) console.error(`  • ${f}`)
  process.exit(1)
}
if (CHECK) console.log('✓ stock-writer lock: every StockLevel write is approved and locked')
