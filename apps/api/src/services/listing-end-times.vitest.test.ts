/**
 * Shared stock plan step 3 — end times for "Fixed number" and "Paused", and a fixed number for a shared
 * eBay variant. Contract: docs/2026-09-19-shared-stock-build.md §3.
 *
 * On a real PostgreSQL with the generated policies (the triggers and indexes of
 * packages/database/workspaces/listing-end-times.sql included), profiles ON, through the real Sync
 * Control route, the real writer (setFollowMasterQuantity), the real cascade and the real end-time
 * service. The story: an operator sets end times from Sync Control → the page shows them → time
 * passes → the job ends each override, sends the right number, and writes the history.
 *
 * Also: the database rule "an end time never outlives its mode"; the CHECK on a fixed number; an
 * operator's later change is never overruled; an Amazon-managed (FBA) listing and an ENDED listing; a
 * writer that fails or stops mid-way leaves the end time for the next minute; one business's run never
 * touches another's rows.
 *
 * Needs NEXUS_TEST_CONCURRENT_PG_URL (a throwaway Docker PostgreSQL); SKIPS without it. Run by
 * scripts/run-real-postgres-tests.mjs before every push.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { CONCURRENT_PG_ENV, concurrentDatabase, concurrentDatabaseUrl } from '../test-support/concurrent-database.js'
import { withWorkspace } from '../lib/workspace-context.js'

const hoisted = vi.hoisted(() => ({
  recascades: [] as Array<Promise<unknown>>,
  realSetFollow: null as null | ((...args: never[]) => Promise<unknown>),
  /** Runs once, just before the next prisma.$transaction: an operator's change between the job's read and its write. */
  beforeNextTransaction: null as null | (() => Promise<unknown>),
}))

let database: Awaited<ReturnType<typeof concurrentDatabase>>
vi.mock('../db.js', async () => {
  const { contextualDatabase } = await import('../lib/database-context.js')
  let wrapped: Record<string, unknown> | null = null
  return {
    default: new Proxy({} as Record<string, unknown>, {
      get: (_t, property) => {
        const target = (wrapped ??= contextualDatabase(database.client as never) as unknown as Record<string, unknown>)
        const hook = hoisted.beforeNextTransaction
        if (property === '$transaction' && hook) {
          hoisted.beforeNextTransaction = null
          return async (...args: unknown[]) => { await hook(); return (target.$transaction as (...a: unknown[]) => unknown)(...args) }
        }
        return target[property as string]
      },
    }),
  }
})
vi.mock('../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []) }
  return {
    addJobSafely: vi.fn(async () => undefined),
    outboundSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, channelSyncQueue: queue, bulkJobQueue: queue,
    redis: { connection: null },
  }
})
// The eBay accounts' out-of-stock option is ON here: a Sync Control pin to 0 on eBay needs it (else eBay ends the item).
vi.mock('./channel-delist.service.js', async (importOriginal) => ({ ...await importOriginal<object>(), readEbayOutOfStockPreference: async () => 'ON' }))
// The real writer, wrapped so an arm can make it fail once.
vi.mock('./follow-master.service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./follow-master.service.js')>()
  hoisted.realSetFollow = real.setFollowMasterQuantity as never
  return { ...real, setFollowMasterQuantity: vi.fn(real.setFollowMasterQuantity) }
})
// The real recascade; the route runs it in the background, so the test keeps each promise to await it.
vi.mock('./stock-movement.service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./stock-movement.service.js')>()
  return {
    ...real,
    recascadeAfterSyncControlChange: vi.fn((...args: Parameters<typeof real.recascadeAfterSyncControlChange>) => {
      const promise = real.recascadeAfterSyncControlChange(...args)
      hoisted.recascades.push(promise)
      return promise
    }),
  }
})

const A = 'ws_a_end_times'
const B = 'ws_b_end_times'
const serverUrl = concurrentDatabaseUrl()
const flagBefore = process.env.NEXUS_WORKSPACES_ENABLED
const MINUTE = 60_000

describe.skipIf(!serverUrl)(`Shared stock step 3 — end times (needs ${CONCURRENT_PG_ENV})`, () => {
  let app: FastifyInstance
  let endTimes: typeof import('./listing-end-times.service.js')
  let followMaster: typeof import('./follow-master.service.js')
  const person = { id: randomUUID(), email: 'owner.b@example.test' }
  const id: Record<string, string> = {}
  const until: Record<string, string> = {}

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]
  const as = <T>(workspaceId: string, work: () => Promise<T>) =>
    withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)
  const settle = async () => { while (hoisted.recascades.length) await Promise.all(hoisted.recascades.splice(0)) }
  const listingRow = async (listingId: string) => (await q<{ quantity: number; followMasterQuantity: boolean; syncPaused: boolean; pinnedUntil: Date | null; pausedUntil: Date | null; quantityOverride: number | null }>(
    `SELECT quantity, "quantityOverride", "followMasterQuantity", "syncPaused", "pinnedUntil" AT TIME ZONE 'UTC' AS "pinnedUntil", "pausedUntil" AT TIME ZONE 'UTC' AS "pausedUntil" FROM "ChannelListing" WHERE id = $1`, [listingId]))[0]
  const memberRow = async (memberId: string) => (await q<{ pinnedQuantity: number | null; pinnedUntil: Date | null; followPool: boolean; pausedUntil: Date | null }>(
    `SELECT "pinnedQuantity", "pinnedUntil" AT TIME ZONE 'UTC' AS "pinnedUntil", "followPool", "pausedUntil" AT TIME ZONE 'UTC' AS "pausedUntil" FROM "SharedListingMembership" WHERE id = $1`, [memberId]))[0]
  /** The newest pending quantity push for a listing (what the channel will receive). */
  const lastPush = async (listingId: string) =>
    (await q<{ quantity: number }>(`SELECT (payload->>'quantity')::int AS quantity FROM "OutboundSyncQueue" WHERE "channelListingId" = $1 AND "syncType" = 'QUANTITY_UPDATE' AND "syncStatus" = 'PENDING' ORDER BY "createdAt" DESC LIMIT 1`, [listingId]))[0]?.quantity ?? null
  const memberPush = async (itemId: string) =>
    (await q<{ quantity: number }>(`SELECT (u->>'quantity')::int AS quantity FROM "OutboundSyncQueue" o, jsonb_array_elements(o.payload->'updates') u WHERE o."channelListingId" IS NULL AND o.payload->>'itemId' = $1 ORDER BY o."createdAt" DESC LIMIT 1`, [itemId]))[0]?.quantity ?? null
  /** What the eBay dispatcher does after a successful revise: remember the number each variant was sent. */
  const stampPushed = () => q(`UPDATE "SharedListingMembership" m SET "lastQtyPushed" = x.qty FROM (
      SELECT DISTINCT ON (o.payload->>'itemId', u->>'sku') o.payload->>'itemId' AS item, u->>'sku' AS sku, (u->>'quantity')::int AS qty
      FROM "OutboundSyncQueue" o, jsonb_array_elements(o.payload->'updates') u WHERE o."channelListingId" IS NULL
      ORDER BY o.payload->>'itemId', u->>'sku', o."createdAt" DESC) x
    WHERE m."itemId" = x.item AND m.sku = x.sku`)
  const auditOf = (scopeId: string) => q<{ actor: string; field: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null; reason: string | null }>(
    `SELECT actor, field, before, after, reason FROM "SyncControlAudit" WHERE "scopeId" = $1 ORDER BY "createdAt", id`, [scopeId])
  const act = async (body: Record<string, unknown>) => {
    const response = await app.inject({ method: 'POST', url: '/api/stock/sync-control/actions', payload: body })
    await settle()
    return { status: response.statusCode, body: response.json() as Record<string, unknown> }
  }
  const coordinate = (listingId: string) => ({ productId: id.coat, channel: listingKey[listingId][0], marketplace: listingKey[listingId][1], channelConnectionId: listingKey[listingId][2], aliasKey: '' })
  const listingKey: Record<string, [string, string, string | null]> = {}
  const inMinutes = (n: number) => new Date(Date.now() + n * MINUTE).toISOString()

  beforeAll(async () => {
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    database = await concurrentDatabase({ maxConnections: 16 })
    await q(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1,'Business A','active','e2e',$1,now()), ($2,'Business B','active','e2e',$2,now())`, [A, B])
    // The signed-in person is an owner of B (row security shows a business's rows only to its members).
    const ownerRole = randomUUID(), membership = randomUUID()
    await q(`INSERT INTO "Role" (id, key, name, "isSystem", "updatedAt") VALUES ($1,'OWNER','Owner',true,now())`, [ownerRole])
    await q(`INSERT INTO "UserProfile" (id, email, status, "updatedAt") VALUES ($1,$2,'active',now())`, [person.id, person.email])
    await q(`INSERT INTO "WorkspaceMembership" (id, "workspaceId", "userId", status, "updatedAt") VALUES ($1,$2,$3,'active',now())`, [membership, B, person.id])
    await q(`INSERT INTO "WorkspaceMemberRole" ("membershipId","roleId") VALUES ($1,$2)`, [membership, ownerRole])
    const location = async (workspaceId: string, code: string) => {
      const lid = randomUUID()
      await q(`INSERT INTO "StockLocation" (id, "workspaceId", type, code, name, "updatedAt") VALUES ($1,$2,'WAREHOUSE',$3,$3,now())`, [lid, workspaceId, code])
      return lid
    }
    id.bMain = await location(B, 'B-MAIN')
    id.aMain = await location(A, 'A-MAIN')
    id.coat = randomUUID(); id.aCoat = randomUUID()
    await q(`INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", "totalStock", "updatedAt") VALUES ($1,$2,'COAT','Coat',10,8,now()), ($3,$4,'COAT','Coat',10,5,now())`, [id.coat, B, id.aCoat, A])
    await q(`INSERT INTO "StockLevel" (id, "workspaceId", "locationId", "productId", quantity, reserved, available, "lastUpdatedAt") VALUES ($1,$2,$3,$4,8,0,8,now()), ($5,$6,$7,$8,5,0,5,now())`,
      [randomUUID(), B, id.bMain, id.coat, randomUUID(), A, id.aMain, id.aCoat])

    // B's eBay listings name B's eBay account, as a live listing does: a pin to 0 on eBay asks that account's
    // out-of-stock option (stood in as ON above), and a listing that names no account cannot be asked.
    id.bEbay = randomUUID()
    await q(`INSERT INTO "ChannelConnection" ("workspaceId", id, "channelType", "accountLabel", "isActive", "isPrimary", "updatedAt") VALUES ($1,$2,'EBAY','B eBay',true,true,now())`, [B, id.bEbay])
    const listing = async (name: string, workspaceId: string, productId: string, channel: string, marketplace: string, extra: Record<string, unknown> = {}) => {
      const lid = randomUUID()
      const account = workspaceId === B && channel === 'EBAY' ? id.bEbay : null
      const cols = { id: lid, workspaceId, productId, channel, marketplace, region: marketplace, channelMarket: `${channel}_${marketplace}`, listingStatus: 'ACTIVE', externalListingId: `ext-${lid.slice(0, 6)}`, updatedAt: new Date(), channelConnectionId: account, ...extra }
      const keys = Object.keys(cols)
      await q(`INSERT INTO "ChannelListing" (${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(cols))
      id[name] = lid
      listingKey[lid] = [channel, marketplace, account]
    }
    // Business B's coat: 8 in its warehouse.
    await listing('eIT', B, id.coat, 'EBAY', 'IT', { quantity: 7, stockBuffer: 1 }) // follows: 8 − 1
    await listing('eDE', B, id.coat, 'EBAY', 'DE', { quantity: 8 })
    await listing('eES', B, id.coat, 'EBAY', 'ES', { quantity: 8 })
    await listing('eFR', B, id.coat, 'EBAY', 'FR', { quantity: 8 })
    await listing('sGL', B, id.coat, 'SHOPIFY', 'GLOBAL', { quantity: 8 })
    await listing('aFba', B, id.coat, 'AMAZON', 'IT', { quantity: 4, followMasterQuantity: false, quantityOverride: 4, fulfillmentMethod: 'FBA' })
    await listing('eUK', B, id.coat, 'EBAY', 'UK', { quantity: 3, followMasterQuantity: false, quantityOverride: 3, listingStatus: 'ENDED' })
    await listing('eNL', B, id.coat, 'EBAY', 'NL', { quantity: 2, followMasterQuantity: false, quantityOverride: 2 })
    await listing('eBE', B, id.coat, 'EBAY', 'BE', { quantity: 2, followMasterQuantity: false, quantityOverride: 2 })
    await listing('eAT', B, id.coat, 'EBAY', 'AT', { quantity: 2, followMasterQuantity: false, quantityOverride: 2 })
    await listing('aOther', A, id.aCoat, 'EBAY', 'IT', { quantity: 1, followMasterQuantity: false, quantityOverride: 1 })
    // Three shared eBay variants of B's coat (one variant in three eBay listings).
    for (const [name, itemId, lastQtyPushed] of [['m1', 'ITEM-1', 8], ['m2', 'ITEM-2', 5], ['m3', 'ITEM-3', 8]] as const) {
      id[name] = randomUUID()
      await q(`INSERT INTO "SharedListingMembership" (id, "workspaceId", marketplace, sku, "itemId", "parentSku", "productId", "variationSpecifics", "lastQtyPushed", "updatedAt") VALUES ($1,$2,'IT','COAT',$3,'COAT',$4,'{}'::jsonb,$5,now())`,
        [id[name], B, itemId, id.coat, lastQtyPushed])
    }

    endTimes = await import('./listing-end-times.service.js')
    followMaster = await import('./follow-master.service.js')
    app = Fastify()
    app.addHook('preHandler', (request, _reply, done) => {
      ;(request as unknown as { authUser: typeof person }).authUser = person
      withWorkspace({ workspaceId: B, actorUserId: person.id, membershipId: membership, roleKeys: ['OWNER'] }, done)
    })
    await app.register((await import('@fastify/multipart')).default)
    const { default: routes } = await import('../routes/sync-control.routes.js')
    await app.register(routes, { prefix: '/api' })
    await app.ready()
  }, 180_000)

  afterAll(async () => {
    await app?.close()
    if (flagBefore === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
    else process.env.NEXUS_WORKSPACES_ENABLED = flagBefore
    await database?.close()
  }, 60_000)

  describe('the database rule: an end time never outlives its mode', () => {
    it('a listing: kept while fixed (a new number keeps it); cleared by Follow; never stored on a following listing', async () => {
      const lid = randomUUID()
      await q(`INSERT INTO "ChannelListing" (id, "workspaceId", "productId", channel, marketplace, region, "channelMarket", "listingStatus", quantity, "followMasterQuantity", "pinnedUntil", "updatedAt")
        VALUES ($1,$2,$3,'WOOCOMMERCE','GLOBAL','GLOBAL','WOOCOMMERCE_GLOBAL','ACTIVE',2,false, now() + interval '1 day', now())`, [lid, B, id.coat])
      expect((await listingRow(lid)).pinnedUntil).not.toBeNull()
      await q(`UPDATE "ChannelListing" SET quantity = 5, "quantityOverride" = 5 WHERE id = $1`, [lid])
      expect((await listingRow(lid)).pinnedUntil, 'changing only the fixed number keeps its end').not.toBeNull()
      await q(`UPDATE "ChannelListing" SET "followMasterQuantity" = true WHERE id = $1`, [lid])
      expect((await listingRow(lid)).pinnedUntil, 'Follow clears the end of the fixed number').toBeNull()
      await q(`UPDATE "ChannelListing" SET "pinnedUntil" = now() + interval '1 day' WHERE id = $1`, [lid])
      expect((await listingRow(lid)).pinnedUntil, 'a following listing cannot hold a fixed-number end').toBeNull()
      await q(`DELETE FROM "ChannelListing" WHERE id = $1`, [lid])
    })

    it('a listing: a pause end is kept while paused; cleared by Resume; never stored on a listing that is not paused', async () => {
      const lid = randomUUID()
      await q(`INSERT INTO "ChannelListing" (id, "workspaceId", "productId", channel, marketplace, region, "channelMarket", "listingStatus", quantity, "syncPaused", "pausedUntil", "updatedAt")
        VALUES ($1,$2,$3,'WOOCOMMERCE','GLOBAL','GLOBAL','WOOCOMMERCE_GLOBAL','ACTIVE',2,true, now() + interval '1 day', now())`, [lid, B, id.coat])
      expect((await listingRow(lid)).pausedUntil).not.toBeNull()
      await q(`UPDATE "ChannelListing" SET "followMasterQuantity" = false, quantity = 1 WHERE id = $1`, [lid])
      expect((await listingRow(lid)).pausedUntil, 'another control changing keeps the pause end').not.toBeNull()
      await q(`UPDATE "ChannelListing" SET "syncPaused" = false WHERE id = $1`, [lid])
      expect((await listingRow(lid)).pausedUntil, 'Resume clears the pause end').toBeNull()
      await q(`UPDATE "ChannelListing" SET "pausedUntil" = now() + interval '1 day' WHERE id = $1`, [lid])
      expect((await listingRow(lid)).pausedUntil, 'a listing that is not paused cannot hold a pause end').toBeNull()
      await q(`DELETE FROM "ChannelListing" WHERE id = $1`, [lid])
    })

    it('a shared variant: the same rule for its fixed number and for Excluded; a negative fixed number is refused', async () => {
      const mid = randomUUID()
      await q(`INSERT INTO "SharedListingMembership" (id, "workspaceId", marketplace, sku, "itemId", "parentSku", "productId", "variationSpecifics", "pinnedQuantity", "pinnedUntil", "followPool", "pausedUntil", "updatedAt")
        VALUES ($1,$2,'IT','COAT','ITEM-RULE','COAT',$3,'{}'::jsonb, 2, now() + interval '1 day', false, now() + interval '1 day', now())`, [mid, B, id.coat])
      expect(await memberRow(mid)).toMatchObject({ pinnedQuantity: 2, followPool: false })
      expect((await memberRow(mid)).pinnedUntil).not.toBeNull()
      await q(`UPDATE "SharedListingMembership" SET "pinnedQuantity" = 4 WHERE id = $1`, [mid])
      expect((await memberRow(mid)).pinnedUntil, 'a new fixed number keeps its end').not.toBeNull()
      await q(`UPDATE "SharedListingMembership" SET "pinnedQuantity" = NULL WHERE id = $1`, [mid])
      expect((await memberRow(mid)).pinnedUntil, 'following the pool clears the fixed-number end').toBeNull()
      expect((await memberRow(mid)).pausedUntil, 'the exclusion end is untouched by that').not.toBeNull()
      await q(`UPDATE "SharedListingMembership" SET "followPool" = true WHERE id = $1`, [mid])
      expect((await memberRow(mid)).pausedUntil, 'Include clears the exclusion end').toBeNull()
      await q(`UPDATE "SharedListingMembership" SET "pausedUntil" = now() + interval '1 day', "pinnedUntil" = now() + interval '1 day' WHERE id = $1`, [mid])
      expect(await memberRow(mid), 'neither end is stored on a variant that follows the pool').toMatchObject({ pinnedUntil: null, pausedUntil: null })
      await expect(q(`UPDATE "SharedListingMembership" SET "pinnedQuantity" = -1 WHERE id = $1`, [mid])).rejects.toMatchObject({ code: '23514' })
      await q(`DELETE FROM "SharedListingMembership" WHERE id = $1`, [mid])
    })
  })

  describe('Sync Control: setting an end time', () => {
    it('refuses a bad end time or number, and writes nothing', async () => {
      const before = await listingRow(id.eIT)
      const refusals: Array<[Record<string, unknown>, RegExp]> = [
        [{ action: 'PIN', until: 'next monday', listings: [coordinate(id.eIT)] }, /not a valid date/],
        [{ action: 'PIN', until: new Date(Date.now() + 20_000).toISOString(), listings: [coordinate(id.eIT)] }, /at least one minute/],
        [{ action: 'PIN', until: new Date(Date.now() + 400 * 24 * 60 * MINUTE).toISOString(), listings: [coordinate(id.eIT)] }, /within one year/],
        [{ action: 'RESUME', until: inMinutes(5), listings: [coordinate(id.eIT)] }, /Fixed number, Zero & Pin, Hold stock sync or Exclude only/],
        [{ action: 'FOLLOW', quantity: 2, listings: [coordinate(id.eIT)] }, /whole number of 0 or more/],
        [{ action: 'PIN', quantity: -1, memberships: [{ itemId: 'ITEM-1', marketplace: 'IT', sku: 'COAT' }] }, /whole number of 0 or more/],
        [{ action: 'PIN', quantity: 2.5, memberships: [{ itemId: 'ITEM-1', marketplace: 'IT', sku: 'COAT' }] }, /whole number of 0 or more/],
        [{ action: 'PIN', quantity: 2, listings: [coordinate(id.eIT)], memberships: [{ itemId: 'ITEM-1', marketplace: 'IT', sku: 'COAT' }] }, /shared eBay variants only/],
      ]
      for (const [body, message] of refusals) {
        const r = await act(body)
        expect(r.status, JSON.stringify(body)).toBe(400)
        expect(String(r.body.error)).toMatch(message)
      }
      expect(await listingRow(id.eIT)).toEqual(before)
      expect(await memberRow(id.m1)).toMatchObject({ pinnedQuantity: null, pinnedUntil: null })
      expect(await q(`SELECT 1 FROM "SyncControlAudit"`)).toHaveLength(0)
    })

    it('sets the end with Fixed number, Zero & Pin, Pause and Exclude; a shared variant gets a fixed number; the history names the person', async () => {
      until.eIT = inMinutes(2); until.eDE = inMinutes(3); until.sGL = inMinutes(2); until.eES = inMinutes(2); until.eFR = inMinutes(2)
      until.m1 = inMinutes(2); until.m3 = inMinutes(2)
      expect((await act({ action: 'PIN', until: until.eIT, listings: [coordinate(id.eIT)] })).status).toBe(200)
      expect((await act({ action: 'ZERO_PIN', until: until.eDE, listings: [coordinate(id.eDE)] })).status).toBe(200)
      expect((await act({ action: 'PAUSE', until: until.sGL, listings: [coordinate(id.sGL)] })).status).toBe(200)
      expect((await act({ action: 'PIN', until: until.eES, listings: [coordinate(id.eES)] })).status).toBe(200)
      expect((await act({ action: 'PIN', until: until.eFR, listings: [coordinate(id.eFR)] })).status).toBe(200)
      // The FBA listing is Amazon's: no fixed number, no end time.
      const fba = await act({ action: 'PIN', until: inMinutes(2), listings: [coordinate(id.aFba)] })
      expect(fba.body).toMatchObject({ skippedFba: 1 })
      expect((await listingRow(id.aFba)).pinnedUntil).toBeNull()
      // Shared variants: a chosen number with an end; a number taken from what eBay shows now; Excluded with an end.
      expect((await act({ action: 'PIN', quantity: 3, until: until.m1, memberships: [{ itemId: 'ITEM-1', marketplace: 'IT', sku: 'COAT' }] })).body).toMatchObject({ updated: 1 })
      expect((await act({ action: 'PIN', memberships: [{ itemId: 'ITEM-2', marketplace: 'IT', sku: 'COAT' }] })).body).toMatchObject({ updated: 1 })
      expect((await act({ action: 'EXCLUDE', until: until.m3, memberships: [{ itemId: 'ITEM-3', marketplace: 'IT', sku: 'COAT' }] })).status).toBe(200)

      expect(await listingRow(id.eIT)).toMatchObject({ followMasterQuantity: false, quantity: 7, pinnedUntil: new Date(until.eIT) })
      expect(await listingRow(id.eDE)).toMatchObject({ followMasterQuantity: false, quantity: 0, pinnedUntil: new Date(until.eDE) })
      expect(await listingRow(id.sGL)).toMatchObject({ syncPaused: true, pausedUntil: new Date(until.sGL) })
      expect(await memberRow(id.m1)).toEqual({ pinnedQuantity: 3, pinnedUntil: new Date(until.m1), followPool: true, pausedUntil: null })
      expect(await memberRow(id.m2)).toEqual({ pinnedQuantity: 5, pinnedUntil: null, followPool: true, pausedUntil: null })
      expect(await memberRow(id.m3)).toEqual({ pinnedQuantity: null, pinnedUntil: null, followPool: false, pausedUntil: new Date(until.m3) })
      // The fixed variant is sent its number at once (eBay showed 8).
      expect(await memberPush('ITEM-1')).toBe(3)
      await stampPushed()

      const history = await auditOf(id.eIT)
      expect(history.map((h) => [h.actor, h.field])).toEqual([[person.email, 'followMasterQuantity'], [person.email, 'pinnedUntil']])
      expect(history[1].after).toEqual({ pinnedUntil: until.eIT })
      expect((await auditOf(id.m1)).map((h) => [h.actor, h.field, h.after])).toEqual([[person.email, 'pinnedQuantity', { pinnedQuantity: 3, pinnedUntil: until.m1 }]])
      // Every end-time history row keeps the end it replaced ("no end" here), so a reader sees both.
      expect(history[1].before).toEqual({ pinnedUntil: null })
      expect((await auditOf(id.m1))[0].before).toEqual({ pinnedQuantity: null, pinnedUntil: null })
      expect((await auditOf(id.eDE)).find((h) => h.field === 'zeroPin')?.before).toMatchObject({ pinnedUntil: null })
      expect((await auditOf(id.sGL)).find((h) => h.field === 'pausedUntil')?.before).toEqual({ pausedUntil: null })
      expect((await auditOf(id.m3)).find((h) => h.field === 'pausedUntil')?.before).toEqual({ pausedUntil: null })
      // Replacing an end, then putting it back: the history shows each old end.
      const later = inMinutes(30)
      expect((await act({ action: 'PIN', until: later, listings: [coordinate(id.eIT)] })).status).toBe(200)
      expect((await act({ action: 'PIN', until: until.eIT, listings: [coordinate(id.eIT)] })).status).toBe(200)
      expect((await auditOf(id.eIT)).filter((h) => h.field === 'pinnedUntil').map((h) => [h.before, h.after])).toEqual([
        [{ pinnedUntil: null }, { pinnedUntil: until.eIT }], [{ pinnedUntil: until.eIT }, { pinnedUntil: later }], [{ pinnedUntil: later }, { pinnedUntil: until.eIT }]])
      expect(await listingRow(id.eIT)).toMatchObject({ followMasterQuantity: false, quantity: 7, pinnedUntil: new Date(until.eIT) })
      // The write itself: a listing that follows (Shopify: paused, still following) never gets a pin end,
      // even when handed one (an operator's Follow landing between the pin and its end).
      const { setListingPinEnds } = await import('./sync-control-overrides.service.js')
      const replaced = await as(B, () => setListingPinEnds([id.eIT, id.sGL], new Date(later)))
      expect(Object.fromEntries(replaced)).toEqual({ [id.eIT]: until.eIT, [id.sGL]: null })
      expect(await listingRow(id.sGL)).toMatchObject({ followMasterQuantity: true, pinnedUntil: null })
      expect((await listingRow(id.eIT)).pinnedUntil).toEqual(new Date(later))
      await as(B, () => setListingPinEnds([id.eIT], new Date(until.eIT)))
    })

    it('the page shows each end time, and the fixed number of a shared variant', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/stock/sync-control/listings?pageSize=100' })
      const rows = (response.json() as { rows: Array<{ lane: string; channel: string; marketplace: string; itemId?: string; mode: string; intendedQty: number | null; endsAt: string | null }> }).rows
      const row = (channel: string, marketplace: string, itemId?: string) => rows.find((r) => r.channel === channel && r.marketplace === marketplace && (itemId ? r.itemId === itemId : r.lane === 'LISTING'))
      expect(row('EBAY', 'IT')).toMatchObject({ mode: 'PINNED', intendedQty: 7, endsAt: until.eIT })
      expect(row('EBAY', 'DE')).toMatchObject({ mode: 'PINNED', intendedQty: 0, endsAt: until.eDE })
      expect(row('SHOPIFY', 'GLOBAL')).toMatchObject({ mode: 'PAUSED', endsAt: until.sGL })
      expect(row('EBAY', 'IT', 'ITEM-1')).toMatchObject({ mode: 'PINNED', intendedQty: 3, endsAt: until.m1 })
      expect(row('EBAY', 'IT', 'ITEM-2')).toMatchObject({ mode: 'PINNED', intendedQty: 5, endsAt: null })
      expect(row('EBAY', 'IT', 'ITEM-3')).toMatchObject({ mode: 'EXCLUDED', endsAt: until.m3 })
    })

    it('a later choice replaces the end: "no end" and a later end', async () => {
      expect((await act({ action: 'PIN', until: null, listings: [coordinate(id.eES)] })).status).toBe(200)
      until.eFR = inMinutes(10)
      expect((await act({ action: 'PIN', until: until.eFR, listings: [coordinate(id.eFR)] })).status).toBe(200)
      expect((await listingRow(id.eES)).pinnedUntil).toBeNull()
      expect((await listingRow(id.eFR)).pinnedUntil).toEqual(new Date(until.eFR))
    })
  })

  describe('the end-time job', () => {
    it('nothing is due before the end times: no run, nothing changes', async () => {
      const now = new Date(Date.now() + 30_000)
      expect(await as(B, () => endTimes.hasDueEndTimes(now))).toBe(false)
    })

    it('when the time comes, each override ends: the number follows the stock, it is sent, and the history says why', async () => {
      // While the listings were fixed or paused, the stock moved: 8 → 6 (nothing was sent then).
      await q(`UPDATE "StockLevel" SET quantity = 6, available = 6 WHERE "productId" = $1`, [id.coat])
      const now = new Date(Date.now() + 5 * MINUTE)
      expect(await as(B, () => endTimes.hasDueEndTimes(now))).toBe(true)
      const run = await as(B, () => endTimes.endDueOverrides(now))
      expect(run).toEqual({ fixedEnded: 2, fixedLapsedFba: 0, pausesEnded: 1, sharedFixedEnded: 1, sharedExclusionsEnded: 1, retryLater: 0 })

      expect(await listingRow(id.eIT)).toMatchObject({ followMasterQuantity: true, quantity: 5, quantityOverride: null, pinnedUntil: null }) // 6 − hold back 1
      expect(await lastPush(id.eIT)).toBe(5)
      expect(await listingRow(id.eDE)).toMatchObject({ followMasterQuantity: true, quantity: 6, pinnedUntil: null })
      expect(await lastPush(id.eDE)).toBe(6)
      expect(await listingRow(id.sGL)).toMatchObject({ syncPaused: false, pausedUntil: null, quantity: 6 })
      expect(await lastPush(id.sGL)).toBe(6)
      expect(await memberRow(id.m1)).toMatchObject({ pinnedQuantity: null, pinnedUntil: null })
      expect(await memberPush('ITEM-1')).toBe(6)
      expect(await memberRow(id.m3)).toMatchObject({ followPool: true, pausedUntil: null })
      expect(await memberPush('ITEM-3')).toBe(6)
      // Untouched: a fixed number with no end, an end moved later by the operator, the FBA listing.
      expect(await listingRow(id.eES)).toMatchObject({ followMasterQuantity: false, quantity: 8 })
      expect(await listingRow(id.eFR)).toMatchObject({ followMasterQuantity: false, pinnedUntil: new Date(until.eFR) })
      expect(await memberRow(id.m2)).toMatchObject({ pinnedQuantity: 5 })
      expect(await listingRow(id.aFba)).toMatchObject({ followMasterQuantity: false, quantity: 4 })

      const job = (rows: Awaited<ReturnType<typeof auditOf>>) => rows.filter((r) => r.actor === 'system:end-time')
      expect(job(await auditOf(id.eIT))).toEqual([{
        actor: 'system:end-time', field: 'followMasterQuantity', reason: 'The fixed number reached its end time.',
        before: { follow: false, quantity: 7, pinnedUntil: until.eIT }, after: { follow: true, quantity: 5 },
      }])
      expect(job(await auditOf(id.sGL))).toEqual([{
        actor: 'system:end-time', field: 'syncPaused', reason: 'The pause reached its end time.',
        before: { syncPaused: true, pausedUntil: until.sGL }, after: { syncPaused: false },
      }])
      expect(job(await auditOf(id.m1))).toEqual([{
        actor: 'system:end-time', field: 'pinnedQuantity', reason: 'The fixed number reached its end time.',
        before: { pinnedQuantity: 3, pinnedUntil: until.m1 }, after: { pinnedQuantity: null },
      }])
      expect(job(await auditOf(id.m3))).toEqual([{
        actor: 'system:end-time', field: 'followPool', reason: 'The exclusion reached its end time.',
        before: { followPool: false, pausedUntil: until.m3 }, after: { followPool: true },
      }])

      // A second run finds nothing: every end time was consumed with its mode.
      expect(await as(B, () => endTimes.hasDueEndTimes(now))).toBe(false)
      expect(await as(B, () => endTimes.endDueOverrides(now))).toEqual({ fixedEnded: 0, fixedLapsedFba: 0, pausesEnded: 0, sharedFixedEnded: 0, sharedExclusionsEnded: 0, retryLater: 0 })
    })

    it('the later end the operator chose is kept to: nothing at +5 min, the fixed number ends at +11 min', async () => {
      const run = await as(B, () => endTimes.endDueOverrides(new Date(Date.now() + 11 * MINUTE)))
      expect(run).toMatchObject({ fixedEnded: 1, retryLater: 0 })
      expect(await listingRow(id.eFR)).toMatchObject({ followMasterQuantity: true, quantity: 6, pinnedUntil: null })
    })

    it('an operator change made after the end time passed, before the job ran, is never overruled', async () => {
      await q(`UPDATE "ChannelListing" SET "pinnedUntil" = (now() AT TIME ZONE 'UTC') - interval '1 minute' WHERE id = $1`, [id.eAT])
      // The operator sets Follow and then a new fixed number without an end, before the job's minute.
      await q(`UPDATE "ChannelListing" SET "followMasterQuantity" = true WHERE id = $1`, [id.eAT])
      await q(`UPDATE "ChannelListing" SET "followMasterQuantity" = false, quantity = 4, "quantityOverride" = 4 WHERE id = $1`, [id.eAT])
      expect(await as(B, () => endTimes.hasDueEndTimes())).toBe(false)
      expect(await as(B, () => endTimes.endDueOverrides())).toMatchObject({ fixedEnded: 0, retryLater: 0 })
      expect(await listingRow(id.eAT)).toMatchObject({ followMasterQuantity: false, quantity: 4, pinnedUntil: null })
    })

    it('an Amazon-managed (FBA) listing: nothing is sent; its end time ends, and the history says so', async () => {
      await q(`UPDATE "ChannelListing" SET "pinnedUntil" = (now() AT TIME ZONE 'UTC') - interval '1 minute' WHERE id = $1`, [id.aFba])
      const run = await as(B, () => endTimes.endDueOverrides())
      expect(run).toMatchObject({ fixedEnded: 0, fixedLapsedFba: 1, retryLater: 0 })
      expect(await listingRow(id.aFba)).toMatchObject({ followMasterQuantity: false, quantity: 4, pinnedUntil: null })
      expect(await lastPush(id.aFba)).toBeNull()
      expect((await auditOf(id.aFba)).filter((r) => r.actor === 'system:end-time').map((r) => [r.field, r.reason]))
        .toEqual([['pinnedUntil', 'The fixed number reached its end time. Amazon manages this listing (FBA), so nothing was sent.']])
      expect(await as(B, () => endTimes.hasDueEndTimes())).toBe(false)
    })

    it('an ENDED listing is not due; the moment it is live again, its fixed number ends', async () => {
      await q(`UPDATE "ChannelListing" SET "pinnedUntil" = (now() AT TIME ZONE 'UTC') - interval '1 minute' WHERE id = $1`, [id.eUK])
      expect(await as(B, () => endTimes.hasDueEndTimes())).toBe(false)
      expect(await as(B, () => endTimes.endDueOverrides())).toMatchObject({ fixedEnded: 0, retryLater: 0 })
      expect((await listingRow(id.eUK)).pinnedUntil, 'kept while the listing is ended').not.toBeNull()
      await q(`UPDATE "ChannelListing" SET "listingStatus" = 'ACTIVE' WHERE id = $1`, [id.eUK])
      expect(await as(B, () => endTimes.hasDueEndTimes())).toBe(true)
      expect(await as(B, () => endTimes.endDueOverrides())).toMatchObject({ fixedEnded: 1, retryLater: 0 })
      expect(await listingRow(id.eUK)).toMatchObject({ followMasterQuantity: true, quantity: 6, pinnedUntil: null })
    })

    it('a writer that fails leaves the end time; the next minute ends it (never fixed forever)', async () => {
      await q(`UPDATE "ChannelListing" SET "pinnedUntil" = (now() AT TIME ZONE 'UTC') - interval '1 minute' WHERE id = ANY($1)`, [[id.eNL, id.eBE]])
      vi.mocked(followMaster.setFollowMasterQuantity).mockRejectedValueOnce(new Error('database went away'))
      expect(await as(B, () => endTimes.endDueOverrides())).toMatchObject({ fixedEnded: 0, retryLater: 2 })
      for (const lid of [id.eNL, id.eBE]) {
        expect(await listingRow(lid), 'still fixed, end time kept').toMatchObject({ followMasterQuantity: false, quantity: 2 })
        expect((await listingRow(lid)).pinnedUntil).not.toBeNull()
        expect((await auditOf(lid)).filter((r) => r.actor === 'system:end-time')).toEqual([])
      }
      expect(await as(B, () => endTimes.hasDueEndTimes())).toBe(true)

      // The writer stops mid-way: only the first row is written.
      vi.mocked(followMaster.setFollowMasterQuantity).mockImplementationOnce(async (opts) =>
        (hoisted.realSetFollow as typeof followMaster.setFollowMasterQuantity)({ ...opts, coordinates: opts.coordinates!.slice(0, 1) }))
      expect(await as(B, () => endTimes.endDueOverrides())).toMatchObject({ fixedEnded: 1, retryLater: 1 })
      expect(await as(B, () => endTimes.endDueOverrides())).toMatchObject({ fixedEnded: 1, retryLater: 0 })
      for (const lid of [id.eNL, id.eBE]) {
        expect(await listingRow(lid)).toMatchObject({ followMasterQuantity: true, quantity: 6, pinnedUntil: null })
        expect((await auditOf(lid)).filter((r) => r.actor === 'system:end-time').map((r) => r.field)).toEqual(['followMasterQuantity'])
      }
    })

    it("one business's run never touches another business's rows", async () => {
      await q(`UPDATE "ChannelListing" SET "pinnedUntil" = (now() AT TIME ZONE 'UTC') - interval '1 minute' WHERE id = $1`, [id.aOther])
      expect(await as(B, () => endTimes.hasDueEndTimes())).toBe(false)
      expect(await as(B, () => endTimes.endDueOverrides())).toMatchObject({ fixedEnded: 0, retryLater: 0 })
      expect(await listingRow(id.aOther)).toMatchObject({ followMasterQuantity: false, quantity: 1 })
      // In its own business, it ends (5 in A's warehouse).
      expect(await as(A, () => endTimes.hasDueEndTimes())).toBe(true)
      expect(await as(A, () => endTimes.endDueOverrides())).toMatchObject({ fixedEnded: 1 })
      expect(await listingRow(id.aOther)).toMatchObject({ followMasterQuantity: true, quantity: 5, pinnedUntil: null })
      expect((await q<{ workspaceId: string }>(`SELECT "workspaceId" FROM "SyncControlAudit" WHERE "scopeId" = $1`, [id.aOther])).map((r) => r.workspaceId)).toEqual([A])
    })

    it('the probe can use the partial indexes (a table scan is never the only way)', async () => {
      const client = await database.pool.connect()
      try {
        await client.query('SET enable_seqscan = off')
        const plan = (await client.query(`EXPLAIN SELECT id FROM "ChannelListing" WHERE "pinnedUntil" <= now() OR "pausedUntil" <= now()`)).rows.map((r) => r['QUERY PLAN']).join('\n')
        expect(plan).toMatch(/ChannelListing_pinnedUntil_due/)
        expect(plan).toMatch(/ChannelListing_pausedUntil_due/)
        const members = (await client.query(`EXPLAIN SELECT id FROM "SharedListingMembership" WHERE "pinnedUntil" <= now() OR "pausedUntil" <= now()`)).rows.map((r) => r['QUERY PLAN']).join('\n')
        expect(members).toMatch(/SharedListingMembership_pinnedUntil_due/)
        expect(members).toMatch(/SharedListingMembership_pausedUntil_due/)
      } finally {
        await client.query('RESET enable_seqscan')
        client.release()
      }
    })
  })

  describe('Excel: a fixed number for a shared variant', () => {
    const upload = async (path: 'preview' | 'apply', rows: Array<{ itemId: string; mode: string; pinnedQty: number | '' }>) => {
      const { buildSyncControlWorkbook } = await import('./sync-control-excel.js')
      const workbook = await buildSyncControlWorkbook(rows.map((r) => ({
        product: 'Coat', sku: 'COAT', channel: 'EBAY', market: 'IT', itemId: r.itemId, lane: 'SHARED', mode: r.mode, pinnedQty: r.pinnedQty,
        buffer: 0, pool: '', intended: '', live: '', drift: '', locked: '',
      })), [])
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(workbook)]), 'sync-control.xlsx')
      const request = new Request('http://test.invalid', { method: 'POST', body: form })
      const response = await app.inject({
        method: 'POST', url: `/api/stock/sync-control/import/${path}`,
        headers: { 'content-type': request.headers.get('content-type')! }, payload: Buffer.from(await request.arrayBuffer()),
      })
      await settle()
      return { status: response.statusCode, body: response.json() as Record<string, unknown> }
    }
    const rows = [
      { itemId: 'ITEM-1', mode: 'Pinned', pinnedQty: 4 as const },
      { itemId: 'ITEM-2', mode: 'Follow', pinnedQty: '' as const },
      { itemId: 'ITEM-3', mode: 'Pinned', pinnedQty: '' as const },
    ]

    it('the preview names each change and refuses a Fixed number without its number; nothing is written', async () => {
      await q(`UPDATE "SharedListingMembership" SET "pinnedUntil" = (now() AT TIME ZONE 'UTC') + interval '1 day' WHERE id = $1`, [id.m2])
      const before = [await memberRow(id.m1), await memberRow(id.m2), await memberRow(id.m3)]
      const preview = await upload('preview', rows)
      expect(preview.status).toBe(200)
      expect((preview.body.changes as Array<Record<string, unknown>>).map((c) => [c.itemId, c.field, c.to, c.pinnedQty ?? null])).toEqual([
        ['ITEM-1', 'mode', 'PINNED', 4],
        ['ITEM-2', 'mode', 'FOLLOW', null],
      ])
      expect(preview.body.skipped).toEqual([{ key: 'COAT@EBAY:IT', reason: 'a Fixed number for a shared variant needs the number in the pinned column' }])
      expect([await memberRow(id.m1), await memberRow(id.m2), await memberRow(id.m3)]).toEqual(before)
    })

    it('apply: the variant is fixed at the sheet\'s number and sent it; Follow clears the number and its end; the history names the person', async () => {
      const applied = await upload('apply', rows)
      expect(applied.body).toMatchObject({ applied: 2, failed: [] })
      expect(await memberRow(id.m1)).toEqual({ pinnedQuantity: 4, pinnedUntil: null, followPool: true, pausedUntil: null })
      expect(await memberPush('ITEM-1')).toBe(4)
      expect(await memberRow(id.m2)).toEqual({ pinnedQuantity: null, pinnedUntil: null, followPool: true, pausedUntil: null })
      expect(await memberRow(id.m3)).toMatchObject({ pinnedQuantity: null, followPool: true })
      expect((await q<{ actor: string; after: Record<string, unknown> }>(`SELECT actor, after FROM "SyncControlAudit" WHERE actor LIKE 'excel:%' ORDER BY "createdAt", id`)).map((r) => [r.actor, r.after]))
        .toEqual([[`excel:${person.email}`, { mode: 'PINNED', pinnedQty: 4 }], [`excel:${person.email}`, { mode: 'FOLLOW' }]])
    })
  })


  describe('a change made while the job runs (after its read, before its write) is never overruled', () => {
    const PAST = `(now() AT TIME ZONE 'UTC') - interval '1 minute'`
    const FUTURE = `(now() AT TIME ZONE 'UTC') + interval '1 day'`

    it('a pause: the operator resumed and paused again without an end — it stays paused', async () => {
      await q(`UPDATE "ChannelListing" SET "syncPaused" = true, "pausedUntil" = ${PAST} WHERE id = $1`, [id.sGL])
      hoisted.beforeNextTransaction = async () => {
        await q(`UPDATE "ChannelListing" SET "syncPaused" = false WHERE id = $1`, [id.sGL])
        await q(`UPDATE "ChannelListing" SET "syncPaused" = true WHERE id = $1`, [id.sGL])
      }
      expect(await as(B, () => endTimes.endDueOverrides())).toMatchObject({ pausesEnded: 0 })
      expect(hoisted.beforeNextTransaction, 'the operator change ran').toBeNull()
      expect(await listingRow(id.sGL)).toMatchObject({ syncPaused: true, pausedUntil: null })
      expect((await auditOf(id.sGL)).filter((r) => r.actor === 'system:end-time')).toHaveLength(1) // the earlier, real end only
    })

    it('a shared fixed number: the operator moved its end later — it stays fixed', async () => {
      await q(`UPDATE "SharedListingMembership" SET "pinnedQuantity" = 1, "pinnedUntil" = ${PAST} WHERE id = $1`, [id.m2])
      hoisted.beforeNextTransaction = () => q(`UPDATE "SharedListingMembership" SET "pinnedUntil" = ${FUTURE} WHERE id = $1`, [id.m2])
      expect(await as(B, () => endTimes.endDueOverrides())).toMatchObject({ sharedFixedEnded: 0 })
      expect(hoisted.beforeNextTransaction, 'the operator change ran').toBeNull()
      expect(await memberRow(id.m2)).toMatchObject({ pinnedQuantity: 1 })
      expect((await memberRow(id.m2)).pinnedUntil).not.toBeNull()
    })

    it('a shared exclusion: the operator included and excluded it again without an end — it stays excluded', async () => {
      await q(`UPDATE "SharedListingMembership" SET "followPool" = false, "pausedUntil" = ${PAST} WHERE id = $1`, [id.m3])
      hoisted.beforeNextTransaction = async () => {
        await q(`UPDATE "SharedListingMembership" SET "followPool" = true WHERE id = $1`, [id.m3])
        await q(`UPDATE "SharedListingMembership" SET "followPool" = false WHERE id = $1`, [id.m3])
      }
      expect(await as(B, () => endTimes.endDueOverrides())).toMatchObject({ sharedExclusionsEnded: 0 })
      expect(hoisted.beforeNextTransaction, 'the operator change ran').toBeNull()
      expect(await memberRow(id.m3)).toMatchObject({ followPool: false, pausedUntil: null })
    })
  })


  describe('each kind of end re-works its own listing (alone, so no other end can do it for it)', () => {
    const PAST = `(now() AT TIME ZONE 'UTC') - interval '1 minute'`
    it('the stock moves to 3 while everything is held', async () => {
      await q(`UPDATE "StockLevel" SET quantity = 3, available = 3 WHERE "productId" = $1`, [id.coat])
      await stampPushed()
      expect(await listingRow(id.sGL)).toMatchObject({ syncPaused: true })
      expect(await memberRow(id.m1)).toMatchObject({ pinnedQuantity: 4 })
      expect(await memberRow(id.m3)).toMatchObject({ followPool: false })
    })

    it('a pause ends alone: the listing is sent the stock of now', async () => {
      await q(`UPDATE "ChannelListing" SET "pausedUntil" = ${PAST} WHERE id = $1`, [id.sGL])
      expect(await as(B, () => endTimes.endDueOverrides())).toEqual({ fixedEnded: 0, fixedLapsedFba: 0, pausesEnded: 1, sharedFixedEnded: 0, sharedExclusionsEnded: 0, retryLater: 0 })
      expect(await lastPush(id.sGL)).toBe(3)
    })

    it('a shared fixed number ends alone: the variant is sent the pool of now', async () => {
      await stampPushed()
      await q(`UPDATE "SharedListingMembership" SET "pinnedUntil" = ${PAST} WHERE id = $1`, [id.m1])
      expect(await as(B, () => endTimes.endDueOverrides())).toEqual({ fixedEnded: 0, fixedLapsedFba: 0, pausesEnded: 0, sharedFixedEnded: 1, sharedExclusionsEnded: 0, retryLater: 0 })
      expect(await memberPush('ITEM-1')).toBe(3)
    })

    it('an exclusion ends alone: the variant is sent the pool of now', async () => {
      await stampPushed()
      await q(`UPDATE "SharedListingMembership" SET "pausedUntil" = ${PAST} WHERE id = $1`, [id.m3])
      expect(await as(B, () => endTimes.endDueOverrides())).toEqual({ fixedEnded: 0, fixedLapsedFba: 0, pausesEnded: 0, sharedFixedEnded: 0, sharedExclusionsEnded: 1, retryLater: 0 })
      expect(await memberPush('ITEM-3')).toBe(3)
    })
  })

})
