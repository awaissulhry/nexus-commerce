// A-24 — did any Amazon queue row for a non-Italian market get marked as sent? READ ONLY.
// Listing pushes only (the AD_* rows use the Ads API, not syncToAmazon). The push takes payload.marketplaceId ?? AMAZON_DEFAULT_MARKETPLACE ?? "IT"; producers set only `marketplace`.
// Default target: production (root .env). `--local`: the local catalogue, as a dry run.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire('/Users/awais/nexus-commerce/apps/api/package.json')
const { Client } = require('pg')
const local = process.argv.includes('--local')
const env = require('dotenv').parse(readFileSync(local ? '/Users/awais/nexus-commerce/apps/api/.env' : '/Users/awais/nexus-commerce/.env'))
const url = new URL(env.DATABASE_URL)
console.log('target host:', url.hostname, local ? '(local dry run)' : '(production, read only)')
if (local ? url.hostname !== '127.0.0.1' : !/neon\.tech$/.test(url.hostname)) { console.error('REFUSE: unexpected host'); process.exit(1) }
const c = new Client({ connectionString: env.DATABASE_URL, statement_timeout: 60000 })
await c.connect()
try {
  await c.query('BEGIN READ ONLY')
  const rows = (await c.query(`
    SELECT "syncType" AS type, "syncStatus"::text AS status,
      upper(coalesce(payload->>'marketplace', payload->>'market', "targetRegion", '?')) AS market,
      (payload ? 'marketplaceId') AS has_id,
      count(*)::int AS n, count("syncedAt")::int AS synced, max("syncedAt") AS last_synced, max("createdAt") AS last_created
    FROM "OutboundSyncQueue" WHERE "targetChannel" = 'AMAZON' AND "syncType" NOT LIKE 'AD\_%'
    GROUP BY 1, 2, 3, 4 ORDER BY synced DESC, n DESC`)).rows
  const risky = rows.filter(r => r.synced > 0 && !r.has_id && r.market !== 'IT')
  console.log('AMAZON QUEUE GROUPS ' + rows.length + ' · SYNCED NON-IT ROWS WITHOUT marketplaceId ' + risky.reduce((n, r) => n + r.synced, 0))
  for (const r of rows.slice(0, 40)) console.log('ROW ' + JSON.stringify(r))
  await c.query('ROLLBACK')
} finally { await c.end() }
