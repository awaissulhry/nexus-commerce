// Single SKU: GET → print current images → PUT with 6 → GET again to verify
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

// 1. GET current state
const getR = await fetch(`https://api.ebay.com/sell/inventory/v1/inventory_item/${encodeURIComponent(SKU)}`, { headers: H })
const item = await getR.json()
console.log('BEFORE PUT:')
console.log('  imageUrls count:', item.product?.imageUrls?.length ?? 0)
console.log('  imageUrls:', item.product?.imageUrls)
console.log('\nFull item structure keys:', Object.keys(item))
console.log('product keys:', Object.keys(item.product ?? {}))

// 2. Build clean PUT body (only the fields eBay Inventory API accepts)
const newImages = [
  'https://m.media-amazon.com/images/I/719YfFDNBOL.jpg',
  'https://m.media-amazon.com/images/I/91H1cawzU6L.jpg',
  'https://m.media-amazon.com/images/I/91IAKoHCQtL.jpg',
  'https://m.media-amazon.com/images/I/711EFrb6VAL.jpg',
  'https://m.media-amazon.com/images/I/91mwV7ACzRL.jpg',
  'https://m.media-amazon.com/images/I/51XaTLTVZOL.jpg',
]

// Build a MINIMAL clean body — only fields that inventory_item PUT accepts
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

console.log('\nPUT body imageUrls count:', newImages.length)

const putR = await fetch(`https://api.ebay.com/sell/inventory/v1/inventory_item/${encodeURIComponent(SKU)}`, {
  method: 'PUT', headers: H, body: JSON.stringify(putBody),
})
console.log('\nPUT status:', putR.status, putR.statusText)
if (!putR.ok && putR.status !== 204) {
  console.log('PUT error:', (await putR.text()).slice(0, 500))
}

// 3. GET again to verify
await new Promise(r => setTimeout(r, 2000)) // small delay
const getR2 = await fetch(`https://api.ebay.com/sell/inventory/v1/inventory_item/${encodeURIComponent(SKU)}`, { headers: H })
const item2 = await getR2.json()
console.log('\nAFTER PUT:')
console.log('  imageUrls count:', item2.product?.imageUrls?.length ?? 0)
console.log('  imageUrls:', item2.product?.imageUrls)

await prisma.$disconnect()
