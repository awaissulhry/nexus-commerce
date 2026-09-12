import pg from 'pg'
process.loadEnvFile('../../.env')
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
await c.connect()
console.error('=== ledger, final state ===')
for (const r of (await c.query(`SELECT "channel","status","verifiedBy","signatureOk",COUNT(*)::int n
  FROM "WebhookEvent" GROUP BY 1,2,3,4 ORDER BY 5 DESC`)).rows)
  console.error(`  ${String(r.channel).padEnd(8)} status=${String(r.status).padEnd(7)} verifiedBy=${String(r.verifiedBy).padEnd(10)} signatureOk=${r.signatureOk === null ? 'null' : r.signatureOk}  rows=${r.n}`)
console.error('\n=== eBay rejection reasons ===')
for (const r of (await c.query(`SELECT regexp_replace("lastError", '^signature rejected: ([a-z_]+).*$', '\\1') AS reason, COUNT(*)::int n
  FROM "WebhookEvent" WHERE "channel"='EBAY' GROUP BY 1 ORDER BY 2 DESC`)).rows)
  console.error(`  ${String(r.reason).padEnd(26)} ${r.n}`)
console.error('\n=== Amazon ingestion still healthy since the change? ===')
for (const r of (await c.query(`SELECT DATE("createdAt")::text d, COUNT(*)::int n, MAX("createdAt")::text newest
  FROM "WebhookEvent" WHERE "channel"='AMAZON' AND "createdAt" > NOW() - INTERVAL '2 days' GROUP BY 1 ORDER BY 1 DESC`)).rows)
  console.error(`  ${r.d}  rows=${r.n}  newest=${r.newest}`)
await c.end()
