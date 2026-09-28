/**
 * Shared stock, step 2 — the switches end to end, through the real services, the real cascade and the
 * real pool worker, on a real multi-connection PostgreSQL with the generated policies, profiles ON.
 * Contract: docs/2026-09-19-shared-stock-build.md §2.
 *
 * One story, in order: A offers its main warehouse → B accepts → B previews and switches its jacket to
 * the pool → a sale in A, then a pool sale in B, move every listing in both businesses → A previews and
 * pauses → B's listings leave the pool → resume → B's own stock arrives (the pool still rules) → B
 * switches back to its own stock and to the pool again → A ends. Fixed-number, paused, Amazon-managed
 * and excluded listings keep their numbers throughout.
 *
 * Needs NEXUS_TEST_CONCURRENT_PG_URL (a throwaway Docker PostgreSQL); SKIPS without it. Run by
 * scripts/run-real-postgres-tests.mjs before every push.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { CONCURRENT_PG_ENV, concurrentDatabase, concurrentDatabaseUrl } from '../../test-support/concurrent-database.js'
import { withWorkspace } from '../../lib/workspace-context.js'

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

const A = 'ws_a_pool_e2e'
const B = 'ws_b_pool_e2e'
const serverUrl = concurrentDatabaseUrl()
const flagBefore = process.env.NEXUS_WORKSPACES_ENABLED

describe.skipIf(!serverUrl)(`Shared stock step 2 — the switches end to end (needs ${CONCURRENT_PG_ENV})`, () => {
  let grants: typeof import('./pool-grants.service.js')
  let links: typeof import('./pool-links.service.js')
  let tasks: typeof import('./pool-tasks.js')
  let doors: typeof import('./pool-doors.js')
  let movement: typeof import('../stock-movement.service.js')
  const user = { ownerA: randomUUID(), ownerB: randomUUID() }
  const id: Record<string, string> = {}
  let grantId = ''
  let grantVersion = 0

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]
  const as = <T>(workspaceId: string, actor: string | null, work: () => Promise<T>) =>
    withWorkspace({ workspaceId, actorUserId: actor, membershipId: null, roleKeys: [] }, work)
  const inContext = async (workspaceId: string, actor: string, statements: Array<[string, unknown[]]>) => {
    const client = await database.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('nexus.workspace_id', $1, true), set_config('nexus.actor_id', $2, true)`, [workspaceId, actor])
      for (const [text, params] of statements) await client.query(text, params)
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
  const qty = async (listingId: string) => Number((await q<{ quantity: number | null }>(`SELECT quantity FROM "ChannelListing" WHERE id = $1`, [listingId]))[0].quantity)
  const snapshot = async () => ({
    bEbay: await qty(id.bEbay), bAmazonFba: await qty(id.bAmazonFba), bAmazonPinned: await qty(id.bAmazonPinned),
    bShopifyPaused: await qty(id.bShopifyPaused), aEbay: await qty(id.aEbay),
  })
  /** The newest pending quantity push for a listing (what the channel will receive). */
  const lastPush = async (listingId: string) =>
    (await q<{ quantity: number }>(`SELECT (payload->>'quantity')::int AS quantity FROM "OutboundSyncQueue" WHERE "channelListingId" = $1 AND "syncType" = 'QUANTITY_UPDATE' AND "syncStatus" = 'PENDING' ORDER BY "createdAt" DESC LIMIT 1`, [listingId]))[0]?.quantity ?? null
  const memberPush = async (itemId: string) =>
    (await q<{ quantity: number }>(`SELECT (u->>'quantity')::int AS quantity FROM "OutboundSyncQueue" o, jsonb_array_elements(o.payload->'updates') u WHERE o."channelListingId" IS NULL AND o.payload->>'itemId' = $1 ORDER BY o."createdAt" DESC LIMIT 1`, [itemId]))[0]?.quantity ?? null
  const pendingTasks = async () => Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM "StockPoolTask"`))[0].n)
  /**
   * Run the pool worker until no task is left (what the poller and the kicks do in the API), then do
   * what the eBay dispatcher does after a successful revise: stamp each shared variant's lastQtyPushed
   * with the number it was sent. (The fan-out skips a variant already at its number, so without the
   * stamp a second push to the same item would look like "no change".)
   */
  const drain = async () => {
    for (let i = 0; i < 5 && (await pendingTasks()) > 0; i++) await tasks.kickStockPoolWork()
    expect(await pendingTasks(), 'pool tasks left after the worker ran').toBe(0)
    await q(`UPDATE "SharedListingMembership" m SET "lastQtyPushed" = x.qty FROM (
      SELECT DISTINCT ON (o.payload->>'itemId', u->>'sku') o.payload->>'itemId' AS item, u->>'sku' AS sku, (u->>'quantity')::int AS qty
      FROM "OutboundSyncQueue" o, jsonb_array_elements(o.payload->'updates') u WHERE o."channelListingId" IS NULL
      ORDER BY o.payload->>'itemId', u->>'sku', o."createdAt" DESC) x
      WHERE m."itemId" = x.item AND m.sku = x.sku`)
  }

  beforeAll(async () => {
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    database = await concurrentDatabase({ maxConnections: 24 })
    await q(`ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_available_invariant" CHECK ("available" = "quantity" - "reserved")`)
    await q(`CREATE UNIQUE INDEX "StockLevel_loc_prod_novar_unique" ON "StockLevel" ("workspaceId", "locationId", "productId") WHERE "variationId" IS NULL`)

    const ownerRole = randomUUID()
    await q(`INSERT INTO "Role" (id, key, name, "isSystem", "updatedAt") VALUES ($1,'OWNER','Owner',true,now())`, [ownerRole])
    for (const [key, uid] of Object.entries(user)) await q(`INSERT INTO "UserProfile" (id, email, status, "updatedAt") VALUES ($1,$2,'active',now())`, [uid, `${key}@example.test`])
    await q(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1,'Lender A','active','e2e',$1,now()), ($2,'Borrower B','active','e2e',$2,now())`, [A, B])
    const member = async (workspaceId: string, userId: string) => {
      const mid = randomUUID()
      await q(`INSERT INTO "WorkspaceMembership" (id, "workspaceId", "userId", status, "updatedAt") VALUES ($1,$2,$3,'active',now())`, [mid, workspaceId, userId])
      await q(`INSERT INTO "WorkspaceMemberRole" ("membershipId","roleId") VALUES ($1,$2)`, [mid, ownerRole])
    }
    await member(A, user.ownerA)
    await member(B, user.ownerA)
    await member(B, user.ownerB)

    const location = async (workspaceId: string, code: string, type = 'WAREHOUSE') => {
      const lid = randomUUID()
      await q(`INSERT INTO "StockLocation" (id, "workspaceId", type, code, name, "updatedAt") VALUES ($1,$2,$3,$4,$4,now())`, [lid, workspaceId, type, code])
      return lid
    }
    id.aMain = await location(A, 'IT-MAIN')
    id.aOutlet = await location(A, 'IT-OUTLET')
    id.bMain = await location(B, 'B-MAIN')
    id.bFba = await location(B, 'B-FBA', 'AMAZON_FBA')

    id.jacket = randomUUID(); id.bJacket = randomUUID()
    await q(`INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", "totalStock", "updatedAt") VALUES ($1,$2,'JACKET','Jacket',10,14,now())`, [id.jacket, A])
    await q(`INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", "updatedAt") VALUES ($1,$2,'JACKET','Jacket',10,now())`, [id.bJacket, B])
    await q(`INSERT INTO "StockLevel" (id, "workspaceId", "locationId", "productId", quantity, reserved, available, "lastUpdatedAt") VALUES ($1,$2,$3,$4,10,0,10,now()), ($5,$2,$6,$4,4,0,4,now())`,
      [randomUUID(), A, id.aMain, id.jacket, randomUUID(), id.aOutlet])

    const listing = async (workspaceId: string, productId: string, channel: string, marketplace: string, extra: Record<string, unknown> = {}) => {
      const lid = randomUUID()
      const cols = { id: lid, workspaceId, productId, channel, marketplace, region: marketplace, channelMarket: `${channel}_${marketplace}`, listingStatus: 'ACTIVE', externalListingId: `ext-${lid.slice(0, 6)}`, updatedAt: new Date(), ...extra }
      const keys = Object.keys(cols)
      await q(`INSERT INTO "ChannelListing" (${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(cols))
      return lid
    }
    // B's eBay IT: two accounts, and on the main one the main listing plus one alias (paused: it keeps its number).
    id.bStore = randomUUID(); id.bStore2 = randomUUID(); id.bAlias = randomUUID()
    await q(`INSERT INTO "ChannelConnection" (id, "workspaceId", "channelType", "accountLabel", "externalAccountId", "isActive", "isPrimary", "updatedAt") VALUES ($1,$3,'EBAY','Main store','seller-main',true,true,now()), ($2,$3,'EBAY','Second store','seller-second',true,false,now())`, [id.bStore, id.bStore2, B])
    id.bEbay = await listing(B, id.bJacket, 'EBAY', 'IT', { quantity: 0, stockBuffer: 1, channelConnectionId: id.bStore })
    await q(`INSERT INTO "ProductListingAlias" (id, "workspaceId", "productId", channel, marketplace, "channelConnectionId", label, position, "updatedAt") VALUES ($1,$2,$3,'EBAY','IT',$4,'Winter listing',1,now())`, [id.bAlias, B, id.bJacket, id.bStore])
    id.bEbayAlias = await listing(B, id.bJacket, 'EBAY', 'IT', { quantity: 3, syncPaused: true, channelConnectionId: id.bStore, aliasId: id.bAlias, aliasKey: id.bAlias })
    id.bAmazonFba = await listing(B, id.bJacket, 'AMAZON', 'IT', { quantity: 6, fulfillmentMethod: 'FBA' })
    id.bAmazonPinned = await listing(B, id.bJacket, 'AMAZON', 'DE', { quantity: 2, followMasterQuantity: false, fulfillmentMethod: 'FBM' })
    id.bShopifyPaused = await listing(B, id.bJacket, 'SHOPIFY', 'GLOBAL', { quantity: 7, syncPaused: true })
    id.aEbay = await listing(A, id.jacket, 'EBAY', 'IT', { quantity: 14 })
    for (const [itemId, followPool] of [['ITEM-FOLLOW', true], ['ITEM-EXCLUDED', false]] as const) {
      await q(`INSERT INTO "SharedListingMembership" (id, "workspaceId", marketplace, sku, "itemId", "parentSku", "productId", "variationSpecifics", "followPool", "lastQtyPushed", "updatedAt") VALUES ($1,$2,'IT','JACKET',$3,'JACKET',$4,'{}'::jsonb,$5,0,now())`,
        [randomUUID(), B, itemId, id.bJacket, followPool])
    }

    // The product share A → B and its catalog link, through the real AE.2 / AE.3 rules.
    const assortmentId = randomUUID(), shareId = randomUUID()
    await inContext(A, user.ownerA, [
      [`INSERT INTO "Assortment" (id, "workspaceId", name, selection, "updatedAt") VALUES ($1,$2,'For B','list',now())`, [assortmentId, A]],
      [`INSERT INTO "AssortmentMember" (id, "workspaceId", "assortmentId", "productId", mode) VALUES ($1,$2,$3,$4,'include')`, [randomUUID(), A, assortmentId, id.jacket]],
      [`INSERT INTO "AssortmentShare" (id, "assortmentId", "ownerWorkspaceId", "workspaceId", "fieldGroups", "createdByUserId", "updatedAt") VALUES ($1,$2,$3,$4,ARRAY['identity'],$5,now())`, [shareId, assortmentId, A, B, user.ownerA]],
    ])
    await inContext(B, user.ownerB, [
      [`SELECT nexus_assortment_share_respond($1,'accept',1)`, [shareId]],
      [`INSERT INTO "CatalogLink" (id, "shareId", "sourceWorkspaceId", "sourceProductId", "targetWorkspaceId", "targetProductId", "linkedBy", "sourceVersion", "updatedAt") VALUES ($1,$2,$3,$4,$5,$6,'created',1,now())`, [randomUUID(), shareId, A, id.jacket, B, id.bJacket]],
    ])

    grants = await import('./pool-grants.service.js')
    links = await import('./pool-links.service.js')
    tasks = await import('./pool-tasks.js')
    doors = await import('./pool-doors.js')
    movement = await import('../stock-movement.service.js')
  }, 180_000)

  afterAll(async () => {
    if (flagBefore === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
    else process.env.NEXUS_WORKSPACES_ENABLED = flagBefore
    await database?.close()
  }, 60_000)

  it('1. A offers its main warehouse; B is told; B accepts; A is told; both sides audited', async () => {
    const offered = await as(A, user.ownerA, () => grants.offerGrant({ borrowerWorkspaceId: B, locationIds: [id.aMain] }))
    expect(offered).toMatchObject({ side: 'lender', status: 'pending', version: 1, ownerWorkspaceName: 'Lender A', workspaceName: 'Borrower B', linkedProducts: 0 })
    expect(offered.locations).toEqual([{ id: id.aMain, code: 'IT-MAIN', name: 'IT-MAIN', usable: true }])
    grantId = offered.id
    expect(await q(`SELECT type, "userId" FROM "Notification" WHERE "workspaceId" = $1`, [B])).toEqual(expect.arrayContaining([{ type: 'stock-pool-offered', userId: user.ownerB }]))
    // The borrower sees the lent warehouse's name, though it cannot read the lender's locations.
    const seen = await as(B, user.ownerB, () => grants.listGrants())
    expect(seen.borrowing[0]).toMatchObject({ side: 'borrower', status: 'pending', locations: [{ code: 'IT-MAIN', usable: true }] })
    await expect(as(B, user.ownerB, () => grants.lenderAction(grantId, 'pause', { expectedVersion: 1 }))).rejects.toMatchObject({ code: 'grant_lender_only' })
    const accepted = await as(B, user.ownerB, () => grants.borrowerDecision(grantId, 'accept', { expectedVersion: 1 }))
    expect(accepted).toMatchObject({ side: 'borrower', status: 'active', version: 2 })
    grantVersion = accepted.version
    expect((await q(`SELECT type FROM "Notification" WHERE "workspaceId" = $1`, [A])).map((r) => r.type)).toContain('stock-pool-changed')
    expect((await q(`SELECT "workspaceId", action FROM "WorkspaceAudit" WHERE "targetId" = $1 ORDER BY "createdAt", "workspaceId"`, [grantId])).map((r) => `${r.workspaceId}:${r.action}`).sort())
      .toEqual([`${A}:stock_pool.accepted`, `${A}:stock_pool.offered`, `${B}:stock_pool.accepted`, `${B}:stock_pool.offered`].sort())
  })

  it('2. the switch preview shows the exact numbers each listing will get, and what keeps its own', async () => {
    const { products } = await as(B, user.ownerB, () => links.previewSwitch({ productIds: [id.bJacket], to: 'pool', grantId }))
    expect(products).toHaveLength(1)
    expect(products[0]).toMatchObject({ from: 'own', to: 'pool', refusal: null })
    const byChannel = Object.fromEntries(products[0].listings.map((l) => [`${l.channel}:${l.marketplace}${l.itemId ? `:${l.itemId}` : ''}${l.listingMark != null ? `#${l.listingMark}` : ''}`, [l.rule, l.willShow]]))
    expect(byChannel).toEqual({
      'EBAY:IT#0': ['follows', 9], // 10 lent − hold back 1
      'EBAY:IT#1': ['paused', null], // the alias keeps its own number
      'AMAZON:IT': ['amazon-managed', null],
      'AMAZON:DE': ['fixed', null],
      'SHOPIFY:GLOBAL': ['paused', null],
      'EBAY:IT:ITEM-FOLLOW': ['follows', 10],
      'EBAY:IT:ITEM-EXCLUDED': ['excluded', null],
    })
    // Each row names its account, and the two listings on one account and market are told apart.
    expect(products[0].listings.filter((l) => l.channel === 'EBAY' && !l.itemId).map((l) => [l.listingId, l.accountLabel, l.listingMark, l.aliasLabel]).sort())
      .toEqual([[id.bEbay, 'Main store', 0, null], [id.bEbayAlias, 'Main store', 1, 'Winter listing']].sort())
    expect(products[0].listings.find((l) => l.channel === 'AMAZON' && l.marketplace === 'IT')).toMatchObject({ accountLabel: null, listingMark: null, aliasLabel: null })
  })

  it('3. switching to the pool moves only the listings that follow; every other listing keeps its number', async () => {
    const before = await snapshot()
    expect(await as(B, user.ownerB, () => links.switchProducts({ productIds: [id.bJacket], to: 'pool', grantId }))).toEqual({ switched: 1, unchanged: 0 })
    await drain()
    expect(await snapshot()).toEqual({ ...before, bEbay: 9 })
    expect(await lastPush(id.bEbay)).toBe(9)
    expect(await memberPush('ITEM-FOLLOW')).toBe(10)
    expect(await memberPush('ITEM-EXCLUDED')).toBeNull()
    expect(await q(`SELECT "masterQuantity" FROM "ChannelListing" WHERE id = $1`, [id.bEbay])).toEqual([{ masterQuantity: 10 }])
    // Every send-time limit and "in stock" check reads the same ledger: the pool, not B's empty shelves.
    const { sellableAvailable, sellableQuantity } = await import('./sync-ledgers.js')
    expect((await as(B, null, () => sellableAvailable(database.client as never, [id.bJacket]))).get(id.bJacket)).toBe(10)
    expect((await as(B, null, () => sellableQuantity(database.client as never, [{ id: id.bJacket, totalStock: 0 }]))).get(id.bJacket)).toBe(10)
    // A second switch is a no-op.
    expect(await as(B, user.ownerB, () => links.switchProducts({ productIds: [id.bJacket], to: 'pool', grantId }))).toEqual({ switched: 0, unchanged: 1 })
  })

  it('4. a sale in the LENDER reaches the borrower\'s listing on its own — no manual run — well inside 10 s', async () => {
    const started = Date.now()
    await as(A, null, () => movement.applyStockMovement({ productId: id.jacket, locationId: id.aMain, change: -3, reason: 'ORDER_PLACED', orderId: 'A-ORDER-1' }))
    const committed = Date.now()
    // Nothing here runs the worker: the movement's own post-commit kick must (the plan's target: < 10 s).
    let seen = await qty(id.bEbay)
    while (seen !== 6 && Date.now() - committed < 10_000) { await new Promise((r) => setTimeout(r, 25)); seen = await qty(id.bEbay) }
    const latency = Date.now() - committed
    expect(seen).toBe(6) // 7 lent − 1
    expect(latency).toBeLessThan(10_000)
    await drain()
    expect((await snapshot()).aEbay).toBe(11) // A's own listing: its whole warehouse ledger, 7 + 4
    if (process.env.NEXUS_TEST_REPORT_DIR) {
      const { writeFileSync } = await import('node:fs')
      writeFileSync(`${process.env.NEXUS_TEST_REPORT_DIR}/stock-pool-latency.json`, JSON.stringify({ saleCommitToBorrowerListingMs: latency, saleCallMs: committed - started }))
    }
  })

  it('5. a POOL sale in the borrower is settled in the lender: movement, event, and the lender\'s own listing', async () => {
    const taken = await as(B, null, () => doors.poolTake(database.client as never, { productId: id.bJacket, quantity: 2, orderRef: 'B-EBAY-1', actor: 'ebay-orders-sync' }))
    expect(taken).toMatchObject({ ok: true, taken: 2 })
    await drain()
    const [m] = await q<{ id: string; poolSettledAt: Date | null; consumerWorkspaceId: string }>(`SELECT id, "poolSettledAt", "consumerWorkspaceId" FROM "StockMovement" WHERE "consumerOrderRef" = 'B-EBAY-1'`)
    expect(m.consumerWorkspaceId).toBe(B)
    expect(m.poolSettledAt).not.toBeNull()
    const events = await q<{ type: string; change: number }>(`SELECT type, (payload->>'change')::int AS change FROM "EventOutbox" WHERE "workspaceId" = $1 AND payload->>'movementId' IN (SELECT id FROM "StockMovement" WHERE "consumerOrderRef" = 'B-EBAY-1')`, [A])
    expect(events).toEqual([{ type: 'inventory.stock_changed', change: -2 }])
    const after = await snapshot()
    expect(after.bEbay).toBe(4)
    expect(after.aEbay).toBe(9) // 5 + 4
    // The oversell alarm watches the pool: B's paused Shopify listing still shows 7, the pool holds 5.
    const risks = await q<{ payload: { maxChannelCommitment: number; poolAvailable: number; excessUnits: number } }>(`SELECT payload FROM "EventOutbox" WHERE "workspaceId" = $1 AND type = 'inventory.oversell_risk_detected'`, [B])
    expect(risks.map((r) => [r.payload.maxChannelCommitment, r.payload.poolAvailable, r.payload.excessUnits])).toEqual([[7, 5, 2]])
    // A channel's number never writes into B's own ledger for a pooled product.
    const channelEvents = await import('../channel-stock-event.service.js')
    const observed = await as(B, null, () => channelEvents.recordChannelStockEvent({ channel: 'EBAY', channelEventId: 'ebay-obs-1', productId: id.bJacket, channelReportedQty: 4 }))
    expect(observed).toMatchObject({ status: 'REVIEW_NEEDED', localQtyAtObservation: 5, drift: -1 })
    await expect(as(B, user.ownerB, () => channelEvents.applyChannelStockEvent(observed.id, user.ownerB))).rejects.toThrow(/shared stock owned by another business profile/)
    expect(await q(`SELECT count(*)::int AS n FROM "StockLevel" WHERE "productId" = $1`, [id.bJacket])).toEqual([{ n: 0 }])
    // Settling twice changes nothing.
    await as(A, null, () => tasks.settlePoolMovement(m.id))
    expect((await q(`SELECT count(*)::int AS n FROM "EventOutbox" WHERE "workspaceId" = $1 AND type = 'inventory.stock_changed'`, [A]))[0]).toEqual({ n: 2 })
  })

  it('6. the lender\'s preview counts what a pause does, without reading the borrower\'s rows', async () => {
    // A pause of B's OTHER eBay account does not count B's main-store listing as paused.
    const policy = randomUUID()
    await q(`INSERT INTO "SyncChannelPolicy" (id, "workspaceId", channel, marketplace, "pushesPaused", "channelConnectionId", "updatedAt") VALUES ($1,$2,'EBAY','IT',true,$3,now())`, [policy, B, id.bStore2])
    const impact = await as(A, user.ownerA, () => grants.grantImpact(grantId))
    expect(impact).toEqual({
      grantId, linkedProducts: 1,
      listings: { toZero: 1, toOwn: 0, pinned: 1, paused: 2, closed: 0, fba: 1 },
      sharedVariants: { toZero: 1, toOwn: 0, excluded: 1 },
    })
    // The same pause for every account does.
    await q(`UPDATE "SyncChannelPolicy" SET "channelConnectionId" = NULL WHERE id = $1`, [policy])
    expect((await as(A, user.ownerA, () => grants.grantImpact(grantId))).listings).toMatchObject({ toZero: 0, paused: 3 })
    await q(`DELETE FROM "SyncChannelPolicy" WHERE id = $1`, [policy])
  })

  it('7. a pause takes the listings off the pool (to 0 here); resume brings the pool number back', async () => {
    const before = await snapshot()
    const paused = await as(A, user.ownerA, () => grants.lenderAction(grantId, 'pause', { expectedVersion: grantVersion }))
    grantVersion = paused.version
    await drain()
    expect(await snapshot()).toEqual({ ...before, bEbay: 0 })
    expect(await memberPush('ITEM-FOLLOW')).toBe(0)
    const resumed = await as(A, user.ownerA, () => grants.lenderAction(grantId, 'resume', { expectedVersion: grantVersion }))
    grantVersion = resumed.version
    await drain()
    expect(await snapshot()).toEqual({ ...before })
  })

  it('8. the borrower\'s own stock arriving does not move a pooled listing; switching to own stock does', async () => {
    await as(B, null, () => movement.applyStockMovement({ productId: id.bJacket, locationId: id.bMain, change: 3, reason: 'INBOUND_RECEIVED' }))
    await drain()
    expect((await snapshot()).bEbay).toBe(4) // still the pool: 5 lent − 1
    const preview = await as(B, user.ownerB, () => links.previewSwitch({ productIds: [id.bJacket], to: 'own' }))
    expect(preview.products[0].listings.find((l) => l.listingId === id.bEbay)).toMatchObject({ rule: 'follows', willShow: 2 })
    expect(await as(B, user.ownerB, () => links.switchProducts({ productIds: [id.bJacket], to: 'own' }))).toEqual({ switched: 1, unchanged: 0 })
    await drain()
    expect((await snapshot()).bEbay).toBe(2) // own 3 − 1
    expect(await as(B, user.ownerB, () => links.switchProducts({ productIds: [id.bJacket], to: 'pool', grantId }))).toEqual({ switched: 1, unchanged: 0 })
    await drain()
    expect((await snapshot()).bEbay).toBe(4)
  })

  it('9. ending the grant ends the links; the listing falls back to its own stock; an order already made still ships', async () => {
    const held = await as(B, null, () => doors.poolReserve(database.client as never, { productId: id.bJacket, quantity: 1, orderRef: 'B-AMZ-1' }))
    expect(held).toMatchObject({ ok: true })
    await drain()
    const ended = await as(A, user.ownerA, () => grants.lenderAction(grantId, 'end', { expectedVersion: grantVersion }))
    expect(ended.status).toBe('revoked')
    await drain()
    const after = await snapshot()
    expect(after.bEbay).toBe(2) // own 3 − 1
    expect(after.bAmazonFba).toBe(6)
    expect(after.bAmazonPinned).toBe(2)
    expect(after.bShopifyPaused).toBe(7)
    expect(await q(`SELECT status, "endedReason" FROM "StockPoolLink" WHERE "productId" = $1 ORDER BY "createdAt" DESC LIMIT 1`, [id.bJacket]))
      .toEqual([{ status: 'ended', endedReason: 'The lending business ended the shared stock.' }])
    expect(await as(B, null, () => doors.poolConsume(database.client as never, { orderRef: 'B-AMZ-1' }))).toMatchObject({ ok: true, consumed: 1 })
    await drain()
    expect((await snapshot()).aEbay).toBe(8) // A's own listing: 4 at IT-MAIN + 4 at the outlet
    expect((await q(`SELECT type FROM "Notification" WHERE "workspaceId" = $1 ORDER BY "createdAt" DESC LIMIT 1`, [B]))[0]).toEqual({ type: 'stock-pool-changed' })
  })
})
