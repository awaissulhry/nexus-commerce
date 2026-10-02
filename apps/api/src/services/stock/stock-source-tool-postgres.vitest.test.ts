/**
 * MCP full control 08 S8 — set-stock-source, Claude's switch between a business's own stock and the shared stock
 * another business lends (by the same SKU), end to end on a REAL multi-connection PostgreSQL with the generated
 * policies and the stock-pool guards, profiles ON — the stock-pool-sku-e2e pattern, through the tool.
 *
 * A lends its main warehouse to B. B's jacket (the same SKU as A's) sells from its own 1 unit. Claude previews the
 * switch (each listing's number now and after); a member of B who is not an owner cannot run it; B's owner runs it
 * and the listing follows A's lent stock; the recorded change's undo switches it back to B's own stock. From A, B's
 * product is not found.
 *
 * Needs NEXUS_TEST_CONCURRENT_PG_URL (a throwaway Docker PostgreSQL); SKIPS without it.
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

const A = 'ws_a_s8_source'
const B = 'ws_b_s8_source'
const serverUrl = concurrentDatabaseUrl()
const flagBefore = process.env.NEXUS_WORKSPACES_ENABLED

describe.skipIf(!serverUrl)(`08 S8 — set-stock-source end to end (needs ${CONCURRENT_PG_ENV})`, () => {
  type Tool = import('../agents/tool-types.js').AgentTool
  let tool: Tool
  let tasks: typeof import('../stock-pool/pool-tasks.js')
  const user = { ownerA: randomUUID(), ownerB: randomUUID(), memberB: randomUUID() }
  const id: Record<string, string> = {}

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]
  const as = <T>(workspaceId: string, actor: string | null, work: () => Promise<T>) =>
    withWorkspace({ workspaceId, actorUserId: actor, membershipId: null, roleKeys: [] }, work)
  const ctx = (userId: string) => ({ userId, can: () => true, via: 'claude' as const })
  const qty = async (listingId: string) => Number((await q<{ quantity: number | null }>(`SELECT quantity FROM "ChannelListing" WHERE id = $1`, [listingId]))[0].quantity)
  const links = async () => q<{ status: string }>(`SELECT status FROM "StockPoolLink" WHERE "productId" = $1 ORDER BY "createdAt"`, [id.bJacket])
  const drain = async () => {
    const pending = async () => Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM "StockPoolTask"`))[0].n)
    for (let i = 0; i < 5 && (await pending()) > 0; i++) await tasks.kickStockPoolWork()
    expect(await pending(), 'pool tasks left after the worker ran').toBe(0)
  }
  const ARGS = { productIds: [] as string[], to: 'pool', lender: 'Lender A' }

  beforeAll(async () => {
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    database = await concurrentDatabase({ maxConnections: 16 })
    await q(`ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_available_invariant" CHECK ("available" = "quantity" - "reserved")`)
    await q(`CREATE UNIQUE INDEX "StockLevel_loc_prod_novar_unique" ON "StockLevel" ("workspaceId", "locationId", "productId") WHERE "variationId" IS NULL`)
    const ownerRole = randomUUID()
    const staffRole = randomUUID()
    await q(`INSERT INTO "Role" (id, key, name, "isSystem", "updatedAt") VALUES ($1,'OWNER','Owner',true,now())`, [ownerRole])
    await q(`INSERT INTO "Role" (id, key, name, "isSystem", permissions, "updatedAt") VALUES ($1,'S8_STAFF','Staff',false,ARRAY['inventory.view','inventory.adjust','ai.run']::text[],now())`, [staffRole])
    for (const [key, uid] of Object.entries(user)) await q(`INSERT INTO "UserProfile" (id, email, status, "updatedAt") VALUES ($1,$2,'active',now())`, [uid, `${key}-s8@example.test`])
    await q(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1,'Lender A','active','s8',$1,now()), ($2,'Borrower B','active','s8',$2,now())`, [A, B])
    const member = async (workspaceId: string, userId: string, roleId: string) => {
      const mid = randomUUID()
      await q(`INSERT INTO "WorkspaceMembership" (id, "workspaceId", "userId", status, "updatedAt") VALUES ($1,$2,$3,'active',now())`, [mid, workspaceId, userId])
      await q(`INSERT INTO "WorkspaceMemberRole" ("membershipId","roleId") VALUES ($1,$2)`, [mid, roleId])
    }
    await member(A, user.ownerA, ownerRole)
    await member(B, user.ownerA, ownerRole)
    await member(B, user.ownerB, ownerRole)
    await member(B, user.memberB, staffRole)
    const location = async (workspaceId: string, code: string) => {
      const lid = randomUUID()
      await q(`INSERT INTO "StockLocation" (id, "workspaceId", type, code, name, "updatedAt") VALUES ($1,$2,'WAREHOUSE',$3,$3,now())`, [lid, workspaceId, code])
      return lid
    }
    id.aMain = await location(A, 'IT-MAIN')
    id.bMain = await location(B, 'B-MAIN')
    const product = async (workspaceId: string, sku: string) => {
      const pid = randomUUID()
      await q(`INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", "updatedAt") VALUES ($1,$2,$3,$3,105,now())`, [pid, workspaceId, sku])
      return pid
    }
    id.aJacket = await product(A, 'TEST-SKU-S8-JACKET')
    id.bJacket = await product(B, 'TEST-SKU-S8-JACKET')
    ARGS.productIds = [id.bJacket]
    const stock = (workspaceId: string, locationId: string, productId: string, quantity: number) =>
      q(`INSERT INTO "StockLevel" (id, "workspaceId", "locationId", "productId", quantity, reserved, available, "lastUpdatedAt") VALUES ($1,$2,$3,$4,$5,0,$5,now())`, [randomUUID(), workspaceId, locationId, productId, quantity])
    await stock(A, id.aMain, id.aJacket, 10)
    await stock(B, id.bMain, id.bJacket, 1)
    await q(`UPDATE "Product" SET "totalStock" = 10 WHERE id = $1`, [id.aJacket])
    await q(`UPDATE "Product" SET "totalStock" = 1 WHERE id = $1`, [id.bJacket])
    id.bEbay = randomUUID()
    await q(`INSERT INTO "ChannelListing" (id, "workspaceId", "productId", channel, marketplace, region, "channelMarket", "listingStatus", "externalListingId", quantity, "updatedAt")
             VALUES ($1,$2,$3,'EBAY','IT','IT','EBAY_IT','ACTIVE','ext-s8',1,now())`, [id.bEbay, B, id.bJacket])

    const grants = await import('../stock-pool/pool-grants.service.js')
    const offered = await as(A, user.ownerA, () => grants.offerGrant({ borrowerWorkspaceId: B, locationIds: [id.aMain] }))
    await as(B, user.ownerB, () => grants.borrowerDecision(offered.id, 'accept', { expectedVersion: 1 }))
    tasks = await import('../stock-pool/pool-tasks.js')
    tool = (await import('../agents/tool-registry.js')).getTool('set-stock-source')!
  }, 180_000)

  afterAll(async () => {
    if (flagBefore === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
    else process.env.NEXUS_WORKSPACES_ENABLED = flagBefore
    await database?.close()
  }, 60_000)

  it('1. the preview (any member may ask) shows each listing now and after; nothing is written', async () => {
    const out = await as(B, user.memberB, () => tool.handler(ARGS, ctx(user.memberB)))
    expect(out, out.error).toMatchObject({
      ok: true,
      preview: { to: { source: 'pool', lender: 'Lender A' }, products: [{ sku: 'TEST-SKU-S8-JACKET', from: 'own', to: 'pool', listings: [{ channel: 'EBAY', marketplace: 'IT', showsNow: 1, willShow: 10, rule: 'follows' }] }], totals: { products: 1, switching: 1 } },
    })
    expect(await links()).toEqual([])
  }, 60_000)

  it('2. a member who is not an owner cannot run it; nothing switches', async () => {
    const out = await as(B, user.memberB, () => tool.execute!(ARGS, ctx(user.memberB)))
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining('owner') })
    expect(await links()).toEqual([])
  }, 60_000)

  it("3. B's owner runs it: the listing follows A's lent stock; its undo switches back to B's own stock", async () => {
    const ran = await as(B, user.ownerB, () => tool.execute!(ARGS, ctx(user.ownerB)))
    expect(ran, ran.error).toMatchObject({ ok: true, data: { switched: 1, unchanged: 0 } })
    await drain()
    expect(await links()).toEqual([{ status: 'active' }])
    expect(await qty(id.bEbay)).toBe(10)
    // Undo as the gate builds it: what is stored is still what the change wrote, and the inverse request runs.
    const change = ran.change!
    expect(await as(B, user.ownerB, () => tool.undo!.current(change))).toEqual(change.after)
    const inverse = tool.undo!.request(change)
    expect(inverse).toEqual({ tool: 'set-stock-source', args: { productIds: [id.bJacket], to: 'own', withVariations: false } })
    const back = await as(B, user.ownerB, () => tool.execute!((inverse as { args: Record<string, unknown> }).args, ctx(user.ownerB)))
    expect(back, back.error).toMatchObject({ ok: true, data: { switched: 1 } })
    await drain()
    expect(await links()).toEqual([{ status: 'ended' }])
    expect(await qty(id.bEbay)).toBe(1)
  }, 60_000)

  it("4. from A, B's product is not found", async () => {
    expect(await as(A, user.ownerA, () => tool.handler({ productIds: [id.bJacket], to: 'own' }, ctx(user.ownerA)))).toEqual({ ok: false, error: 'Product not found' })
  }, 60_000)
})
