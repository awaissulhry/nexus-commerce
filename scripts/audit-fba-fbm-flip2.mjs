#!/usr/bin/env node
// READ-ONLY follow-up: active vs latent. Did the 64 FBA-by-STOCK Amazon
// listings actually receive a LIVE quantity push (real flip), or is the risk
// latent behind the publish gate? Keys on FBA stock (not offers).
import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'; import pg from 'pg'
const here = path.dirname(fileURLToPath(import.meta.url)); dotenv.config({ path: path.join(here, '..', '.env') })
const url = process.env.DATABASE_URL?.replace('-pooler', ''); if (!url) { console.error('no DATABASE_URL'); process.exit(1) }
const c = new pg.Client({ connectionString: url }); await c.connect()
const hr = (t) => console.log('\n' + '═'.repeat(72) + '\n' + t + '\n' + '═'.repeat(72))
const q = async (label, sql) => { try { return (await c.query(sql)).rows } catch (e) { console.log(`  [${label}] ${e.message}`); return null } }

// CTE: Amazon listings backed by FBA stock (the true FBA population)
const FBA_CTE = `
  WITH fba AS (
    SELECT cl.id, p.sku, cl.marketplace, cl."fulfillmentMethod"::text cl_fm, cl."isPublished" pub
    FROM "ChannelListing" cl JOIN "Product" p ON p.id=cl."productId"
    WHERE cl.channel='AMAZON' AND EXISTS (
      SELECT 1 FROM "StockLevel" sl JOIN "StockLocation" loc ON loc.id=sl."locationId"
      WHERE sl."productId"=cl."productId" AND loc.code='AMAZON-EU-FBA' AND sl.quantity>0))`

hr('E1 — QUANTITY_UPDATE history against FBA-stock Amazon listings (ALL TIME)')
const e1 = await q('E1', `${FBA_CTE}
  SELECT q."syncStatus"::text status, count(*) c,
         to_char(min(q."createdAt"),'YYYY-MM-DD') first, to_char(max(q."createdAt"),'YYYY-MM-DD') last
  FROM "OutboundSyncQueue" q JOIN fba f ON f.id=q."channelListingId"
  WHERE q."syncType"='QUANTITY_UPDATE' GROUP BY q."syncStatus" ORDER BY c DESC`)
if (e1) e1.forEach(r=>console.log(`  ${r.status.padEnd(10)} ${String(r.c).padStart(5)}   ${r.first} → ${r.last}`))

hr('E2 — most recent SUCCESS quantity pushes to FBA-stock listings (the suspected flips)')
const e2 = await q('E2', `${FBA_CTE}
  SELECT to_char(q."createdAt",'YYYY-MM-DD HH24:MI') ts, f.sku, f.marketplace mkt, f.cl_fm,
         q.payload->>'quantity' qty, q.payload->>'source' src
  FROM "OutboundSyncQueue" q JOIN fba f ON f.id=q."channelListingId"
  WHERE q."syncType"='QUANTITY_UPDATE' AND q."syncStatus"='SUCCESS'
  ORDER BY q."createdAt" DESC LIMIT 25`)
if (e2) { console.log(`  rows: ${e2.length}`); e2.forEach(r=>console.log(`  ${r.ts}  ${r.sku} [${r.mkt}] cl_fm=${r.cl_fm} qty→${r.qty} src=${r.src}`)) }

hr('E3 — were FBA-stock SKUs published LIVE? (ChannelPublishAttempt, all time)')
const e3 = await q('E3', `${FBA_CTE}, fba_skus AS (SELECT DISTINCT sku FROM fba)
  SELECT cpa.mode, cpa.outcome, count(*) c, to_char(max(cpa."attemptedAt"),'YYYY-MM-DD') last
  FROM "ChannelPublishAttempt" cpa JOIN fba_skus s ON s.sku=cpa.sku
  WHERE cpa.channel='AMAZON' GROUP BY cpa.mode, cpa.outcome ORDER BY c DESC`)
if (e3) e3.forEach(r=>console.log(`  mode=${String(r.mode).padEnd(8)} outcome=${String(r.outcome).padEnd(14)} ${String(r.c).padStart(5)}  last=${r.last}`))

hr('E4 — why are 713 QUANTITY_UPDATE→AMAZON FAILING? (error breakdown)')
const e4 = await q('E4', `
  SELECT "errorCode", left(coalesce("errorMessage",'(null)'),90) msg, count(*) c
  FROM "OutboundSyncQueue"
  WHERE "targetChannel"='AMAZON' AND "syncType"='QUANTITY_UPDATE' AND "syncStatus"='FAILED'
  GROUP BY "errorCode", left(coalesce("errorMessage",'(null)'),90) ORDER BY c DESC LIMIT 12`)
if (e4) e4.forEach(r=>console.log(`  ${String(r.c).padStart(5)}  [${r.errorCode??'∅'}] ${r.msg}`))

hr('E5 — recent LIVE Amazon publishes overall (what is actually going live?)')
const e5 = await q('E5', `
  SELECT to_char(cpa."attemptedAt",'YYYY-MM-DD HH24:MI') ts, cpa.sku, cpa.marketplace mkt, cpa.outcome
  FROM "ChannelPublishAttempt" cpa
  WHERE cpa.channel='AMAZON' AND cpa.mode='live'
  ORDER BY cpa."attemptedAt" DESC LIMIT 20`)
if (e5) { console.log(`  most recent live attempts:`); e5.forEach(r=>console.log(`  ${r.ts}  ${r.sku} [${r.mkt}] ${r.outcome}`)) }

hr('E6 — what is the SUCCESS QUANTITY_UPDATE actually doing? (sample payloads + recency, all markets)')
const e6 = await q('E6', `
  SELECT to_char("createdAt",'YYYY-MM-DD HH24:MI') ts, "targetRegion" reg,
         payload->>'quantity' qty, payload->>'source' src, "syncedAt" IS NOT NULL synced
  FROM "OutboundSyncQueue"
  WHERE "targetChannel"='AMAZON' AND "syncType"='QUANTITY_UPDATE' AND "syncStatus"='SUCCESS'
  ORDER BY "createdAt" DESC LIMIT 15`)
if (e6) e6.forEach(r=>console.log(`  ${r.ts} reg=${r.reg} qty=${r.qty} src=${r.src} synced=${r.synced}`))

await c.end(); console.log('\nDone (read-only).')
