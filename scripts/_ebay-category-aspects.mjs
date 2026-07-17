// Check category aspect requirements for EBAY_IT category 177104 (Giacche moto)
// Also check if GTIN exemption is active for this account
import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'
import { PrismaClient } from '@prisma/client'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
const prisma = new PrismaClient()

const CATEGORY_ID = '177104'
const MARKETPLACE_IT = 'EBAY_IT'

// Get token
const conn = await prisma.channelConnection.findFirst({
  where: { channelType: 'EBAY', isActive: true },
  select: { id: true, accessToken: true, refreshToken: true, tokenExpiresAt: true },
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
const H = { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }

// 1. Check category aspect metadata — which aspects are required vs optional
console.log(`\n════ Category aspects for ${CATEGORY_ID} on ${MARKETPLACE_IT} ════`)
const aspRes = await fetch(
  `https://api.ebay.com/sell/metadata/v1/marketplace/${MARKETPLACE_IT}/get_item_aspects_for_category?category_id=${CATEGORY_ID}`,
  { headers: H }
)
if (!aspRes.ok) {
  console.log(`aspects API ${aspRes.status}: ${(await aspRes.text()).slice(0, 300)}`)
} else {
  const data = await aspRes.json()
  const aspects = data.aspects ?? []
  const required  = aspects.filter(a => a.aspectConstraint?.aspectRequired === true)
  const eanRelated = aspects.filter(a => /ean|gtin|upc|isbn|barcode/i.test(a.localizedAspectName))
  console.log(`Total aspects: ${aspects.length}  Required: ${required.length}`)
  console.log('\nRequired aspects:')
  for (const a of required) {
    const mode = a.aspectConstraint?.itemToAspectCardinality ?? '?'
    const vals = (a.aspectValues ?? []).slice(0, 5).map(v => v.localizedValue).join(', ')
    console.log(`  [REQUIRED] ${a.localizedAspectName}  cardinality=${mode}  sampleValues=${vals || '(free text)'}`)
  }
  console.log('\nEAN/GTIN-related aspects:')
  for (const a of eanRelated) {
    const req = a.aspectConstraint?.aspectRequired ? 'REQUIRED' : 'optional'
    const vals = (a.aspectValues ?? []).slice(0, 10).map(v => v.localizedValue).join(', ')
    console.log(`  [${req}] ${a.localizedAspectName}  values=${vals || '(free text)'}`)
  }
}

// 2. Check the current stored inventory item for one of the failing SKUs to see what eBay has
console.log('\n════ Current eBay inventory_item state for GALE-JACKET-BLACK-MEN-3XL ════')
const invRes = await fetch('https://api.ebay.com/sell/inventory/v1/inventory_item/GALE-JACKET-BLACK-MEN-3XL', {
  headers: { ...H, 'X-EBAY-C-MARKETPLACE-ID': MARKETPLACE_IT, 'Content-Language': 'it-IT', 'Accept-Language': 'it-IT' }
})
if (!invRes.ok) {
  console.log(`${invRes.status}: ${(await invRes.text()).slice(0, 200)}`)
} else {
  const item = await invRes.json()
  console.log('aspects:', JSON.stringify(item.product?.aspects ?? {}, null, 2))
  console.log('ean field:', item.product?.ean ?? 'not set')
  console.log('epid:', item.product?.epid ?? 'not set')
  console.log('mpn:', item.product?.mpn ?? 'not set')
}

await prisma.$disconnect()
