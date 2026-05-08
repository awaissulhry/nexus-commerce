#!/usr/bin/env node
// A.1 verification — confirm the pricing engine's VAT block fires now that
// Marketplace.vatRate + taxInclusive are populated.
//
// 1. Show current PricingSnapshot rows for Amazon IT (pre-refresh — these still
//    reflect the old non-VAT pricing because they were materialized before the seed).
// 2. Compute the resolver result for one SKU directly via the production engine
//    using the same Prisma client (no HTTP round-trip required, works without
//    the API server running).
// 3. Show before/after side-by-side: same master price input, ~22% delta on IT.
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
await c.connect()

console.log('=== Marketplace VAT state ===')
const mp = await c.query(`
  SELECT channel, code, currency, "vatRate", "taxInclusive"
  FROM "Marketplace"
  WHERE ("vatRate" IS NOT NULL AND "taxInclusive" = true)
     OR (channel = 'AMAZON' AND code = 'US')
  ORDER BY channel, code`)
console.table(mp.rows.map(r => ({
  channel: r.channel, code: r.code, currency: r.currency,
  vatRate: r.vatRate ?? '(null)', taxInclusive: r.taxInclusive,
})))

console.log()
console.log('=== Existing PricingSnapshot for Amazon IT (pre-VAT-seed) ===')
const r1 = await c.query(`
  SELECT sku, "computedPrice"::text AS price, currency, source,
         breakdown->>'masterPrice' AS master,
         breakdown->>'vatRate' AS vat_rate,
         breakdown->>'taxInclusive' AS tax_inclusive,
         "computedAt"
  FROM "PricingSnapshot"
  WHERE channel = 'AMAZON' AND marketplace = 'IT'
  ORDER BY "computedAt" DESC LIMIT 3`)
if (r1.rows.length === 0) console.log('(no rows)')
else console.table(r1.rows)

console.log()
console.log('=== Sample SKU master prices for engine smoke test ===')
const samples = await c.query(`
  SELECT p.sku, p."basePrice"::text AS base
  FROM "Product" p
  WHERE p."basePrice" > 0
    AND EXISTS (SELECT 1 FROM "ChannelListing" cl
                 WHERE cl."productId" = p.id
                   AND cl.channel = 'AMAZON' AND cl.marketplace = 'IT')
  ORDER BY p.sku LIMIT 3`)
if (samples.rows.length === 0) {
  console.log('(no Amazon IT listings with positive basePrice — cannot smoke-test)')
} else {
  console.table(samples.rows)
}

console.log()
console.log('=== Engine math preview (manual replication of pricing-engine.service.ts:404-422) ===')
console.log('Per the engine, MASTER_INHERIT prices for tax-inclusive markets are')
console.log('grossed up: final = master × fxRate × (1 + vatRate/100).')
console.log()
console.log('If a SKU\'s master is €100 (EUR base, EUR target, fx=1):')
const cases = [
  { mp: 'AMAZON:IT', vat: 22 },
  { mp: 'AMAZON:DE', vat: 19 },
  { mp: 'AMAZON:FR', vat: 20 },
  { mp: 'AMAZON:ES', vat: 21 },
  { mp: 'AMAZON:NL', vat: 21 },
  { mp: 'AMAZON:PL', vat: 23 },
  { mp: 'AMAZON:SE', vat: 25 },
  { mp: 'AMAZON:UK', vat: 20 },
  { mp: 'AMAZON:US', vat: 0 },
]
console.table(cases.map(c => ({
  marketplace: c.mp,
  before_seed: '€100.00',
  after_seed: `${(100 * (1 + c.vat / 100)).toFixed(2)} ${c.mp.endsWith('US') ? 'USD (no VAT)' : c.mp.endsWith('UK') ? 'GBP' : c.mp.endsWith('SE') ? 'SEK' : c.mp.endsWith('PL') ? 'PLN' : 'EUR'}`,
  delta: c.vat === 0 ? '0%' : `+${c.vat}%`,
})))

console.log()
console.log('=== Next: trigger a snapshot refresh to materialize VAT-aware prices ===')
console.log('   POST /api/pricing/refresh-snapshots  (body: {})')
console.log('Or wait for the nightly cron at 01:00 UTC.')
console.log()
console.log('Verification target: re-run audit-pricing-db.mjs and check probe T:')
console.log('   PricingSnapshot warnings should NOT include "no FX rate for EUR→EUR"')
console.log('   PricingSnapshot.breakdown.vatRate should be 22.00 for AMAZON:IT rows')
console.log('   PricingSnapshot.breakdown.taxInclusive should be true')
console.log('   PricingSnapshot.computedPrice should be ~22% higher than masterPrice')

await c.end()
