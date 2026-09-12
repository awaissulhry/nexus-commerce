/** Local metadata only. Never prints credentials or changes business records. */
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { Client } from 'pg'
import { parse } from 'dotenv'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const env = parse(await readFile(`${root}apps/api/.env`))
const target = new URL(env.DATABASE_URL)
if (!['127.0.0.1', 'localhost', '::1'].includes(target.hostname)) throw new Error('This verification is restricted to the local development database.')
const db = new Client({ connectionString: target.href, connectionTimeoutMillis: 10_000, statement_timeout: 15_000 })
try {
  await db.connect()
  await db.query('BEGIN READ ONLY')
  if (process.argv.includes('--search-plan')) {
    await db.query("SET LOCAL ROLE nexus_workspace_runtime; SELECT set_config('nexus.workspace_id','nexus_legacy_workspace',true), set_config('nexus.actor_id','',true)")
    const source = (await db.query('SELECT "activeSnapshotId" FROM "MarketplaceTaxonomy" WHERE channel=$1 AND marketplace=$2', ['EBAY','DE'])).rows[0]
    const plan = (await db.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) SELECT "externalId",path FROM "MarketplaceTaxonomyNode" WHERE "snapshotId"=$1 AND (path ILIKE $2 OR "externalId" ILIKE $2) ORDER BY path,"externalId" LIMIT 50', [source.activeSnapshotId, '%suit%'])).rows.map(r => r['QUERY PLAN'])
    console.log(plan.join('\n'))
    await db.query('ROLLBACK')
    await db.end()
    process.exit(0)
  }
  if (process.argv.includes('--activity')) {
    console.log(JSON.stringify((await db.query("SELECT datname, state, wait_event_type, wait_event, EXTRACT(epoch FROM now()-query_start)::int AS seconds FROM pg_stat_activity WHERE datname LIKE 'nexus_taxonomy_load_%'")).rows, null, 2))
    await db.query('ROLLBACK')
    await db.end()
    process.exit(0)
  }
  const history = (await db.query('SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY started_at DESC')).rows
  const complete = new Set(history.filter(r => r.finished_at && !r.rolled_back_at).map(r => r.migration_name))
  const local = (await readdir(`${root}packages/database/prisma/migrations`, { withFileTypes: true })).filter(f => f.isDirectory()).map(f => f.name)
  const report = {
    at: new Date().toISOString(), target: 'local development',
    version: (await db.query("SELECT current_setting('server_version') AS version")).rows[0].version,
    pending: local.filter(name => !complete.has(name)).sort(),
    failed: history.filter(r => !r.finished_at && !r.rolled_back_at).map(r => r.migration_name),
    taxonomyMigration: history.find(r => r.migration_name === '20260911_category_taxonomies' && r.finished_at && !r.rolled_back_at) ?? null,
    expectedChecksum: createHash('sha256').update(await readFile(`${root}packages/database/prisma/migrations/20260911_category_taxonomies/migration.sql`)).digest('hex'),
    workspaces: (await db.query('SELECT id, name, status FROM "Workspace"')).rows,
    connections: (await db.query('SELECT "workspaceId", "channelType", region, "managedBy", "isActive", "authStatus", "isPrimary", ("credentialsEnc" IS NOT NULL) AS encrypted FROM "ChannelConnection"')).rows,
    markets: (await db.query('SELECT "workspaceId", channel, code, region, "isActive" FROM "Marketplace" ORDER BY channel, code')).rows,
    products: (await db.query('SELECT "workspaceId", count(*)::int AS products FROM "Product" WHERE "deletedAt" IS NULL GROUP BY "workspaceId"')).rows,
  }
  await db.query('ROLLBACK')
  await writeFile(new URL('./local-readiness-evidence.json', import.meta.url), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally { await db.end() }
