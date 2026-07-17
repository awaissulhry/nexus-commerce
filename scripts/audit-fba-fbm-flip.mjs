#!/usr/bin/env node
// READ-ONLY diagnostic for the suspected FBA→FBM "Quantity bug".
//
// A merchant `fulfillment_availability` with fulfillment_channel_code:"DEFAULT"
// + a quantity tells Amazon the seller fulfills the SKU, flipping AMAZON_EU (FBA)
// → DEFAULT (FBM) = "Venduto e spedito da XAVIA RACING".
//
// This script ONLY runs SELECTs. It does NOT write anything.
//
// Run: node scripts/audit-fba-fbm-flip.mjs
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const url = process.env.DATABASE_URL?.replace('-pooler', '')
if (!url) { console.error('DATABASE_URL missing — set it in .env'); process.exit(1) }

const c = new pg.Client({ connectionString: url })
await c.connect()

const WINDOW = "90 days"
const hr = (t) => console.log('\n' + '═'.repeat(72) + '\n' + t + '\n' + '═'.repeat(72))
const q = async (label, sql) => {
  try { const r = await c.query(sql); return r.rows }
  catch (e) { console.log(`  [${label}] query failed: ${e.message}`); return null }
}

// Replicate isFbaListing() exactly (outbound-sync.service.ts:165)
function isFbaDetected(cl_fm, prod_fm, pa) {
  const faChannel = String(pa?.fulfillment_availability?.[0]?.fulfillment_channel_code ?? '').toUpperCase()
  return (
    cl_fm === 'FBA' ||
    faChannel.startsWith('AMAZON') ||
    (cl_fm == null && String(prod_fm ?? '').toUpperCase() === 'FBA')
  )
}

// ─────────────────────────────────────────────────────────────────────────
hr('SECTION A — Structural fail-open risk (the at-risk population)')
// For every AMAZON listing: would isFbaListing() detect it as FBA, vs. what the
// ground truth (active FBA offer / FBA stock bucket) says.
const rowsA = await q('A', `
  SELECT cl.id, cl.marketplace, cl."fulfillmentMethod"::text AS cl_fm,
         cl."platformAttributes" AS pa, cl."isPublished", cl."offerActive",
         cl.quantity AS cl_qty, p.sku AS sku, p."fulfillmentMethod"::text AS prod_fm,
         (SELECT bool_or(o."fulfillmentMethod"::text='FBA' AND o."isActive")
            FROM "Offer" o WHERE o."channelListingId"=cl.id) AS has_active_fba_offer,
         (SELECT bool_or(o."fulfillmentMethod"::text='FBM' AND o."isActive")
            FROM "Offer" o WHERE o."channelListingId"=cl.id) AS has_active_fbm_offer,
         (SELECT COALESCE(SUM(sl.quantity),0) FROM "StockLevel" sl
            JOIN "StockLocation" loc ON loc.id=sl."locationId"
            WHERE sl."productId"=cl."productId" AND loc.code='AMAZON-EU-FBA') AS fba_stock
  FROM "ChannelListing" cl JOIN "Product" p ON p.id=cl."productId"
  WHERE cl.channel='AMAZON'`)

if (rowsA) {
  let total=0, detected=0, gtFba=0, atRisk=0, flippedSignal=0
  const atRiskSamples=[], flippedSamples=[]
  for (const r of rowsA) {
    total++
    const det = isFbaDetected(r.cl_fm, r.prod_fm, r.pa)
    const faChannel = String(r.pa?.fulfillment_availability?.[0]?.fulfillment_channel_code ?? '').toUpperCase()
    const groundTruthFba = r.has_active_fba_offer === true || Number(r.fba_stock) > 0
    if (det) detected++
    if (groundTruthFba) gtFba++
    if (groundTruthFba && !det) {
      atRisk++
      if (atRiskSamples.length<25) atRiskSamples.push(
        `${r.sku} [${r.marketplace}] cl_fm=${r.cl_fm} prod_fm=${r.prod_fm} pa_fch=${faChannel||'∅'} fbaStock=${r.fba_stock} fbaOffer=${r.has_active_fba_offer} qty=${r.cl_qty} pub=${r.isPublished}`)
    }
    // Already-flipped-and-pulled signal: ground truth FBA but persisted channel now DEFAULT
    if (groundTruthFba && faChannel === 'DEFAULT') {
      flippedSignal++
      if (flippedSamples.length<25) flippedSamples.push(
        `${r.sku} [${r.marketplace}] pa_fch=DEFAULT fbaStock=${r.fba_stock} fbaOffer=${r.has_active_fba_offer} fbmOffer=${r.has_active_fbm_offer} qty=${r.cl_qty}`)
    }
  }
  console.log(`  Total AMAZON listings:                 ${total}`)
  console.log(`  Detected as FBA by isFbaListing():     ${detected}`)
  console.log(`  Ground-truth FBA (active offer/stock): ${gtFba}`)
  console.log(`  ⚠ AT-RISK (FBA truth but NOT detected → guard fails open → flip): ${atRisk}`)
  console.log(`  🔴 Already shows DEFAULT in our data but is FBA by truth: ${flippedSignal}`)
  if (atRiskSamples.length) { console.log('\n  At-risk samples:'); atRiskSamples.forEach(s=>console.log('    - '+s)) }
  if (flippedSamples.length) { console.log('\n  Likely-already-flipped samples:'); flippedSamples.forEach(s=>console.log('    - '+s)) }
}

// ─────────────────────────────────────────────────────────────────────────
hr(`SECTION B — Automated queue pushes (OutboundSyncQueue, last ${WINDOW})`)
const bStatus = await q('B-status', `
  SELECT "syncStatus"::text AS status, count(*) c FROM "OutboundSyncQueue"
  WHERE "targetChannel"='AMAZON' AND "syncType"='QUANTITY_UPDATE'
    AND "createdAt" > now() - interval '${WINDOW}'
  GROUP BY "syncStatus" ORDER BY c DESC`)
if (bStatus) { console.log('  QUANTITY_UPDATE→AMAZON by status:'); bStatus.forEach(r=>console.log(`    ${r.status.padEnd(12)} ${r.c}`)) }

const bFlips = await q('B-flips', `
  SELECT q."syncStatus"::text status, q."createdAt", p.sku,
         cl."fulfillmentMethod"::text fm,
         cl."platformAttributes"->'fulfillment_availability'->0->>'fulfillment_channel_code' AS pa_fch,
         q.payload->>'quantity' AS pushed_qty, q.payload->>'source' AS source, q."errorMessage"
  FROM "OutboundSyncQueue" q
  JOIN "ChannelListing" cl ON cl.id=q."channelListingId"
  JOIN "Product" p ON p.id=cl."productId"
  WHERE q."targetChannel"='AMAZON' AND q."syncType"='QUANTITY_UPDATE'
    AND q."syncStatus"='SUCCESS' AND q."createdAt" > now() - interval '${WINDOW}'
    AND EXISTS (SELECT 1 FROM "Offer" o WHERE o."channelListingId"=cl.id
                AND o."fulfillmentMethod"::text='FBA' AND o."isActive")
  ORDER BY q."createdAt" DESC LIMIT 30`)
if (bFlips) {
  console.log(`\n  🔴 SUCCESS quantity pushes to SKUs with an ACTIVE FBA offer (= executed flips): ${bFlips.length}${bFlips.length===30?'+ (capped)':''}`)
  bFlips.forEach(r=>console.log(`    - ${new Date(r.createdAt).toISOString().slice(0,16)} ${r.sku} fm=${r.fm} pa_fch=${r.pa_fch||'∅'} qty→${r.pushed_qty} src=${r.source}`))
}
const bSkip = await q('B-skip', `
  SELECT "errorMessage", count(*) c FROM "OutboundSyncQueue"
  WHERE "targetChannel"='AMAZON' AND "syncType"='QUANTITY_UPDATE'
    AND "syncStatus"='SKIPPED' AND "createdAt" > now() - interval '${WINDOW}'
  GROUP BY "errorMessage" ORDER BY c DESC LIMIT 10`)
if (bSkip) { console.log('\n  SKIPPED reasons (guard firing correctly):'); bSkip.forEach(r=>console.log(`    ${String(r.c).padStart(5)}  ${r.errorMessage ?? '(null)'}`)) }

// ─────────────────────────────────────────────────────────────────────────
hr(`SECTION C — Raw SP-API call log (OutboundApiCallLog, last ${WINDOW})`)
const cOps = await q('C-ops', `
  SELECT operation, "triggeredBy", success, count(*) c FROM "OutboundApiCallLog"
  WHERE channel='AMAZON' AND "createdAt" > now() - interval '${WINDOW}'
    AND (operation ILIKE '%feed%' OR operation ILIKE '%listing%')
  GROUP BY operation, "triggeredBy", success ORDER BY c DESC LIMIT 30`)
if (cOps) { console.log('  Feed/listings calls to Amazon by operation × trigger × success:')
  cOps.forEach(r=>console.log(`    ${r.operation.padEnd(22)} ${String(r.triggeredBy).padEnd(8)} ok=${r.success} ${r.c}`)) }

const cDanger = await q('C-danger', `
  SELECT operation, "triggeredBy", "createdAt", "listingId", "productId",
         left("requestPayload"::text, 500) AS sample
  FROM "OutboundApiCallLog"
  WHERE channel='AMAZON' AND "requestPayload" IS NOT NULL
    AND "createdAt" > now() - interval '${WINDOW}'
    AND "requestPayload"::text ILIKE '%fulfillment%'
    AND "requestPayload"::text ILIKE '%DEFAULT%'
    AND "requestPayload"::text ILIKE '%quantity%'
  ORDER BY "createdAt" DESC LIMIT 20`)
if (cDanger) {
  console.log(`\n  🔴 Logged payloads containing fulfillment + DEFAULT + quantity (direct evidence): ${cDanger.length}${cDanger.length===20?'+ (capped)':''}`)
  cDanger.forEach(r=>console.log(`    - ${new Date(r.createdAt).toISOString().slice(0,16)} ${r.operation} by=${r.triggeredBy} listing=${r.listingId}\n        ${r.sample}`))
}

// ─────────────────────────────────────────────────────────────────────────
hr(`SECTION D — ChannelPublishAttempt (manual cockpit/flat-file/batch, last ${WINDOW})`)
const dRows = await q('D', `
  SELECT mode, outcome, count(*) c FROM "ChannelPublishAttempt"
  WHERE channel='AMAZON' AND "attemptedAt" > now() - interval '${WINDOW}'
  GROUP BY mode, outcome ORDER BY c DESC LIMIT 30`)
if (dRows) { dRows.forEach(r=>console.log(`    mode=${String(r.mode).padEnd(8)} outcome=${String(r.outcome).padEnd(14)} ${r.c}`)) }

await c.end()
console.log('\nDone (read-only — no writes performed).')
