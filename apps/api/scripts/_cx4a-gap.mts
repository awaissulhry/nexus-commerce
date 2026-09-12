import pg from 'pg'
process.loadEnvFile('../../.env')
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
await c.connect()
const rows = (await c.query(`
  WITH g AS (
    SELECT "createdAt", LAG("createdAt") OVER (ORDER BY "createdAt") AS prev
    FROM "WebhookEvent" WHERE "channel"='AMAZON' AND "createdAt" > NOW() - INTERVAL '30 days')
  SELECT ROUND(EXTRACT(EPOCH FROM ("createdAt"-prev))/3600.0, 1) AS gap_h, "createdAt"::text AS at
  FROM g WHERE prev IS NOT NULL ORDER BY 1 DESC LIMIT 8`)).rows
console.error('=== 8 longest gaps between Amazon notifications, last 30 days ===')
for (const r of rows) console.error(`  ${String(r.gap_h).padStart(6)} h   ended ${r.at}`)
const now = (await c.query(`SELECT ROUND(EXTRACT(EPOCH FROM (NOW() - MAX("createdAt")))/3600.0,1) AS h FROM "WebhookEvent" WHERE "channel"='AMAZON'`)).rows[0]
console.error(`\ncurrent gap: ${now.h} h`)
console.error(`reading: if the current gap sits inside the normal range above, the quiet is ordinary.`)
await c.end()
