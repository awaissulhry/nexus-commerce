#!/usr/bin/env node
// READ-ONLY safety check after NEXUS_ENABLE_AMAZON_PUBLISH was re-enabled.
// Confirms FBA-stock SKUs are now SKIPPED (fail-closed guard working), NOT
// SUCCESS (which would mean we're flipping again).
import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'; import pg from 'pg'
const here = path.dirname(fileURLToPath(import.meta.url)); dotenv.config({ path: path.join(here, '..', '.env') })
const url = process.env.DATABASE_URL?.replace('-pooler', ''); if (!url) { console.error('no DATABASE_URL'); process.exit(1) }
const c = new pg.Client({ connectionString: url }); await c.connect()
const hr = (t) => console.log('\n' + '─'.repeat(70) + '\n' + t)
const Q = async (l, s) => { try { return (await c.query(s)).rows } catch (e) { console.log(`  [${l}] ${e.message}`); return [] } }

console.log(`DB now(): ${(await Q('now', `SELECT to_char(now(),'YYYY-MM-DD HH24:MI:SS') t`))[0]?.t}`)

const ISFBA = `EXISTS(SELECT 1 FROM "StockLevel" sl JOIN "StockLocation" loc ON loc.id=sl."locationId"
  WHERE sl."productId"=cl."productId" AND loc.code='AMAZON-EU-FBA' AND sl.quantity>0)`

hr('Last 20 QUANTITY_UPDATE→AMAZON rows (status + is-FBA):')
const rows = await Q('rows', `
  SELECT to_char(q."createdAt",'MM-DD HH24:MI') ts, q."syncStatus"::text st, p.sku,
         ${ISFBA} is_fba, left(coalesce(q."errorMessage",''),48) msg
  FROM "OutboundSyncQueue" q
  LEFT JOIN "ChannelListing" cl ON cl.id=q."channelListingId"
  LEFT JOIN "Product" p ON p.id=cl."productId"
  WHERE q."targetChannel"='AMAZON' AND q."syncType"='QUANTITY_UPDATE'
  ORDER BY q."createdAt" DESC LIMIT 20`)
rows.forEach(r => console.log(`  ${r.ts}  ${r.st.padEnd(9)} ${r.is_fba ? 'FBA' : 'fbm'}  ${r.sku ?? '(no sku)'}  ${r.msg}`))

hr('🔴 DANGER — any SUCCESS quantity push to an FBA-stock SKU in last 3h (must be 0):')
const danger = await Q('danger', `
  SELECT to_char(q."createdAt",'MM-DD HH24:MI') ts, p.sku, q.payload->>'quantity' qty
  FROM "OutboundSyncQueue" q
  JOIN "ChannelListing" cl ON cl.id=q."channelListingId"
  JOIN "Product" p ON p.id=cl."productId"
  WHERE q."targetChannel"='AMAZON' AND q."syncType"='QUANTITY_UPDATE'
    AND q."syncStatus"='SUCCESS' AND ${ISFBA}
    AND q."createdAt" > now() - interval '3 hours'
  ORDER BY q."createdAt" DESC LIMIT 20`)
if (danger.length === 0) console.log('  ✅ none — FBA SKUs are NOT being pushed')
else danger.forEach(r => console.log(`  ⚠️ ${r.ts} ${r.sku} qty→${r.qty}  ← FLIPPING AGAIN`))

hr('QUANTITY_UPDATE→AMAZON in last 30 min, by status (SKIPPED=guard working):')
const last30 = await Q('30', `
  SELECT "syncStatus"::text st, count(*) c FROM "OutboundSyncQueue"
  WHERE "targetChannel"='AMAZON' AND "syncType"='QUANTITY_UPDATE'
    AND "createdAt" > now() - interval '30 minutes'
  GROUP BY "syncStatus" ORDER BY c DESC`)
if (last30.length) last30.forEach(r => console.log(`  ${r.st.padEnd(9)} ${r.c}`)); else console.log('  (none in last 30 min — next cycle not run yet)')

await c.end(); console.log('\nDone (read-only).')
