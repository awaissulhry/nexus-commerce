// Retry just the publish step for GALE-JACKET group (after items + offers are already created).
// Error 25604 "Prodotto non trovato" is a timing issue — eBay needs ~30s to index new items.
import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'
import { PrismaClient } from '@prisma/client'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
const prisma = new PrismaClient()

const GROUP_KEY = 'GALE-JACKET'
const MKT_ID   = 'EBAY_IT'
const EBAY_API = 'https://api.ebay.com'
const delay = ms => new Promise(r => setTimeout(r, ms))

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
  console.log('Token refreshed')
}
const H = {
  Authorization: `Bearer ${tok}`,
  'Content-Type': 'application/json',
  'Content-Language': 'it-IT', 'Accept-Language': 'it-IT',
  'X-EBAY-C-MARKETPLACE-ID': MKT_ID,
}

// Verify items + group are ready before publishing
console.log('Verifying group state...')
const groupR = await fetch(`${EBAY_API}/sell/inventory/v1/inventory_item_group/${encodeURIComponent(GROUP_KEY)}`, { headers: H })
if (!groupR.ok) { console.error('Group not found:', groupR.status); process.exit(1) }
const g = await groupR.json()
console.log(`  Group SKUs: ${g.variantSKUs?.length ?? 0}`)
console.log(`  Group images: ${g.imageUrls?.length ?? 0}`)
console.log(`  aspectsImageVariesBy: ${JSON.stringify(g.variesBy?.aspectsImageVariesBy)}`)

// Check first variant
const firstSku = g.variantSKUs?.[0]
if (firstSku) {
  const itemR = await fetch(`${EBAY_API}/sell/inventory/v1/inventory_item/${encodeURIComponent(firstSku)}`, { headers: H })
  if (itemR.ok) {
    const item = await itemR.json()
    console.log(`  Sample item ${firstSku}: imageUrls=${item.product?.imageUrls?.length ?? 0}`)
  }
}

// Retry publish up to 3 times with 30s wait between attempts
let listingId = null
for (let attempt = 1; attempt <= 3; attempt++) {
  console.log(`\nPublish attempt ${attempt}/3...`)
  if (attempt > 1) {
    console.log(`  Waiting 30s for eBay indexing...`)
    await delay(30000)
  }

  const pubRes = await fetch(`${EBAY_API}/sell/inventory/v1/offer/publish_by_inventory_item_group`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ inventoryItemGroupKey: GROUP_KEY, marketplaceId: MKT_ID }),
  })
  const pubData = await pubRes.json().catch(() => ({}))
  console.log(`  Status: ${pubRes.status}`)

  if (pubData.errors?.length) {
    pubData.errors.forEach(e => console.log(`  Error [${e.errorId}]: ${e.message}`))
  }

  if (pubRes.ok || pubRes.status === 200) {
    listingId = pubData.listingId
    console.log(`  ✓ Published! listingId: ${listingId ?? '(checking via offer GET)'}`)
    break
  }
}

// Fallback: GET offer to find listingId
if (!listingId && firstSku) {
  await delay(5000)
  const offerR = await fetch(`${EBAY_API}/sell/inventory/v1/offer?sku=${encodeURIComponent(firstSku)}&marketplace_id=${MKT_ID}`, { headers: H })
  if (offerR.ok) {
    const od = await offerR.json().catch(() => ({}))
    listingId = od.offers?.[0]?.listing?.listingId
    console.log(`listingId (from offer GET): ${listingId ?? '(none)'}`)
  }
}

if (!listingId) {
  console.log('\n⚠ Publish did not return a listingId — check eBay Seller Hub manually')
  process.exit(0)
}

// Verify images on re-created items
console.log('\nVerifying images post-publish...')
await delay(3000)
const SAMPLE_SKUS = ['GALE-JACKET-BLACK-MEN-M', 'GALE-JACKET-YELLOW-MEN-M']
for (const sku of SAMPLE_SKUS) {
  const r = await fetch(`${EBAY_API}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, { headers: H })
  if (r.ok) {
    const item = await r.json().catch(() => ({}))
    console.log(`  ${sku}: ${item.product?.imageUrls?.length ?? 0} images`)
  }
}

// Update DB
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
  console.log(`\nDB updated: ${updated.count} channelListing rows → listingId=${listingId}`)
}

console.log(`\n✓ View listing: https://www.ebay.it/itm/${listingId}`)
await prisma.$disconnect()
