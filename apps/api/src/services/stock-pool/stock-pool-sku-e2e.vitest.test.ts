/**
 * Shared stock by SKU, end to end (Owner 2026-10-01; plan docs/shared-stock-by-sku/PLAN-2026-10-01.md) — through
 * the real services, the real cascade and the real pool worker with its LISTEN, on a real multi-connection
 * PostgreSQL with the generated policies, profiles ON. No product share and no catalog link anywhere.
 *
 * One story: A lends its main warehouse to B and to C → B previews and connects two jacket SKUs by SKU, C one →
 * every listing that follows moves (eBay main and copy, Amazon IT and DE, Shopify, Etsy; FBA keeps Amazon's own) →
 * a sale in A and a pool sale in B, both written by the API process (which never kicks the worker), reach the
 * other businesses' listings through the database's wake signal in under 2 s → a connected SKU cannot be renamed
 * in either business (D1) → B disconnects and its listings follow its own stock again.
 *
 * Needs NEXUS_TEST_CONCURRENT_PG_URL (a throwaway Docker PostgreSQL); SKIPS without it. Run by
 * scripts/run-real-postgres-tests.mjs before every push.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { CONCURRENT_PG_ENV, concurrentDatabase, concurrentDatabaseUrl } from '../../test-support/concurrent-database.js'
import { withWorkspace } from '../../lib/workspace-context.js'
import { stockPoolConnectedRefusal } from '../../lib/stock-pool-refusal.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: Record<string, unknown> | null = null
  return {
    default: new Proxy({} as Record<string, unknown>, {
      get: (_t, property) => (wrapped ??= contextualDatabase(database.client as never) as unknown as Record<string, unknown>)[property as string],
    }),
  }
})
vi.mock('../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []) }
  return {
    addJobSafely: vi.fn(async () => undefined),
    outboundSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, channelSyncQueue: queue, bulkJobQueue: queue,
    redis: { connection: null },
  }
})

const A = 'ws_a_sku_e2e'
const B = 'ws_b_sku_e2e'
const C = 'ws_c_sku_e2e'
const serverUrl = concurrentDatabaseUrl()
const flagBefore = process.env.NEXUS_WORKSPACES_ENABLED
const roleBefore = process.env.NEXUS_PROCESS_ROLE
/** The Owner's target (plan §3.5): a sale reaches the other business's listings within 2 s. */
const REAL_TIME_MS = 2_000

describe.skipIf(!serverUrl)(`Shared stock by SKU end to end (needs ${CONCURRENT_PG_ENV})`, () => {
  let grants: typeof import('./pool-grants.service.js')
  let links: typeof import('./pool-links.service.js')
  let tasks: typeof import('./pool-tasks.js')
  let doors: typeof import('./pool-doors.js')
  let movement: typeof import('../stock-movement.service.js')
  const user = { ownerA: randomUUID(), ownerB: randomUUID(), ownerC: randomUUID() }
  const id: Record<string, string> = {}
  const latency: Record<string, number> = {}
  let grantB = ''
  let grantC = ''

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]
  const as = <T>(workspaceId: string, actor: string | null, work: () => Promise<T>) =>
    withWorkspace({ workspaceId, actorUserId: actor, membershipId: null, roleKeys: [] }, work)
  const qty = async (listingId: string) => Number((await q<{ quantity: number | null }>(`SELECT quantity FROM "ChannelListing" WHERE id = $1`, [listingId]))[0].quantity)
  const snapshot = async () => {
    const out: Record<string, number> = {}
    for (const key of ['bEbayM', 'bEbayCopyM', 'bAmazonItM', 'bAmazonDeM', 'bAmazonFbaM', 'bShopifyM', 'bEtsyM', 'bEbayS', 'aEbayM', 'cEbayM']) out[key] = await qty(id[key])
    return out
  }
  /** The newest pending quantity row for a listing: the number the channel will be sent. */
  const lastPush = async (listingId: string) =>
    (await q<{ quantity: number }>(`SELECT (payload->>'quantity')::int AS quantity FROM "OutboundSyncQueue" WHERE "channelListingId" = $1 AND "syncType" = 'QUANTITY_UPDATE' AND "syncStatus" = 'PENDING' ORDER BY "createdAt" DESC LIMIT 1`, [listingId]))[0]?.quantity ?? null
  const pendingTasks = async () => Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM "StockPoolTask"`))[0].n)
  /** Run the pool worker until no task is left (what the wake signal, the kicks and the poll do in the worker). */
  const drain = async () => {
    for (let i = 0; i < 5 && (await pendingTasks()) > 0; i++) await tasks.kickStockPoolWork()
    expect(await pendingTasks(), 'pool tasks left after the worker ran').toBe(0)
  }
  /** Milliseconds until every listing shows its expected number (polled every 10 ms), or the limit. */
  const until = async (expected: Record<string, number>, limitMs: number) => {
    const began = Date.now()
    for (;;) {
      const now = await snapshot()
      if (Object.entries(expected).every(([key, value]) => now[key] === value)) return Date.now() - began
      if (Date.now() - began > limitMs) return Infinity
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  beforeAll(async () => {
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    database = await concurrentDatabase({ maxConnections: 24 })
    await q(`ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_available_invariant" CHECK ("available" = "quantity" - "reserved")`)
    await q(`CREATE UNIQUE INDEX "StockLevel_loc_prod_novar_unique" ON "StockLevel" ("workspaceId", "locationId", "productId") WHERE "variationId" IS NULL`)

    const ownerRole = randomUUID()
    await q(`INSERT INTO "Role" (id, key, name, "isSystem", "updatedAt") VALUES ($1,'OWNER','Owner',true,now())`, [ownerRole])
    for (const [key, uid] of Object.entries(user)) await q(`INSERT INTO "UserProfile" (id, email, status, "updatedAt") VALUES ($1,$2,'active',now())`, [uid, `${key}@example.test`])
    await q(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1,'Lender A','active','e2e',$1,now()), ($2,'Borrower B','active','e2e',$2,now()), ($3,'Borrower C','active','e2e',$3,now())`, [A, B, C])
    const member = async (workspaceId: string, userId: string) => {
      const mid = randomUUID()
      await q(`INSERT INTO "WorkspaceMembership" (id, "workspaceId", "userId", status, "updatedAt") VALUES ($1,$2,$3,'active',now())`, [mid, workspaceId, userId])
      await q(`INSERT INTO "WorkspaceMemberRole" ("membershipId","roleId") VALUES ($1,$2)`, [mid, ownerRole])
    }
    await member(A, user.ownerA)
    await member(B, user.ownerA)
    await member(C, user.ownerA)
    await member(B, user.ownerB)
    await member(C, user.ownerC)

    const location = async (workspaceId: string, code: string) => {
      const lid = randomUUID()
      await q(`INSERT INTO "StockLocation" (id, "workspaceId", type, code, name, "updatedAt") VALUES ($1,$2,'WAREHOUSE',$3,$3,now())`, [lid, workspaceId, code])
      return lid
    }
    id.aMain = await location(A, 'IT-MAIN')
    id.aOutlet = await location(A, 'IT-OUTLET')
    id.bMain = await location(B, 'B-MAIN')

    // The same jacket family in A and B (same SKUs, made separately: no product share), and one SKU in C.
    const product = async (workspaceId: string, sku: string, parentId: string | null = null) => {
      const pid = randomUUID()
      await q(`INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", "parentId", "isParent", "updatedAt") VALUES ($1,$2,$3,$3,105,$4,$5,now())`, [pid, workspaceId, sku, parentId, parentId === null && sku === 'GALE-JACKET'])
      return pid
    }
    for (const ws of [['a', A], ['b', B]] as const) {
      id[`${ws[0]}Parent`] = await product(ws[1], 'GALE-JACKET')
      id[`${ws[0]}M`] = await product(ws[1], 'GALE-JACKET-BLACK-M', id[`${ws[0]}Parent`])
      id[`${ws[0]}S`] = await product(ws[1], 'GALE-JACKET-BLACK-S', id[`${ws[0]}Parent`])
    }
    id.bOnly = await product(B, 'MOTOVENTO-ONLY-CAP')
    id.cM = await product(C, 'GALE-JACKET-BLACK-M')
    const stock = (workspaceId: string, locationId: string, productId: string, quantity: number) =>
      q(`INSERT INTO "StockLevel" (id, "workspaceId", "locationId", "productId", quantity, reserved, available, "lastUpdatedAt") VALUES ($1,$2,$3,$4,$5,0,$5,now())`, [randomUUID(), workspaceId, locationId, productId, quantity])
    await stock(A, id.aMain, id.aM, 10)
    await stock(A, id.aMain, id.aS, 4)
    await stock(A, id.aOutlet, id.aM, 2)
    await stock(B, id.bMain, id.bM, 1)
    await q(`UPDATE "Product" SET "totalStock" = 12 WHERE id = $1`, [id.aM])
    await q(`UPDATE "Product" SET "totalStock" = 4 WHERE id = $1`, [id.aS])
    await q(`UPDATE "Product" SET "totalStock" = 1 WHERE id = $1`, [id.bM])

    const listing = async (workspaceId: string, productId: string, channel: string, marketplace: string, extra: Record<string, unknown> = {}) => {
      const lid = randomUUID()
      const cols = { id: lid, workspaceId, productId, channel, marketplace, region: marketplace, channelMarket: `${channel}_${marketplace}`, listingStatus: 'ACTIVE', externalListingId: `ext-${lid.slice(0, 6)}`, quantity: 0, updatedAt: new Date(), ...extra }
      const keys = Object.keys(cols)
      await q(`INSERT INTO "ChannelListing" (${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(cols))
      return lid
    }
    id.bStore = randomUUID(); id.bCopy = randomUUID()
    await q(`INSERT INTO "ChannelConnection" (id, "workspaceId", "channelType", "accountLabel", "externalAccountId", "isActive", "isPrimary", "updatedAt") VALUES ($1,$2,'EBAY','Motovento store','seller-b',true,true,now())`, [id.bStore, B])
    await q(`INSERT INTO "ProductListingAlias" (id, "workspaceId", "productId", channel, marketplace, "channelConnectionId", label, position, "updatedAt") VALUES ($1,$2,$3,'EBAY','IT',$4,'IT-GALE-JACKET',1,now())`, [id.bCopy, B, id.bParent, id.bStore])
    id.bEbayM = await listing(B, id.bM, 'EBAY', 'IT', { stockBuffer: 1, channelConnectionId: id.bStore })
    id.bEbayCopyM = await listing(B, id.bM, 'EBAY', 'IT', { channelConnectionId: id.bStore, aliasId: id.bCopy, aliasKey: id.bCopy })
    id.bAmazonItM = await listing(B, id.bM, 'AMAZON', 'IT', { fulfillmentMethod: 'FBM' })
    id.bAmazonDeM = await listing(B, id.bM, 'AMAZON', 'DE', { fulfillmentMethod: 'FBM' })
    id.bAmazonFbaM = await listing(B, id.bM, 'AMAZON', 'FR', { fulfillmentMethod: 'FBA', quantity: 6 })
    id.bShopifyM = await listing(B, id.bM, 'SHOPIFY', 'GLOBAL')
    // 2026-10-01 — Etsy joins the stock cascade: it follows the pool like the others, less its own hold-back of 2.
    id.bEtsyM = await listing(B, id.bM, 'ETSY', 'GLOBAL', { stockBuffer: 2 })
    id.bEbayS = await listing(B, id.bS, 'EBAY', 'IT', { channelConnectionId: id.bStore })
    id.aEbayM = await listing(A, id.aM, 'EBAY', 'IT', { quantity: 12 })
    id.cEbayM = await listing(C, id.cM, 'EBAY', 'IT')

    grants = await import('./pool-grants.service.js')
    links = await import('./pool-links.service.js')
    tasks = await import('./pool-tasks.js')
    doors = await import('./pool-doors.js')
    movement = await import('../stock-movement.service.js')
  }, 180_000)

  afterAll(async () => {
    if (flagBefore === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
    else process.env.NEXUS_WORKSPACES_ENABLED = flagBefore
    if (roleBefore === undefined) delete process.env.NEXUS_PROCESS_ROLE
    else process.env.NEXUS_PROCESS_ROLE = roleBefore
    if (process.env.NEXUS_TEST_REPORT_DIR) {
      const { writeFileSync } = await import('node:fs')
      writeFileSync(`${process.env.NEXUS_TEST_REPORT_DIR}/stock-pool-sku-latency.json`, JSON.stringify(latency))
    }
    await database?.close()
  }, 60_000)

  it('1. A lends its main warehouse to B and to C; each accepts', async () => {
    for (const [borrower, owner] of [[B, user.ownerB], [C, user.ownerC]] as const) {
      const offered = await as(A, user.ownerA, () => grants.offerGrant({ borrowerWorkspaceId: borrower, locationIds: [id.aMain] }))
      const accepted = await as(borrower, owner, () => grants.borrowerDecision(offered.id, 'accept', { expectedVersion: 1 }))
      expect(accepted.status).toBe('active')
      if (borrower === B) grantB = offered.id
      else grantC = offered.id
    }
  })

  it('2. B previews by SKU: the exact number each listing will get, and a SKU A does not have is refused in words', async () => {
    const { products } = await as(B, user.ownerB, () => links.previewSwitch({ productIds: [id.bM, id.bS, id.bOnly], to: 'pool', grantId: grantB, withVariations: false }))
    const bySku = Object.fromEntries(products.map((p) => [p.sku, p]))
    expect(bySku['MOTOVENTO-ONLY-CAP'].refusal).toBe('Lender A has no product with the SKU MOTOVENTO-ONLY-CAP, so this product cannot use its stock.')
    expect(bySku['GALE-JACKET-BLACK-S']).toMatchObject({ from: 'own', refusal: null })
    expect(bySku['GALE-JACKET-BLACK-S'].listings.map((l) => [l.channel, l.rule, l.willShow])).toEqual([['EBAY', 'follows', 4]])
    const m = bySku['GALE-JACKET-BLACK-M']
    expect(m).toMatchObject({ from: 'own', refusal: null })
    const rows = Object.fromEntries(m.listings.map((l) => [`${l.channel}:${l.marketplace}${l.aliasLabel ? `:${l.aliasLabel}` : ''}`, [l.rule, l.willShow]]))
    expect(rows).toEqual({
      'EBAY:IT': ['follows', 9], // 10 lent at IT-MAIN − hold back 1 (the outlet is not lent)
      'EBAY:IT:IT-GALE-JACKET': ['follows', 10],
      'AMAZON:IT': ['follows', 10],
      'AMAZON:DE': ['follows', 10],
      'AMAZON:FR': ['amazon-managed', null],
      'SHOPIFY:GLOBAL': ['follows', 10],
      'ETSY:GLOBAL': ['follows', 8],
    })
    expect(await q(`SELECT count(*)::int AS n FROM "StockPoolLink"`)).toEqual([{ n: 0 }])
  })

  it('3. B connects two SKUs by SKU: every listing that follows moves; FBA keeps Amazon\'s own; the other SKU stays', async () => {
    const before = await snapshot()
    expect(await as(B, user.ownerB, () => links.switchProducts({ productIds: [id.bM, id.bS], to: 'pool', grantId: grantB, withVariations: false }))).toEqual({ switched: 2, unchanged: 0 })
    await drain()
    expect(await snapshot()).toEqual({ ...before, bEbayM: 9, bEbayCopyM: 10, bAmazonItM: 10, bAmazonDeM: 10, bShopifyM: 10, bEtsyM: 8, bEbayS: 4 })
    // The Etsy listing is not only written: its quantity row is queued (before 2026-10-01 none was), with the pool's number.
    expect(await lastPush(id.bEtsyM)).toBe(8)
    expect(await lastPush(id.bShopifyM)).toBe(10)
    const made = await q(`SELECT "productId", sku, "catalogLinkId", "sourceProductId" FROM "StockPoolLink" ORDER BY sku`)
    expect(made).toEqual([
      { productId: id.bM, sku: 'GALE-JACKET-BLACK-M', catalogLinkId: null, sourceProductId: id.aM },
      { productId: id.bS, sku: 'GALE-JACKET-BLACK-S', catalogLinkId: null, sourceProductId: id.aS },
    ])
    // The parent was not selected, so it was not connected.
    expect(await q(`SELECT count(*)::int AS n FROM "StockPoolLink" WHERE "productId" = $1`, [id.bParent])).toEqual([{ n: 0 }])
  })

  it('4. C connects the same SKU from the same lender: one pool, two businesses', async () => {
    expect(await as(C, user.ownerC, () => links.switchProducts({ productIds: [id.cM], to: 'pool', grantId: grantC, withVariations: false }))).toEqual({ switched: 1, unchanged: 0 })
    await drain()
    expect((await snapshot()).cEbayM).toBe(10)
  })

  it(`5. real time: a sale in A written by the API process reaches B and C through the wake signal in under ${REAL_TIME_MS} ms`, async () => {
    const url = new URL(serverUrl!.toString())
    url.pathname = `/${database.name}`
    // The API process never kicks the worker (afterPoolChange); only the database's signal can be this fast:
    // the worker's first poll is 5 s away.
    process.env.NEXUS_PROCESS_ROLE = 'api'
    const stopWorker = tasks.startStockPoolWorker({ listenUrl: url.toString() })
    try {
      for (let i = 0; i < 100 && Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM pg_stat_activity WHERE datname = $1 AND query ILIKE 'LISTEN nexus_stock_pool%'`, [database.name]))[0].n) === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      await as(A, null, () => movement.applyStockMovement({ productId: id.aM, locationId: id.aMain, change: -3, reason: 'ORDER_PLACED', orderId: 'A-ORDER-1' }))
      // 7 lent: B's main listing 7 − 1, its copy, Amazon and Shopify 7; C 7. A's own listing: 7 + 2 at the outlet.
      latency.lenderSaleToBorrowers = await until({ bEbayM: 6, bEbayCopyM: 7, bAmazonItM: 7, bAmazonDeM: 7, bShopifyM: 7, bEtsyM: 5, cEbayM: 7 }, 10_000)
      expect(latency.lenderSaleToBorrowers).toBeLessThan(REAL_TIME_MS)

      // The other way: B sells 2 from the pool (an eBay order, written by the API process).
      const taken = await as(B, null, () => doors.poolTake(database.client as never, { productId: id.bM, quantity: 2, orderRef: 'B-EBAY-1', actor: 'ebay-orders-sync' }))
      expect(taken).toMatchObject({ ok: true, taken: 2 })
      latency.borrowerSaleToLenderAndOthers = await until({ aEbayM: 7, cEbayM: 5, bEbayM: 4, bAmazonItM: 5, bEtsyM: 3 }, 10_000)
      expect(latency.borrowerSaleToLenderAndOthers).toBeLessThan(REAL_TIME_MS)
      expect((await snapshot()).bAmazonFbaM).toBe(6)
      expect(await lastPush(id.bEtsyM)).toBe(3)
    } finally {
      await stopWorker()
      if (roleBefore === undefined) delete process.env.NEXUS_PROCESS_ROLE
      else process.env.NEXUS_PROCESS_ROLE = roleBefore
    }
    await drain()
  })

  it('6. D1: while connected, neither business may rename the SKU or delete the product — the refusal names who to disconnect', async () => {
    const refusal = async (work: Promise<unknown>) => {
      try { await work } catch (error) { return stockPoolConnectedRefusal(error) ?? `other: ${(error as Error).message}` }
      return 'NO ERROR'
    }
    expect(await refusal(as(B, user.ownerB, () => database.client.product.update({ where: { id: id.bM }, data: { sku: 'GALE-JACKET-BLACK-M2' } }))))
      .toBe('GALE-JACKET-BLACK-M sells from the stock of Lender A. Disconnect it first (Matrix, Stock source), then change it.')
    expect(await refusal(as(A, user.ownerA, () => database.client.product.update({ where: { id: id.aM }, data: { deletedAt: new Date() } }))))
      .toMatch(/^GALE-JACKET-BLACK-M shares its stock with Borrower (B|C)\. Disconnect it there first, then change it\.$/)
    // The parent was never connected: it may be renamed.
    await as(B, user.ownerB, () => database.client.product.update({ where: { id: id.bParent }, data: { sku: 'GALE-JACKET-2' } }))
    await as(B, user.ownerB, () => database.client.product.update({ where: { id: id.bParent }, data: { sku: 'GALE-JACKET' } }))
  })

  it('7. B disconnects M: its listings follow its own stock again; A and C are not touched; the SKU may change', async () => {
    const before = await snapshot()
    expect(await as(B, user.ownerB, () => links.switchProducts({ productIds: [id.bM], to: 'own', grantId: null, withVariations: false }))).toEqual({ switched: 1, unchanged: 0 })
    await drain()
    // B's own warehouse holds 1: eBay main 1 − 1, the copy, Amazon and Shopify 1, Etsy 1 − 2 → 0; FBA unchanged.
    expect(await snapshot()).toEqual({ ...before, bEbayM: 0, bEbayCopyM: 1, bAmazonItM: 1, bAmazonDeM: 1, bShopifyM: 1, bEtsyM: 0 })
    expect(await lastPush(id.bEtsyM)).toBe(0)
    await as(B, user.ownerB, () => database.client.product.update({ where: { id: id.bM }, data: { sku: 'GALE-JACKET-BLACK-M2' } }))
    await as(B, user.ownerB, () => database.client.product.update({ where: { id: id.bM }, data: { sku: 'GALE-JACKET-BLACK-M' } }))
    // A still lends M to C.
    expect(stockPoolConnectedRefusal(await as(A, user.ownerA, () => database.client.product.update({ where: { id: id.aM }, data: { sku: 'X' } })).catch((e) => e)))
      .toMatch(/shares its stock with Borrower C/)
  })
})
