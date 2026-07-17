#!/usr/bin/env node
// Live validator: waits for the NEXT QUANTITY_UPDATE→AMAZON push after the
// current latest, and reports whether FBA-stock SKUs are SKIPPED (fix live/safe)
// or SUCCESS (still flipping). Polls every 120s, up to ~24 min. READ-ONLY.
import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'; import pg from 'pg'
const here = path.dirname(fileURLToPath(import.meta.url)); dotenv.config({ path: path.join(here, '..', '.env') })
const url = process.env.DATABASE_URL?.replace('-pooler', ''); if (!url) { console.error('no DATABASE_URL'); process.exit(1) }
const c = new pg.Client({ connectionString: url }); await c.connect()
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const ISFBA = `EXISTS(SELECT 1 FROM "StockLevel" sl JOIN "StockLocation" loc ON loc.id=sl."locationId"
  WHERE sl."productId"=cl."productId" AND loc.code='AMAZON-EU-FBA' AND sl.quantity>0)`

const base = (await c.query(`SELECT COALESCE(max("createdAt"), now()) m FROM "OutboundSyncQueue"
  WHERE "targetChannel"='AMAZON' AND "syncType"='QUANTITY_UPDATE'`)).rows[0].m
console.log(`Baseline (latest existing push): ${new Date(base).toISOString()}`)

let verdict = 'NO_PUSH_OBSERVED'
for (let i = 0; i < 12; i++) {
  await sleep(120000)
  const rows = (await c.query(`
    SELECT to_char(q."createdAt",'HH24:MI') ts, q."syncStatus"::text st, p.sku, ${ISFBA} is_fba,
           q.payload->>'quantity' qty
    FROM "OutboundSyncQueue" q
    LEFT JOIN "ChannelListing" cl ON cl.id=q."channelListingId"
    LEFT JOIN "Product" p ON p.id=cl."productId"
    WHERE q."targetChannel"='AMAZON' AND q."syncType"='QUANTITY_UPDATE' AND q."createdAt" > $1
    ORDER BY q."createdAt"`, [base])).rows
  if (rows.length) {
    console.log(`\nNew push(es) observed at poll ${i + 1}:`)
    rows.forEach(r => console.log(`  ${r.ts}  ${r.st.padEnd(9)} ${r.is_fba ? 'FBA' : 'fbm'}  ${r.sku ?? '(no sku)'}  qty=${r.qty}`))
    const fbaFlip = rows.find(r => r.is_fba && r.st === 'SUCCESS')
    const fbaSkip = rows.find(r => r.is_fba && r.st === 'SKIPPED')
    if (fbaFlip) verdict = '🔴 STILL FLIPPING — FBA SKU got SUCCESS push (turn gate OFF)'
    else if (fbaSkip) verdict = '✅ FIX LIVE — FBA SKU was SKIPPED (safe)'
    else verdict = `⚠️ pushes seen but no FBA row — inconclusive (statuses: ${[...new Set(rows.map(r=>r.st))].join(',')})`
    break
  }
  console.log(`  poll ${i + 1}/12 — no new push yet`)
}
console.log(`\nVERDICT: ${verdict}`)
await c.end()
