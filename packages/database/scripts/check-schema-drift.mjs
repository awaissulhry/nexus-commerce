#!/usr/bin/env node
//
// Schema-migration drift detector.
//
// Parses prisma/schema.prisma for `model X` declarations, scans all
// prisma/migrations/<ts>/migration.sql files for `CREATE TABLE "X"`,
// and exits non-zero if any model lacks a corresponding CREATE TABLE.
//
// Catches the specific class of bug that took down /products on
// 2026-05-02: a Prisma model in the schema with no migration creating
// its Postgres table. TypeScript / `prisma generate` are happy, runtime
// blows up the first time the relation is selected.
//
// Run from the package root (or via `npm run check:drift`):
//   node scripts/check-schema-drift.mjs
//
// Limitations (consciously out of scope):
//   - Column-level drift (model has a field but no migration adds the
//     column). Catching this needs a real shadow DB; that's a heavier
//     check best run in CI with a postgres service container.
//   - @@map("custom_name") — there are zero in the current schema.
//     If we ever introduce one, extend the parser.
//   - Tables created via raw SQL with non-standard quoting. Regex
//     accepts both `CREATE TABLE "Foo"` and `CREATE TABLE Foo` to
//     cover the common cases.

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

// ── Parse schema.prisma for model names ───────────────────────────
let schemaText
try {
  schemaText = readFileSync(schemaPath, 'utf8')
} catch (err) {
  fail(`Could not read ${schemaPath}: ${err.message}`)
}

const modelNames = []
const modelRe = /^model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/gm
let m
while ((m = modelRe.exec(schemaText)) !== null) {
  modelNames.push(m[1])
}
if (modelNames.length === 0) {
  fail('No models found in schema.prisma — is the path correct?')
}

// Honour @@map("alt_name") if it appears inside a model block. We
// don't currently use any, but supporting it now is cheap.
const modelToTable = new Map()
{
  // Split into model blocks and inspect each
  const blockRe = /^model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([\s\S]*?)^\}/gm
  let b
  while ((b = blockRe.exec(schemaText)) !== null) {
    const name = b[1]
    const body = b[2]
    const mapMatch = /@@map\(\s*"([^"]+)"\s*\)/.exec(body)
    modelToTable.set(name, mapMatch ? mapMatch[1] : name)
  }
}

// ── Scan migration SQL for CREATE TABLE table names ──────────────
function listMigrationDirs() {
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
    .map((e) => join(migrationsDir, e, 'migration.sql'))
}

const tableNames = new Set()
const createRe =
  /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/gi
for (const sqlPath of listMigrationDirs()) {
  let sql
  try {
    sql = readFileSync(sqlPath, 'utf8')
  } catch {
    // Migration directory without a migration.sql — skip.
    continue
  }
  let c
  while ((c = createRe.exec(sql)) !== null) {
    tableNames.add(c[1] ?? c[2])
  }
}

// ── Allow-list: known pre-existing drift, with TECH_DEBT references.
// Each entry must explain WHY it's allowed and link to a ticket. The
// gate's job is to prevent NEW drift; pre-existing drift is documented
// and being worked off the list.
//
// To remove an entry: ship the missing migration (or remove the model
// from schema.prisma) and delete the line below.
//
// 2026-05-07 / S.0 — DraftListing entry removed; migration
// `20260507_s0_draft_listing_table` ships the table.
const ALLOW_LIST = new Map([])

// ── Diff: every model must have a CREATE TABLE for its mapped name ──
const missing = []
const allowed = []
for (const name of modelNames) {
  const table = modelToTable.get(name) ?? name
  if (tableNames.has(table)) continue
  if (ALLOW_LIST.has(name)) {
    allowed.push({ model: name, ticket: ALLOW_LIST.get(name) })
    continue
  }
  missing.push({ model: name, table })
}

if (allowed.length > 0) {
  console.warn('')
  console.warn(
    `⚠ Drift allow-list active for ${allowed.length} pre-existing item(s):`,
  )
  for (const { model, ticket } of allowed) {
    console.warn(`  - ${model}  (${ticket})`)
  }
  console.warn('  (See packages/database/scripts/check-schema-drift.mjs)')
  console.warn('')
}

if (missing.length === 0) {
  console.log(
    `✓ Schema drift check passed — all ${modelNames.length} model(s) have a CREATE TABLE in migrations.`,
  )
  process.exit(0)
}

console.error('')
console.error('❌ Schema-migration drift detected')
console.error('')
console.error(
  'The following Prisma model(s) exist in schema.prisma but no migration',
)
console.error('creates their Postgres table. Runtime queries will fail with')
console.error(`"table public.<X> does not exist":`)
console.error('')
for (const { model, table } of missing) {
  const noun = model === table ? '' : ` (maps to "${table}")`
  console.error(`  - model ${model}${noun}`)
}
console.error('')
console.error('To fix:')
console.error('  1. Create a migration:')
console.error('       cd packages/database')
console.error('       npx prisma migrate dev --name add_<name>')
console.error('  2. Or remove the model from schema.prisma if it was')
console.error('     accidentally left behind.')
console.error('')
process.exit(1)
