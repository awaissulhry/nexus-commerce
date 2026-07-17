// Diagnose the Gale Jacket image situation end-to-end.
// Key question: do same-colour variants carry different URLs on eBay?
import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'
import { PrismaClient } from '@prisma/client'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
const prisma = new PrismaClient()

// ── eBay token ───────────────────────────────────────────────────────────────
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
  'Content-Language': 'it-IT', 'Accept-Language': 'it-IT',
  'X-EBAY-C-MARKETPLACE-ID': 'EBAY_IT',
}

// ── 1. DB: Amazon ChannelListing images per variant ──────────────────────────
console.log('════ DB: Amazon imageUrls per Gale variant ════\n')
const galeVariants = await prisma.product.findMany({
  where: {
    sku: { startsWith: 'GALE-JACKET', not: { contains: 'FBM' } },
    deletedAt: null,
    parentId: { not: null },
  },
  select: {
    sku: true,
    channelListings: {
      where: { channel: 'AMAZON' },
      select: { platformAttributes: true },
      take: 1,
    },
    images: {
      orderBy: { sortOrder: 'asc' },
      select: { url: true, type: true },
      take: 10,
    },
  },
  orderBy: { sku: 'asc' },
})

console.log(`${galeVariants.length} variants found\n`)

const dbColourUrls = {} // colour → Set<url>
for (const p of galeVariants) {
  const colour = (p.sku.match(/GALE-JACKET-(BLACK|YELLOW)/i)?.[1] ?? 'unknown').toLowerCase()
  const attrs = (p.channelListings[0]?.platformAttributes ?? {})
  const paUrls = Array.isArray(attrs.imageUrls)
    ? attrs.imageUrls.filter(Boolean)
    : Array.isArray(attrs.main_product_image_locator)
      ? attrs.main_product_image_locator.map(l => l?.media_location).filter(Boolean)
      : []
  const piUrls = p.images.map(i => i.url)
  const allUrls = [...new Set([...paUrls, ...piUrls])]

  if (!dbColourUrls[colour]) dbColourUrls[colour] = new Set()
  for (const u of allUrls) dbColourUrls[colour].add(u)

  console.log(`  ${p.sku.padEnd(32)} PA=${paUrls.length}  PI=${piUrls.length}  total=${allUrls.length}`)
}

console.log('\n── Unique URL count across same-colour variants in DB ──')
for (const [colour, urls] of Object.entries(dbColourUrls)) {
  console.log(`  ${colour.toUpperCase()}: ${urls.size} unique URLs`)
  ;[...urls].slice(0, 4).forEach(u => console.log(`    ${u.slice(0, 90)}`))
  if (urls.size > 4) console.log(`    … +${urls.size - 4} more`)
}

// ── 2. eBay LIVE: what does each variant actually have right now? ─────────────
console.log('\n════ eBay LIVE: imageUrls per inventory_item ════\n')
const ebayColourUrls = {}

for (const p of galeVariants) {
  const sku = p.sku
  const colour = (sku.match(/GALE-JACKET-(BLACK|YELLOW)/i)?.[1] ?? 'unknown').toLowerCase()

  const r = await fetch(
    `https://api.ebay.com/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
    { headers: H }
  )
  if (!r.ok) { console.log(`  ${sku}: HTTP ${r.status}`); continue }
  const item = await r.json()
  const urls = item.product?.imageUrls ?? []

  if (!ebayColourUrls[colour]) ebayColourUrls[colour] = new Set()
  for (const u of urls) ebayColourUrls[colour].add(u)

  console.log(`  ${sku.padEnd(32)} eBay imageUrls=${urls.length}  first=${urls[0]?.slice(0, 70) ?? '(none)'}`)
}

console.log('\n── Unique URLs currently on eBay per colour ──')
for (const [colour, urls] of Object.entries(ebayColourUrls)) {
  const variantCount = galeVariants.filter(p => p.sku.toLowerCase().includes(colour)).length
  console.log(`  ${colour.toUpperCase()} (${variantCount} size variants): ${urls.size} unique URLs on eBay`)
  console.log(`  → Buyer selecting ${colour.toUpperCase()} will see UP TO ${urls.size} images`)
}

// ── 3. eBay group ─────────────────────────────────────────────────────────────
console.log('\n════ eBay group GALE-JACKET ════')
const grpR = await fetch('https://api.ebay.com/sell/inventory/v1/inventory_item_group/GALE-JACKET', { headers: H })
if (grpR.ok) {
  const g = await grpR.json()
  const specs = g.variesBy?.specifications ?? []
  console.log(`  specifications: ${specs.map(s => `${s.name}[${s.values?.join(',')}]`).join(' | ')}`)
  console.log(`  imageVariesByAxes: ${JSON.stringify(g.variesBy?.aspectsImageVariesBy)}`)
  console.log(`  group imageUrls: ${g.product?.imageUrls?.length ?? 0}`)
} else {
  console.log(`  GET group failed: ${grpR.status}`)
}

await prisma.$disconnect()
