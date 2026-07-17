// Definitive test: send 5 images where NONE match the existing 3.
// If eBay still shows the original 3 → eBay is silently ignoring the update.
// If eBay shows any of the new 5 → eBay accepted but may cap at 3.
import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'
import { PrismaClient } from '@prisma/client'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
const prisma = new PrismaClient()

const SKU = 'GALE-JACKET-BLACK-MEN-M'
const MARKETPLACE = 'EBAY_IT'

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

const getR = await fetch(`https://api.ebay.com/sell/inventory/v1/inventory_item/${encodeURIComponent(SKU)}`, { headers: H })
const item = await getR.json()
const existingUrls = item.product?.imageUrls ?? []
console.log('BEFORE: count=' + existingUrls.length)
existingUrls.forEach(u => console.log('  ' + u))

// Use images 4-8 — completely different from images 1-3 currently on eBay
const newImages = [
  'https://m.media-amazon.com/images/I/711EFrb6VAL.jpg',
  'https://m.media-amazon.com/images/I/91mwV7ACzRL.jpg',
  'https://m.media-amazon.com/images/I/51XaTLTVZOL.jpg',
  'https://m.media-amazon.com/images/I/A1WgzcXIPUL.jpg',
  'https://m.media-amazon.com/images/I/91x4vzVKTZL.jpg',
]
console.log('\nPUT with 5 completely new images (none matching existing):')
newImages.forEach(u => console.log('  ' + u))

const putBody = {
  condition: item.condition ?? 'NEW',
  availability: item.availability,
  product: {
    title: item.product.title,
    description: item.product.description ?? '',
    imageUrls: newImages,
    aspects: item.product.aspects ?? {},
    ean: item.product.ean ?? ['Does not apply'],
    mpn: item.product.mpn ?? 'Does not apply',
  },
}
if (item.packageWeightAndSize) putBody.packageWeightAndSize = item.packageWeightAndSize

const putR = await fetch(`https://api.ebay.com/sell/inventory/v1/inventory_item/${encodeURIComponent(SKU)}`, {
  method: 'PUT', headers: H, body: JSON.stringify(putBody),
})
console.log('\nPUT status:', putR.status, putR.statusText)
if (putR.status !== 204) console.log('body:', (await putR.text()).slice(0, 500))

// Wait 15 seconds for eBay to process
console.log('Waiting 15s for eBay to process...')
await new Promise(r => setTimeout(r, 15000))

const getR2 = await fetch(`https://api.ebay.com/sell/inventory/v1/inventory_item/${encodeURIComponent(SKU)}`, { headers: H })
const item2 = await getR2.json()
const afterUrls = item2.product?.imageUrls ?? []
console.log('\nAFTER (15s): count=' + afterUrls.length)
afterUrls.forEach(u => console.log('  ' + u))

const overlap = afterUrls.filter(u => existingUrls.includes(u))
const fresh = afterUrls.filter(u => !existingUrls.includes(u))
console.log('\nDiagnosis:')
console.log('  URLs matching original:', overlap.length, overlap)
console.log('  URLs from new set:', fresh.length, fresh)
if (afterUrls.length === existingUrls.length && overlap.length === existingUrls.length) {
  console.log('\n  → eBay IGNORED the PUT entirely (images unchanged)')
} else if (fresh.length > 0) {
  console.log('\n  → eBay ACCEPTED the PUT (new URLs present)')
  if (afterUrls.length < newImages.length) console.log('  → eBay CAPPED at ' + afterUrls.length + ' images')
} else {
  console.log('\n  → Ambiguous result')
}

await prisma.$disconnect()
