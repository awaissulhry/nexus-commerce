#!/usr/bin/env node
//
// Column-level schema-migration drift detector (TECH_DEBT #0 / #37).
//
// Sibling to check-schema-drift.mjs (which catches table-level drift —
// model in schema with no CREATE TABLE). This script catches the
// next class of drift up: a model whose *columns* don't match what
// migrations create. That bug took down Railway production for ~30
// minutes on 2026-05-05 (Return table redefined with 22 cols against
// an existing 8-col table; CREATE TABLE IF NOT EXISTS silently
// no-op'd, then CREATE INDEX on a non-existent column failed with
// 42703 and blocked all subsequent deploys with P3009).
//
// Approach (no shadow DB needed — works in pre-push hook unchanged):
//   1. Parse schema.prisma → for each model, list scalar/enum
//      columns. Skip relation fields. Honour @map("custom_name").
//   2. Walk every migration.sql in chronological order. Parse
//      CREATE TABLE column lists, ALTER TABLE ADD/DROP/RENAME
//      COLUMN, and DROP TABLE. Build a final per-table column set.
//   3. For each model, every schema column must be present in the
//      computed migration column set. Surface anything missing.
//
// Limitations (consciously out of scope):
//   - Does NOT compare types (TEXT vs VARCHAR, Int vs SMALLINT) —
//     those are usually semantic-equivalent and Prisma is lenient.
//   - Does NOT compare DEFAULT values, NOT NULL, indexes, or
//     constraints. Catching those requires `prisma migrate diff`
//     against a real shadow DB, which is the heavyweight version.
//   - Conditional SQL (DO $$ ... END $$ blocks, plpgsql) parses
//     opaquely. Anything column-mutating inside them won't update
//     the running set; allow-list those tables manually.
//
// Run from the package root or via `npm run check:column-drift`.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, '..')
const schemaPath = join(pkgRoot, 'prisma', 'schema.prisma')
const migrationsDir = join(pkgRoot, 'prisma', 'migrations')

function fail(msg) {
  console.error(`\n❌ ${msg}\n`)
  process.exit(1)
}

// ── Parse schema.prisma ──────────────────────────────────────────────
let schemaText
try {
  schemaText = readFileSync(schemaPath, 'utf8')
} catch (err) {
  fail(`Could not read ${schemaPath}: ${err.message}`)
}

// Collect every model name first so we can recognise relation field
// types when iterating fields.
const modelNames = new Set()
{
  const re = /^model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/gm
  let m
  while ((m = re.exec(schemaText)) !== null) {
    modelNames.add(m[1])
  }
}
const enumNames = new Set()
{
  const re = /^enum\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/gm
  let m
  while ((m = re.exec(schemaText)) !== null) {
    enumNames.add(m[1])
  }
}

/**
 * Returns Map<modelName, { table: string, columns: Set<columnName> }>.
 * Each column in the returned set is the actual DB column name, post
 * @map() resolution.
 */
function parseSchemaModels() {
  const out = new Map()
  const blockRe = /^model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([\s\S]*?)^\}/gm
  let b
  while ((b = blockRe.exec(schemaText)) !== null) {
    const modelName = b[1]
    const body = b[2]
    const tableMap = /@@map\(\s*"([^"]+)"\s*\)/.exec(body)
    const tableName = tableMap ? tableMap[1] : modelName

    const columns = new Set()
    const lines = body.split('\n')
    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (!line || line.startsWith('//') || line.startsWith('@@')) continue

      // Field shape: name Type[?|[]] [@attrs]
      // Stop the type group at the first whitespace; modifiers ?, []
      // attach to type sans-space.
      const fieldRe = /^([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)(\??|\[\])\s*(.*)$/
      const m = fieldRe.exec(line)
      if (!m) continue
      const [, fieldName, fieldType, modifier, rest] = m

      // Relation field — has @relation(...) — does NOT own a column.
      // (The FK columns are listed separately in the model body.)
      if (/@relation\b/.test(rest)) continue

      // Field type is another model → relation list (`Foo[]`) or a
      // back-ref (`Foo`). Either way no column on this side.
      if (modelNames.has(fieldType)) continue

      // Field type is an enum → it IS a column.
      // Field type is a scalar (String, Int, Decimal, DateTime,
      // Boolean, BigInt, Float, Bytes, Json) → column.
      // We don't strictly check the type; if it's not a model,
      // assume it's a column-bearing field.

      const mapMatch = /@map\(\s*"([^"]+)"\s*\)/.exec(rest)
      const columnName = mapMatch ? mapMatch[1] : fieldName
      columns.add(columnName)
    }
    out.set(modelName, { table: tableName, columns })
  }
  return out
}

const schemaByModel = parseSchemaModels()

// ── Parse migrations chronologically ─────────────────────────────────
function listMigrationFiles() {
  let entries
  try {
    entries = readdirSync(migrationsDir)
  } catch (err) {
    fail(`Could not read ${migrationsDir}: ${err.message}`)
  }
  return entries
    .filter((e) => {
      const full = join(migrationsDir, e)
      try {
        return statSync(full).isDirectory()
      } catch {
        return false
      }
    })
    .sort() // dir names are timestamped → lexicographic = chronological
    .map((e) => ({ dir: e, path: join(migrationsDir, e, 'migration.sql') }))
}

/** Strip line comments + simple block-comment markers + DO $$ blocks
 *  so they don't fool the regex-based parsers below. DO blocks
 *  (plpgsql) commonly wrap ALTER TABLE constraint maintenance that
 *  isn't column-mutating; stripping them avoids the outer ALTER TABLE
 *  parser swallowing past statements while looking for a `;`. */
function stripComments(sql) {
  return sql
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/DO\s+\$\$[\s\S]*?\$\$\s*;?/gi, '')
}

/** Extract the column list inside a CREATE TABLE statement.
 *  The body is everything between the opening "(" of the column list
 *  and its matching ")". Constraint lines (PRIMARY KEY, FOREIGN KEY,
 *  UNIQUE, CONSTRAINT, CHECK) are skipped. */
function parseCreateTableColumns(body) {
  const cols = new Set()
  // Split by top-level commas. Naive but works for the column-list
  // shape Prisma migrations emit.
  let depth = 0
  let buf = ''
  const parts = []
  for (const ch of body) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      parts.push(buf.trim())
      buf = ''
      continue
    }
    buf += ch
  }
  if (buf.trim()) parts.push(buf.trim())

  for (const raw of parts) {
    if (!raw) continue
    const upper = raw.toUpperCase()
    if (
      upper.startsWith('CONSTRAINT') ||
      upper.startsWith('PRIMARY KEY') ||
      upper.startsWith('FOREIGN KEY') ||
      upper.startsWith('UNIQUE ') ||
      upper.startsWith('UNIQUE(') ||
      upper.startsWith('CHECK')
    ) {
      continue
    }
    // First token is the column name, possibly quoted.
    const colMatch = /^(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/.exec(raw)
    if (!colMatch) continue
    cols.add(colMatch[1] ?? colMatch[2])
  }
  return cols
}

/**
 * Apply one migration SQL file to the running per-table column map.
 * Mutates `tables` in place. Statements are applied in file order so
 * a DROP + CREATE pair (Prisma's "redesign this table" pattern) ends
 * up with the post-CREATE column set rather than the pre-DROP one.
 */
function applyMigration(sql, tables) {
  // Collect every column-mutating statement with its file offset, then
  // sort by offset and apply in order. Cheaper than tokenising the SQL
  // properly and good enough for Prisma's emitted shapes.
  const events = []

  // CREATE TABLE
  {
    const ctRe =
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\s*\(/gi
    let m
    while ((m = ctRe.exec(sql)) !== null) {
      const tableName = m[1] ?? m[2]
      const start = m.index + m[0].length
      let depth = 1
      let i = start
      while (i < sql.length && depth > 0) {
        const ch = sql[i]
        if (ch === '(') depth++
        else if (ch === ')') depth--
        i++
      }
      const body = sql.substring(start, i - 1)
      events.push({
        offset: m.index,
        kind: 'create',
        table: tableName,
        cols: parseCreateTableColumns(body),
      })
    }
  }

  // DROP TABLE
  {
    const dropTableRe =
      /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/gi
    let m
    while ((m = dropTableRe.exec(sql)) !== null) {
      events.push({
        offset: m.index,
        kind: 'drop',
        table: m[1] ?? m[2],
      })
    }
  }

  // Apply all non-ALTER events in file order first. The ALTER block
  // below already does its own per-clause processing and runs after.
  events.sort((a, b) => a.offset - b.offset)
  for (const ev of events) {
    if (ev.kind === 'create') {
      const existing = tables.get(ev.table) ?? new Set()
      for (const c of ev.cols) existing.add(c)
      tables.set(ev.table, existing)
    } else if (ev.kind === 'drop') {
      tables.delete(ev.table)
    }
  }

  // ALTER TABLE ... — Prisma emits multi-clause statements like:
  //   ALTER TABLE "Foo"
  //   ADD COLUMN "a" TEXT,
  //   ADD COLUMN "b" INT,
  //   DROP COLUMN "c";
  // Find each ALTER TABLE...; block, then walk every clause inside.
  const alterRe =
    /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\s+([\s\S]*?);/gi
  let am
  while ((am = alterRe.exec(sql)) !== null) {
    const table = am[1] ?? am[2]
    const body = am[3]
    let s = tables.get(table)
    if (!s) {
      s = new Set()
      tables.set(table, s)
    }
    // Split on top-level commas so each "ADD COLUMN ..." or
    // "DROP COLUMN ..." or "RENAME COLUMN ... TO ..." clause is one
    // unit. Naive split is fine here because Prisma migrations don't
    // emit nested expressions in ALTER bodies.
    const clauses = []
    {
      let depth = 0
      let buf = ''
      for (const ch of body) {
        if (ch === '(') depth++
        else if (ch === ')') depth--
        if (ch === ',' && depth === 0) {
          clauses.push(buf.trim())
          buf = ''
          continue
        }
        buf += ch
      }
      if (buf.trim()) clauses.push(buf.trim())
    }
    for (const clause of clauses) {
      const upper = clause.toUpperCase()
      if (upper.startsWith('ADD COLUMN')) {
        const cm = /ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/i.exec(
          clause,
        )
        if (cm) s.add(cm[1] ?? cm[2])
      } else if (upper.startsWith('DROP COLUMN')) {
        const cm = /DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/i.exec(
          clause,
        )
        if (cm) s.delete(cm[1] ?? cm[2])
      } else if (upper.startsWith('RENAME COLUMN')) {
        const cm =
          /RENAME\s+COLUMN\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\s+TO\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/i.exec(
            clause,
          )
        if (cm) {
          const oldCol = cm[1] ?? cm[2]
          const newCol = cm[3] ?? cm[4]
          if (s.has(oldCol)) {
            s.delete(oldCol)
            s.add(newCol)
          }
        }
      }
      // Other clauses (ADD CONSTRAINT, ALTER COLUMN, ADD CONSTRAINT,
      // ENABLE TRIGGER, etc.) don't affect the column set we track.
    }
  }
}

const tableColumns = new Map()
for (const { path: sqlPath } of listMigrationFiles()) {
  let sql
  try {
    sql = readFileSync(sqlPath, 'utf8')
  } catch {
    continue
  }
  applyMigration(stripComments(sql), tableColumns)
}

// ── Allow-list: known column-level drift, with TECH_DEBT references ─
// Same shape as check-schema-drift.mjs's allow list. Each entry must
// link to a ticket explaining why the drift is tolerated. Use sparingly
// — the gate's whole job is to prevent this.
//
// Format: [modelName, [columnName, ticket][]]
const COLUMN_ALLOW_LIST = new Map([
  // Pre-existing drift discovered when this gate was first wired up.
  // SyncLog has two fields in schema.prisma that no migration creates;
  // either ship a backfill migration or drop the fields. Logged in
  // TECH_DEBT — same class as #37.
  [
    'SyncLog',
    [
      ['itemsSuccessful', 'TECH_DEBT — pre-existing column drift'],
      ['details', 'TECH_DEBT — pre-existing column drift'],
    ],
  ],
])

// ── Diff ────────────────────────────────────────────────────────────
const drifts = []
const allowed = []
for (const [modelName, info] of schemaByModel) {
  const dbCols = tableColumns.get(info.table)
  if (!dbCols) {
    // Table-level miss; the sibling script reports this. Skip here.
    continue
  }
  const allowEntries = COLUMN_ALLOW_LIST.get(modelName) ?? []
  const allowMap = new Map(allowEntries)
  for (const col of info.columns) {
    if (dbCols.has(col)) continue
    if (allowMap.has(col)) {
      allowed.push({ model: modelName, column: col, ticket: allowMap.get(col) })
      continue
    }
    drifts.push({ model: modelName, table: info.table, column: col })
  }
}

if (allowed.length > 0) {
  console.warn('')
  console.warn(
    `⚠ Column-drift allow-list active for ${allowed.length} item(s):`,
  )
  for (const { model, column, ticket } of allowed) {
    console.warn(`  - ${model}.${column}  (${ticket})`)
  }
  console.warn('')
}

if (drifts.length === 0) {
  const tablesChecked = Array.from(schemaByModel.values()).filter((v) =>
    tableColumns.has(v.table),
  ).length
  console.log(
    `✓ Column drift check passed — ${tablesChecked} table(s) match their schema columns.`,
  )
  process.exit(0)
}

console.error('')
console.error('❌ Column-level schema/migration drift detected')
console.error('')
console.error(
  'The following Prisma model fields exist in schema.prisma but no',
)
console.error(
  'migration creates the matching Postgres column. Production deploys',
)
console.error('will fail when Prisma tries to query the column.')
console.error('')
const byModel = new Map()
for (const d of drifts) {
  const arr = byModel.get(d.model) ?? []
  arr.push(d)
  byModel.set(d.model, arr)
}
for (const [model, rows] of byModel) {
  console.error(`  model ${model} (table "${rows[0].table}"):`)
  for (const r of rows) {
    console.error(`    - missing column "${r.column}"`)
  }
}
console.error('')
console.error('To fix:')
console.error(
  '  1. Generate a migration that ALTER TABLEs the missing columns:',
)
console.error('       cd packages/database')
console.error('       npx prisma migrate dev --name add_<column_set>')
console.error(
  '  2. Or remove the field from schema.prisma if it was added in error.',
)
console.error('')
console.error(
  '  If the drift is intentional and being phased out, add the column',
)
console.error('  to COLUMN_ALLOW_LIST in this script with a TECH_DEBT ref.')
console.error('')
process.exit(1)
