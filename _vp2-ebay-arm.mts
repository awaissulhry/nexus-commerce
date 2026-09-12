import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import { PrismaClient } from '@prisma/client'
import routes from './apps/api/src/routes/product-studio.routes.js'
const GALE = 'cmokmy3a40078pm0p1fvnu523'
const ACC = 'cmr4aaqb00025nz016k18rup9'
const D = 9000
const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL! } } })
const app = Fastify(); await app.register(multipart); await app.register(routes); await app.ready()
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const get = async () => (await app.inject({ method: 'GET', url: `/products/${GALE}/studio/projection?channel=EBAY&market=IT&accountId=${ACC}` })).json() as any
const pl = () => db.channelListing.findFirst({ where: { productId: GALE, channel: 'EBAY', marketplace: 'IT', aliasKey: '' }, select: { id: true, version: true, platformAttributes: true } })

const p0 = (await db.product.findUnique({ where: { id: GALE }, select: { variationTheme: true, version: true } }))!
const l0 = (await pl())!
const pa0 = (l0.platformAttributes ?? {}) as Record<string, unknown>
console.log('BEFORE : Product.variationTheme =', JSON.stringify(p0.variationTheme), '| Product.version', p0.version,
  '| _axisNameLabels present:', '_axisNameLabels' in pa0, '| listing version', l0.version)
const g0 = await get()
console.log('BEFORE mapping:', JSON.stringify(g0.mapping))
console.log('PREDICT: Taglia target "Taglia" → "Scollatura" (a REAL aspect of this category, currently free).')
console.log('         Allowed while LOCKED because the axis SET is unchanged. _axisNameLabels appears with both axes;')
console.log('         Product.variationTheme KEEPS "Colore,Taglia"; _variationAxes and _axisValueOrder untouched.')
const res = await app.inject({ method: 'PATCH', url: `/products/${GALE}/studio/projection?channel=EBAY&market=IT&accountId=${ACC}`,
  payload: { expectedVersion: g0.version, mapping: [{ axisKey: 'Colore', target: 'Colore', order: 0 }, { axisKey: 'Taglia', target: 'Scollatura', order: 1 }] } })
console.log('WRITE  :', res.statusCode, res.statusCode === 200 ? 'ok' : JSON.stringify(res.json()).slice(0, 250))
await sleep(D)
const l1 = (await pl())!; const pa1 = (l1.platformAttributes ?? {}) as Record<string, unknown>
const p1 = (await db.product.findUnique({ where: { id: GALE }, select: { variationTheme: true, version: true } }))!
const g1 = await get()
console.log('AFTER sql :', JSON.stringify({ _axisNameLabels: pa1._axisNameLabels, productTheme: p1.variationTheme, listingVersion: l1.version }))
console.log('AFTER read:', JSON.stringify(g1.mapping), '| targetOptions taken:', JSON.stringify(g1.targetOptions.map((o: any) => [o.code, o.taken])))
console.log('ORDER key UNTOUCHED  :', JSON.stringify(pa1._variationAxes), JSON.stringify(Object.keys((pa1._axisValueOrder ?? {}) as object)))
console.log('SET preserved         :', p1.variationTheme === p0.variationTheme)
const paR = { ...pa1 }; delete paR._axisNameLabels
await db.channelListing.update({ where: { id: l0.id }, data: { platformAttributes: paR as never, version: { increment: 1 } } })
await db.product.update({ where: { id: GALE }, data: { variationTheme: p0.variationTheme, version: p0.version } })
await sleep(D)
const l2 = (await pl())!; const pa2 = (l2.platformAttributes ?? {}) as Record<string, unknown>
const p2 = (await db.product.findUnique({ where: { id: GALE }, select: { variationTheme: true, version: true } }))!
const g2 = await get()
console.log('RESTORED: _axisNameLabels present:', '_axisNameLabels' in pa2, '| theme', JSON.stringify(p2.variationTheme),
  '| Product.version', p2.version, '| key set matches BEFORE:', JSON.stringify(Object.keys(pa2).sort()) === JSON.stringify(Object.keys(pa0).sort()))
console.log('RESTORED mapping:', JSON.stringify(g2.mapping), '| matches BEFORE:', JSON.stringify(g2.mapping) === JSON.stringify(g0.mapping))
await app.close(); await db.$disconnect(); process.exit(0)
