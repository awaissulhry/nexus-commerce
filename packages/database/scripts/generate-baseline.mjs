#!/usr/bin/env node
/**
 * PLAN Step 0.4 — regenerate `prisma/baseline.sql` from `prisma/schema.prisma`.
 *
 * WHY A BASELINE EXISTS. The 467-migration history does not replay from zero. Measured 2026-09-22
 * with `replay-migrations.mjs`: 443 apply, 24 fail. None is a missing migration — every object they
 * want is created somewhere, just later than the migration that uses it. Ordering, plus a cascade.
 *
 * WHY NOT RENAME THE FOLDERS. `migration_name` is the key in production's `_prisma_migrations`.
 * Renaming makes every production row applied-but-missing and every new folder pending, so
 * `prisma migrate deploy` would re-run already-applied SQL against production. The Step 0.1 gate
 * (`check-applied-but-missing.mjs`) refuses exactly that, at deploy, before anything is applied.
 *
 * WHY THIS IS NOT "DUMP PRODUCTION". The source is `prisma/schema.prisma`, in this repo, which the
 * drift gates already hold the migrations to. Production is never read.
 *
 * WHAT USES IT. `bootstrap-fresh-database.mjs` — a FRESH database only. Existing databases,
 * production included, keep applying the history exactly as before.
 *
 * 🟠 ONE PASS, and an earlier version of this file wrongly had two.
 * `prisma migrate diff --from-url <db> --to-schema` reports 420 `ALTER COLUMN
 * "workspaceId" SET DEFAULT NULLIF(current_setting(...))` statements against a database that
 * ALREADY HAS them: Postgres stores the expression normalised, with `::text` casts, and Prisma does
 * not recognise it as its own. Reading that residual as "phase one omitted these" was wrong — a
 * second pass was added to append them, and it was pure duplication. Measured on a database built
 * from phase one alone: **420 of 431 `workspaceId` columns already carry the default**, emitted
 * inline in `CREATE TABLE`. The check that settled it queried `information_schema`, not the tool
 * whose blindness was the thing in question.
 *
 *   node packages/database/scripts/generate-baseline.mjs
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, '..')
const outPath = join(pkgRoot, 'prisma', 'baseline.sql')

const HEADER = `-- GENERATED — do not hand-edit.
--
-- Source: prisma/schema.prisma.  Regenerate: node scripts/generate-baseline.mjs
-- Verified by: scripts/baseline.vitest.test.ts — a database built from this file is compared back
-- against schema.prisma, and the ONLY difference allowed is the dbgenerated workspaceId default
-- that Prisma cannot round-trip. Anything else is drift and fails.
--
-- This is the from-empty schema for a FRESH database. It is NOT a migration: it lives outside
-- prisma/migrations/ so Prisma never applies it, and it never touches a deployed database.
-- See scripts/generate-baseline.mjs for why the 467-migration history cannot be replayed instead.
`

const sql = execFileSync(
  'npx',
  ['prisma', 'migrate', 'diff', '--from-empty', '--to-schema', 'prisma/schema.prisma', '--script'],
  { cwd: pkgRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
)

const out = HEADER + sql
writeFileSync(outPath, out)
const defaults = (sql.match(/DEFAULT NULLIF\(current_setting\('nexus\.workspace_id'/g) ?? []).length
console.log(`✓ wrote prisma/baseline.sql — ${out.split('\n').length} lines, ${defaults} workspaceId defaults inline`)
