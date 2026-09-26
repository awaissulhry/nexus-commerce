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
 *   a write method (update, updateMany, updateManyAndReturn, upsert, create, createMany,
 *   createManyAndReturn, delete, deleteMany) called on the delegate however it is reached:
 *   `x.stockLevel.update(`, `x['stockLevel'].update(`, a destructured delegate (renamed or not) or
 *   one kept in a variable; and a string or template literal containing UPDATE / INSERT INTO /
 *   DELETE FROM / MERGE INTO the table, quoted or not, `public.`-qualified or not, ONLY or not.
 * Also counted (re-review, 2026-09-26): a delegate behind a cast or parentheses (`(tx.stockLevel as
 * any).update(`); a NESTED relation write inside any write call's arguments — `stockLevels` /
 * `stockLevel` (a StockLevel write), `reservations` (a StockReservation write), `stockMovements` /
 * `movements` with a literal order reason (an order movement) — under create, createMany, update,
 * updateMany, upsert, delete, deleteMany, connectOrCreate, connect, disconnect or set; order movements
 * written with createMany arrays; and a raw INSERT INTO / MERGE INTO "StockMovement" (any reason: a raw
 * movement bypasses the ledger), or a raw UPDATE of it that names an order reason.
 * KNOWN LIMITS (documented, not chased): a delegate reached through a whole-client cast used as a
 * variable of another name and then indexed (`const c = tx as any; c[name]`), a delegate passed
 * through a function argument, a `reason` held in a variable, a table name concatenated at runtime,
 * and writes in a migration outside a function body (`DO $$ … $$` blocks, plain UPDATE statements):
 * migrations are reviewed on their own and run once, under the expand/contract gate. Also not detected:
 * `applyStockMovement({...} as any)` / `consumeWithFefo({...} as any)` with an order reason — the `as`
 * cast around the argument hides the literal reason.
 * scripts/check-stock-writer-lock.test.mjs holds one probe per pattern (review B3, 2026-09-26).
 *
 * DATABASE FUNCTIONS (shared stock, plan 2026-09-19)
 * The pool doors in packages/database/workspaces/*.sql write StockLevel too, in the lender's ledger
 * for a borrower. They must take the SAME lock, before their first write, or they race the
 * TypeScript writers above (measured: without it, a door deadlocks against the lender's own sales —
 * stock-pool-concurrency.vitest.test.ts, arm 4). Each function that writes StockLevel must be listed
 * under "sqlFunctions" with its exact number of write sites, and its body must contain
 *   PERFORM 1 FROM "Product" WHERE id = … FOR NO KEY UPDATE
 * before its first write. SQL comments (`-- …`) never count.
 *
 * ORDER MOVEMENTS (stock model R2): a movement whose reason is ORDER_PLACED, ORDER_CANCELLED or
 * RESERVATION_CONSUMED (a literal `reason` given to applyStockMovement, applyStockMovementInTx,
 * consumeWithFefo or a stockMovement write) is an order's stock effect: only the files in
 * "orderMovementFiles" (the stock service) may write one.
 *
 * DATABASE FUNCTIONS are read from the policy files AND every migration folder, CREATE FUNCTION with
 * or without OR REPLACE: the last definition of a name is the one judged.
 *
 * ONE OWNER OF ORDER HOLDS (stock model R2, 2026-09-26)
 * A hold is a StockReservation row plus its StockLevel.reserved. Only the stock service may write
 * StockReservation: every hold, consume and release goes through apps/api/src/services/
 * stock-level.service.ts (or a pool door), so no order path can keep a second record of a hold that
 * the others do not update (the Etsy OrderLineHold defect). "reservationFiles" lists the one file
 * and its exact write-site count; "reservationSqlFunctions" the pool doors that write the lender's
 * reservations. Detected like StockLevel writes: <x>.stockReservation.<write>( and raw
 * INSERT INTO / UPDATE / DELETE FROM "StockReservation".
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
const listFlag = args.indexOf('--list')
const LIST = JSON.parse(readFileSync(listFlag >= 0 ? args[listFlag + 1] : fileURLToPath(new URL('./stock-writer-lock.json', import.meta.url)), 'utf8'))

const WRITE_METHODS = new Set(['update', 'updateMany', 'updateManyAndReturn', 'upsert', 'create', 'createMany', 'createManyAndReturn', 'delete', 'deleteMany'])
const DELEGATES = new Set(['stockLevel', 'stockReservation'])
// Quoted or not, schema-qualified or not, ONLY or not (review B3: public."StockReservation" passed).
const tableWrite = (table) => new RegExp(`\\b(UPDATE|INSERT\\s+INTO|DELETE\\s+FROM|MERGE\\s+INTO)\\s+(?:ONLY\\s+)?(?:"?public"?\\s*\\.\\s*)?"?${table}"?(?![A-Za-z0-9_])`, 'gi')
const RAW_WRITE = tableWrite('StockLevel')
const RAW_RESERVATION_WRITE = tableWrite('StockReservation')
const RAW_MOVEMENT_INSERT = /\b(INSERT\s+INTO|MERGE\s+INTO)\s+(?:ONLY\s+)?(?:"?public"?\s*\.\s*)?"?StockMovement"?(?![A-Za-z0-9_])/i
const RAW_MOVEMENT_UPDATE = /\bUPDATE\s+(?:ONLY\s+)?(?:"?public"?\s*\.\s*)?"?StockMovement"?(?![A-Za-z0-9_])/i
const ORDER_REASON_TEXT = /'(ORDER_PLACED|ORDER_CANCELLED|RESERVATION_CONSUMED)'/
// Nested relation writes (re-review 2026-09-26): the relation field → what it writes.
const NESTED_RELATIONS = new Map([['stockLevels', 'level'], ['stockLevel', 'level'], ['reservations', 'reservation'], ['stockMovements', 'movement'], ['movements', 'movement']])
const NESTED_WRITES = new Set(['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany', 'connectOrCreate', 'connect', 'disconnect', 'set'])
// Order movements (R2): a movement with one of these reasons is the order lifecycle's — only the
// stock service may write it. Detected on the movement primitives' calls and on stockMovement writes.
const MOVEMENT_CALLS = new Set(['applyStockMovement', 'applyStockMovementInTx', 'consumeWithFefo'])
const ORDER_REASONS = new Set(['ORDER_PLACED', 'ORDER_CANCELLED', 'RESERVATION_CONSUMED'])
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

/** A string literal's text, through `as const` and parentheses; null for anything computed. */
function literalText(node) {
  while (node && (ts.isAsExpression(node) || ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression?.(node))) node = node.expression
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null
}

/** A literal order reason in an object literal's `reason` (or its `data.reason`, or an array of them), else null. */
function orderReason(arg) {
  if (arg && ts.isArrayLiteralExpression(arg)) return arg.elements.map(orderReason).find(Boolean) ?? null
  if (!arg || !ts.isObjectLiteralExpression(arg)) return null
  for (const prop of arg.properties) {
    if (!ts.isPropertyAssignment(prop)) continue
    const name = prop.name && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) ? prop.name.text : null
    if (name === 'reason') { const text = literalText(prop.initializer); if (text && ORDER_REASONS.has(text)) return text }
    if (name === 'data') { const nested = orderReason(prop.initializer); if (nested) return nested }
  }
  return null
}

/** A literal order reason anywhere inside a node (a nested create of movements). */
function deepOrderReason(node) {
  let found = null
  const look = (n) => {
    if (found) return
    if (ts.isPropertyAssignment(n)) {
      const name = n.name && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) ? n.name.text : null
      const text = name === 'reason' ? literalText(n.initializer) : null
      if (text && ORDER_REASONS.has(text)) { found = text; return }
    }
    ts.forEachChild(n, look)
  }
  look(node)
  return found
}

/** A property's name, for identifiers and string keys. */
const propName = (prop) => prop.name && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) ? prop.name.text : null

/** Nested relation writes inside one write call's arguments: [{ kind, what, reason? }]. */
function nestedWrites(args) {
  const out = []
  const look = (n) => {
    if (ts.isPropertyAssignment(n) && NESTED_RELATIONS.has(propName(n)) && ts.isObjectLiteralExpression(n.initializer)) {
      for (const inner of n.initializer.properties) {
        if (!ts.isPropertyAssignment(inner) || !NESTED_WRITES.has(propName(inner))) continue
        out.push({ what: NESTED_RELATIONS.get(propName(n)), kind: `nested ${propName(n)}.${propName(inner)}`, reason: deepOrderReason(inner.initializer) })
      }
    }
    ts.forEachChild(n, look)
  }
  for (const arg of args) look(arg)
  return out
}

/** Write sites and lock calls in one file, from its AST. */
function inspect(file) {
  const text = readFileSync(file, 'utf8')
  const result = { writes: [], reservationWrites: [], orderMovements: [], lockCalls: 0 }
  // Cheap pre-filter; the AST decides.
  if (!/stockLevel|StockLevel|lockProductStock|stockReservation|StockReservation|ORDER_PLACED|ORDER_CANCELLED|RESERVATION_CONSUMED|StockMovement|reservations|stockMovements/.test(text)) return result
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const line = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
  // A delegate reached another way than `x.stockLevel.update(`: destructured (`const { stockLevel } =
  // tx`, renamed or not) or kept in a variable (`const d = tx.stockReservation` / tx['stockReservation']).
  const aliases = new Map()
  const delegateOf = (expr) => {
    // Through casts and parentheses: `(tx.stockLevel as any)`, `tx.stockLevel!`.
    while (expr && (ts.isAsExpression(expr) || ts.isParenthesizedExpression(expr) || ts.isNonNullExpression(expr) || ts.isSatisfiesExpression?.(expr) || ts.isTypeAssertionExpression?.(expr))) expr = expr.expression
    if (!expr) return null
    if (ts.isPropertyAccessExpression(expr) && DELEGATES.has(expr.name.text)) return expr.name.text
    if (ts.isElementAccessExpression(expr)) { const key = literalText(expr.argumentExpression); if (key && DELEGATES.has(key)) return key }
    if (ts.isIdentifier(expr)) return aliases.get(expr.text) ?? (DELEGATES.has(expr.text) ? expr.text : null)
    return null
  }
  const collect = (node) => {
    if (ts.isVariableDeclaration(node)) {
      if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          const key = element.propertyName ? literalText(element.propertyName) ?? (ts.isIdentifier(element.propertyName) ? element.propertyName.text : null) : (ts.isIdentifier(element.name) ? element.name.text : null)
          if (key && DELEGATES.has(key) && ts.isIdentifier(element.name)) aliases.set(element.name.text, key)
        }
      } else if (ts.isIdentifier(node.name) && node.initializer) {
        const model = delegateOf(node.initializer)
        if (model) aliases.set(node.name.text, model)
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
      const model = delegateOf(node.right)
      if (model) aliases.set(node.left.text, model)
    }
    ts.forEachChild(node, collect)
  }
  collect(source)
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const method = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isElementAccessExpression(callee) ? literalText(callee.argumentExpression) : null
      if (method && WRITE_METHODS.has(method)) {
        const model = delegateOf(callee.expression)
        if (model === 'stockLevel') result.writes.push({ line: line(node), kind: `stockLevel.${method}` })
        if (model === 'stockReservation') result.reservationWrites.push({ line: line(node), kind: `stockReservation.${method}` })
        const owner = callee.expression
        const movementDelegate = (ts.isPropertyAccessExpression(owner) && owner.name.text === 'stockMovement') || (ts.isElementAccessExpression(owner) && literalText(owner.argumentExpression) === 'stockMovement')
        if (movementDelegate) {
          const reason = node.arguments.map(orderReason).find(Boolean)
          if (reason) result.orderMovements.push({ line: line(node), kind: `stockMovement.${method} ${reason}` })
        }
        for (const nested of nestedWrites(node.arguments)) {
          if (nested.what === 'level') result.writes.push({ line: line(node), kind: nested.kind })
          if (nested.what === 'reservation') result.reservationWrites.push({ line: line(node), kind: nested.kind })
          if (nested.what === 'movement' && nested.reason) result.orderMovements.push({ line: line(node), kind: `${nested.kind} ${nested.reason}` })
        }
      }
      const fn = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null
      if (fn && MOVEMENT_CALLS.has(fn)) {
        const reason = node.arguments.map(orderReason).find(Boolean)
        if (reason) result.orderMovements.push({ line: line(node), kind: `${fn} ${reason}` })
      }
      if (ts.isIdentifier(callee) && callee.text === 'lockProductStock') result.lockCalls++
    }
    // A whole raw statement (a string, or a template with its parameters removed): raw movement writes.
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      const sql = ts.isTemplateExpression(node) ? [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' ? ') : node.text
      const insert = sql.match(RAW_MOVEMENT_INSERT)
      if (insert) result.orderMovements.push({ line: line(node), kind: `raw ${insert[1].replace(/\s+/g, ' ').toUpperCase()} "StockMovement"` })
      else if (RAW_MOVEMENT_UPDATE.test(sql) && ORDER_REASON_TEXT.test(sql)) result.orderMovements.push({ line: line(node), kind: `raw UPDATE "StockMovement" ${sql.match(ORDER_REASON_TEXT)[1]}` })
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)
      || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      for (const match of node.text.matchAll(RAW_WRITE)) {
        result.writes.push({ line: line(node), kind: `raw ${match[1].replace(/\s+/g, ' ').toUpperCase()} "StockLevel"` })
      }
      for (const match of node.text.matchAll(RAW_RESERVATION_WRITE)) {
        result.reservationWrites.push({ line: line(node), kind: `raw ${match[1].replace(/\s+/g, ' ').toUpperCase()} "StockReservation"` })
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
  if (r.writes.length > 0 || r.reservationWrites.length > 0 || r.orderMovements.length > 0 || r.lockCalls > 0) found.set(relative(ROOT, file).split(sep).join('/'), r)
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
// ── One owner of StockReservation (R2) ─────────────────────────────────────────────────────────
const RES_LIST = LIST.reservationFiles ?? {}
let totalReservationWrites = 0
for (const [path, r] of found) {
  if (r.reservationWrites.length === 0) continue
  totalReservationWrites += r.reservationWrites.length
  const entry = RES_LIST[path]
  const sites = r.reservationWrites.map((w) => `${path}:${w.line} ${w.kind}`).join('\n      ')
  if (!entry) {
    failures.push(`${path} writes StockReservation, but only the stock service may (one owner of order holds, R2):\n      ${sites}\n    Hold, consume or release through apps/api/src/services/stock-level.service.ts instead.`)
    continue
  }
  if (r.reservationWrites.length !== entry.writes) failures.push(`${path} has ${r.reservationWrites.length} StockReservation write site(s); the list approves ${entry.writes}:\n      ${sites}`)
}
for (const path of Object.keys(RES_LIST)) {
  if (!found.get(path)?.reservationWrites.length) failures.push(`${path} is in "reservationFiles" but writes no StockReservation — remove it from the list.`)
}
if (Object.keys(RES_LIST).length > 0 && totalReservationWrites === 0) failures.push('found ZERO StockReservation write sites although an approved writer exists — the scanner is not seeing them')

// ── Order movements belong to the stock service (R2) ───────────────────────────────────────────
const MOVE_LIST = LIST.orderMovementFiles ?? {}
let totalOrderMovements = 0
for (const [path, r] of found) {
  if (r.orderMovements.length === 0) continue
  totalOrderMovements += r.orderMovements.length
  const entry = MOVE_LIST[path]
  const sites = r.orderMovements.map((w) => `${path}:${w.line} ${w.kind}`).join('\n      ')
  if (!entry) {
    failures.push(`${path} writes an order stock movement (ORDER_PLACED / ORDER_CANCELLED / RESERVATION_CONSUMED), but only the stock service may (R2):\n      ${sites}\n    Take, give back or consume through apps/api/src/services/stock-level.service.ts instead.`)
    continue
  }
  if (r.orderMovements.length !== entry.writes) failures.push(`${path} has ${r.orderMovements.length} order movement site(s); the list approves ${entry.writes}:\n      ${sites}`)
}
for (const path of Object.keys(MOVE_LIST)) {
  if (!found.get(path)?.orderMovements.length) failures.push(`${path} is in "orderMovementFiles" but writes no order movement — remove it from the list.`)
}
if (Object.keys(MOVE_LIST).length > 0 && totalOrderMovements === 0) failures.push('found ZERO order movement sites although an approved writer exists — the scanner is not seeing them')

// ── Database functions that write StockLevel (the pool doors) ─────────────────────────────────
const SQL_DIR = join(ROOT, 'packages', 'database', 'workspaces')
const MIGRATIONS_DIR = join(ROOT, 'packages', 'database', 'prisma', 'migrations')
const SQL_LIST = LIST.sqlFunctions ?? {}
const LOCK_LINE = /PERFORM\s+1\s+FROM\s+(?:"?public"?\s*\.\s*)?"Product"\s+WHERE\s+id\s*=\s*[^;]+?FOR\s+NO\s+KEY\s+UPDATE/i
// Every function definition, with or without OR REPLACE, schema-qualified or not (review B3). The
// policy files first, then each migration folder in the order PostgreSQL applies them: the LAST
// definition of a name is the one that runs, so it is the one judged (a migration can define a
// function no policy file carries — review B3: those were never scanned).
const sqlSources = []
if (existsSync(SQL_DIR)) for (const name of readdirSync(SQL_DIR).filter((n) => n.endsWith('.sql')).sort()) sqlSources.push({ file: `packages/database/workspaces/${name}`, path: join(SQL_DIR, name) })
if (existsSync(MIGRATIONS_DIR)) {
  for (const folder of readdirSync(MIGRATIONS_DIR).sort()) {
    const path = join(MIGRATIONS_DIR, folder, 'migration.sql')
    if (existsSync(path)) sqlSources.push({ file: `packages/database/prisma/migrations/${folder}/migration.sql`, path })
  }
}
const sqlFound = new Map()
const sqlReservationFound = new Map()
for (const { file, path } of sqlSources) {
  // Comments never count: strip `-- …` to the end of each line first.
  const text = readFileSync(path, 'utf8').replace(/--[^\n]*/g, '')
  for (const block of text.split(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+/i).slice(1)) {
    const fn = /^(?:"?public"?\s*\.\s*)?"?([A-Za-z_][A-Za-z0-9_]*)/.exec(block)?.[1]
    if (!fn) continue
    const reservationWrites = [...block.matchAll(RAW_RESERVATION_WRITE)].length
    if (reservationWrites > 0) sqlReservationFound.set(fn, { file, writes: reservationWrites })
    else if (!file.startsWith('packages/database/workspaces/') && sqlReservationFound.get(fn)?.file.startsWith('packages/database/prisma/')) sqlReservationFound.delete(fn)
    const writes = [...block.matchAll(RAW_WRITE)]
    if (writes.length === 0) {
      // A later definition that writes nothing replaces an earlier writer.
      if (sqlFound.get(fn) && !file.startsWith('packages/database/workspaces/')) sqlFound.delete(fn)
      continue
    }
    const lock = LOCK_LINE.exec(block)
    sqlFound.set(fn, { file, writes: writes.length, lockedFirst: !!lock && lock.index < writes[0].index })
  }
}
for (const [fn, r] of sqlFound) {
  totalWrites += r.writes
  const entry = SQL_LIST[fn]
  if (!entry) {
    failures.push(`${r.file}: function ${fn}() writes StockLevel but is not an approved stock writer. Take the product lock first (PERFORM 1 FROM "Product" WHERE id = … FOR NO KEY UPDATE) and add it to "sqlFunctions" in scripts/stock-writer-lock.json.`)
    continue
  }
  if (r.writes !== entry.writes) failures.push(`${r.file}: function ${fn}() has ${r.writes} StockLevel write site(s); the list approves ${entry.writes}.`)
  if (!r.lockedFirst) failures.push(`${r.file}: function ${fn}() writes StockLevel without first taking the product lock (PERFORM 1 FROM "Product" WHERE id = … FOR NO KEY UPDATE before its first write).`)
}
for (const fn of Object.keys(SQL_LIST)) {
  if (!sqlFound.has(fn)) failures.push(`${fn}() is in "sqlFunctions" of scripts/stock-writer-lock.json but no function of that name writes StockLevel — remove it from the list.`)
}
if (Object.keys(SQL_LIST).length > 0 && sqlFound.size === 0) failures.push(`found ZERO StockLevel-writing database functions under ${SQL_DIR} although approved ones exist — the scanner is not seeing them`)
const RES_SQL_LIST = LIST.reservationSqlFunctions ?? {}
for (const [fn, r] of sqlReservationFound) {
  const entry = RES_SQL_LIST[fn]
  if (!entry) { failures.push(`${r.file}: function ${fn}() writes StockReservation but is not an approved pool door ("reservationSqlFunctions" in scripts/stock-writer-lock.json).`); continue }
  if (r.writes !== entry.writes) failures.push(`${r.file}: function ${fn}() has ${r.writes} StockReservation write site(s); the list approves ${entry.writes}.`)
}
for (const fn of Object.keys(RES_SQL_LIST)) {
  if (!sqlReservationFound.has(fn)) failures.push(`${fn}() is in "reservationSqlFunctions" but no function of that name writes StockReservation — remove it from the list.`)
}

// Positive control: the approved list is non-empty, so a scanner that finds nothing is broken.
if (Object.keys(LIST.files).length > 0 && totalWrites === 0) failures.push('found ZERO StockLevel write sites although approved writers exist — the scanner is not seeing them')

if (!CHECK || failures.length === 0) {
  console.log(`stock-writer lock: ${files.length} runtime files scanned, ${totalWrites} StockLevel write site(s) in ${[...found.values()].filter((r) => r.writes.length).length} file(s)`)
  for (const [path, r] of found) if (r.writes.length) console.log(`  ${String(r.writes.length).padStart(2)}  ${path}${r.lockCalls ? `  (lockProductStock ×${r.lockCalls})` : ''}`)
  for (const [fn, r] of sqlFound) console.log(`  ${String(r.writes).padStart(2)}  ${r.file} ${fn}()${r.lockedFirst ? '  (product lock first)' : '  (NO LOCK FIRST)'}`)
  console.log(`stock-reservation owner: ${totalReservationWrites} StockReservation write site(s)`)
  for (const [path, r] of found) if (r.reservationWrites.length) console.log(`  ${String(r.reservationWrites.length).padStart(2)}  ${path}`)
  for (const [fn, r] of sqlReservationFound) console.log(`  ${String(r.writes).padStart(2)}  ${r.file} ${fn}()`)
}
if (CHECK && failures.length > 0) {
  console.error(`❌ stock-writer lock: ${failures.length} problem(s)`)
  for (const f of failures) console.error(`  • ${f}`)
  process.exit(1)
}
if (CHECK) console.log('✓ stock-writer lock: every StockLevel write is approved and locked; StockReservation is written only by the stock service and the pool doors')
