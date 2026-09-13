/**
 * VT.F2 — READ-ONLY facts probe for items 2 and 4. Opens the LOCAL database with the URL stated EXPLICITLY
 * (`reference_which_database_is_this_api_on`: a script that picks up whichever `.env` Prisma finds is a script
 * whose target you cannot state) and refuses anything but `nexus_development`.
 */
import { PrismaClient } from '@prisma/client'
import { readFileSync } from 'node:fs'
import { parse } from 'dotenv'

const url = parse(readFileSync(new URL('../.env', import.meta.url).pathname, 'utf8')).DATABASE_URL!
if (!/127\.0\.0\.1|localhost/.test(url) || !/nexus_development/.test(url)) throw new Error(`REFUSED: not the local database: ${url.replace(/:[^:@]+@/, ':***@')}`)
const prisma = new PrismaClient({ datasources: { db: { url } } })

const db = await prisma.$queryRawUnsafe<Array<{ db: string }>>(`SELECT current_database()::text AS db`)
const gale = await prisma.product.findFirst({ where: { sku: 'GALE-JACKET' }, select: { id: true, version: true, productType: true, variationAxes: true, variationTheme: true } })
const products = await prisma.product.count()
console.log('DISCRIMINATOR', JSON.stringify({ current_database: db[0].db, products, gale }))

// 1 — GALE's eBay·IT parent listing: every column a new DRAFT row must satisfy, and where the category lives.
const ebay = await prisma.channelListing.findFirst({ where: { productId: gale!.id, channel: 'EBAY', marketplace: 'IT', aliasKey: '' } })
console.log('GALE EBAY·IT LISTING KEYS', JSON.stringify(Object.keys(ebay ?? {})))
console.log('GALE EBAY·IT LISTING', JSON.stringify({
  id: ebay?.id, marketplace: ebay?.marketplace, channelConnectionId: ebay?.channelConnectionId, listingStatus: ebay?.listingStatus,
  externalListingId: ebay?.externalListingId, categoryId: (ebay as Record<string, unknown> | null)?.categoryId,
  version: ebay?.version, aliasKey: ebay?.aliasKey, workspaceId: (ebay as Record<string, unknown> | null)?.workspaceId,
  paKeys: Object.keys((ebay?.platformAttributes ?? {}) as Record<string, unknown>),
}))
const amazonIt = await prisma.channelListing.findFirst({ where: { productId: gale!.id, channel: 'AMAZON', marketplace: 'IT', aliasKey: '' } })
console.log('GALE AMAZON·IT LISTING', JSON.stringify({ id: amazonIt?.id, version: amazonIt?.version, channelConnectionId: amazonIt?.channelConnectionId, categoryId: (amazonIt as Record<string, unknown> | null)?.categoryId, variationTheme: amazonIt?.variationTheme, variationMapping: amazonIt?.variationMapping, listingStatus: amazonIt?.listingStatus }))

// 2 — the ORDERED shape's prevalence today: the BEFORE for R-VT-13's claim.
const shapes = await prisma.$queryRawUnsafe<Array<{ shape: string; n: bigint }>>(`
  SELECT CASE
    WHEN "variationMapping" IS NULL THEN 'null'
    WHEN jsonb_typeof(("variationMapping"::jsonb) -> 'axes') = 'array' THEN 'ordered'
    WHEN ("variationMapping"::jsonb) = '{}'::jsonb THEN 'empty'
    ELSE 'flat' END AS shape, COUNT(*)::bigint AS n
  FROM "ChannelListing" GROUP BY 1 ORDER BY 2 DESC`)
console.log('variationMapping SHAPES TODAY', JSON.stringify(shapes.map(r => [r.shape, Number(r.n)])))

// 3 — the cached Amazon variation theme enums, per (marketplace, productType), and what they match.
const schemas = await prisma.categorySchema.findMany({
  where: { channel: 'AMAZON' },
  select: { marketplace: true, productType: true, variationThemes: true, fetchedAt: true, schemaVersion: true },
  orderBy: [{ marketplace: 'asc' }, { productType: 'asc' }, { fetchedAt: 'desc' }],
})
const canon = (s: string) => s.trim().toLowerCase().replace(/_?name$/, '').replace(/[^a-z]/g, '')
const AXES = ['color', 'size', 'fittype']
const WANT = [...AXES].sort().join('|')
const themesOf = (v: unknown): string[] => {
  const seen = new Set<string>()
  const walk = (node: unknown) => {
    if (Array.isArray(node)) { for (const n of node) walk(n); return }
    if (node && typeof node === 'object') { for (const val of Object.values(node as Record<string, unknown>)) walk(val); return }
    if (typeof node === 'string' && node.length > 1) seen.add(node)
  }
  walk(v)
  return [...seen]
}
console.log('AMAZON CategorySchema ROWS', schemas.length)
for (const row of schemas) {
  const themes = themesOf(row.variationThemes)
  let exact = 0
  const twoOfThree: string[] = []
  for (const theme of themes) {
    const segs = theme.split('/').map(canon).filter(Boolean)
    const key = [...segs].sort().join('|')
    if (key === WANT) exact++
    else if (segs.length === 2 && segs.every(s => AXES.includes(s)) && new Set(segs).size === 2) twoOfThree.push(theme)
  }
  console.log('  ', JSON.stringify({ mk: row.marketplace, pt: row.productType, themes: themes.length, exact, twoOfThree: twoOfThree.slice(0, 3), widest: Math.max(0, ...themes.map(t => t.split('/').length)), fetchedAt: row.fetchedAt }))
}
await prisma.$disconnect()
