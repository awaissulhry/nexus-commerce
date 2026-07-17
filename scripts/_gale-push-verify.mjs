// Push Gale Jacket (18-variant main family) to eBay IT and verify the resulting
// inventory_item_group and a sample of inventory_items.
// Usage: node scripts/_gale-push-verify.mjs
import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'
import { PrismaClient } from '@prisma/client'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const API = 'https://nexusapi-production-b7bb.up.railway.app'
const EBAY_API = 'https://api.ebay.com'
const MARKETPLACE_IT = 'EBAY_IT'
const prisma = new PrismaClient()

// ── 1. Fetch rows ────────────────────────────────────────────────────────────
console.log('Fetching eBay flat-file rows…')
const rowsRes = await fetch(`${API}/api/ebay/flat-file/rows`)
if (!rowsRes.ok) { console.error(`GET /rows ${rowsRes.status}`, await rowsRes.text()); process.exit(1) }
const { rows: allRows } = await rowsRes.json()
const galeRows = allRows.filter(r =>
  String(r.sku ?? '').toUpperCase().startsWith('GALE-JACKET') &&
  !String(r.sku ?? '').toUpperCase().includes('FBM')
)
console.log(`Found ${galeRows.length} Gale FBM-eligible rows`)

// ── 2. Push ──────────────────────────────────────────────────────────────────
console.log('\nPushing to eBay IT…')
const pushRes = await fetch(`${API}/api/ebay/flat-file/push`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ rows: galeRows, marketplace: 'IT', mode: 'api' }),
})
const pushText = await pushRes.text()
let pushData
try { pushData = JSON.parse(pushText) } catch { pushData = pushText }
console.log(`Push HTTP ${pushRes.status}`)
if (Array.isArray(pushData)) {
  const errors = pushData.filter(r => r.status === 'ERROR')
  const pushed = pushData.filter(r => r.status === 'PUSHED')
  console.log(`  PUSHED: ${pushed.length}   ERRORS: ${errors.length}`)
  if (errors.length) {
    console.log('\n── ERRORS ──')
    for (const r of errors) console.log(`  ✗ ${r.sku}\n      ${r.message}`)
  }
} else {
  console.log(JSON.stringify(pushData, null, 2).slice(0, 800))
}

// ── 3. Verify eBay API state ─────────────────────────────────────────────────
const conn = await prisma.channelConnection.findFirst({
  where: { channelType: 'EBAY', isActive: true },
  select: { accessToken: true, refreshToken: true, tokenExpiresAt: true },
})
if (!conn) { console.error('No EBAY connection'); await prisma.$disconnect(); process.exit(1) }

let tok = conn.accessToken
if (!tok || (conn.tokenExpiresAt && new Date(conn.tokenExpiresAt) <= new Date())) {
  const creds = Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString('base64')
  const r = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${creds}` },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: conn.refreshToken }),
  })
  tok = (await r.json()).access_token
}
const H = {
  Authorization: `Bearer ${tok}`,
  'Content-Type': 'application/json',
  'Content-Language': 'it-IT',
  'Accept-Language': 'it-IT',
  'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE_IT,
}

// 3a. GET group
console.log('\n════ inventory_item_group: GALE-JACKET ════')
const grpRes = await fetch(`${EBAY_API}/sell/inventory/v1/inventory_item_group/GALE-JACKET`, { headers: H })
if (!grpRes.ok) {
  console.log(`group GET ${grpRes.status}: ${(await grpRes.text()).slice(0, 300)}`)
} else {
  const g = await grpRes.json()
  console.log(`title: ${g.title}`)
  console.log(`variantSKUs count: ${g.variantSKUs?.length ?? 0}`)
  const specs = g.variesBy?.specifications ?? []
  console.log(`specifications (${specs.length}):`)
  for (const s of specs) console.log(`  ${s.name}: [${s.values?.join(', ')}]`)
  console.log(`aspectsImageVariesBy: ${JSON.stringify(g.variesBy?.aspectsImageVariesBy)}  ${
    (g.variesBy?.aspectsImageVariesBy ?? []).join('').toLowerCase().includes('color') ||
    (g.variesBy?.aspectsImageVariesBy ?? []).join('').toLowerCase().includes('colore')
      ? '✓' : '✗ WRONG — should be Color/Colore'
  }`)
  // inventory_item_group imageUrls is at the TOP LEVEL, not inside product
  console.log(`group imageUrls count: ${g.imageUrls?.length ?? 0}`)
  if (g.imageUrls?.length) console.log(`  first group image: ${g.imageUrls[0].slice(0, 80)}`)
}

// 3b. GET two BLACK variants (first + another size) — verify same images
const BLACK_SKUS = galeRows
  .filter(r => String(r.sku).toUpperCase().includes('BLACK') && !r._isParent)
  .slice(0, 2)
  .map(r => String(r.sku))

const YELLOW_SKUS = galeRows
  .filter(r => String(r.sku).toUpperCase().includes('YELLOW') && !r._isParent)
  .slice(0, 2)
  .map(r => String(r.sku))

const sampleSkus = [...BLACK_SKUS, ...YELLOW_SKUS]
if (sampleSkus.length === 0) sampleSkus.push(...galeRows.slice(0, 3).map(r => String(r.sku)))

console.log(`\n════ inventory_item spot-check (${sampleSkus.join(', ')}) ════`)
const imagesBySku = {}
for (const sku of sampleSkus) {
  const r = await fetch(`${EBAY_API}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, { headers: H })
  if (!r.ok) { console.log(`  ${sku}: ${r.status} ${(await r.text()).slice(0, 100)}`); continue }
  const item = await r.json()
  const urls = item.product?.imageUrls ?? []
  imagesBySku[sku] = urls
  console.log(`  ${sku}: imageUrls=${urls.length}  ${urls[0]?.slice(0, 70) ?? '(none)'}`)
}

// Check: all BLACK variants should have the same image set; same for YELLOW
if (BLACK_SKUS.length >= 2) {
  const [b0, b1] = BLACK_SKUS
  const same = JSON.stringify(imagesBySku[b0]?.sort()) === JSON.stringify(imagesBySku[b1]?.sort())
  console.log(`\n  Black image dedup: ${b0} vs ${b1} same URLs → ${same ? '✓ SAME' : '✗ DIFFERENT (eBay will show combined set)'}`)
}
if (YELLOW_SKUS.length >= 2) {
  const [y0, y1] = YELLOW_SKUS
  const same = JSON.stringify(imagesBySku[y0]?.sort()) === JSON.stringify(imagesBySku[y1]?.sort())
  console.log(`  Yellow image dedup: ${y0} vs ${y1} same URLs → ${same ? '✓ SAME' : '✗ DIFFERENT'}`)
}

// 3c. DB: check externalListingId populated
console.log('\n════ DB ChannelListing state ════')
const dbListings = await prisma.channelListing.findMany({
  where: {
    channel: 'EBAY', region: 'IT', listingStatus: 'ACTIVE',
    product: { sku: { startsWith: 'GALE-JACKET' }, deletedAt: null },
  },
  select: { externalListingId: true, listingStatus: true, product: { select: { sku: true } } },
  take: 6,
})
if (dbListings.length === 0) {
  console.log('  No ACTIVE EBAY_IT ChannelListings found for GALE-JACKET*')
} else {
  for (const l of dbListings) {
    console.log(`  ${l.product.sku}: listingId=${l.externalListingId ?? 'null'} status=${l.listingStatus}`)
  }
  const withId = dbListings.filter(l => l.externalListingId)
  console.log(`\n  ${withId.length}/${dbListings.length} rows have externalListingId populated`)
}

await prisma.$disconnect()
