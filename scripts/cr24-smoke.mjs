// CR.24 smoke: run catalog sync, verify tiers are populated.
import dotenv from 'dotenv'
dotenv.config({ path: '/Users/awais/nexus-commerce/.env' })
import pg from 'pg'

let url = process.env.DATABASE_URL.replace('-pooler.', '.')
const c = new pg.Client({ connectionString: url })
await c.connect()

// Seed a SENDCLOUD carrier with creds so the sync's resolveCredentials passes.
const cryptoMod = await import('/Users/awais/nexus-commerce/apps/api/src/lib/crypto.ts')
const enc = cryptoMod.encryptSecret(JSON.stringify({ publicKey: 'pk', privateKey: 'sk' }))
await c.query(`INSERT INTO "Carrier" (id, code, name, "isActive", "credentialsEncrypted", "createdAt", "updatedAt")
               VALUES ($1, 'SENDCLOUD', 'Sendcloud', true, $2, NOW(), NOW())
               ON CONFLICT (code) DO UPDATE SET "isActive"=true, "credentialsEncrypted"=$2`,
              ['cr24-test-' + Date.now(), enc])
const cidRes = await c.query(`SELECT id FROM "Carrier" WHERE code='SENDCLOUD'`)
const carrierId = cidRes.rows[0].id

const { runCarrierServiceSync } = await import('/Users/awais/nexus-commerce/apps/api/src/jobs/carrier-service-sync.job.ts')
const result = await runCarrierServiceSync()
console.log('sync:', result)

const services = await c.query(
  `SELECT name, "carrierSubName", tier FROM "CarrierService" WHERE "carrierId"=$1 ORDER BY name`,
  [carrierId],
)
console.log('CarrierService rows:')
console.table(services.rows)
const tiered = services.rows.filter((s) => s.tier !== null)
console.log(`tier populated: ${tiered.length}/${services.rows.length}`)

// Verify resolveServiceMap auto-tier fallback now matches a STANDARD service for IT→IT
const sendcloud = await import('/Users/awais/nexus-commerce/apps/api/src/services/sendcloud/index.ts')
const domesticPick = await sendcloud.resolveServiceMap('AMAZON', 'IT', null, 'IT')
console.log('resolveServiceMap(AMAZON, IT, dest=IT) =', domesticPick, domesticPick !== null ? '✓ tier-matched' : '— no match')
const intlPick = await sendcloud.resolveServiceMap('AMAZON', 'GB', null, 'GB')
console.log('resolveServiceMap(AMAZON, GB, dest=GB) =', intlPick, intlPick !== null ? '✓ tier-matched' : '— no match')

// Cleanup
await c.query(`DELETE FROM "CarrierService" WHERE "carrierId"=$1`, [carrierId])
if (carrierId.startsWith('cr24-test-')) await c.query(`DELETE FROM "Carrier" WHERE id=$1`, [carrierId])
await c.end()
console.log('CR.24 smoke OK')
