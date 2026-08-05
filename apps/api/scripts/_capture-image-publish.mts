/**
 * CAPTURE HARNESS — runs the REAL publishEbayImagesViaInventory end-to-end with
 * EBAY_API_BASE pointed at a local sink, so we see the EXACT inventory_item PUT
 * bodies the deployed code produces (local == origin/main == ACTIVE build).
 *
 * ZERO eBay writes: every /sell/* call lands on 127.0.0.1. The group PUT gets a
 * 400 so publish never proceeds (=> no __offerIds writeback). The two pieces of
 * DB metadata the service touches (ListingImage.publishStatus, the diagnostic
 * ChannelImagePublishJob row) are snapshotted first and restored after.
 *
 * Mirrors the operator's real click exactly: marketplace 'IT', activeAxis
 * 'Color' (from the 10:47 job's requestPayload).
 */
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'

const PORT = 39871
process.env.EBAY_API_BASE = `http://127.0.0.1:${PORT}`
process.env.NEXUS_EBAY_REAL_API = 'true'

const { default: prisma } = await import('../src/db.js')
// Re-assert AFTER db import (dotenvx may inject; module-scope const reads at import)
process.env.EBAY_API_BASE = `http://127.0.0.1:${PORT}`

interface Cap { method: string; url: string; body: unknown }
const captures: Cap[] = []

const server = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    let body: unknown = null
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') } catch { body = Buffer.concat(chunks).toString('utf8') }
    captures.push({ method: req.method ?? '?', url: req.url ?? '?', body })
    const url = req.url ?? ''
    if (req.method === 'PUT' && url.includes('/inventory_item/') && !url.includes('_group')) {
      res.writeHead(204); res.end(); return
    }
    if (req.method === 'GET' && url.includes('/offer')) {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"offers":[],"total":0}'); return
    }
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end('{"errors":[{"errorId":99999,"message":"SINK: not eBay — capture harness"}]}')
  })
})
await new Promise<void>((ok) => server.listen(PORT, '127.0.0.1', ok))
console.log(`sink listening on :${PORT}`)

// ── snapshot the DB metadata the service will touch ────────────────────────
const p = await prisma.product.findFirst({ where: { sku: 'GALE-JACKET', deletedAt: null }, select: { id: true } })
if (!p) throw new Error('GALE-JACKET not found')
const liBefore = await prisma.listingImage.findMany({
  where: { productId: p.id, platform: 'EBAY' },
  select: { id: true, publishStatus: true, publishedAt: true, publishError: true },
})
const jobsBefore = new Set((await prisma.channelImagePublishJob.findMany({
  where: { productId: p.id, channel: 'EBAY' }, select: { id: true },
})).map((j) => j.id))
console.log(`snapshot: ${liBefore.length} ListingImage rows, ${jobsBefore.size} existing jobs`)

// ── run the REAL service, exactly as the UI invoked it ─────────────────────
let result: unknown
try {
  const { publishEbayImagesViaInventory } = await import('../src/services/images/ebay-inventory-image-publish.service.js')
  result = await publishEbayImagesViaInventory(p.id, 'IT', 'Color')
} catch (e) {
  result = { threw: (e as Error).message }
}

// ── restore metadata ───────────────────────────────────────────────────────
for (const r of liBefore) {
  await prisma.listingImage.update({
    where: { id: r.id },
    data: { publishStatus: r.publishStatus, publishedAt: r.publishedAt, publishError: r.publishError },
  })
}
const del = await prisma.channelImagePublishJob.deleteMany({
  where: { productId: p.id, channel: 'EBAY', id: { notIn: [...jobsBefore] } },
})
console.log(`restored ${liBefore.length} ListingImage rows · deleted ${del.count} diagnostic job row(s)`)
server.close()

// ── THE ANSWER: what did each inventory_item PUT carry? ────────────────────
const outPath = '/private/tmp/claude-501/-Users-awais-nexus-commerce/d027119c-29ec-42b4-9052-5dab9e08b3ce/scratchpad/image-publish-capture.json'
writeFileSync(outPath, JSON.stringify({ result, captures }, null, 1))
console.log(`\nfull capture: ${outPath}`)
console.log('service result:', JSON.stringify(result).slice(0, 300))

const itemPuts = captures.filter((c) => c.method === 'PUT' && c.url.includes('/inventory_item/') && !c.url.includes('_group'))
console.log(`\ninventory_item PUTs captured: ${itemPuts.length}`)
const classify = (u: string) => u.includes('media-amazon') ? 'AMAZON' : u.includes('cloudinary') ? 'CLOUDINARY' : u.includes('shopify') ? 'SHOPIFY' : 'OTHER'
for (const c of itemPuts.slice(0, 4)) {
  const sku = decodeURIComponent(c.url.split('/inventory_item/')[1] ?? '')
  const urls = ((c.body as Record<string, unknown>)?.product as Record<string, unknown> | undefined)?.imageUrls as string[] | undefined ?? []
  console.log(`\n● ${sku}: ${urls.length} imageUrls  [${urls.map(classify).join(',')}]`)
  urls.slice(0, 8).forEach((u, i) => console.log(`   ${i + 1}. …${u.slice(-55)}`))
}
// summary across all
const summary: Record<string, number> = {}
for (const c of itemPuts) {
  const urls = ((c.body as Record<string, unknown>)?.product as Record<string, unknown> | undefined)?.imageUrls as string[] | undefined ?? []
  const key = `${urls.length}:${urls.map(classify).join(',').slice(0, 40)}`
  summary[key] = (summary[key] ?? 0) + 1
}
console.log('\nPUT summary (count of variants per imageUrl-shape):', JSON.stringify(summary, null, 1))
await prisma.$disconnect()
process.exit(0)
