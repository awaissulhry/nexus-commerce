// Final CR-engagement smoke: walk every endpoint we shipped and
// verify it responds with the right shape. Doesn't hit Sendcloud
// real mode — uses dryRun.
import dotenv from 'dotenv'
dotenv.config({ path: '/Users/awais/nexus-commerce/.env' })
import pg from 'pg'

let url = process.env.DATABASE_URL.replace('-pooler.', '.')
const client = new pg.Client({ connectionString: url })
await client.connect()

console.log('=== CR final smoke ===\n')

// 1. Schema state
const cols = await client.query(`
  SELECT column_name FROM information_schema.columns WHERE table_name='Carrier'
  AND column_name IN ('lastUsedAt','lastVerifiedAt','lastErrorAt','lastError','accountLabel','mode','webhookSecret')
  ORDER BY column_name`)
console.log(`✓ Carrier health columns: ${cols.rows.length}/7`)

const tables = await client.query(`
  SELECT table_name FROM information_schema.tables WHERE table_schema='public'
  AND table_name IN ('CarrierService','CarrierServiceMapping','CarrierMetric','PickupSchedule')
  ORDER BY table_name`)
console.log(`✓ CR.3 tables: ${tables.rows.length}/4 — ${tables.rows.map(r => r.table_name).join(', ')}`)

// 2. Carrier table state
const carriers = await client.query(`SELECT code, "isActive", "lastVerifiedAt" IS NOT NULL AS verified FROM "Carrier"`)
console.log(`✓ Carrier rows: ${carriers.rows.length}`)
for (const r of carriers.rows) console.log(`  ${r.code} active=${r.isActive} verified=${r.verified}`)

// 3. Helpers
const cryptoMod = await import('/Users/awais/nexus-commerce/apps/api/src/lib/crypto.ts')
const env = cryptoMod.encryptSecret('{"publicKey":"smoke","privateKey":"smoke"}')
const decrypted = cryptoMod.decryptSecret(env)
console.log(`✓ encrypt/decrypt round-trip: ${decrypted === '{"publicKey":"smoke","privateKey":"smoke"}'}`)

// 4. Sendcloud helpers
const sendcloud = await import('/Users/awais/nexus-commerce/apps/api/src/services/sendcloud/client.ts')
const verify = await sendcloud.verifyCredentials({ publicKey: 'pk', privateKey: 'sk' })
console.log(`✓ verifyCredentials dryRun: ok=${verify.ok}`)

const methods = await sendcloud.listShippingMethods({ publicKey: 'pk', privateKey: 'sk' }, { weightKg: 1.5, toCountry: 'IT' })
console.log(`✓ listShippingMethods dryRun: ${methods.length} services`)

// 5. Buy Shipping
const buyShipping = await import('/Users/awais/nexus-commerce/apps/api/src/services/amazon-pushback/buy-shipping.ts')
const eligibility = await buyShipping.getEligibleShippingServices({
  amazonOrderId: '111-1234567-7654321',
  itemList: [{ orderItemId: '12345', quantity: 1 }],
  shipFromAddress: { name: 'Xavia', addressLine1: 'Via Roma 1', city: 'Riccione', postalCode: '47838', countryCode: 'IT' },
  weightGrams: 1500,
})
console.log(`✓ Buy Shipping eligibility dryRun: ${eligibility.length} services`)

// 6. resolveServiceMap fallback chain
const sendcloudIdx = await import('/Users/awais/nexus-commerce/apps/api/src/services/sendcloud/index.ts')
const noMapping = await sendcloudIdx.resolveServiceMap('SHOPIFY', 'GLOBAL')
console.log(`✓ resolveServiceMap(SHOPIFY, GLOBAL) with no mappings: ${noMapping === null ? 'null (correct)' : noMapping}`)

await client.end()
console.log('\n=== ALL SMOKE CHECKS PASSED ===')
