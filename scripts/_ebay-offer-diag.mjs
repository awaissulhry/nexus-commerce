// Diagnose eBay offer state for the 2 failing SKUs (BLACK-MEN-L + YELLOW-MEN-XL)
import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'
import { PrismaClient } from '@prisma/client'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
const prisma = new PrismaClient()

const FAILING_SKUS = ['GALE-JACKET-BLACK-MEN-L', 'GALE-JACKET-YELLOW-MEN-XL']
const PASSING_SKUS = ['GALE-JACKET-BLACK-MEN-M', 'GALE-JACKET-YELLOW-MEN-M'] // control group

const EBAY_API = 'https://api.ebay.com'
const MARKETPLACE_IT = 'EBAY_IT'

// ── Get eBay access token ───────────────────────────────────────────────────
const conn = await prisma.channelConnection.findFirst({
  where: { channelType: 'EBAY', isActive: true },
  select: { id: true, accessToken: true, refreshToken: true, tokenExpiresAt: true },
})
if (!conn) { console.error('No active EBAY connection'); process.exit(1) }

let tok = conn.accessToken
if (!tok || (conn.tokenExpiresAt && new Date(conn.tokenExpiresAt) <= new Date())) {
  const creds = Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString('base64')
  const r = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${creds}` },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: conn.refreshToken }),
  })
  if (!r.ok) { console.error('Token refresh failed:', await r.text()); process.exit(1) }
  tok = (await r.json()).access_token
}
const H = {
  Authorization: `Bearer ${tok}`,
  'Content-Type': 'application/json',
  'Content-Language': 'it-IT',
  'Accept-Language': 'it-IT',
  'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE_IT,
}

// ── DB: check qty + ChannelListing state for these SKUs ────────────────────
console.log('════════════ DB state ════════════')
for (const sku of [...FAILING_SKUS, ...PASSING_SKUS]) {
  const prod = await prisma.product.findFirst({
    where: { sku, deletedAt: null },
    select: {
      id: true, sku: true, brand: true,
      channelListings: {
        where: { channel: 'EBAY' },
        select: { id: true, marketplace: true, region: true, listingStatus: true, externalListingId: true, offerActive: true, platformAttributes: true },
      },
    },
  })
  if (!prod) { console.log(`  ${sku}: not found in DB`); continue }
  console.log(`\n  ${sku} (id …${prod.id.slice(-6)}) brand=${prod.brand ?? 'null'}`)
  for (const cl of prod.channelListings) {
    const pa = (cl.platformAttributes ?? {})
    const qty = pa.it_qty ?? pa.quantity ?? '?'
    console.log(`    eBay [${cl.marketplace ?? cl.region}] status=${cl.listingStatus} active=${cl.offerActive} extId=${cl.externalListingId ?? 'none'} it_qty=${qty}`)
  }
}

// ── eBay API: GET offer for each SKU ────────────────────────────────────────
console.log('\n════════════ eBay offer state ════════════')
for (const sku of [...FAILING_SKUS, ...PASSING_SKUS]) {
  const r = await fetch(`${EBAY_API}/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${MARKETPLACE_IT}`, { headers: H })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) {
    console.log(`\n  ${sku}: GET offer ${r.status} — ${JSON.stringify(body).slice(0, 200)}`)
    continue
  }
  const offers = body.offers ?? []
  console.log(`\n  ${sku}: ${offers.length} offer(s)`)
  for (const o of offers) {
    console.log(`    offerId=${o.offerId} status=${o.status} qty=${o.availableQuantity} price=${o.pricingSummary?.price?.value} currency=${o.pricingSummary?.price?.currency}`)
    console.log(`    location=${o.merchantLocationKey} fulfillment=${o.listingPolicies?.fulfillmentPolicyId ?? '—'} return=${o.listingPolicies?.returnPolicyId ?? '—'}`)
    if (o.warnings?.length) console.log(`    warnings: ${JSON.stringify(o.warnings)}`)
  }
}

// ── eBay API: GET inventory_item for each SKU ───────────────────────────────
console.log('\n════════════ eBay inventory_item availability ════════════')
for (const sku of FAILING_SKUS) {
  const r = await fetch(`${EBAY_API}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, { headers: H })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) { console.log(`\n  ${sku}: ${r.status} — ${JSON.stringify(body).slice(0, 200)}`); continue }
  const avail = body.availability
  console.log(`\n  ${sku}:`)
  console.log(`    condition=${body.condition}`)
  console.log(`    availability: ${JSON.stringify(avail)}`)
  console.log(`    imageUrls count: ${body.product?.imageUrls?.length ?? 0}`)
  const brand = Object.entries(body.product?.aspects ?? {}).find(([k]) => ['marca', 'brand', 'marke'].includes(k.toLowerCase()))
  console.log(`    brand aspect: ${brand ? `${brand[0]}=${JSON.stringify(brand[1])}` : 'NOT SET'}`)
}

await prisma.$disconnect()
