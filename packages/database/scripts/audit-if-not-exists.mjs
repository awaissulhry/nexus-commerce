#!/usr/bin/env node
// P1 #38 — defense-in-depth audit of `CREATE TABLE IF NOT EXISTS` and
// `CREATE INDEX IF NOT EXISTS` patterns across the migration tree.
//
// IF NOT EXISTS is silent on collision: when a model is later
// redefined with new columns but the table already exists with the
// old shape, the CREATE no-ops and any subsequent reference to the
// new columns crashes far from the actual bug. That's the failure
// mode that hid the Return-table collision through the entire
// fulfillment B.1 review cycle.
//
// This script classifies every occurrence into:
//
//   • LEGITIMATE — preceded by a matching DROP within the same
//     migration, OR wrapped in a `DO $$ ... $$;` block (which is
//     usually defensive-init code that needs idempotency by design),
//     OR in an explicitly-named "catchup_..." migration.
//
//   • BARE — no preceding DROP, no DO wrapper, regular migration.
//     These are the riskiest: a re-run after schema changes could
//     silently no-op, leaving the production schema out of date.
//
// The output is a per-migration breakdown with line numbers. Run
// from repo root:  node packages/database/scripts/audit-if-not-exists.mjs
//
// Returns non-zero exit code only if invoked with `--strict` AND
// any NEW bare occurrence is introduced (compared to the snapshot
// in this script's BASELINE_BARE_COUNT). Default mode is read-only.

import path from 'path'
import { readdirSync, readFileSync, statSync } from 'fs'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const migrationsDir = path.join(here, '..', 'prisma', 'migrations')

// Snapshot of the "bare" count at the time the audit landed. Future
// commits that introduce new bare occurrences will trip the strict
// check (when --strict is set). Baseline matches the count this
// script produced on 2026-05-08 against the migration tree at HEAD.
const BASELINE_BARE_COUNT = 221

// Regex catches both CREATE TABLE and CREATE INDEX with IF NOT EXISTS,
// case-insensitive. Captures the kind (TABLE/INDEX) and the rest of
// the line for the report.
const ifNotExistsRe =
  /CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\s+([^\s;]+)/gi

const dropRe = /DROP\s+(?:TABLE|INDEX)\s+(?:IF\s+EXISTS\s+)?([^\s;]+)/gi

function listMigrations() {
  return readdirSync(migrationsDir)
    .filter((entry) => {
      try {
        return statSync(path.join(migrationsDir, entry)).isDirectory()
      } catch {
        return false
      }
    })
    .sort()
    .map((dir) => ({
      dir,
      sqlPath: path.join(migrationsDir, dir, 'migration.sql'),
    }))
}

function classifyOccurrence(sql, occurrenceIndex, migrationDir) {
  // Legitimate-by-name: catchup migrations are explicitly idempotent.
  if (
    migrationDir.includes('catchup') ||
    migrationDir.includes('backfill_fix')
  ) {
    return { class: 'LEGITIMATE', reason: 'catchup/backfill migration — idempotent by design' }
  }

  // Legitimate-by-DO: occurrence inside a DO $$ ... $$ block.
  // Walk back from occurrenceIndex to see if we're inside one.
  const before = sql.slice(0, occurrenceIndex)
  const lastDoOpen = before.lastIndexOf('DO $$')
  if (lastDoOpen >= 0) {
    const closeAfterOpen = sql.indexOf('$$;', lastDoOpen)
    if (closeAfterOpen > occurrenceIndex) {
      return { class: 'LEGITIMATE', reason: 'inside DO $$ ... $$ block' }
    }
  }

  // Legitimate-by-DROP: a matching DROP within ~500 chars before the
  // CREATE for the same table/index name.
  const ifNotExistsRe2 =
    /CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\s+([^\s;]+)/gi
  ifNotExistsRe2.lastIndex = occurrenceIndex
  const m = ifNotExistsRe2.exec(sql)
  if (m) {
    const targetName = m[2]
    const window = sql.slice(Math.max(0, occurrenceIndex - 500), occurrenceIndex)
    const dropMatches = window.matchAll(dropRe)
    for (const dropMatch of dropMatches) {
      if (dropMatch[1] === targetName) {
        return { class: 'LEGITIMATE', reason: `preceded by DROP of ${targetName}` }
      }
    }
  }

  return { class: 'BARE', reason: 'no DROP, no DO wrapper, no catchup naming' }
}

const migrations = listMigrations()
let totalLegitimate = 0
let totalBare = 0
const bareDetails = []

for (const m of migrations) {
  let sql
  try {
    sql = readFileSync(m.sqlPath, 'utf8')
  } catch {
    continue
  }
  const matches = Array.from(sql.matchAll(ifNotExistsRe))
  for (const match of matches) {
    const idx = match.index ?? 0
    const lineNumber = sql.slice(0, idx).split('\n').length
    const result = classifyOccurrence(sql, idx, m.dir)
    if (result.class === 'BARE') {
      totalBare++
      bareDetails.push({
        migration: m.dir,
        line: lineNumber,
        kind: match[1],
        target: match[2],
        reason: result.reason,
      })
    } else {
      totalLegitimate++
    }
  }
}

console.log(`\n=== IF NOT EXISTS audit ===`)
console.log(`Migrations scanned:  ${migrations.length}`)
console.log(`Total occurrences:   ${totalLegitimate + totalBare}`)
console.log(`  LEGITIMATE:        ${totalLegitimate}  (catchup naming, DO blocks, or preceded by DROP)`)
console.log(`  BARE:              ${totalBare}  (no preceding context — silent on collision)`)
console.log(`  Baseline bare:     ${BASELINE_BARE_COUNT}  (snapshot at audit landing)`)

if (totalBare > 0) {
  console.log(`\nBare occurrences (review when redefining the target):`)
  // Group by migration for readability — most operators care about
  // "which migration has the most" not the per-line list.
  const byMigration = new Map()
  for (const b of bareDetails) {
    const arr = byMigration.get(b.migration) ?? []
    arr.push(b)
    byMigration.set(b.migration, arr)
  }
  const sorted = Array.from(byMigration.entries()).sort(
    (a, b) => b[1].length - a[1].length,
  )
  for (const [migration, items] of sorted.slice(0, 15)) {
    console.log(`  ${migration}  (${items.length})`)
  }
  if (sorted.length > 15) {
    console.log(`  … and ${sorted.length - 15} more migrations.`)
  }
}

const strict = process.argv.includes('--strict')
if (strict) {
  if (totalBare > BASELINE_BARE_COUNT) {
    const delta = totalBare - BASELINE_BARE_COUNT
    console.error(
      `\n❌ Bare IF NOT EXISTS count grew by ${delta} since baseline (was ${BASELINE_BARE_COUNT}, now ${totalBare}).`,
    )
    console.error(
      `   New CREATE TABLE/INDEX IF NOT EXISTS without DROP/DO wrapping needs review.`,
    )
    console.error(
      `   If the new occurrence is intentional (catchup migration, idempotent rerun), name the migration directory with "catchup" or "backfill_fix" to opt in.`,
    )
    process.exit(1)
  } else {
    console.log(`\n✓ Bare count within baseline (${totalBare} ≤ ${BASELINE_BARE_COUNT}).`)
  }
}
