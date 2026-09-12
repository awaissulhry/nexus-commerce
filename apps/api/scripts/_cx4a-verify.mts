import pg from 'pg'
process.loadEnvFile('../../.env')
const B = 'https://nexusapi-production-b7bb.up.railway.app'
const marker = `cx4a-live-${Date.now()}`
const sig = Buffer.from(JSON.stringify({ kid: 'not-a-real-key', signature: 'AAAA' }), 'utf8').toString('base64')
const body = JSON.stringify({ metadata: { topic: 'marketplace.order.created', notificationId: marker }, notification: { data: { orderId: 'probe' } } })

const res = await fetch(`${B}/api/webhooks/ebay-notification`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-ebay-signature': sig },
  body,
})
console.error(`forged POST -> HTTP ${res.status}  (412 = rejected, 204 = the old "accepted")`)

// The challenge must still answer, or eBay marks the endpoint down.
const ch = await fetch(`${B}/api/webhooks/ebay-notification?challenge_code=${marker}`)
console.error(`challenge   -> HTTP ${ch.status}  ${(await ch.text()).slice(0, 80)}`)

await new Promise((r) => setTimeout(r, 2500))
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
await client.connect()

const rows = (await client.query(
  `SELECT "externalId","eventType","status","signatureOk","verifiedBy","attempts",LEFT("lastError",110) AS err,"payloadDigest" IS NOT NULL AS has_digest
     FROM "WebhookEvent" WHERE "channel"='EBAY' ORDER BY "createdAt" DESC LIMIT 5`)).rows
console.error(`\neBay ledger rows now: ${rows.length}`)
for (const r of rows) {
  const named = r.externalId === marker
  console.error(`  externalId=${String(r.externalId).slice(0, 74)}`)
  console.error(`     status=${r.status} signatureOk=${r.signatureOk} verifiedBy=${r.verifiedBy} attempts=${r.attempts} digest=${r.has_digest}`)
  console.error(`     ${r.err}`)
  console.error(`     keyed on the id the forged payload NAMED: ${named ? 'YES — vulnerable build' : 'no — correct'}`)
}

const tot = (await client.query(`SELECT "channel", COUNT(*)::int n, SUM(CASE WHEN "signatureOk"=false THEN 1 ELSE 0 END)::int rejected FROM "WebhookEvent" GROUP BY 1`)).rows
console.error('\nledger totals:')
for (const t of tot) console.error(`  ${String(t.channel).padEnd(8)} rows=${t.n} rejected=${t.rejected}`)
await client.end()
