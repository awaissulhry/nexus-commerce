// Full local re-push for Gale Jacket variation group.
// Ends current listing → deletes all inventory_items → re-creates with 6 images per color → re-publishes.
// Runs locally to bypass Railway's 30s proxy timeout.
import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'
import { PrismaClient } from '@prisma/client'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
const prisma = new PrismaClient()

const GROUP_KEY   = 'GALE-JACKET'
const MP          = 'IT'
const MKT_ID      = 'EBAY_IT'
const EBAY_API    = 'https://api.ebay.com'
const delay = ms => new Promise(r => setTimeout(r, ms))

// ─── Token ────────────────────────────────────────────────────────────────────
const conn = await prisma.channelConnection.findFirst({
  where: { channelType: 'EBAY', isActive: true },
  select: { accessToken: true, refreshToken: true, tokenExpiresAt: true, connectionMetadata: true },
})
if (!conn) { console.error('No active EBAY ChannelConnection'); process.exit(1) }

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

// ─── Load DB data ─────────────────────────────────────────────────────────────
console.log('\nLoading DB data...')
const allVariants = await prisma.product.findMany({
  where: { sku: { startsWith: 'GALE-JACKET' }, deletedAt: null, parentId: { not: null } },
  select: {
    id: true, sku: true,
    images: { orderBy: { sortOrder: 'asc' }, select: { url: true } },
  },
  orderBy: { sku: 'asc' },
})
// Exclude FBM (separate listing) and XXS orphan family (no category_id)
const variants = allVariants.filter(v => !v.sku.includes('FBM') && !v.sku.includes('XXS'))
const parent = await prisma.product.findFirst({
  where: { sku: GROUP_KEY, deletedAt: null },
  select: { id: true, images: { orderBy: { sortOrder: 'asc' }, select: { url: true } } },
})
console.log(`  Variants (excl. FBM+XXS): ${variants.length}`)
console.log(`  Parent images: ${parent?.images?.length ?? 0}`)

// Build colour-representative sets (first 6 per colour)
const colorRepImages = {}
for (const v of variants) {
  const m = v.sku.match(/GALE-JACKET-(BLACK|YELLOW)/i)
  const color = m?.[1]?.toLowerCase()
  if (!color || colorRepImages[color]) continue
  colorRepImages[color] = v.images.map(i => i.url).filter(Boolean).slice(0, 6)
  console.log(`  ${color.toUpperCase()}: ${colorRepImages[color].length} images (first: ${colorRepImages[color][0]?.slice(-30)})`)
}

// Group gallery: first 12 of parent's Cloudinary images
const groupImages = (parent?.images ?? []).map(i => i.url).filter(Boolean).slice(0, 12)
console.log(`  Group images: ${groupImages.length}`)

// ─── Phase 1: Read current eBay state ─────────────────────────────────────────
console.log('\nPhase 1: Reading current eBay state...')
const savedItems  = {}   // sku → inventory_item response body
const savedOffers = {}   // sku → offer response body
const offerIds    = {}   // sku → offerId

// GET the group
const groupR = await fetch(`${EBAY_API}/sell/inventory/v1/inventory_item_group/${encodeURIComponent(GROUP_KEY)}`, { headers: H })
const savedGroup = groupR.ok ? await groupR.json() : {}
console.log(`  Group: ${groupR.status} — title: ${(savedGroup.title ?? '').slice(0, 60)}`)

for (const v of variants) {
  const sku = v.sku
  // GET inventory_item
  const itemR = await fetch(`${EBAY_API}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, { headers: H })
  if (itemR.ok) {
    savedItems[sku] = await itemR.json()
  } else {
    console.log(`  WARN: GET item ${sku}: ${itemR.status}`)
  }
  await delay(120)

  // GET offer
  const offerR = await fetch(`${EBAY_API}/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${MKT_ID}`, { headers: H })
  if (offerR.ok) {
    const od = await offerR.json()
    const offer = od.offers?.[0]
    if (offer) {
      savedOffers[sku] = offer
      offerIds[sku] = offer.offerId
    }
  }
  await delay(120)
}
console.log(`  Items read: ${Object.keys(savedItems).length}/${variants.length}`)
console.log(`  Offers found: ${Object.keys(offerIds).length}/${variants.length}`)

// Resolve policies from connection metadata (fallback if some offers not found)
const connMeta  = (conn.connectionMetadata ?? {})
const policies  = (connMeta.ebayPolicies ?? {})
const savedPolicySample = savedOffers[variants[0]?.sku]?.listingPolicies ?? {}
const fulfillmentPolicyId = savedPolicySample.fulfillmentPolicyId ?? policies.fulfillmentPolicyId ?? ''
const paymentPolicyId     = savedPolicySample.paymentPolicyId     ?? policies.paymentPolicyId     ?? ''
const returnPolicyId      = savedPolicySample.returnPolicyId      ?? policies.returnPolicyId      ?? ''
const merchantLocationKey = savedOffers[variants[0]?.sku]?.merchantLocationKey ?? policies.merchantLocationKey ?? ''
const categoryId          = savedOffers[variants[0]?.sku]?.categoryId ?? ''

console.log(`  Policies — fulfillment:${fulfillmentPolicyId.slice(-6)} payment:${paymentPolicyId.slice(-6)} return:${returnPolicyId.slice(-6)}`)
console.log(`  merchantLocationKey: ${merchantLocationKey}`)
console.log(`  categoryId: ${categoryId}`)

if (!merchantLocationKey) {
  console.error('\nABORT: merchantLocationKey missing — cannot create offers without it.')
  process.exit(1)
}

// ─── Phase 2: DELETE offers (ends the listing) ─────────────────────────────────
console.log('\nPhase 2: Deleting offers (ending listing)...')
let delOfferOk = 0, delOfferFail = 0
for (const [sku, offerId] of Object.entries(offerIds)) {
  const r = await fetch(`${EBAY_API}/sell/inventory/v1/offer/${offerId}`, { method: 'DELETE', headers: H })
  if (r.ok || r.status === 204 || r.status === 200) {
    console.log(`  ✓ offer ${offerId} (${sku.slice(-12)})`)
    delOfferOk++
  } else {
    console.log(`  ✗ ${sku}: ${r.status} ${(await r.text()).slice(0, 120)}`)
    delOfferFail++
  }
  await delay(200)
}
console.log(`  Deleted: ${delOfferOk}  Failed: ${delOfferFail}`)
if (delOfferFail > 0) {
  console.error('\nABORT: offer deletion failed — listing may still be active. Fix before retrying.')
  process.exit(1)
}

// Give eBay 3s to propagate the listing end
console.log('  Waiting 3s for eBay to end the listing...')
await delay(3000)

// ─── Phase 3: DELETE inventory_items ─────────────────────────────────────────
console.log('\nPhase 3: Deleting inventory_items...')
let delItemOk = 0, delItemFail = 0
for (const v of variants) {
  const sku = v.sku
  const r = await fetch(`${EBAY_API}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, { method: 'DELETE', headers: H })
  if (r.ok || r.status === 204 || r.status === 200 || r.status === 404) {
    console.log(`  ✓ ${sku.slice(-20)}`)
    delItemOk++
  } else {
    const txt = (await r.text()).slice(0, 150)
    console.log(`  ✗ ${sku}: ${r.status} ${txt}`)
    delItemFail++
  }
  await delay(200)
}
console.log(`  Deleted: ${delItemOk}  Failed: ${delItemFail}`)
await delay(2000)

// ─── Phase 4: Re-PUT inventory_items with 6 images per colour ─────────────────
console.log('\nPhase 4: Re-creating inventory_items (6 images per colour)...')
let createOk = 0, createFail = 0
for (const v of variants) {
  const sku = v.sku
  const m = sku.match(/GALE-JACKET-(BLACK|YELLOW)/i)
  const color = m?.[1]?.toLowerCase()
  const images = colorRepImages[color] ?? []
  const prev = savedItems[sku] ?? {}
  const body = {
    condition: prev.condition ?? 'NEW',
    availability: prev.availability ?? { shipToLocationAvailability: { quantity: 999 } },
    product: {
      title: prev.product?.title ?? sku,
      description: prev.product?.description ?? '',
      imageUrls: images,
      aspects: prev.product?.aspects ?? {},
      ean: prev.product?.ean?.length ? prev.product.ean : ['Does not apply'],
      mpn: prev.product?.mpn ?? 'Does not apply',
    },
  }
  if (prev.packageWeightAndSize) body.packageWeightAndSize = prev.packageWeightAndSize

  const r = await fetch(`${EBAY_API}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, {
    method: 'PUT', headers: H, body: JSON.stringify(body),
  })
  if (r.ok || r.status === 204) {
    console.log(`  ✓ ${sku.slice(-20)}  imgs=${images.length}`)
    createOk++
  } else {
    const txt = (await r.text()).slice(0, 200)
    console.log(`  ✗ ${sku}: ${r.status} ${txt}`)
    createFail++
  }
  await delay(150)
}
console.log(`  Created: ${createOk}  Failed: ${createFail}`)
await delay(1000)

// ─── Phase 5: Re-PUT group ─────────────────────────────────────────────────────
console.log('\nPhase 5: Re-creating inventory_item_group...')
const groupBody = {
  title: savedGroup.title ?? `Gale Jacket — variation group`,
  description: savedGroup.description ?? '',
  imageUrls: groupImages,
  variantSKUs: variants.map(v => v.sku),
  variesBy: savedGroup.variesBy ?? {
    aspectsImageVariesBy: ['Color'],
    specifications: [
      { name: 'Color', values: ['Nero', 'Giallo'] },
      { name: 'Size',  values: ['XS','S','M','L','XL','XXL','3XL','4XL','5XL'] },
    ],
  },
}
const groupPutR = await fetch(`${EBAY_API}/sell/inventory/v1/inventory_item_group/${encodeURIComponent(GROUP_KEY)}`, {
  method: 'PUT', headers: H, body: JSON.stringify(groupBody),
})
if (groupPutR.ok || groupPutR.status === 204) {
  console.log(`  ✓ Group updated — ${groupImages.length} images, ${variants.length} SKUs`)
} else {
  console.log(`  ✗ Group PUT: ${groupPutR.status} ${(await groupPutR.text()).slice(0, 300)}`)
}
await delay(1000)

// ─── Phase 6: Create new offers ───────────────────────────────────────────────
console.log('\nPhase 6: Creating offers...')
const newOfferIds = {}   // sku → new offerId
let offerOk = 0, offerFail = 0
for (const v of variants) {
  const sku = v.sku
  const prev = savedOffers[sku]

  const offerBody = {
    sku,
    marketplaceId: MKT_ID,
    format: prev?.format ?? 'FIXED_PRICE',
    availableQuantity: prev?.availableQuantity ?? 999,
    categoryId: prev?.categoryId ?? categoryId,
    listingDescription: prev?.listingDescription ?? (savedGroup.description ?? ''),
    listingPolicies: {
      ...(fulfillmentPolicyId ? { fulfillmentPolicyId } : {}),
      ...(paymentPolicyId     ? { paymentPolicyId }     : {}),
      ...(returnPolicyId      ? { returnPolicyId }      : {}),
    },
    pricingSummary: prev?.pricingSummary ?? { price: { value: '0.00', currency: 'EUR' } },
    merchantLocationKey,
    quantityLimitPerBuyer: 10,
  }
  if (prev?.tax) offerBody.tax = prev.tax

  const r = await fetch(`${EBAY_API}/sell/inventory/v1/offer`, {
    method: 'POST', headers: H, body: JSON.stringify(offerBody),
  })
  if (r.ok || r.status === 201) {
    const od = await r.json().catch(() => ({}))
    newOfferIds[sku] = od.offerId
    console.log(`  ✓ ${sku.slice(-20)}  offerId=${od.offerId}`)
    offerOk++
  } else {
    const txt = (await r.text()).slice(0, 250)
    console.log(`  ✗ ${sku}: ${r.status} ${txt}`)
    offerFail++
  }
  await delay(150)
}
console.log(`  Created: ${offerOk}  Failed: ${offerFail}`)
if (offerOk === 0) {
  console.error('\nABORT: zero offers created — cannot publish.')
  process.exit(1)
}
await delay(1000)

// ─── Phase 7: Publish ─────────────────────────────────────────────────────────
console.log('\nPhase 7: Publishing variation group...')
const pubRes = await fetch(`${EBAY_API}/sell/inventory/v1/offer/publish_by_inventory_item_group`, {
  method: 'POST', headers: H,
  body: JSON.stringify({ inventoryItemGroupKey: GROUP_KEY, marketplaceId: MKT_ID }),
})
const pubData = await pubRes.json().catch(() => ({}))
console.log(`  Status: ${pubRes.status}`)
let listingId = pubData.listingId
console.log(`  listingId (from publish): ${listingId ?? '(none)'}`)

if (pubData.errors?.length) {
  console.log('  Publish errors:')
  pubData.errors.forEach(e => console.log(`    [${e.errorId}] ${e.message}`))
}

// Fallback: GET offer to extract listingId
if (!listingId) {
  await delay(3000)
  const firstSku = variants[0]?.sku
  const checkR = await fetch(`${EBAY_API}/sell/inventory/v1/offer?sku=${encodeURIComponent(firstSku)}&marketplace_id=${MKT_ID}`, { headers: H })
  if (checkR.ok) {
    const od = await checkR.json().catch(() => ({}))
    listingId = od.offers?.[0]?.listing?.listingId
    console.log(`  listingId (from offer GET): ${listingId ?? '(none)'}`)
  }
}

// ─── Phase 8: Verify images were set correctly ─────────────────────────────────
if (pubRes.ok || pubRes.status === 200) {
  console.log('\nPhase 8: Verifying images on re-created items...')
  await delay(2000)
  for (const color of Object.keys(colorRepImages)) {
    const sample = variants.find(v => v.sku.toUpperCase().includes(color.toUpperCase()))
    if (!sample) continue
    const checkR = await fetch(`${EBAY_API}/sell/inventory/v1/inventory_item/${encodeURIComponent(sample.sku)}`, { headers: H })
    if (checkR.ok) {
      const item = await checkR.json().catch(() => ({}))
      const count = item.product?.imageUrls?.length ?? 0
      const first = item.product?.imageUrls?.[0]?.slice(-40) ?? ''
      console.log(`  ${color.toUpperCase()}: ${count} images  (${first})`)
    }
  }
}

// ─── Phase 9: Update DB ────────────────────────────────────────────────────────
console.log('\nPhase 9: Updating DB channelListings...')
const productIds = variants.map(v => v.id).filter(Boolean)
if (productIds.length > 0 && listingId) {
  const updated = await prisma.channelListing.updateMany({
    where: { productId: { in: productIds }, channel: 'EBAY', region: 'IT' },
    data: { externalListingId: listingId, listingStatus: 'ACTIVE', offerActive: true },
  })
  console.log(`  Updated ${updated.count} channelListing rows`)
} else if (!listingId) {
  // Mark ACTIVE without listingId (listing is live but we don't have the ID)
  await prisma.channelListing.updateMany({
    where: { productId: { in: productIds }, channel: 'EBAY', region: 'IT' },
    data: { listingStatus: 'ACTIVE', offerActive: true },
  }).catch(() => {})
  console.log('  WARN: listingId not obtained — status set to ACTIVE but externalListingId not updated')
}

console.log('\n═══════════════════════════════')
console.log('  Re-push complete')
console.log(`  Variants re-created: ${createOk}/${variants.length}`)
console.log(`  Offers created:      ${offerOk}/${variants.length}`)
console.log(`  Listing ID:          ${listingId ?? 'unknown'}`)
if (listingId) console.log(`  View: https://www.ebay.it/itm/${listingId}`)
console.log('═══════════════════════════════')

await prisma.$disconnect()
