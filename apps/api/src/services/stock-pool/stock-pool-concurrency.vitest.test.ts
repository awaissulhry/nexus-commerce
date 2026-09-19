/**
 * Shared stock, step 1 — two businesses selling the SAME units at the same moment must never both
 * win, and never lose an update. Contract: docs/2026-09-19-shared-stock-build.md §1.
 *
 * 🔴 These arms need a MULTI-CONNECTION PostgreSQL (see stock-concurrency.vitest.test.ts). On PGlite
 * every transaction is queued, so a race cannot happen and every arm would pass whether or not the
 * doors are safe. Without a server the suite SKIPS with that reason.
 *
 *   NEXUS_TEST_CONCURRENT_PG_URL=postgresql://postgres@127.0.0.1:<port>/postgres \
 *     npx vitest run src/services/stock-pool/stock-pool-concurrency.vitest.test.ts   (from apps/api)
 *
 * The lender sells through its own TypeScript writers (applyStockMovement, reserveStock), which read
 * the level and write an ABSOLUTE value under lockProductStock. The borrower sells through the doors,
 * which write RELATIVE values. Only the shared product row lock orders them — arm 4 removes it from
 * the door and shows what it prevents (a deadlock against the lender's writers, or a lost sale).
 *
 * apps/api vitest hides the console of passing tests, so the round tallies are written to
 * $NEXUS_TEST_REPORT_DIR/stock-pool-race.json when that variable is set (for the build record).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { CONCURRENT_PG_ENV, concurrentDatabase, concurrentDatabaseUrl } from '../../test-support/concurrent-database.js'
import { withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({} as Record<string, unknown>, {
    get: (_t, property) => (database.client as unknown as Record<string, unknown>)[property as string],
  }),
}))
// Post-commit BullMQ adds must not reach a real Redis (a local .env may name a shared one).
vi.mock('../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []) }
  return {
    addJobSafely: vi.fn(async () => undefined),
    outboundSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, channelSyncQueue: queue, bulkJobQueue: queue,
    redis: { connection: null },
  }
})

const A = 'ws_a_pool_race'
const B = 'ws_b_pool_race'
const serverUrl = concurrentDatabaseUrl()
const flagBefore = process.env.NEXUS_WORKSPACES_ENABLED

describe.skipIf(!serverUrl)(`Shared stock step 1 — two businesses at the same moment (needs ${CONCURRENT_PG_ENV})`, () => {
  let movement: typeof import('../stock-movement.service.js')
  let levels: typeof import('../stock-level.service.js')
  let doors: typeof import('./pool-doors.js')
  const user = { ownerA: randomUUID(), ownerB: randomUUID() }
  let locationId = ''
  let grantId = ''

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]
  const inA = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: A, actorUserId: null, membershipId: null, roleKeys: [] }, work)
  const inB = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: B, actorUserId: null, membershipId: null, roleKeys: [] }, work)
  const inContext = async (workspaceId: string, actor: string, statements: Array<[string, unknown[]]>) => {
    const client = await database.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('nexus.workspace_id', $1, true), set_config('nexus.actor_id', $2, true)`, [workspaceId, actor])
      for (const [text, params] of statements) await client.query(text, params)
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }

  /** One lender product with `units` at the lent warehouse, linked to a new borrower product. */
  const seedPair = async (units: number) => {
    const source = randomUUID(), target = randomUUID(), catalogId = randomUUID(), levelId = randomUUID()
    const sku = `RACE-${source.slice(0, 8)}`
    await q(`INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", "totalStock", "updatedAt") VALUES ($1,$2,$3,$3,10,$4,now())`, [source, A, sku, units])
    await q(`INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", "updatedAt") VALUES ($1,$2,$3,$3,10,now())`, [target, B, sku])
    await q(`INSERT INTO "StockLevel" (id, "workspaceId", "locationId", "productId", quantity, reserved, available, "lastUpdatedAt") VALUES ($1,$2,$3,$4,$5,0,$5,now())`, [levelId, A, locationId, source, units])
    await q(`INSERT INTO "AssortmentMember" (id, "workspaceId", "assortmentId", "productId", mode) VALUES ($1,$2,$3,$4,'include')`, [randomUUID(), A, assortmentId, source])
    await inContext(B, user.ownerB, [
      [`INSERT INTO "CatalogLink" (id, "shareId", "sourceWorkspaceId", "sourceProductId", "targetWorkspaceId", "targetProductId", "linkedBy", "sourceVersion", "updatedAt") VALUES ($1,$2,$3,$4,$5,$6,'created',1,now())`, [catalogId, shareId, A, source, B, target]],
      [`INSERT INTO "StockPoolLink" (id, "workspaceId", "grantId", "catalogLinkId", "productId", "sourceProductId", "createdByUserId", "updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,now())`, [randomUUID(), B, grantId, catalogId, target, source, user.ownerB]],
    ])
    return { source, target, levelId }
  }
  const level = async (levelId: string) =>
    (await q<{ quantity: number; reserved: number; available: number }>(`SELECT quantity, reserved, available FROM "StockLevel" WHERE id = $1`, [levelId]))[0]
  const movedSum = async (productId: string) =>
    Number((await q<{ s: string }>(`SELECT COALESCE(SUM(change),0)::text AS s FROM "StockMovement" WHERE "productId" = $1`, [productId]))[0].s)
  const openHeld = async (levelId: string) =>
    Number((await q<{ s: string }>(`SELECT COALESCE(SUM(quantity),0)::text AS s FROM "StockReservation" WHERE "stockLevelId" = $1 AND "releasedAt" IS NULL AND "consumedAt" IS NULL AND kind = 'HARD'`, [levelId]))[0].s)
  const settled = async <T>(tasks: Array<() => Promise<T>>) => Promise.allSettled(tasks.map((task) => task()))

  let assortmentId = ''
  let shareId = ''

  beforeAll(async () => {
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    database = await concurrentDatabase({ maxConnections: 24 })
    await q(`ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_available_invariant" CHECK ("available" = "quantity" - "reserved")`)
    await q(`ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_quantity_nonneg" CHECK ("quantity" >= 0)`)
    await q(`ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_reserved_nonneg" CHECK ("reserved" >= 0)`)
    await q(`ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_quantity_positive" CHECK ("quantity" > 0)`)
    await q(`CREATE UNIQUE INDEX "StockLevel_loc_prod_novar_unique" ON "StockLevel" ("workspaceId", "locationId", "productId") WHERE "variationId" IS NULL`)

    const ownerRole = randomUUID()
    await q(`INSERT INTO "Role" (id, key, name, "isSystem", "updatedAt") VALUES ($1,'OWNER','Owner',true,now())`, [ownerRole])
    for (const [key, id] of Object.entries(user)) await q(`INSERT INTO "UserProfile" (id, email, status, "updatedAt") VALUES ($1,$2,'active',now())`, [id, `${key}@example.test`])
    for (const id of [A, B]) await q(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1,$1,'active','race',$1,now())`, [id])
    const member = async (workspaceId: string, userId: string) => {
      const id = randomUUID()
      await q(`INSERT INTO "WorkspaceMembership" (id, "workspaceId", "userId", status, "updatedAt") VALUES ($1,$2,$3,'active',now())`, [id, workspaceId, userId])
      await q(`INSERT INTO "WorkspaceMemberRole" ("membershipId","roleId") VALUES ($1,$2)`, [id, ownerRole])
    }
    await member(A, user.ownerA)
    await member(B, user.ownerA)
    await member(B, user.ownerB)
    locationId = randomUUID()
    await q(`INSERT INTO "StockLocation" (id, "workspaceId", type, code, name, "updatedAt") VALUES ($1,$2,'WAREHOUSE','IT-MAIN','Main',now())`, [locationId, A])

    assortmentId = randomUUID(); shareId = randomUUID(); grantId = randomUUID()
    await inContext(A, user.ownerA, [
      [`INSERT INTO "Assortment" (id, "workspaceId", name, selection, "updatedAt") VALUES ($1,$2,'Race','list',now())`, [assortmentId, A]],
      [`INSERT INTO "AssortmentShare" (id, "assortmentId", "ownerWorkspaceId", "workspaceId", "fieldGroups", "createdByUserId", "updatedAt") VALUES ($1,$2,$3,$4,ARRAY['identity'],$5,now())`, [shareId, assortmentId, A, B, user.ownerA]],
      [`INSERT INTO "StockPoolGrant" (id, "ownerWorkspaceId", "workspaceId", "locationIds", "createdByUserId", "updatedAt") VALUES ($1,$2,$3,$4,$5,now())`, [grantId, A, B, [locationId], user.ownerA]],
    ])
    await inContext(B, user.ownerB, [
      [`SELECT nexus_assortment_share_respond($1,'accept',1)`, [shareId]],
      [`SELECT nexus_stock_pool_grant_respond($1,'accept',1)`, [grantId]],
    ])

    movement = await import('../stock-movement.service.js')
    levels = await import('../stock-level.service.js')
    doors = await import('./pool-doors.js')
  }, 180_000)

  afterAll(async () => {
    if (flagBefore === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
    else process.env.NEXUS_WORKSPACES_ENABLED = flagBefore
    await database?.close()
  }, 60_000)

  it('the last unit, 100 times: the lender\'s own sale and the borrower\'s pool sale — exactly one wins, never below 0', async () => {
    const outcomes = { lender: 0, borrower: 0 }
    for (let round = 0; round < 100; round++) {
      const { source, target, levelId } = await seedPair(1)
      const [lender, borrower] = await settled<unknown>([
        () => inA(() => movement.applyStockMovement({ productId: source, locationId, change: -1, reason: 'ORDER_PLACED', orderId: `A-${round}` })),
        () => inB(async () => {
          const r = await doors.poolTake(database.client as never, { productId: target, quantity: 1, orderRef: `B-${round}` })
          if (!r.ok) throw new Error(r.refusal.code)
          return r
        }),
      ])
      const wins = [lender, borrower].filter((r) => r.status === 'fulfilled').length
      expect(wins, `round ${round}`).toBe(1)
      if (lender.status === 'fulfilled') outcomes.lender++
      else {
        outcomes.borrower++
        expect(String((lender as PromiseRejectedResult).reason)).toMatch(/negative|available_invariant|quantity_nonneg/)
      }
      if (borrower.status === 'rejected') expect(String(borrower.reason)).toMatch(/insufficient/)
      expect(await level(levelId), `round ${round}`).toEqual({ quantity: 0, reserved: 0, available: 0 })
      expect(1 + await movedSum(source)).toBe(0)
    }
    expect(outcomes.lender + outcomes.borrower).toBe(100)
    if (process.env.NEXUS_TEST_REPORT_DIR) {
      const { writeFileSync } = await import('node:fs')
      writeFileSync(`${process.env.NEXUS_TEST_REPORT_DIR}/stock-pool-race.json`, JSON.stringify({ lastUnitRounds: 100, ...outcomes }))
    }
  }, 120_000)

  it('the last unit, 100 times: the lender\'s hold and the borrower\'s pool hold — exactly one wins', async () => {
    for (let round = 0; round < 100; round++) {
      const { source, target, levelId } = await seedPair(1)
      const [lender, borrower] = await settled<unknown>([
        () => inA(() => levels.reserveStock({ productId: source, locationId, quantity: 1, orderId: `A-${round}` })),
        () => inB(async () => {
          const r = await doors.poolReserve(database.client as never, { productId: target, quantity: 1, orderRef: `B-${round}` })
          if (!r.ok) throw new Error(r.refusal.code)
          return r
        }),
      ])
      expect([lender, borrower].filter((r) => r.status === 'fulfilled').length, `round ${round}`).toBe(1)
      for (const r of [lender, borrower]) if (r.status === 'rejected') expect(String(r.reason)).toMatch(/insufficient/)
      expect(await level(levelId)).toEqual({ quantity: 1, reserved: 1, available: 0 })
      expect(await openHeld(levelId)).toBe(1)
    }
  }, 120_000)

  it('a crowd: 20 lender sales and 20 borrower sales on 25 units — exactly 25 sold, and the ledger balances', async () => {
    const { source, target, levelId } = await seedPair(25)
    const results = await settled<unknown>([
      ...Array.from({ length: 20 }, (_, i) => () => inA(() => movement.applyStockMovement({ productId: source, locationId, change: -1, reason: 'ORDER_PLACED', orderId: `A-crowd-${i}` }))),
      ...Array.from({ length: 20 }, (_, i) => () => inB(async () => {
        const r = await doors.poolTake(database.client as never, { productId: target, quantity: 1, orderRef: `B-crowd-${i}` })
        if (!r.ok) throw new Error(r.refusal.code)
        return r
      })),
    ])
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(25)
    for (const r of results) if (r.status === 'rejected') expect(String(r.reason)).toMatch(/insufficient|negative|available_invariant|quantity_nonneg/)
    expect(await level(levelId)).toEqual({ quantity: 0, reserved: 0, available: 0 })
    expect(25 + await movedSum(source)).toBe(0)
    expect(Number((await q<{ t: number }>(`SELECT "totalStock" AS t FROM "Product" WHERE id = $1`, [source]))[0].t)).toBe(0)
  }, 120_000)

  it('a crowd of holds: 12 lender holds and 12 borrower holds on 20 units, 5 times — exactly 20 held, reserved = the open holds', async () => {
    for (let round = 0; round < 5; round++) {
      const { source, target, levelId } = await seedPair(20)
      const results = await settled<unknown>([
        ...Array.from({ length: 12 }, (_, i) => () => inA(() => levels.reserveStock({ productId: source, locationId, quantity: 1, orderId: `A-holds-${round}-${i}` }))),
        ...Array.from({ length: 12 }, (_, i) => () => inB(async () => {
          const r = await doors.poolReserve(database.client as never, { productId: target, quantity: 1, orderRef: `B-holds-${round}-${i}` })
          if (!r.ok) throw new Error(r.refusal.code)
          return r
        })),
      ])
      expect(results.filter((r) => r.status === 'fulfilled').length, `round ${round}`).toBe(20)
      for (const r of results) if (r.status === 'rejected') expect(String(r.reason)).toMatch(/insufficient/)
      expect(await level(levelId), `round ${round}`).toEqual({ quantity: 20, reserved: 20, available: 0 })
      expect(await openHeld(levelId), `round ${round}`).toBe(20)
    }
  }, 120_000)

  it('the same order given back twice, or taken out twice, at the same moment counts once', async () => {
    for (let round = 0; round < 50; round++) {
      const { target, levelId } = await seedPair(5)
      // Two holds on the same level, so a double release cannot hide behind the clamp at 0.
      for (const order of [`X-${round}`, `Y-${round}`]) {
        const r = await inB(() => doors.poolReserve(database.client as never, { productId: target, quantity: 1, orderRef: order }))
        expect(r.ok).toBe(true)
      }
      const released = await settled([
        () => inB(() => doors.poolRelease(database.client as never, { orderRef: `X-${round}` })),
        () => inB(() => doors.poolRelease(database.client as never, { orderRef: `X-${round}` })),
      ])
      expect(released.map((r) => (r.status === 'fulfilled' && r.value.ok ? r.value.released : -1)).sort()).toEqual([0, 1])
      expect(await level(levelId)).toEqual({ quantity: 5, reserved: 1, available: 4 })
      const consumed = await settled([
        () => inB(() => doors.poolConsume(database.client as never, { orderRef: `Y-${round}` })),
        () => inB(() => doors.poolConsume(database.client as never, { orderRef: `Y-${round}` })),
      ])
      expect(consumed.map((r) => (r.status === 'fulfilled' && r.value.ok ? r.value.consumed : -1)).sort()).toEqual([0, 1])
      expect(await level(levelId)).toEqual({ quantity: 4, reserved: 0, available: 4 })
    }
  }, 120_000)

  it('control: without the product lock, the door deadlocks against the lender\'s own writers or loses a sale', async () => {
    // A copy of the take door with its one lock line removed. Without the lock the door takes the level
    // row first and the product row last (the lender total), while the lender's writers take them in the
    // other order: the database must then kill one of them (40P01), or — if the door slips in between the
    // lender's read and its absolute write — a sale is lost. The real door showed neither in the arms above.
    const body = (await q<{ def: string }>(`SELECT pg_get_functiondef('nexus_pool_take(text,integer,text,text)'::regprocedure) AS def`))[0].def
    const unlocked = body
      .replace('FUNCTION public.nexus_pool_take(', 'FUNCTION public.nexus_pool_take_unlocked(')
      .replace(/PERFORM 1 FROM "Product" WHERE id = e\.source_product_id FOR NO KEY UPDATE;/, '/* lock removed for the control */')
    expect(unlocked).not.toBe(body)
    expect(unlocked).toContain('lock removed for the control')
    await q(unlocked)
    await q(`GRANT EXECUTE ON FUNCTION nexus_pool_take_unlocked(text,integer,text,text) TO nexus_workspace_runtime`)
    let broken = 0
    for (let round = 0; round < 10 && broken === 0; round++) {
      const { source, target, levelId } = await seedPair(20)
      const results = await settled<unknown>([
        ...Array.from({ length: 5 }, (_, i) => () => inA(() => movement.applyStockMovement({ productId: source, locationId, change: -1, reason: 'ORDER_PLACED', orderId: `A-ctl-${round}-${i}` }))),
        ...Array.from({ length: 5 }, (_, i) => () => inB(() => database.client.$queryRaw`SELECT nexus_pool_take_unlocked(${target}, 1, ${`B-ctl-${round}-${i}`}, NULL::text)`)),
      ])
      const deadlocked = results.some((r) => r.status === 'rejected' && /deadlock/i.test(String(r.reason)))
      const after = await level(levelId)
      if (deadlocked || after.quantity !== 20 + await movedSum(source)) broken++
    }
    await q(`DROP FUNCTION nexus_pool_take_unlocked(text,integer,text,text)`)
    expect(broken, 'the unlocked door neither deadlocked nor lost a sale — the control does not reach the race').toBeGreaterThan(0)
  }, 120_000)
})
