/**
 * VP.2 — FORCE the arm the first rehearsal could not exercise.
 *
 * In run (A) the eBay·DE row was ALREADY `isPublished: false`, so "exclude lowers isPublished" was asserted by
 * a field that could not have moved. The arm that would have failed is the one never run. This forces it on a
 * row where `isPublished` is TRUE — eBay·IT, same child — and restores it by value.
 *
 * Announced as part of `FIXTURE-VP2-INCLUSION`. The database is the LOCAL Docker copy.
 */
import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import { PrismaClient } from '@prisma/client'
import routes from './apps/api/src/routes/product-studio.routes.js'

const GALE = 'cmokmy3a40078pm0p1fvnu523'
const CHILD = 'cmokmy2ir005bpm0p0sm1rxx8'
const EBAY_IT_LISTING = 'cmqrogyvn0005njpku3qdechl'
const ACCOUNT = 'cmr4aaqb00025nz016k18rup9'
const DELAY_MS = 9000

const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL! } } })
const app = Fastify()
await app.register(multipart)
await app.register(routes)
await app.ready()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const read = async () => (await db.$queryRawUnsafe<any[]>(
  `SELECT id, "listingStatus", "isPublished", "syncPaused", "variationExcluded", version, "externalListingId"
     FROM "ChannelListing" WHERE id = $1`, EBAY_IT_LISTING))[0]
const queueCount = async () =>
  Number((await db.$queryRawUnsafe<any[]>(`SELECT count(*)::int AS n FROM "OutboundSyncQueue" WHERE "productId" = $1`, CHILD))[0].n)

const before = await read()
const qBefore = await queueCount()
const projBefore = (await app.inject({ method: 'GET', url: `/products/${GALE}/studio/projection?channel=EBAY&market=IT&accountId=${ACCOUNT}` })).json() as any
console.log('BEFORE   :', JSON.stringify(before), '| queue', qBefore)
console.log('PREDICT  : isPublished TRUE→FALSE, variationExcluded FALSE→TRUE, syncPaused UNCHANGED (false),')
console.log('           externalListingId KEPT (257584954808 is not lost by excluding), zero new queue rows.')
if (before.isPublished !== true) {
  console.log('ABORT: this row is not isPublished=true, so it cannot exercise the arm. Nothing written.')
  process.exit(1)
}

const res = await app.inject({
  method: 'PATCH',
  url: `/products/${GALE}/studio/projection/children?channel=EBAY&market=IT&accountId=${ACCOUNT}`,
  payload: { expectedVersion: projBefore.version, changes: [{ id: CHILD, included: false }] },
})
console.log('WRITE    :', res.statusCode, JSON.stringify((res.json() as any).results ?? res.json()))
await sleep(DELAY_MS)
const after = await read()
console.log('AFTER    :', JSON.stringify(after), '| queue', await queueCount())
console.log('ARM EXERCISED — isPublished moved:', before.isPublished === true && after.isPublished === false)
console.log('externalListingId kept:', after.externalListingId === before.externalListingId, `(${after.externalListingId})`)
console.log('syncPaused untouched on an EXISTING row:', after.syncPaused === before.syncPaused)

// RESTORE BY VALUE — both fields, back to exactly what was read above.
await db.$executeRawUnsafe(
  'UPDATE "ChannelListing" SET "variationExcluded" = $1, "isPublished" = $2, version = version + 1 WHERE id = $3',
  before.variationExcluded, before.isPublished, EBAY_IT_LISTING)
await sleep(DELAY_MS)
const restored = await read()
console.log('RESTORED :', JSON.stringify(restored))
console.log('matches BEFORE on every field except version:',
  restored.isPublished === before.isPublished && restored.variationExcluded === before.variationExcluded
  && restored.syncPaused === before.syncPaused && restored.listingStatus === before.listingStatus
  && restored.externalListingId === before.externalListingId)
console.log('queue rows unchanged end to end:', (await queueCount()) === qBefore)

await app.close()
await db.$disconnect()
process.exit(0)
