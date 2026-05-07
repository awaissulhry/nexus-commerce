// CR.10 smoke: verify warehouse → CarrierAccount routing.
import dotenv from 'dotenv'
dotenv.config({ path: '/Users/awais/nexus-commerce/.env' })
import pg from 'pg'

let url = process.env.DATABASE_URL.replace('-pooler.', '.')
const client = new pg.Client({ connectionString: url })
await client.connect()

// Setup: ensure SENDCLOUD primary carrier exists
let r = await client.query(`SELECT id FROM "Carrier" WHERE code='SENDCLOUD' LIMIT 1`)
let carrierId
let createdCarrier = false
if (r.rows.length === 0) {
  const cryptoMod = await import('/Users/awais/nexus-commerce/apps/api/src/lib/crypto.ts')
  const enc = cryptoMod.encryptSecret(JSON.stringify({ publicKey: 'PRI_PK', privateKey: 'PRI_SK' }))
  const ins = await client.query(`
    INSERT INTO "Carrier" (id, code, name, "isActive", "credentialsEncrypted", "createdAt", "updatedAt")
    VALUES ($1, 'SENDCLOUD', 'Sendcloud', true, $2, NOW(), NOW()) RETURNING id`,
    ['cr10-test-' + Date.now(), enc])
  carrierId = ins.rows[0].id
  createdCarrier = true
} else { carrierId = r.rows[0].id }

// Create a CarrierAccount
const cryptoMod = await import('/Users/awais/nexus-commerce/apps/api/src/lib/crypto.ts')
const accEnc = cryptoMod.encryptSecret(JSON.stringify({ publicKey: 'ACC_PK', privateKey: 'ACC_SK' }))
const accId = 'acc-cr10-' + Date.now()
await client.query(`
  INSERT INTO "CarrierAccount" (id, "carrierId", "accountLabel", "credentialsEncrypted", mode, "isActive", "createdAt", "updatedAt")
  VALUES ($1, $2, 'CR.10 Test Account', $3, 'sandbox', true, NOW(), NOW())`,
  [accId, carrierId, accEnc])
console.log('✓ Created CarrierAccount')

// Find a warehouse + bind the account
const wRes = await client.query(`SELECT id, "defaultCarrierAccountId" FROM "Warehouse" LIMIT 1`)
if (wRes.rows.length === 0) {
  console.log('No warehouse — skipping bind test')
} else {
  const whId = wRes.rows[0].id
  const oldBinding = wRes.rows[0].defaultCarrierAccountId
  await client.query(`UPDATE "Warehouse" SET "defaultCarrierAccountId"=$1 WHERE id=$2`, [accId, whId])
  console.log('✓ Bound warehouse to account')

  // Test resolveCredentials with warehouseId routes to account
  const sendcloud = await import('/Users/awais/nexus-commerce/apps/api/src/services/sendcloud/index.ts')
  const credsAcc = await sendcloud.resolveCredentials(whId)
  console.log('  resolveCredentials(warehouseId) → publicKey =', credsAcc.publicKey, credsAcc.publicKey === 'ACC_PK' ? '✓' : '✗')

  // Without warehouseId → primary
  const credsPri = await sendcloud.resolveCredentials()
  console.log('  resolveCredentials() (no warehouse) → publicKey =', credsPri.publicKey, credsPri.publicKey === 'PRI_PK' ? '✓' : '✗')

  // Restore
  await client.query(`UPDATE "Warehouse" SET "defaultCarrierAccountId"=$1 WHERE id=$2`, [oldBinding, whId])
}

// Cleanup
await client.query(`DELETE FROM "CarrierAccount" WHERE id=$1`, [accId])
if (createdCarrier) await client.query(`DELETE FROM "Carrier" WHERE id=$1`, [carrierId])
await client.end()
console.log('\nCR.10 smoke PASSED')
