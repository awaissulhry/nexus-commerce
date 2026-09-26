#!/usr/bin/env -S npx tsx
/**
 * CI (docs/ci-plan.md §2.3) — stand up a disposable PostgreSQL database the way a fresh environment
 * gets one, and give it the reference rows the API tests expect to find.
 *
 * WHY
 * Some API tests mock most of Prisma but still reach the real client for reference data: for example
 * `marketLanguages()` reads `Marketplace` (services/categories/marketplace-ids.ts). On a developer
 * machine that quietly hits the seeded `nexus_development`. On a clean runner it hit nothing and 5
 * files failed. This gives CI the same thing a new business gets, from the same code:
 *   1. `bootstrap-fresh-database.mjs` — baseline schema, migration history marked applied, the
 *      isolation layer (policies, grants), and its own refusal of a database with zero policies;
 *   2. the market catalogue rows (`marketCatalogueRows()`, the rows a new business receives) in the
 *      legacy business.
 *
 * SAFETY
 * The target must be loopback AND its database name must contain "test". The database is created if
 * missing and must be empty (the bootstrap refuses one with tables).
 *
 *   npx tsx scripts/ci/prepare-test-database.mts --url postgresql://postgres@127.0.0.1:5432/nexus_test
 *   … --database-dir .ci/base/packages/database   bootstrap with ANOTHER tree's scripts (the merge base)
 *   … --no-markets                                 schema and isolation only
 */
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { marketCatalogueRows } from '../../apps/api/src/services/pim/market-catalogue.ts'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const args = process.argv.slice(2)
const value = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }

const raw = value('--url') ?? process.env.NEXUS_TEST_LOCAL_PG_URL
if (!raw) { console.error('✗ --url (or NEXUS_TEST_LOCAL_PG_URL) is required'); process.exit(1) }
const url = new URL(raw)
const database = url.pathname.replace(/^\//, '')
if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname) || !database.includes('test')) {
  console.error(`✗ REFUSED: ${url.hostname}/${database} — only a loopback database whose name contains "test".`)
  process.exit(1)
}

const admin = new URL(url.toString())
admin.pathname = '/postgres'
const adminClient = new pg.Client({ connectionString: admin.toString() })
await adminClient.connect()
const exists = await adminClient.query('SELECT 1 FROM pg_database WHERE datname = $1', [database])
if (exists.rowCount === 0) await adminClient.query(`CREATE DATABASE "${database.replace(/"/g, '')}"`)
await adminClient.end()

const databaseDir = resolve(ROOT, value('--database-dir') ?? 'packages/database')
const bootstrap = spawnSync(process.execPath, [join(databaseDir, 'scripts', 'bootstrap-fresh-database.mjs')], {
  cwd: ROOT,
  env: { ...process.env, DATABASE_URL: url.toString() },
  stdio: 'inherit',
})
if (bootstrap.status !== 0) { console.error(`✗ bootstrap failed (${databaseDir})`); process.exit(bootstrap.status ?? 1) }

if (!args.includes('--no-markets')) {
  const client = new pg.Client({ connectionString: url.toString() })
  await client.connect()
  const rows = marketCatalogueRows()
  await client.query('BEGIN')
  await client.query("SELECT set_config('nexus.workspace_id', 'nexus_legacy_workspace', true)")
  for (const row of rows) {
    await client.query(
      `INSERT INTO "Marketplace" (id, channel, code, name, "marketplaceId", region, currency, language, languages,
         "domainUrl", "vatRate", "taxInclusive", "isActive", "updatedAt")
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
       ON CONFLICT ("workspaceId", channel, code) DO NOTHING`,
      [row.channel, row.code, row.name, row.marketplaceId, row.region, row.currency, row.language, row.languages,
        row.domainUrl, row.vatRate, row.taxInclusive, row.isActive],
    )
  }
  await client.query('COMMIT')
  const count = (await client.query(`SELECT count(*)::int AS n FROM "Marketplace" WHERE "workspaceId" = 'nexus_legacy_workspace'`)).rows[0].n
  await client.end()
  if (count < rows.length) { console.error(`✗ expected ${rows.length} markets, found ${count}`); process.exit(1) }
  console.log(`[prepare] ${count} markets in the legacy business`)
}
console.log(`✓ ${url.hostname}/${database} is ready`)
