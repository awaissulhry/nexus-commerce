#!/usr/bin/env node
// Read-only verification of the DP.1 orders-dayparting SQL against prod.
// Mirrors aggregateOrdersDayparting() so we confirm TZ/DISTINCT/cents/peak logic.
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
await c.connect()

async function agg({ channel = 'AMAZON', marketplace = null, productId = null, sku = null, windowDays = 90, metric = 'revenue' } = {}) {
  const params = [channel]
  let join = 'LEFT JOIN "OrderItem" oi ON oi."orderId" = o.id'
  if (productId || sku) join = 'JOIN "OrderItem" oi ON oi."orderId" = o.id'
  let mktClause = ''
  if (marketplace) { params.push(marketplace); mktClause = `AND o."marketplace" = $${params.length}` }
  let prodClause = ''
  if (productId) { params.push(productId); prodClause = `AND oi."productId" = $${params.length}` }
  let skuClause = ''
  if (sku) { params.push(sku); skuClause = `AND oi."sku" = $${params.length}` }
  const sql = `
    SELECT
      EXTRACT(DOW  FROM (COALESCE(o."purchaseDate", o."createdAt") AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Rome'))::int AS dow,
      EXTRACT(HOUR FROM (COALESCE(o."purchaseDate", o."createdAt") AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Rome'))::int AS hour,
      COUNT(DISTINCT o.id)::bigint AS orders,
      COALESCE(SUM(oi."quantity"), 0)::bigint AS units,
      COALESCE(SUM(ROUND(oi."price" * oi."quantity" * 100)), 0)::bigint AS cents
    FROM "Order" o
    ${join}
    WHERE o."deletedAt" IS NULL
      AND o."channel"::text = $1
      AND COALESCE(o."purchaseDate", o."createdAt") >= now() - interval '${windowDays} days'
      AND COALESCE(o."currencyCode", 'EUR') = 'EUR'
      ${mktClause} ${prodClause} ${skuClause}
    GROUP BY 1,2 ORDER BY 1,2`
  const { rows } = await c.query(sql, params)
  const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ orders: 0, units: 0, revenueCents: 0 })))
  const totals = { orders: 0, units: 0, revenueCents: 0 }
  for (const r of rows) {
    const d = Number(r.dow), h = Number(r.hour)
    grid[d][h].orders += Number(r.orders); grid[d][h].units += Number(r.units); grid[d][h].revenueCents += Number(r.cents)
    totals.orders += Number(r.orders); totals.units += Number(r.units); totals.revenueCents += Number(r.cents)
  }
  const hour = Array.from({ length: 24 }, (_, h) => {
    let o = 0, u = 0, c2 = 0
    for (let d = 0; d < 7; d++) { o += grid[d][h].orders; u += grid[d][h].units; c2 += grid[d][h].revenueCents }
    return { h, orders: o, units: u, revenueCents: c2 }
  })
  const val = (b) => metric === 'revenue' ? b.revenueCents : metric === 'orders' ? b.orders : b.units
  const mean = hour.reduce((s, b) => s + val(b), 0) / 24
  const peak = hour.filter((b) => mean > 0 && val(b) / mean >= 1.2).map((b) => b.h)
  const trough = hour.filter((b) => mean > 0 && val(b) / mean < 0.6).map((b) => b.h)
  return { totals, peak, trough, hour }
}

console.log('--- AMAZON / IT / 90d / revenue ---')
const a = await agg({ marketplace: 'IT', windowDays: 90, metric: 'revenue' })
console.log('totals:', a.totals, '\npeakHours:', a.peak, '\ntroughHours:', a.trough)
console.log('hour €:', a.hour.map((b) => `${b.h}:${(b.revenueCents / 100).toFixed(0)}`).join(' '))

console.log('\n--- AMAZON / all markets / 90d / orders ---')
const b = await agg({ windowDays: 90, metric: 'orders' })
console.log('totals:', b.totals, '\npeakHours:', b.peak, '\ntroughHours:', b.trough)

// product-scoped sanity: top SKU last 365d
const top = await c.query(`SELECT oi.sku, count(*) n FROM "OrderItem" oi JOIN "Order" o ON o.id=oi."orderId" WHERE o."deletedAt" IS NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 1`)
const topSku = top.rows[0]?.sku
console.log(`\n--- AMAZON / sku=${topSku} / 365d / units ---`)
const d = await agg({ sku: topSku, windowDays: 365, metric: 'units' })
console.log('totals:', d.totals, '\npeakHours:', d.peak)

await c.end()
console.log('\nDone.')
