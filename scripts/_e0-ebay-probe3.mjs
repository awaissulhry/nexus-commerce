// E0 read-only probe 3: per-item Site / category / SKU / variation shape for
// all live listings + EbayCampaign table contents. NO WRITES.
import dotenv from 'dotenv'
import { PrismaClient } from '@prisma/client'
dotenv.config({ path: '/Users/awais/nexus-commerce/.env' })
const prisma = new PrismaClient()

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

async function trading(callName, bodyXml, siteId = '101') {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents">
${bodyXml}
</${callName}Request>`
  const r = await fetch('https://api.ebay.com/ws/api.dll', {
    method: 'POST',
    headers: {
      'X-EBAY-API-COMPATIBILITY-LEVEL': '1193',
      'X-EBAY-API-CALL-NAME': callName,
      'X-EBAY-API-SITEID': siteId,
      'X-EBAY-API-IAF-TOKEN': tok,
      'Content-Type': 'text/xml',
    },
    body: xml,
  })
  return await r.text()
}

// gather all active item IDs again
const items = []
let page = 1
while (page <= 20) {
  const xml = await trading('GetMyeBaySelling', `
  <ActiveList><Include>true</Include>
    <Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination>
  </ActiveList>`)
  items.push(...[...xml.matchAll(/<ItemID>(\d+)<\/ItemID>/g)].map(m => m[1]))
  const totalPages = Number(xml.match(/<TotalNumberOfPages>(\d+)<\/TotalNumberOfPages>/)?.[1] ?? 1)
  if (page >= totalPages) break
  page++
}
const ids = [...new Set(items)]
console.log(`items to inspect: ${ids.length}`)

const rows = []
for (const id of ids) {
  const xml = await trading('GetItem', `<ItemID>${id}</ItemID><IncludeItemSpecifics>true</IncludeItemSpecifics>`)
  const g = (tag) => xml.match(new RegExp(`<${tag}>(.*?)</${tag}>`))?.[1]
  const site = g('Site')
  const title = g('Title')?.slice(0, 48)
  const sku = xml.match(/<SKU>(.*?)<\/SKU>/)?.[1] // top-level SKU (first match may be variation SKU — check position)
  const hasVariations = /<Variations>/.test(xml)
  const varSkus = hasVariations ? [...xml.matchAll(/<Variation>\s*<SKU>(.*?)<\/SKU>/g)].length : 0
  const catId = xml.match(/<PrimaryCategory><CategoryID>(\d+)<\/CategoryID>/)?.[1]
  const catName = xml.match(/<CategoryName>(.*?)<\/CategoryName>/)?.[1]?.slice(0, 50)
  const qty = g('Quantity')
  const sold = g('QuantitySold')
  const price = xml.match(/<CurrentPrice currencyID="(\w+)">([\d.]+)<\/CurrentPrice>/)
  rows.push({ id, site, catId, catName, hasVariations, varSkus, sku: sku ? 'yes' : 'no', qty, sold, price: price ? `${price[2]} ${price[1]}` : '?', title })
}
const bySite = {}
for (const r of rows) bySite[r.site ?? '?'] = (bySite[r.site ?? '?'] ?? 0) + 1
console.log(`by site: ${JSON.stringify(bySite)}`)
const byCat = {}
for (const r of rows) byCat[`${r.catId} ${r.catName ?? ''}`] = (byCat[`${r.catId} ${r.catName ?? ''}`] ?? 0) + 1
console.log(`by category: ${JSON.stringify(byCat, null, 1)}`)
console.log('\nitem detail:')
for (const r of rows) {
  console.log(`  ${r.id} [${r.site}] cat=${r.catId} var=${r.hasVariations ? r.varSkus : 'no'} skuTag=${r.sku} qty=${r.qty} sold=${r.sold} price=${r.price} "${r.title}"`)
}

// EbayCampaign table contents
const camps = await prisma.ebayCampaign.findMany({ select: { externalCampaignId: true, name: true, status: true, marketplace: true, fundingStrategy: true } }).catch(e => `err: ${e.message}`)
console.log(`\nEbayCampaign rows in DB: ${Array.isArray(camps) ? camps.length : camps}`)
if (Array.isArray(camps)) for (const c of camps) console.log(`  ${c.externalCampaignId} "${c.name}" ${c.status} ${c.marketplace} ${c.fundingStrategy}`)

await prisma.$disconnect()
