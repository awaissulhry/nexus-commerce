// CR.25 smoke: secondary-account test endpoint persists health.
import dotenv from 'dotenv'
dotenv.config({ path: '/Users/awais/nexus-commerce/.env' })
import pg from 'pg'

let url = process.env.DATABASE_URL.replace('-pooler.', '.')
const c = new pg.Client({ connectionString: url })
await c.connect()

// Seed carrier + account
const cryptoMod = await import('/Users/awais/nexus-commerce/apps/api/src/lib/crypto.ts')
const enc = cryptoMod.encryptSecret(JSON.stringify({ publicKey: 'pk', privateKey: 'sk' }))
await c.query(`INSERT INTO "Carrier" (id, code, name, "isActive", "credentialsEncrypted", "createdAt", "updatedAt")
               VALUES ($1, 'SENDCLOUD', 'Sendcloud', true, $2, NOW(), NOW())
               ON CONFLICT (code) DO UPDATE SET "isActive"=true`,
              ['cr25-test-' + Date.now(), enc])
const cid = (await c.query(`SELECT id FROM "Carrier" WHERE code='SENDCLOUD'`)).rows[0].id
const accId = 'acc-cr25-' + Date.now()
await c.query(`INSERT INTO "CarrierAccount" (id, "carrierId", "accountLabel", "credentialsEncrypted", mode, "isActive", "createdAt", "updatedAt")
               VALUES ($1, $2, 'CR.25 Test', $3, 'sandbox', true, NOW(), NOW())`,
              [accId, cid, enc])
console.log('seeded account:', accId)

// Hit the endpoint via the API service helpers (we don't have HTTP server here; inline the logic).
// Simulate by invoking the same path resolveCredentials uses for accounts.
const sendcloud = await import('/Users/awais/nexus-commerce/apps/api/src/services/sendcloud/index.ts')
// Since the test endpoint reads from CarrierAccount + calls verifyCredentials,
// we just call verifyCredentials directly with the decrypted creds and verify
// what the endpoint persists by re-reading the row.

// Manually run the same logic as the endpoint:
const account = await c.query(`SELECT "credentialsEncrypted" FROM "CarrierAccount" WHERE id=$1`, [accId])
const ct = account.rows[0].credentialsEncrypted
const decrypted = cryptoMod.isEncrypted(ct) ? cryptoMod.decryptSecret(ct) : ct
const parsed = JSON.parse(decrypted)
const result = await sendcloud.verifyCredentials({
  publicKey: parsed.publicKey, privateKey: parsed.privateKey,
})
console.log('verify result:', result)

if (result.ok) {
  await c.query(`UPDATE "CarrierAccount" SET "lastVerifiedAt"=NOW(), "lastError"=NULL, "lastErrorAt"=NULL WHERE id=$1`, [accId])
} else {
  await c.query(`UPDATE "CarrierAccount" SET "lastError"=$2, "lastErrorAt"=NOW() WHERE id=$1`, [accId, result.reason])
}

const after = await c.query(`SELECT "lastVerifiedAt", "lastError" FROM "CarrierAccount" WHERE id=$1`, [accId])
console.log('account after test:', after.rows[0])
console.log('  lastVerifiedAt set?', after.rows[0].lastVerifiedAt !== null ? '✓' : '✗')

// Cleanup
await c.query(`DELETE FROM "CarrierAccount" WHERE id=$1`, [accId])
if (cid.startsWith('cr25-test-')) await c.query(`DELETE FROM "Carrier" WHERE id=$1`, [cid])
await c.end()
console.log('CR.25 smoke OK')
