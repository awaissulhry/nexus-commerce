// Fix error 25002: Re-PUT the group with Marca aspect, then retry publish.
// The full re-push (phases 1-6) already ran; items + offers exist.
// This script only fixes the group body and publishes.
import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'
import { PrismaClient } from '@prisma/client'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
const prisma = new PrismaClient()

const GROUP_KEY = 'GALE-JACKET'
const MKT_ID   = 'EBAY_IT'
const EBAY_API = 'https://api.ebay.com'
const delay = ms => new Promise(r => setTimeout(r, ms))

// ─── Token ─────────────────────────────────────────────────────────────────────
const conn = await prisma.channelConnection.findFirst({
  where: { channelType: 'EBAY', isActive: true },
  select: { accessToken: true, refreshToken: true, tokenExpiresAt: true },
})
let tok = conn.accessToken
if (!tok || (conn.tokenExpiresAt && new Date(conn.tokenExpiresAt) <= new Date())) {
  const creds = Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString('base64')
  const r = await fetch(`${EBAY_API}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${creds}` },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: conn.refreshToken }),
  })
  tok = (await r.json()).access_token
  if (!tok) { console.error('Token refresh failed'); process.exit(1) }
  console.log('Token refreshed')
}
const H = {
  Authorization: `Bearer ${tok}`,
  'Content-Type': 'application/json',
  'Content-Language': 'it-IT',
  'Accept-Language': 'it-IT',
  'X-EBAY-C-MARKETPLACE-ID': MKT_ID,
}

// ─── Step 1: GET current group ─────────────────────────────────────────────────
console.log('Step 1: Reading current group...')
const gRes = await fetch(`${EBAY_API}/sell/inventory/v1/inventory_item_group/${encodeURIComponent(GROUP_KEY)}`, { headers: H })
if (!gRes.ok) { console.error('Group GET failed:', gRes.status, await gRes.text()); process.exit(1) }
const g = await gRes.json()
console.log(`  Title: ${g.title}`)
console.log(`  SKUs: ${g.variantSKUs?.length ?? 0}`)
console.log(`  Images: ${g.imageUrls?.length ?? 0}`)
console.log(`  Current aspects: ${JSON.stringify(g.aspects ?? {})}`)
console.log(`  variesBy.aspectsImageVariesBy: ${JSON.stringify(g.variesBy?.aspectsImageVariesBy)}`)

// ─── Step 2: Re-PUT group with Brand aspect ────────────────────────────────────
console.log('\nStep 2: Re-PUT group with Marca=Xavia aspect...')
const fixedGroupBody = {
  inventoryItemGroupKey: GROUP_KEY,
  title: g.title,
  description: g.description ?? '',
  imageUrls: g.imageUrls ?? [],
  variantSKUs: g.variantSKUs ?? [],
  variesBy: g.variesBy ?? {
    aspectsImageVariesBy: ['Color'],
    specifications: [
      { name: 'Color', values: ['Nero', 'Giallo'] },
      { name: 'Size',  values: ['XS','S','M','L','XL','XXL','3XL','4XL','5XL'] },
    ],
  },
  aspects: {
    'Marca': ['Xavia'],
  },
}

const putRes = await fetch(`${EBAY_API}/sell/inventory/v1/inventory_item_group/${encodeURIComponent(GROUP_KEY)}`, {
  method: 'PUT', headers: H, body: JSON.stringify(fixedGroupBody),
})
if (putRes.ok || putRes.status === 204) {
  console.log(`  ✓ Group updated with Marca aspect (status ${putRes.status})`)
} else {
  const txt = await putRes.text()
  console.error(`  ✗ Group PUT failed: ${putRes.status} ${txt}`)
  process.exit(1)
}

// ─── Step 3: Wait for eBay to index ───────────────────────────────────────────
console.log('\nStep 3: Waiting 15s for eBay to index updated group...')
await delay(15000)

// Verify the group has Marca now
const gVerify = await fetch(`${EBAY_API}/sell/inventory/v1/inventory_item_group/${encodeURIComponent(GROUP_KEY)}`, { headers: H })
if (gVerify.ok) {
  const gv = await gVerify.json()
  console.log(`  Verified aspects: ${JSON.stringify(gv.aspects ?? {})}`)
  const hasMarca = gv.aspects?.['Marca']?.length > 0
  console.log(`  Marca present: ${hasMarca ? '✓' : '✗ MISSING — may still fail'}`)
}

// ─── Step 4: Publish with retries ─────────────────────────────────────────────
console.log('\nStep 4: Publishing variation group...')
let listingId = null
for (let attempt = 1; attempt <= 3; attempt++) {
  if (attempt > 1) {
    console.log(`\n  Waiting 30s before attempt ${attempt}...`)
    await delay(30000)
  }

  const pubRes = await fetch(`${EBAY_API}/sell/inventory/v1/offer/publish_by_inventory_item_group`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ inventoryItemGroupKey: GROUP_KEY, marketplaceId: MKT_ID }),
  })
  const pubData = await pubRes.json().catch(() => ({}))
  console.log(`  Attempt ${attempt}/3 — status ${pubRes.status}`)

  if (pubData.errors?.length) {
    pubData.errors.forEach(e => console.log(`    Error [${e.errorId}]: ${e.message}`))
  }
  if (pubData.warnings?.length) {
    pubData.warnings.forEach(w => console.log(`    Warning [${w.errorId}]: ${w.message}`))
  }

  if (pubRes.ok || pubRes.status === 200) {
    listingId = pubData.listingId
    console.log(`  ✓ Published! listingId: ${listingId}`)
    break
  }
}

// Fallback: check offer for listingId
if (!listingId) {
  console.log('\n  Checking offer for listingId (fallback)...')
  await delay(5000)
  const firstSku = g.variantSKUs?.[0]
  if (firstSku) {
    const ofR = await fetch(`${EBAY_API}/sell/inventory/v1/offer?sku=${encodeURIComponent(firstSku)}&marketplace_id=${MKT_ID}`, { headers: H })
    if (ofR.ok) {
      const od = await ofR.json().catch(() => ({}))
      listingId = od.offers?.[0]?.listing?.listingId
      console.log(`  listingId from offer: ${listingId ?? '(none)'}`)
    }
  }
}

if (!listingId) {
  console.error('\n✗ Publish failed after 3 attempts — listing NOT live. Check eBay Seller Hub.')
  await prisma.$disconnect()
  process.exit(1)
}

// ─── Step 5: Verify images post-publish ───────────────────────────────────────
console.log('\nStep 5: Verifying images post-publish (3s wait)...')
await delay(3000)
for (const sku of ['GALE-JACKET-BLACK-MEN-M', 'GALE-JACKET-YELLOW-MEN-M']) {
  const r = await fetch(`${EBAY_API}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, { headers: H })
  if (r.ok) {
    const item = await r.json().catch(() => ({}))
    const urls = item.product?.imageUrls ?? []
    console.log(`  ${sku}: ${urls.length} images`)
    urls.forEach(u => console.log(`    - ${u.slice(0, 80)}`))
  }
}

// ─── Step 6: Update DB ─────────────────────────────────────────────────────────
console.log('\nStep 6: Updating DB channelListings...')
const variants = await prisma.product.findMany({
  where: { sku: { startsWith: 'GALE-JACKET' }, deletedAt: null, parentId: { not: null } },
  select: { id: true, sku: true },
})
const productIds = variants.filter(v => !v.sku.includes('FBM') && !v.sku.includes('XXS')).map(v => v.id)
if (productIds.length > 0) {
  const updated = await prisma.channelListing.updateMany({
    where: { productId: { in: productIds }, channel: 'EBAY', region: 'IT' },
    data: { externalListingId: listingId, listingStatus: 'ACTIVE', offerActive: true },
  })
  console.log(`  ✓ Updated ${updated.count} channelListing rows → externalListingId=${listingId}`)
} else {
  console.log('  No variant rows found in DB')
}

console.log(`\n✓ Done! View listing: https://www.ebay.it/itm/${listingId}`)
await prisma.$disconnect()
