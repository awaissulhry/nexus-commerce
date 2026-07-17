// Directly update inventory_item images for all Gale Jacket variants using
// ProductImage rows (the canonical source — 7-8 for Black, 10 for Yellow).
// Runs locally against eBay API — bypasses Railway timeout entirely.
// Only updates imageUrls on existing inventory_items; does NOT re-create offers
// or re-publish the group (listing stays live throughout).
import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'
import { PrismaClient } from '@prisma/client'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
const prisma = new PrismaClient()

const MARKETPLACE = 'EBAY_IT'

// ── Token ────────────────────────────────────────────────────────────────────
const conn = await prisma.channelConnection.findFirst({
  where: { channelType: 'EBAY', isActive: true },
  select: { accessToken: true, refreshToken: true, tokenExpiresAt: true },
})
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
  'Content-Language': 'it-IT', 'Accept-Language': 'it-IT',
  'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE,
}

// ── 1. Fetch variant SKUs + ProductImage rows ────────────────────────────────
const variants = await prisma.product.findMany({
  where: {
    sku: { startsWith: 'GALE-JACKET', not: { contains: 'FBM' } },
    deletedAt: null,
    parentId: { not: null }, // variants only, skip parent
  },
  select: {
    sku: true,
    images: { orderBy: { sortOrder: 'asc' }, select: { url: true } },
  },
  orderBy: { sku: 'asc' },
})
console.log(`Found ${variants.length} Gale variants in DB`)

// ── 2. Build colour-representative image sets ─────────────────────────────────
// All BLACK variants get the same 6 images (from the first BLACK variant).
// All YELLOW variants get the same 6 images (from the first YELLOW variant).
const colorRepImages = {}
for (const p of variants) {
  const colour = p.sku.match(/GALE-JACKET-(BLACK|YELLOW)/i)?.[1]?.toLowerCase() ?? 'unknown'
  if (colorRepImages[colour]) continue // already have representative
  const urls = p.images.map(i => i.url).filter(Boolean).slice(0, 6)
  colorRepImages[colour] = urls
  console.log(`  colour rep: ${colour.toUpperCase()} from ${p.sku} → ${urls.length} images`)
  urls.forEach(u => console.log(`    ${u.slice(0, 90)}`))
}

// ── 3. GET current inventory_item + PATCH imageUrls ───────────────────────────
console.log('\nUpdating inventory_item imageUrls on eBay…')
let ok = 0, fail = 0

for (const p of variants) {
  const sku = p.sku
  const colour = sku.match(/GALE-JACKET-(BLACK|YELLOW)/i)?.[1]?.toLowerCase() ?? 'unknown'
  const newImages = colorRepImages[colour] ?? []

  if (newImages.length === 0) {
    console.log(`  SKIP ${sku} — no images for colour ${colour}`)
    continue
  }

  // GET the current inventory_item so we can PUT back the full body with updated images
  const getR = await fetch(`https://api.ebay.com/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, { headers: H })
  if (!getR.ok) {
    console.log(`  ERROR ${sku}: GET ${getR.status} ${(await getR.text()).slice(0, 100)}`)
    fail++; continue
  }
  const item = await getR.json()

  // Replace imageUrls, keep everything else intact
  const updated = {
    ...item,
    product: { ...item.product, imageUrls: newImages },
  }
  delete updated.sku // sku goes in URL, not body
  delete updated.locale // read-only field

  const putR = await fetch(`https://api.ebay.com/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, {
    method: 'PUT', headers: H, body: JSON.stringify(updated),
  })

  if (putR.ok || putR.status === 204) {
    console.log(`  ✓ ${sku}  images=${newImages.length}`)
    ok++
  } else {
    const err = (await putR.text().catch(() => '')).slice(0, 200)
    console.log(`  ✗ ${sku}: PUT ${putR.status} ${err}`)
    fail++
  }
}

console.log(`\nDone: ${ok} updated, ${fail} failed`)
await prisma.$disconnect()
