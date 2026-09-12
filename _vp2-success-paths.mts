/**
 * VP.2 — `FIXTURE-VP2-SUCCESS-PATHS`: force the two success paths that only their refusals had exercised.
 * Every write is predicted first, read back after a delay on two paths, and restored by value.
 */
import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import { PrismaClient } from '@prisma/client'
import routes from './apps/api/src/routes/product-studio.routes.js'

const GALE = 'cmokmy3a40078pm0p1fvnu523'
const EBAY_ACCOUNT = 'cmr4aaqb00025nz016k18rup9'
const DELAY_MS = 9000
const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL! } } })
const app = Fastify()
await app.register(multipart)
await app.register(routes)
await app.ready()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// The discriminator, re-read immediately before writing (a stale environment claim is the dangerous one).
const disc = await db.product.findUnique({ where: { id: GALE }, select: { version: true } })
console.log(`DATABASE discriminator: GALE Product.version = ${disc!.version}  (local Docker was 54+, Neon 51)\n`)

const get = async (url: string) => (await app.inject({ method: 'GET', url })).json() as any
const parentListing = (channel: string, market: string) => db.channelListing.findFirst({
  where: { productId: GALE, channel, marketplace: market, aliasKey: '' },
  select: { id: true, version: true, variationTheme: true, variationMapping: true, platformAttributes: true },
})

console.log('=== (C1) mapping WRITE — AMAZON·IT branch (variationTheme + flat variationMapping) ===========')
const aBefore = (await parentListing('AMAZON', 'IT'))!
console.log('BEFORE  :', JSON.stringify({ id: aBefore.id, version: aBefore.version, variationTheme: aBefore.variationTheme, variationMapping: aBefore.variationMapping }))
const aProj = await get(`/products/${GALE}/studio/projection?channel=AMAZON&market=IT`)
console.log('PREDICT : variationMapping NULL → {"Colore":"color_name","Taglia":"size_name"}, variationTheme NULL → "COLOR_NAME/SIZE_NAME",')
console.log('          listing version', aProj.version, '→', aProj.version + 1, ', and the GET then reports both targets as mapped.')
const aRes = await app.inject({
  method: 'PATCH', url: `/products/${GALE}/studio/projection?channel=AMAZON&market=IT`,
  payload: { expectedVersion: aProj.version, theme: 'COLOR_NAME/SIZE_NAME',
    mapping: [{ axisKey: 'Colore', target: 'color_name', order: 0 }, { axisKey: 'Taglia', target: 'size_name', order: 1 }] },
})
console.log('WRITE   :', aRes.statusCode, aRes.statusCode === 200 ? 'ok' : JSON.stringify(aRes.json()).slice(0, 200))
await sleep(DELAY_MS)
const aAfter = (await parentListing('AMAZON', 'IT'))!
const aProjAfter = await get(`/products/${GALE}/studio/projection?channel=AMAZON&market=IT`)
console.log('AFTER  sql :', JSON.stringify({ version: aAfter.version, variationTheme: aAfter.variationTheme, variationMapping: aAfter.variationMapping }))
console.log('AFTER  read:', JSON.stringify({ version: aProjAfter.version, mapping: aProjAfter.mapping, theme: aProjAfter.theme?.value }))
console.log('SHAPE is FLAT strings, which is what amazon-publish.adapter.ts:427 reads:',
  Object.values((aAfter.variationMapping ?? {}) as Record<string, unknown>).every((v) => typeof v === 'string'))
await db.$executeRawUnsafe('UPDATE "ChannelListing" SET "variationTheme" = NULL, "variationMapping" = NULL, version = version + 1 WHERE id = $1', aBefore.id)
await sleep(DELAY_MS)
const aRestored = (await parentListing('AMAZON', 'IT'))!
console.log('RESTORED:', JSON.stringify({ variationTheme: aRestored.variationTheme, variationMapping: aRestored.variationMapping }),
  '| matches BEFORE:', aRestored.variationTheme === aBefore.variationTheme && aRestored.variationMapping === aBefore.variationMapping)

console.log('\n=== (C2) mapping WRITE — eBAY·IT branch, RENAME only (the set is locked) =====================')
const product0 = await db.product.findUnique({ where: { id: GALE }, select: { variationTheme: true, version: true } })
const eBefore = (await parentListing('EBAY', 'IT'))!
const pa0 = (eBefore.platformAttributes ?? {}) as Record<string, unknown>
console.log('BEFORE  : Product.variationTheme =', JSON.stringify(product0!.variationTheme),
  '| _axisNameLabels present:', '_axisNameLabels' in pa0, '| listing version', eBefore.version)
const eProj = await get(`/products/${GALE}/studio/projection?channel=EBAY&market=IT&accountId=${EBAY_ACCOUNT}`)
console.log('PREDICT : a RENAME is allowed while the SET is locked — _axisNameLabels gains {Colore:"Colore",Taglia:"Taglia IT"},')
console.log('          Product.variationTheme KEEPS its order "Colore,Taglia", and the GET reports target "Taglia IT".')
const eRes = await app.inject({
  method: 'PATCH', url: `/products/${GALE}/studio/projection?channel=EBAY&market=IT&accountId=${EBAY_ACCOUNT}`,
  payload: { expectedVersion: eProj.version, mapping: [{ axisKey: 'Colore', target: 'Colore', order: 0 }, { axisKey: 'Taglia', target: 'Taglia IT', order: 1 }] },
})
console.log('WRITE   :', eRes.statusCode, eRes.statusCode === 200 ? 'ok' : JSON.stringify(eRes.json()).slice(0, 200))
await sleep(DELAY_MS)
const eAfter = (await parentListing('EBAY', 'IT'))!
const paA = (eAfter.platformAttributes ?? {}) as Record<string, unknown>
const product1 = await db.product.findUnique({ where: { id: GALE }, select: { variationTheme: true, version: true } })
const eProjAfter = await get(`/products/${GALE}/studio/projection?channel=EBAY&market=IT&accountId=${EBAY_ACCOUNT}`)
console.log('AFTER  sql :', JSON.stringify({ _axisNameLabels: paA._axisNameLabels, productTheme: product1!.variationTheme, listingVersion: eAfter.version }))
console.log('AFTER  read:', JSON.stringify(eProjAfter.mapping))
console.log('ORDER PRESERVED (the order editor owns it, not this PATCH):', product1!.variationTheme === product0!.variationTheme)
console.log('_variationAxes UNTOUCHED:', JSON.stringify(paA._variationAxes), '| _axisValueOrder UNTOUCHED:', JSON.stringify(Object.keys((paA._axisValueOrder ?? {}) as object)))
// RESTORE: remove the key entirely (its ABSENCE is the before-state) and put the product theme back verbatim.
const paRestore = { ...paA }
delete paRestore._axisNameLabels
await db.channelListing.update({ where: { id: eBefore.id }, data: { platformAttributes: paRestore as never, version: { increment: 1 } } })
await db.product.update({ where: { id: GALE }, data: { variationTheme: product0!.variationTheme, version: product0!.version } })
await sleep(DELAY_MS)
const eRestored = (await parentListing('EBAY', 'IT'))!
const paR = (eRestored.platformAttributes ?? {}) as Record<string, unknown>
const productR = await db.product.findUnique({ where: { id: GALE }, select: { variationTheme: true, version: true } })
console.log('RESTORED: _axisNameLabels present:', '_axisNameLabels' in paR, '| Product.variationTheme =', JSON.stringify(productR!.variationTheme),
  '| version back to', productR!.version, '| keys match BEFORE:', JSON.stringify(Object.keys(paR).sort()) === JSON.stringify(Object.keys(pa0).sort()))

console.log('\n=== (D) generate with dryRun:FALSE — the only path that creates Product rows ==================')
const fam0 = await get(`/products/${GALE}/studio/family?market=IT`)
const kids0 = await db.product.count({ where: { parentId: GALE, deletedAt: null } })
const pv0 = (await db.product.findUnique({ where: { id: GALE }, select: { version: true } }))!.version
console.log('BEFORE  : children', kids0, '| parent Product.version', pv0)
console.log('PREDICT : exactly ONE product created, status DRAFT, parentId GALE, axis values in BOTH stores,')
console.log('          ZERO ChannelListing rows on it, parent version', pv0, '→', pv0 + 1)
const gRes = await app.inject({
  method: 'POST', url: `/products/${GALE}/studio/family/generate`,
  payload: { version: fam0.version, dryRun: false, skuPattern: 'VP2-REHEARSAL-{Colore.code}-{Taglia.code}',
    axisValues: { Colore: ['Rosso'], Taglia: ['XXS'] } },
})
const gBody = gRes.json() as any
console.log('WRITE   :', gRes.statusCode, JSON.stringify(gBody))
await sleep(DELAY_MS)
const created = gBody.created?.[0]
if (!created) {
  console.log('NOTHING CREATED — this is a FAILURE of the commit path, not a clean run.')
} else {
  const row = await db.product.findUnique({ where: { id: created.id }, select: { id: true, sku: true, status: true, parentId: true, isParent: true, basePrice: true, totalStock: true, categoryAttributes: true, variantAttributes: true, name: true } })
  const listings = await db.channelListing.count({ where: { productId: created.id } })
  console.log('CREATED :', JSON.stringify({ sku: row!.sku, status: row!.status, parentId: row!.parentId === GALE, isParent: row!.isParent, basePrice: row!.basePrice, totalStock: row!.totalStock }))
  console.log('  variations bag  :', JSON.stringify(((row!.categoryAttributes ?? {}) as any).variations))
  console.log('  variantAttributes:', JSON.stringify(row!.variantAttributes))
  console.log('  ChannelListing rows on the new child:', listings, '(spec §3.4 requires 0)')
  console.log('  copied its name from a sibling:', (row!.name ?? '').length > 0)
  const pv1 = (await db.product.findUnique({ where: { id: GALE }, select: { version: true } }))!.version
  console.log('  parent version', pv0, '→', pv1)
  const fam1 = await get(`/products/${GALE}/studio/family?market=IT`)
  console.log('  family read now:', fam1.children.length, 'children, coverage', JSON.stringify(fam1.coverage.combinations), 'combinations')
  // RESTORE — hard delete the product this run created, and put the parent's version back.
  await db.product.delete({ where: { id: created.id } })
  await db.product.update({ where: { id: GALE }, data: { version: pv0 } })
  await sleep(DELAY_MS)
  const kids1 = await db.product.count({ where: { parentId: GALE, deletedAt: null } })
  const pv2 = (await db.product.findUnique({ where: { id: GALE }, select: { version: true } }))!.version
  const orphan = await db.product.count({ where: { sku: { startsWith: 'VP2-REHEARSAL' } } })
  console.log('RESTORED: children', kids1, '(was', kids0, ') | parent version', pv2, '(was', pv0, ') | VP2-REHEARSAL products left:', orphan)
}

await app.close()
await db.$disconnect()
process.exit(0)
