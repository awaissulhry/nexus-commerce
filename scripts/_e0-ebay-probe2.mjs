// E0 read-only probe 2: actual live listings on the eBay account (Trading API
// GetMyeBaySelling) vs what Nexus tracks; size-aspect sample of unmapped items.
// NO WRITES.
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

// ── Active listings via GetMyeBaySelling (paginated) ────────────────────────
console.log('════════ Live active listings on the eBay account ════════')
const items = []
let page = 1
while (page <= 20) {
  const xml = await trading('GetMyeBaySelling', `
  <ActiveList>
    <Include>true</Include>
    <Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination>
  </ActiveList>
  <DetailLevel>ReturnAll</DetailLevel>`)
  const ack = xml.match(/<Ack>(.*?)<\/Ack>/)?.[1]
  if (ack !== 'Success' && ack !== 'Warning') {
    console.log(`  page ${page}: Ack=${ack}`)
    console.log('  ' + (xml.match(/<LongMessage>(.*?)<\/LongMessage>/)?.[1] ?? xml.slice(0, 300)))
    break
  }
  const chunk = [...xml.matchAll(/<Item>([\s\S]*?)<\/Item>/g)].map(m => {
    const g = (tag) => m[1].match(new RegExp(`<${tag}>(.*?)</${tag}>`))?.[1]
    return {
      itemId: g('ItemID'),
      title: g('Title')?.slice(0, 60),
      site: g('Site'),
      qty: g('QuantityAvailable') ?? g('Quantity'),
      format: g('ListingType'),
    }
  })
  items.push(...chunk)
  const totalPages = Number(xml.match(/<TotalNumberOfPages>(\d+)<\/TotalNumberOfPages>/)?.[1] ?? 1)
  if (page >= totalPages) break
  page++
}
console.log(`  total active items on account: ${items.length}`)
const bySite = {}
for (const it of items) bySite[it.site ?? '?'] = (bySite[it.site ?? '?'] ?? 0) + 1
console.log(`  by site: ${JSON.stringify(bySite)}`)

// ── Compare to Nexus ChannelListing ──────────────────────────────────────────
const tracked = await prisma.channelListing.findMany({
  where: { channel: 'EBAY', externalListingId: { not: null } },
  select: { externalListingId: true },
})
const trackedIds = new Set(tracked.map(t => t.externalListingId))
const unmapped = items.filter(it => !trackedIds.has(it.itemId))
console.log(`  tracked in Nexus (any status): ${trackedIds.size} distinct itemIds`)
console.log(`  live-on-eBay but NOT in Nexus: ${unmapped.length}`)
for (const it of unmapped.slice(0, 15)) console.log(`    ${it.itemId} [${it.site}] ${it.format} qty=${it.qty} "${it.title}"`)

// ── Size-aspect sample for a few live items (GetItem, read-only) ────────────
console.log('\n════════ Size aspects on live items (sample) ════════')
const sample = items.slice(0, 10)
for (const it of sample) {
  const xml = await trading('GetItem', `
  <ItemID>${it.itemId}</ItemID>
  <IncludeItemSpecifics>true</IncludeItemSpecifics>
  <DetailLevel>ReturnAll</DetailLevel>`)
  const specifics = [...xml.matchAll(/<NameValueList><Name>(.*?)<\/Name>(<Value>[\s\S]*?<\/Value>)+?<\/NameValueList>/g)]
    .map(m => m[1])
  const hasVariations = /<Variations>/.test(xml)
  const sizeNames = specifics.filter(n => /^(taglia|size|größe|grösse|talla|taille)/i.test(n))
  // variation specifics too
  const varSpecificNames = [...new Set([...xml.matchAll(/<VariationSpecificsSet>[\s\S]*?<\/VariationSpecificsSet>/g)]
    .flatMap(m => [...m[0].matchAll(/<Name>(.*?)<\/Name>/g)].map(x => x[1])))]
  console.log(`  ${it.itemId} [${it.site}] "${it.title}"`)
  console.log(`    itemSpecifics size-keys=${JSON.stringify(sizeNames)} variations=${hasVariations} varSpecifics=${JSON.stringify(varSpecificNames)}`)
}

await prisma.$disconnect()
