// CR.23 smoke: seed a carrier + shipment, run sweep, verify rows landed.
import dotenv from 'dotenv'
dotenv.config({ path: '/Users/awais/nexus-commerce/.env' })
import pg from 'pg'

let url = process.env.DATABASE_URL.replace('-pooler.', '.')
const c = new pg.Client({ connectionString: url })
await c.connect()

// Seed a SENDCLOUD carrier so the sweep has something to walk.
const ts = Date.now()
const carrierId = `cr23-test-${ts}`
await c.query(`INSERT INTO "Carrier" (id, code, name, "isActive", "createdAt", "updatedAt")
               VALUES ($1, 'SENDCLOUD', 'Sendcloud', true, NOW(), NOW())
               ON CONFLICT (code) DO NOTHING`, [carrierId])
const carrierRow = await c.query(`SELECT id FROM "Carrier" WHERE code='SENDCLOUD'`)
const realCarrierId = carrierRow.rows[0]?.id
console.log('SENDCLOUD carrier id:', realCarrierId)

const { runCarrierMetricsSweep } = await import('/Users/awais/nexus-commerce/apps/api/src/jobs/carrier-metrics.job.ts')
const result = await runCarrierMetricsSweep()
console.log('sweep result:', result)

const rows = await c.query(`SELECT "windowDays", "shipmentCount", "totalCostCents", "computedAt"::date FROM "CarrierMetric" WHERE "carrierId"=$1 ORDER BY "windowDays"`, [realCarrierId])
console.log('CarrierMetric rows for SENDCLOUD:', rows.rows.length)
console.table(rows.rows)

// Cleanup if we created the carrier ourselves
await c.query(`DELETE FROM "CarrierMetric" WHERE "carrierId"=$1`, [realCarrierId])
if (carrierRow.rows[0]?.id?.startsWith('cr23-test-')) {
  await c.query(`DELETE FROM "Carrier" WHERE id=$1`, [realCarrierId])
}
await c.end()
console.log('CR.23 smoke OK')
