/** APPROVED repair (owner, 2026-07-18): republish the GALE family via the
 *  Inventory group path so YELLOW-XXS joins the primary listing →
 *  20 variations / 398 units. Then live parity read-back. */
process.env.NEXUS_EBAY_REAL_API = 'true'
process.env.NEXUS_ENABLE_EBAY_PUBLISH = 'true'
process.env.EBAY_PUBLISH_MODE = 'live'

const { default: prisma } = await import('../src/db.js')
const { default: Fastify } = await import('fastify')
const { default: routes } = await import('../src/routes/ebay-flat-file.routes.js')
const app = Fastify({ logger: false })
await app.register(routes)
await app.ready()

const parent = await prisma.product.findFirst({ where: { sku: 'GALE-JACKET', deletedAt: null }, select: { id: true } })
if (!parent) throw new Error('GALE-JACKET parent not found')

const r = await app.inject({ method: 'GET', url: `/ebay/flat-file/rows?familyId=${parent.id}&marketplace=IT` })
const allRows = (r.json() as { rows: Array<Record<string, unknown>> }).rows
console.log('rows loaded:', allRows.length)

const CANON = new Set<string>()
for (const c of ['BLACK', 'YELLOW']) for (const sz of ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL', '5XL']) CANON.add(`GALE-JACKET-${c}-MEN-${sz}`)

const parentRow = allRows.find((x) => String(x.sku) === 'GALE-JACKET' && x._shared !== true)
const childRows = allRows.filter((x) => CANON.has(String(x.sku)) && x._shared !== true && String(x.parent_sku) === 'GALE-JACKET')
console.log('parent found:', !!parentRow, '| shared flag on parent:', parentRow?.shared_sku_listing, '| canonical children:', childRows.length)
if (!parentRow || childRows.length !== 20) throw new Error('unexpected scope — abort, nothing sent')

// Force the INVENTORY group path: the primary is Inventory-API-managed; the
// shared/Trading branch would dead-end at the adopt belt (revises rejected).
const pushRows = [{ ...parentRow, shared_sku_listing: false }, ...childRows.map((c) => ({ ...c, shared_sku_listing: false }))]

const push = await app.inject({ method: 'POST', url: '/ebay/flat-file/push', payload: { rows: pushRows, markets: ['IT'], marketplace: 'IT' } })
const pj = push.json() as { pushed?: number; errors?: number; pooled?: number; results?: Array<{ sku: string; status: string; message?: string }> }
console.log(`push: HTTP ${push.statusCode} pushed=${pj.pushed} errors=${pj.errors} pooled=${pj.pooled}`)
for (const line of pj.results ?? []) {
  if (line.status !== 'PUSHED' || String(line.sku).includes('XXS')) console.log(`  ${line.status} ${line.sku} ${line.message ?? ''}`)
}

// Live parity read-back
const { ebayAuthService } = await import('../src/services/ebay-auth.service.js')
const { callTradingApi, siteIdForMarket } = await import('../src/services/ebay-trading-api.service.js')
const conn = await prisma.channelConnection.findFirst({ where: { channelType: 'EBAY', isActive: true }, select: { id: true } })
const token = await ebayAuthService.getValidToken(conn!.id)
const got = await callTradingApi('GetItem', `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ItemID>257584954808</ItemID></GetItemRequest>`, { oauthToken: token, siteId: siteIdForMarket('IT') })
const blocks = [...got.raw.matchAll(/<Variation>([\s\S]*?)<\/Variation>/g)].map((m) => m[1])
let total = 0
const liveSkus: string[] = []
for (const b of blocks) {
  const sku = /<SKU>([^<]*)<\/SKU>/.exec(b)?.[1] ?? ''
  const qty = Number(/<Quantity>(\d+)<\/Quantity>/.exec(b)?.[1] ?? '0')
  const sold = Number(/<QuantitySold>(\d+)<\/QuantitySold>/.exec(b)?.[1] ?? '0')
  liveSkus.push(sku)
  total += qty - sold
}
console.log(`LIVE after publish: ${blocks.length} variations, total available ${total}`)
const missing = [...CANON].filter((sku) => !liveSkus.includes(sku))
console.log('missing canonical:', missing.length ? missing.join(',') : 'NONE — 20/20')
await prisma.$disconnect()
