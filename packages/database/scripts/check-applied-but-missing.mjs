#!/usr/bin/env node
/**
 * Applied-but-missing migration gate.
 *
 * REFUSES a deploy when the target database records a migration that has NO folder in
 * `prisma/migrations/`. That is the direction no other check in this repo covers.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT `check-schema-drift.mjs`
 * ----------------------------------------------------------
 * `check-schema-drift.mjs` parses `schema.prisma` and scans migration `.sql` FILES. Both of its
 * inputs are in the repo, so a migration applied to production with no folder here is invisible
 * to it *by construction* — not a bug in it, and not fixable by extending it.
 * `scripts/check-migrations-state.mjs` does open the database, but computes only the opposite
 * set (`pending` = in repo, not applied) and sits in no hook.
 * Nothing in this repo runs `prisma migrate status`, and `prisma migrate deploy` applies pending
 * migrations while saying nothing about extra ones.
 *
 * So until this file existed, "somebody applied SQL to production by hand and it is in no
 * migration folder" was detected by nobody, at no point in the pipeline.
 *
 * WHY IT RUNS AT DEPLOY AND NOT IN THE PUSH HOOK
 * ---------------------------------------------
 * Detecting this requires querying the target database. A pre-push hook would therefore need a
 * production DATABASE_URL on every developer's machine — and removing exactly that variable from
 * the repo root is the point of the credential step in docs/product-cheat/PLAN.md (Step 0.3).
 * A gate in the hook would be broken by that step. Here the credential is already legitimately
 * present, and the check fires in the same breath as the migration it guards.
 *
 * REFUSAL SEMANTICS
 * -----------------
 *   drift       → exit 1. Named migrations are on the database and in no folder.
 *   no-history  → exit 0. No `_prisma_migrations` table yet: a first-ever deploy. Nothing applied,
 *                 so nothing can be missing. This is a measured zero, not an assumed one.
 *   unreachable → exit 1, reported as "COULD NOT CHECK", never as "no drift". An unwitnessed zero
 *                 neither passes nor convicts. `migrate deploy` runs next and would fail on the
 *                 same connection anyway, so this adds no new outage mode.
 *
 * Rolled-back rows are excluded: a migration that rolled back was not applied. Both of the two
 * rolled-back rows on production today have a successful sibling row, and this rule resolves
 * both correctly.
 *
 * Run standalone:  node packages/database/scripts/check-applied-but-missing.mjs
 */
import { readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const here = dirname(fileURLToPath(import.meta.url))
const defaultMigrationsDir = join(here, '..', 'prisma', 'migrations')

/**
 * The decision, as a pure function, so every branch can be exercised without a database.
 *
 * @param {{migration_name: string, finished_at: Date|null, rolled_back_at: Date|null}[]} rows
 * @param {string[]} localFolders
 */
export function classifyMigrations(rows, localFolders) {
  const local = new Set(localFolders)
  const live = rows.filter((r) => r.rolled_back_at == null)

  const appliedButMissing = [...new Set(live.filter((r) => !local.has(r.migration_name)).map((r) => r.migration_name))].sort()
  const inProgress = [...new Set(live.filter((r) => r.finished_at == null).map((r) => r.migration_name))].sort()
  const appliedNames = new Set(live.map((r) => r.migration_name))
  const pending = localFolders.filter((f) => !appliedNames.has(f)).sort()

  return {
    status: appliedButMissing.length > 0 ? 'drift' : 'ok',
    appliedButMissing,
    inProgress,
    pending,
    counts: { rows: rows.length, localFolders: localFolders.length, rolledBack: rows.length - live.length },
  }
}

export function readMigrationFolders(migrationsDir = defaultMigrationsDir) {
  return readdirSync(migrationsDir)
    .filter((entry) => {
      try {
        return statSync(join(migrationsDir, entry)).isDirectory()
      } catch {
        return false
      }
    })
    .sort()
}

/**
 * @param {{connectionString: string, migrationsDir?: string, schema?: string}} opts
 */
export async function checkAppliedButMissing({ connectionString, migrationsDir, schema }) {
  const localFolders = readMigrationFolders(migrationsDir)
  let client
  try {
    client = new pg.Client({ connectionString, connectionTimeoutMillis: 10_000, query_timeout: 30_000 })
    await client.connect()
  } catch {
    await client?.end().catch(() => {})
    return { status: 'unreachable', error: 'Database connection failed', appliedButMissing: [], inProgress: [], pending: [], counts: null }
  }

  try {
    // Test-only knob. Validated, not escaped: a schema name is an identifier, and an identifier
    // that is not [A-Za-z0-9_] has no business being interpolated into SQL at all.
    if (schema !== undefined && !/^[A-Za-z0-9_]+$/.test(schema)) {
      throw new Error(`refusing an unsafe schema name: ${schema}`)
    }

    const exists = await client.query(
      `SELECT to_regclass($1) IS NOT NULL AS present`,
      [schema ? `${schema}._prisma_migrations` : '_prisma_migrations'],
    )
    if (!exists.rows[0].present) {
      return { status: 'no-history', appliedButMissing: [], inProgress: [], pending: localFolders, counts: { rows: 0, localFolders: localFolders.length, rolledBack: 0 } }
    }

    const res = await client.query(
      `SELECT migration_name, finished_at, rolled_back_at FROM ${schema ? `"${schema}".` : ''}"_prisma_migrations"`,
    )
    return classifyMigrations(res.rows, localFolders)
  } catch {
    return { status: 'unreachable', error: 'Migration history query failed', appliedButMissing: [], inProgress: [], pending: [], counts: null }
  } finally {
    await client.end().catch(() => {})
  }
}

// ── CLI ───────────────────────────────────────────────────────────
const isDirect = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isDirect) {
  const raw = process.env.DATABASE_URL ?? ''
  if (!raw) {
    console.error('[applied-but-missing] DATABASE_URL is not set')
    process.exit(1)
  }
  const result = await checkAppliedButMissing({ connectionString: raw.replace('-pooler', '') })
  process.exit(reportAndExitCode(result))
}

/** Shared by the CLI and by migrate-direct.mjs, so both say the same thing. */
export function reportAndExitCode(result) {
  const tag = '[applied-but-missing]'
  if (result.status === 'unreachable') {
    console.error(`${tag} 🔴 COULD NOT CHECK — ${result.error}`)
    console.error(`${tag} This is NOT "no drift". Refusing rather than reporting an unwitnessed zero.`)
    return 1
  }
  if (result.status === 'no-history') {
    console.log(`${tag} no _prisma_migrations table — first deploy, nothing applied, nothing can be missing`)
    return 0
  }
  const { counts, inProgress, appliedButMissing } = result
  console.log(`${tag} ${counts.rows} rows on the database (${counts.rolledBack} rolled back) vs ${counts.localFolders} folders in the repo`)
  if (inProgress.length > 0) {
    console.warn(`${tag} ⚠ IN-PROGRESS, never finished: ${inProgress.join(', ')}`)
  }
  if (appliedButMissing.length > 0) {
    console.error(`\n${tag} ❌ REFUSED — ${appliedButMissing.length} migration(s) are applied to this database with NO folder in prisma/migrations/:\n`)
    for (const name of appliedButMissing) console.error(`    ${name}`)
    console.error(`\n${tag} Somebody applied schema changes this repo cannot account for.`)
    console.error(`${tag} Recover the SQL, commit it as a migration folder with a named owner, then deploy.\n`)
    return 1
  }
  console.log(`${tag} ✓ every applied migration has a folder in the repo`)
  return 0
}
