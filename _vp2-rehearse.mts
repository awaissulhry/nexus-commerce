/**
 * VP.2 — the announced rehearsal (`FIXTURE-VP2-INCLUSION`), run through the ROUTES via app.inject.
 *
 * Both writes are restored by VALUE, and every read-back is taken twice: once through the projection read and
 * once by direct SQL, after a delay. "The write did not land" and "I read too early" look identical from one
 * early read, so neither is trusted here.
 */
import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import { PrismaClient } from '@prisma/client'
import routes from './apps/api/src/routes/product-studio.routes.js'

const GALE = 'cmokmy3a40078pm0p1fvnu523'
const CHILD = 'cmokmy2ir005bpm0p0sm1rxx8'
const CHILD_SKU = 'GALE-JACKET-BLACK-MEN-5XL'
const EBAY_DE_LISTING = 'cmtvv9i1r000qnjpxm9he89j9'
const DELAY_MS = 9000

const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL! } } })
const app = Fastify()
await app.register(multipart)
await app.register(routes)
await app.ready()

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const sql = async (where: string, ...args: unknown[]) =>
  db.$queryRawUnsafe<any[]>(
    `SELECT id, channel, marketplace, "listingStatus", "isPublished", "syncPaused", "variationExcluded", version, "externalListingId"
       FROM "ChannelListing" WHERE ${where}`, ...args)

const projection = async (channel: string, market: string, account?: string) => {
  const res = await app.inject({ method: 'GET', url: `/products/${GALE}/studio/projection?channel=${channel}&market=${market}${account ? `&accountId=${account}` : ''}` })
  const body = res.json() as any
  return { version: body.version, child: body.children?.find((c: any) => c.id === CHILD), counts: body.counts }
}

const queueCount = async () =>
  Number((await db.$queryRawUnsafe<any[]>(`SELECT count(*)::int AS n FROM "OutboundSyncQueue" WHERE "productId" = $1`, CHILD))[0].n)

console.log('=== (A) eBay·DE — exclude, read back, restore =================================')
const qBefore = await queueCount()
const aBefore = (await sql('id = $1', EBAY_DE_LISTING))[0]
const pBefore = await projection('EBAY', 'DE', 'cmr4aaqb00025nz016k18rup9')
console.log('BEFORE sql       :', JSON.stringify(aBefore))
console.log('BEFORE projection:', JSON.stringify({ version: pBefore.version, included: pBefore.child?.included, state: pBefore.child?.listing?.state, counts: pBefore.counts }))
console.log('BEFORE SyncQueue rows for this child:', qBefore)

// PREDICTION, written before the write (a read-back alone only confirms; a plausible wrong value passes):
console.log('PREDICT: variationExcluded false→TRUE, version 3→4, isPublished stays false (already false),')
console.log('         syncPaused stays false (an existing row is never re-paused), state listed/draft→EXCLUDED,')
console.log('         counts.included 21→20, SyncQueue rows unchanged at', qBefore)

const excl = await app.inject({
  method: 'PATCH',
  url: `/products/${GALE}/studio/projection/children?channel=EBAY&market=DE&accountId=cmr4aaqb00025nz016k18rup9`,
  payload: { expectedVersion: pBefore.version, changes: [{ id: CHILD, included: false }] },
})
console.log('WRITE response   :', excl.statusCode, JSON.stringify((excl.json() as any).results ?? (excl.json() as any)))

console.log(`waiting ${DELAY_MS}ms before reading back…`)
await sleep(DELAY_MS)
const aAfter = (await sql('id = $1', EBAY_DE_LISTING))[0]
const pAfter = await projection('EBAY', 'DE', 'cmr4aaqb00025nz016k18rup9')
console.log('AFTER  sql       :', JSON.stringify(aAfter))
console.log('AFTER  projection:', JSON.stringify({ version: pAfter.version, included: pAfter.child?.included, state: pAfter.child?.listing?.state, counts: pAfter.counts }))
console.log('AFTER  SyncQueue rows for this child:', await queueCount())

// RESTORE by value, through the same endpoint.
const back = await app.inject({
  method: 'PATCH',
  url: `/products/${GALE}/studio/projection/children?channel=EBAY&market=DE&accountId=cmr4aaqb00025nz016k18rup9`,
  payload: { expectedVersion: pAfter.version, changes: [{ id: CHILD, included: true }] },
})
console.log('RESTORE response :', back.statusCode, JSON.stringify((back.json() as any).results ?? (back.json() as any)))
await sleep(DELAY_MS)
const aRestored = (await sql('id = $1', EBAY_DE_LISTING))[0]
const pRestored = await projection('EBAY', 'DE', 'cmr4aaqb00025nz016k18rup9')
console.log('RESTORED sql     :', JSON.stringify(aRestored))
console.log('RESTORED proj    :', JSON.stringify({ included: pRestored.child?.included, state: pRestored.child?.listing?.state, counts: pRestored.counts }))
console.log('RESTORED matches before on every field except version:',
  aRestored.variationExcluded === aBefore.variationExcluded
  && aRestored.isPublished === aBefore.isPublished
  && aRestored.syncPaused === aBefore.syncPaused
  && aRestored.listingStatus === aBefore.listingStatus
  && aRestored.externalListingId === aBefore.externalListingId)
console.log(`version ${aBefore.version} → ${aAfter.version} → ${aRestored.version} (two writes, two bumps — a CAS token moving is not a data change)`)

console.log('\n=== (B) Shopify·GLOBAL — include a child with NO row ==========================')
const sBefore = await sql('"productId" = $1 AND channel = $2', CHILD, 'SHOPIFY')
console.log('BEFORE rows      :', sBefore.length, JSON.stringify(sBefore))
const spBefore = await projection('SHOPIFY', 'GLOBAL')
console.log('BEFORE projection:', JSON.stringify({ version: spBefore.version, included: spBefore.child?.included, state: spBefore.child?.listing?.state }))
console.log('PREDICT: one row CREATED — DRAFT, isPublished FALSE, syncPaused TRUE, variationExcluded FALSE,')
console.log('         externalListingId NULL, and ZERO new SyncQueue rows.')

const qB = await queueCount()
const inc = await app.inject({
  method: 'PATCH',
  url: `/products/${GALE}/studio/projection/children?channel=SHOPIFY&market=GLOBAL`,
  payload: { expectedVersion: spBefore.version, changes: [{ id: CHILD, included: true }] },
})
console.log('WRITE response   :', inc.statusCode, JSON.stringify((inc.json() as any).results ?? (inc.json() as any)))
await sleep(DELAY_MS)
const sAfter = await sql('"productId" = $1 AND channel = $2', CHILD, 'SHOPIFY')
console.log('AFTER  rows      :', sAfter.length, JSON.stringify(sAfter))
console.log('AFTER  SyncQueue rows for this child:', await queueCount(), '(before:', qB, ')')
const created = sAfter.find((r) => !sBefore.some((b) => b.id === r.id))
if (created) {
  console.log('CREATED row      :', JSON.stringify(created))
  console.log('birth state correct:', created.listingStatus === 'DRAFT' && created.isPublished === false
    && created.syncPaused === true && created.variationExcluded === false && created.externalListingId === null)
  // RESTORE: the row did not exist, so its absence is the restore. Deleted BY ID, recorded above.
  await db.$executeRawUnsafe('DELETE FROM "ChannelListing" WHERE id = $1', created.id)
  await sleep(DELAY_MS)
  const sRestored = await sql('"productId" = $1 AND channel = $2', CHILD, 'SHOPIFY')
  console.log('RESTORED rows    :', sRestored.length, '(before:', sBefore.length, ') — match:', sRestored.length === sBefore.length)
} else {
  console.log('NO ROW CREATED — nothing to restore. This is a FAILURE of the include path, not a clean run.')
}

await app.close()
await db.$disconnect()
process.exit(0)
