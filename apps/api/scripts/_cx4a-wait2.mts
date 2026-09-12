/**
 * Wait for the build carrying BOTH fixes, then report what prod actually says.
 * The probe body is constant, so every poll before the fix collapses onto ONE row
 * (attempts counts the polls) rather than littering the ledger.
 */
import pg from 'pg'
process.loadEnvFile('../../.env')
const B = 'https://nexusapi-production-b7bb.up.railway.app'
const CLAIMED = 'cx4a-final-probe'
const sig = Buffer.from(JSON.stringify({ kid: 'nexus-cx4a-not-a-real-kid', signature: 'AAAA' }), 'utf8').toString('base64')
const body = JSON.stringify({ metadata: { topic: 'marketplace.order.created', notificationId: CLAIMED }, notification: { data: {} } })

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
await client.connect()

for (let i = 0; i < 40; i++) {
  try {
    await fetch(`${B}/api/webhooks/ebay-notification`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ebay-signature': sig }, body })
  } catch { /* a restarting API is expected mid-deploy */ }
  const r = (await client.query(
    `SELECT "externalId","status","signatureOk","verifiedBy","attempts",LEFT("lastError",140) AS err
       FROM "WebhookEvent" WHERE "channel"='EBAY' AND "externalId" LIKE 'sha256:%' ORDER BY "createdAt" DESC LIMIT 1`)).rows
  if (r.length > 0) {
    console.log('DEPLOYED — both fixes live on prod')
    console.log(`  externalId : ${r[0].externalId}`)
    console.log(`  keyed on the id the payload claimed ("${CLAIMED}")? no — digest`)
    console.log(`  status=${r[0].status} signatureOk=${r[0].signatureOk} verifiedBy=${r[0].verifiedBy} attempts=${r[0].attempts}`)
    console.log(`  reason     : ${r[0].err}`)
    console.log(`  => a reason of public_key_not_found means our eBay APPLICATION CREDENTIAL WORKS.`)
    console.log(`     app_token_unavailable / public_key_forbidden would mean it does not.`)
    await client.end(); process.exit(0)
  }
  await new Promise((res) => setTimeout(res, 25000))
}
console.log('TIMED OUT waiting for the deploy')
await client.end(); process.exit(1)
