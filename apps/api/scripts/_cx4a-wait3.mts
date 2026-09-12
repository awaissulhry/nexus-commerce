import pg from 'pg'
process.loadEnvFile('../../.env')
const B = 'https://nexusapi-production-b7bb.up.railway.app'
const sig = Buffer.from(JSON.stringify({ kid: 'nexus-cx4a-not-a-real-kid', signature: 'AAAA' }), 'utf8').toString('base64')
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
await client.connect()

for (let i = 0; i < 12; i++) {
  // A distinct body each poll: a redelivery only increments `attempts`, so re-sending
  // the same bytes would never record the NEW reason even once the build lands.
  const body = JSON.stringify({ metadata: { topic: 'marketplace.order.created', notificationId: `cx4a-reason-${i}` }, notification: { data: { n: i } } })
  try {
    await fetch(`${B}/api/webhooks/ebay-notification`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ebay-signature': sig }, body })
  } catch { /* restarting API mid-deploy */ }
  const r = (await client.query(
    `SELECT "lastError" FROM "WebhookEvent" WHERE "channel"='EBAY' AND "lastError" NOT LIKE '%public_key_unavailable%'
       AND "lastError" LIKE '%signature rejected%' ORDER BY "createdAt" DESC LIMIT 1`)).rows
  if (r.length > 0) {
    const reason = String(r[0].lastError)
    console.log(`REASON SPLIT IS LIVE\n  ${reason}\n`)
    if (reason.includes('public_key_not_found')) {
      console.log('  => eBay ACCEPTED our application token and simply has no key for that made-up kid.')
      console.log('     The notification credential is HEALTHY. A real notification would be verifiable.')
    } else if (reason.includes('app_token_unavailable')) {
      console.log('  => We cannot obtain an eBay application token at all.')
      console.log('     Every genuine notification would be rejected. This is a REAL defect to fix.')
    } else if (reason.includes('public_key_forbidden')) {
      console.log('  => eBay REFUSED our application token (401/403).')
      console.log('     Every genuine notification would be rejected. This is a REAL defect to fix.')
    }
    await client.end(); process.exit(0)
  }
  await new Promise((res) => setTimeout(res, 45000))
}
console.log('TIMED OUT — reason split not observed yet')
await client.end(); process.exit(1)
