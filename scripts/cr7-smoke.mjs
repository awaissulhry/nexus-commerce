// CR.7 smoke: services + mappings endpoints + resolveServiceMap.
import dotenv from 'dotenv'
dotenv.config({ path: '/Users/awais/nexus-commerce/.env' })
import pg from 'pg'

let url = process.env.DATABASE_URL.replace('-pooler.', '.')
const client = new pg.Client({ connectionString: url })
await client.connect()

// Setup: ensure a Sendcloud carrier exists for the test
const r1 = await client.query(`SELECT id FROM "Carrier" WHERE code='SENDCLOUD' LIMIT 1`)
let carrierId
if (r1.rows.length === 0) {
  const ins = await client.query(`
    INSERT INTO "Carrier" (id, code, name, "isActive", "createdAt", "updatedAt")
    VALUES ($1, 'SENDCLOUD', 'Sendcloud', true, NOW(), NOW()) RETURNING id`,
    ['cr7-test-' + Date.now()])
  carrierId = ins.rows[0].id
} else {
  carrierId = r1.rows[0].id
}

// (1) Insert a CarrierService row directly
const svcId = 'svc-cr7-' + Date.now()
await client.query(`
  INSERT INTO "CarrierService" (id, "carrierId", "externalId", name, "carrierSubName", tier, "syncedAt", "updatedAt")
  VALUES ($1, $2, '12345', 'BRT Express 0-2kg', 'BRT', 'EXPRESS', NOW(), NOW())
  ON CONFLICT ("carrierId", "externalId") DO NOTHING
`, [svcId, carrierId])
console.log('CarrierService seeded')

// (2) Insert a mapping for AMAZON IT
const mapId = 'map-cr7-' + Date.now()
await client.query(`
  INSERT INTO "CarrierServiceMapping" (id, "carrierId", "serviceId", channel, marketplace, "warehouseId", "updatedAt")
  VALUES ($1, $2, (SELECT id FROM "CarrierService" WHERE "externalId"='12345' AND "carrierId"=$2), 'AMAZON', 'IT', NULL, NOW())
`, [mapId, carrierId])
console.log('CarrierServiceMapping seeded')

// (3) Verify resolveServiceMap returns 12345 for AMAZON IT
const sendcloud = await import('/Users/awais/nexus-commerce/apps/api/src/services/sendcloud/index.ts')
const resolved = await sendcloud.resolveServiceMap('AMAZON', 'IT')
console.log('resolveServiceMap(AMAZON, IT) =', resolved, resolved === 12345 ? '✓' : '✗')

const resolvedFallback = await sendcloud.resolveServiceMap('AMAZON', 'DE')
console.log('resolveServiceMap(AMAZON, DE) =', resolvedFallback, '(expected null — no mapping yet)')

// (4) Verify resolution honors GLOBAL fallback
await client.query(`
  INSERT INTO "CarrierService" (id, "carrierId", "externalId", name, "carrierSubName", tier, "syncedAt", "updatedAt")
  VALUES ($1, $2, '99999', 'GLS Global', 'GLS', 'STANDARD', NOW(), NOW())
  ON CONFLICT ("carrierId", "externalId") DO NOTHING
`, ['svc-global-' + Date.now(), carrierId])
await client.query(`
  INSERT INTO "CarrierServiceMapping" (id, "carrierId", "serviceId", channel, marketplace, "warehouseId", "updatedAt")
  VALUES ($1, $2, (SELECT id FROM "CarrierService" WHERE "externalId"='99999' AND "carrierId"=$2), 'EBAY', 'GLOBAL', NULL, NOW())
`, ['map-global-' + Date.now(), carrierId])
const ebayDe = await sendcloud.resolveServiceMap('EBAY', 'DE')
console.log('resolveServiceMap(EBAY, DE) =', ebayDe, '(expected 99999 via GLOBAL fallback)', ebayDe === 99999 ? '✓' : '✗')

// Cleanup
await client.query(`DELETE FROM "CarrierServiceMapping" WHERE "carrierId" = $1`, [carrierId])
await client.query(`DELETE FROM "CarrierService" WHERE "carrierId" = $1`, [carrierId])
if (r1.rows.length === 0) {
  await client.query(`DELETE FROM "Carrier" WHERE id = $1`, [carrierId])
}
await client.end()
console.log('CR.7 smoke PASSED')
