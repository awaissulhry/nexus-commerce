/**
 * AE.1 — stock writes must not lose an update when they run at the same time.
 *
 * Plan: docs/2026-09-16-assortment-engine-plan.md §2.3 F1 and §8 AE.1 (R-AE-3).
 *
 * 🔴 These arms need a MULTI-CONNECTION PostgreSQL. The usual disposable database
 * (PGlite behind one socket) serialises every transaction, so a race cannot happen on it
 * and every arm here would pass whether or not the code is safe. Without a server the
 * suite SKIPS with that reason; it never pretends to have measured anything.
 *
 *   docker run -d --rm --name ae1-stock-pg -p 127.0.0.1:55498:5432 \
 *     -e POSTGRES_HOST_AUTH_METHOD=trust --tmpfs /var/lib/postgresql/data pgvector/pgvector:pg17
 *   NEXUS_TEST_CONCURRENT_PG_URL=postgresql://postgres@127.0.0.1:55498/postgres \
 *     npx vitest run src/services/stock-concurrency.vitest.test.ts      (from apps/api)
 *
 * Every arm checks the LEDGER against itself: the final StockLevel must equal the start
 * plus every movement that committed, `reserved` must equal the open HARD reservations,
 * and `available` must equal quantity − reserved. A lost update breaks the first equation
 * even when no error is thrown.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { CONCURRENT_PG_ENV, concurrentDatabase, concurrentDatabaseUrl } from '../test-support/concurrent-database.js'
import { withWorkspace } from '../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
vi.mock('../db.js', () => ({
  default: new Proxy({} as Record<string, unknown>, {
    get: (_t, property) => (database.client as unknown as Record<string, unknown>)[property as string],
  }),
}))
// Post-commit BullMQ adds must not reach a real Redis (a local .env may name the shared one).
vi.mock('../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []) }
  return {
    addJobSafely: vi.fn(async () => undefined),
    outboundSyncQueue: queue,
    readCacheQueue: queue,
    searchIndexQueue: queue,
    channelSyncQueue: queue,
    bulkJobQueue: queue,
    redis: { connection: null },
  }
})

const WS = 'nexus_legacy_workspace'
const serverUrl = concurrentDatabaseUrl()
const flagBefore = process.env.NEXUS_WORKSPACES_ENABLED
const inBusiness = <T>(work: () => Promise<T>) =>
  withWorkspace({ workspaceId: WS, actorUserId: null, membershipId: null, roleKeys: [] }, work)

describe.skipIf(!serverUrl)(`AE.1 — concurrent stock writes (needs ${CONCURRENT_PG_ENV})`, () => {
  let movement: typeof import('./stock-movement.service.js')
  let levels: typeof import('./stock-level.service.js')
  let stockImport: typeof import('./stock-import.service.js')
  let locationId: string

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await database.pool.query(sql, params)).rows as T[]

  const seedProduct = async (quantity: number, reserved = 0) => {
    const productId = randomUUID()
    const sku = `AE1-${productId.slice(0, 8)}`
    await q(`INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", "updatedAt") VALUES ($1,$2,$3,$3,10,now())`, [productId, WS, sku])
    const stockLevelId = randomUUID()
    await q(
      `INSERT INTO "StockLevel" (id, "workspaceId", "locationId", "productId", quantity, reserved, available, "lastUpdatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,now())`,
      [stockLevelId, WS, locationId, productId, quantity, reserved, quantity - reserved],
    )
    return { productId, sku, stockLevelId }
  }

  const level = async (stockLevelId: string) =>
    (await q<{ quantity: number; reserved: number; available: number }>(
      `SELECT quantity, reserved, available FROM "StockLevel" WHERE id = $1`, [stockLevelId],
    ))[0]

  /** Sum of every committed movement for the product (the ledger's own account of what happened). */
  const movedSum = async (productId: string) =>
    Number((await q<{ s: string | null }>(`SELECT COALESCE(SUM(change),0)::text AS s FROM "StockMovement" WHERE "productId" = $1`, [productId]))[0].s)

  const openHardReserved = async (stockLevelId: string) =>
    Number((await q<{ s: string | null }>(
      `SELECT COALESCE(SUM(quantity),0)::text AS s FROM "StockReservation"
       WHERE "stockLevelId" = $1 AND "releasedAt" IS NULL AND "consumedAt" IS NULL AND kind = 'HARD'`, [stockLevelId],
    ))[0].s)

  /** Runs every task at once and waits for all of them; returns how many fulfilled. */
  const race = async (tasks: Array<() => Promise<unknown>>) => {
    const results = await Promise.allSettled(tasks.map((task) => inBusiness(task)))
    return {
      ok: results.filter((r) => r.status === 'fulfilled').length,
      errors: results.flatMap((r) => (r.status === 'rejected' ? [String((r.reason as Error)?.message ?? r.reason)] : [])),
    }
  }

  beforeAll(async () => {
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    database = await concurrentDatabase({ maxConnections: 24 })
    // Deployed databases carry these; schema.prisma cannot express them. Without the
    // partial unique index two concurrent creates would silently make TWO level rows here
    // and throw 23505 in production — the test would measure a database that does not exist.
    await q(`ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_available_invariant" CHECK ("available" = "quantity" - "reserved")`)
    await q(`ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_quantity_nonneg" CHECK ("quantity" >= 0)`)
    await q(`ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_reserved_nonneg" CHECK ("reserved" >= 0)`)
    await q(`ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_quantity_positive" CHECK ("quantity" > 0)`)
    await q(`CREATE UNIQUE INDEX "StockLevel_loc_prod_novar_unique" ON "StockLevel" ("workspaceId", "locationId", "productId") WHERE "variationId" IS NULL`)

    locationId = randomUUID()
    await q(`INSERT INTO "StockLocation" (id, "workspaceId", type, code, name, "updatedAt") VALUES ($1,$2,'WAREHOUSE','IT-MAIN','Main',now())`, [locationId, WS])

    movement = await import('./stock-movement.service.js')
    levels = await import('./stock-level.service.js')
    stockImport = await import('./stock-import.service.js')
  }, 180_000)

  afterAll(async () => {
    if (flagBefore === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
    else process.env.NEXUS_WORKSPACES_ENABLED = flagBefore
    await database?.close()
  }, 60_000)

  beforeEach(() => vi.clearAllMocks())

  it('CONTROL — sequential sales leave the ledger consistent (the harness itself counts right)', async () => {
    const p = await seedProduct(5)
    for (let i = 0; i < 5; i++) {
      await inBusiness(() => movement.applyStockMovement({ productId: p.productId, locationId, change: -1, reason: 'ORDER_PLACED' }))
    }
    expect(await level(p.stockLevelId)).toEqual({ quantity: 0, reserved: 0, available: 0 })
    expect(await movedSum(p.productId)).toBe(-5)
  })

  it('A1 — 20 sales at the same moment on 20 units: every sale lands, none is lost', async () => {
    const p = await seedProduct(20)
    const r = await race(Array.from({ length: 20 }, () => () =>
      movement.applyStockMovement({ productId: p.productId, locationId, change: -1, reason: 'ORDER_PLACED' })))
    expect(r.errors).toEqual([])
    const after = await level(p.stockLevelId)
    expect(after.quantity).toBe(20 + (await movedSum(p.productId)))
    expect(after).toEqual({ quantity: 0, reserved: 0, available: 0 })
    // Each movement recorded a distinct balance: 19, 18, … 0.
    const balances = (await q<{ b: number }>(`SELECT "balanceAfter" AS b FROM "StockMovement" WHERE "productId" = $1 ORDER BY 1`, [p.productId])).map((x) => x.b)
    expect(balances).toEqual(Array.from({ length: 20 }, (_, i) => i))
  }, 60_000)

  it('A2 — 25 buyers reserve the last 20 units at once: exactly 20 win, reserved never overshoots', async () => {
    const p = await seedProduct(20)
    const r = await race(Array.from({ length: 25 }, () => () =>
      levels.reserveStock({ productId: p.productId, locationId, quantity: 1, reason: 'PENDING_ORDER' })))
    expect(r.ok).toBe(20)
    expect(r.errors.every((e) => e.includes('insufficient available'))).toBe(true)
    const after = await level(p.stockLevelId)
    expect(after).toEqual({ quantity: 20, reserved: 20, available: 0 })
    expect(await openHardReserved(p.stockLevelId)).toBe(20)
  }, 60_000)

  it('A3 — sales, receipts and reservations mixed at once: quantity, reserved and available all agree with the ledger', async () => {
    const p = await seedProduct(30)
    const tasks: Array<() => Promise<unknown>> = []
    for (let i = 0; i < 8; i++) tasks.push(() => movement.applyStockMovement({ productId: p.productId, locationId, change: -1, reason: 'ORDER_PLACED' }))
    for (let i = 0; i < 4; i++) tasks.push(() => movement.applyStockMovement({ productId: p.productId, locationId, change: 2, reason: 'MANUAL_ADJUSTMENT' }))
    for (let i = 0; i < 6; i++) tasks.push(() => levels.reserveStock({ productId: p.productId, locationId, quantity: 1, reason: 'PENDING_ORDER' }))
    const r = await race(tasks)
    expect(r.errors).toEqual([])
    const after = await level(p.stockLevelId)
    expect(after.quantity).toBe(30 + (await movedSum(p.productId)))
    expect(after.quantity).toBe(30 - 8 + 8)
    expect(after.reserved).toBe(await openHardReserved(p.stockLevelId))
    expect(after.reserved).toBe(6)
    expect(after.available).toBe(after.quantity - after.reserved)
  }, 60_000)

  it('A4 — the same reservation consumed twice at once: the stock leaves ONCE', async () => {
    const p = await seedProduct(10)
    const reservation = await inBusiness(() => levels.reserveStock({ productId: p.productId, locationId, quantity: 3, reason: 'OPEN_ORDER', orderId: 'order-a4' }))
    const r = await race([
      () => levels.consumeReservation(reservation.id),
      () => levels.consumeReservation(reservation.id),
    ])
    // The second call is IDEMPOTENT, not an error. Without the lock it also takes the stock
    // unless a CHECK happens to reject its stale write — an error an order path would log as
    // a failed shipment. Asserting no error is what makes this arm fail without the lock.
    expect(r.errors).toEqual([])
    expect(await level(p.stockLevelId)).toEqual({ quantity: 7, reserved: 0, available: 7 })
    expect(await movedSum(p.productId)).toBe(-3)
    const consumedRows = await q(`SELECT id FROM "StockMovement" WHERE "reservationId" = $1 AND reason = 'RESERVATION_CONSUMED'`, [reservation.id])
    expect(consumedRows).toHaveLength(1)
  }, 60_000)

  it('A5 — the same reservation released twice at once: reserved drops ONCE', async () => {
    const p = await seedProduct(10)
    const first = await inBusiness(() => levels.reserveStock({ productId: p.productId, locationId, quantity: 2, reason: 'OPEN_ORDER', orderId: 'order-a5-1' }))
    await inBusiness(() => levels.reserveStock({ productId: p.productId, locationId, quantity: 3, reason: 'OPEN_ORDER', orderId: 'order-a5-2' }))
    const r = await race([
      () => levels.releaseReservation(first.id),
      () => levels.releaseReservation(first.id),
    ])
    expect(r.errors).toEqual([])
    expect(await level(p.stockLevelId)).toEqual({ quantity: 10, reserved: 3, available: 7 })
    expect(await openHardReserved(p.stockLevelId)).toBe(3)
    // Without the lock both calls release, and the two stale `reserved` writes can cancel out
    // to the right number by accident. The audit trail cannot: exactly ONE release happened.
    const releasedRows = await q(`SELECT id FROM "StockMovement" WHERE "reservationId" = $1 AND reason = 'RESERVATION_RELEASED'`, [first.id])
    expect(releasedRows).toHaveLength(1)
  }, 60_000)

  it('A6 — one order reserved twice at once (a webhook and a poll): ONE reservation', async () => {
    const p = await seedProduct(10)
    await race([
      () => levels.reserveOpenOrder({ orderId: 'order-a6', productId: p.productId, locationId, quantity: 2 }),
      () => levels.reserveOpenOrder({ orderId: 'order-a6', productId: p.productId, locationId, quantity: 2 }),
    ])
    const rows = await q(`SELECT id FROM "StockReservation" WHERE "orderId" = 'order-a6' AND "releasedAt" IS NULL AND "consumedAt" IS NULL`)
    expect(rows).toHaveLength(1)
    expect(await level(p.stockLevelId)).toEqual({ quantity: 10, reserved: 2, available: 8 })
  }, 60_000)

  // A7 pins the import READING stock inside its write transaction (before AE.1 it planned from
  // reads taken up front). It passes with the lock disabled — it is not a test of the lock.
  it('A7 — a sale lands while a bulk import (ADJUST +5) is running: the sale is not overwritten', async () => {
    const p = await seedProduct(10)
    let saleDone = false
    const rows = [{
      rowIndex: 0, raw: `${p.sku},5`, sku: p.sku, quantity: 5, productId: p.productId, resolvedSku: p.sku,
      matchType: 'EXACT', confidence: 1, candidates: [], channel: null, marketplace: null, notes: null,
      currentWarehouseQty: 10, wouldBeWarehouseQty: 15, currentChannelQty: null, wouldBeChannelQty: null,
      channelListings: [], warnings: [], error: null,
    }] as unknown as import('./stock-import.service.js').PreviewRow[]
    const result = await inBusiness(() => stockImport.applyImport({
      rows, locationCode: 'IT-MAIN', mode: 'ADJUST', target: 'WAREHOUSE',
      // The first progress call happens after the import has read stock and before it writes.
      // A sale committed here is exactly the window a real order hits.
      onProgress: async () => {
        if (saleDone) return
        saleDone = true
        await inBusiness(() => movement.applyStockMovement({ productId: p.productId, locationId, change: -1, reason: 'ORDER_PLACED' }))
      },
    }))
    expect(saleDone).toBe(true)
    expect(result.failed).toBe(0)
    const after = await level(p.stockLevelId)
    expect(after.quantity).toBe(10 + (await movedSum(p.productId)))
    expect(after).toEqual({ quantity: 14, reserved: 0, available: 14 })
  }, 60_000)

  it('A8 — a bulk import SET races sales on the same product: final stock = the set value minus sales that committed after it', async () => {
    const p = await seedProduct(10)
    const rows = [{
      rowIndex: 0, raw: `${p.sku},50`, sku: p.sku, quantity: 50, productId: p.productId, resolvedSku: p.sku,
      matchType: 'EXACT', confidence: 1, candidates: [], channel: null, marketplace: null, notes: null,
      currentWarehouseQty: 10, wouldBeWarehouseQty: 50, currentChannelQty: null, wouldBeChannelQty: null,
      channelListings: [], warnings: [], error: null,
    }] as unknown as import('./stock-import.service.js').PreviewRow[]
    const tasks: Array<() => Promise<unknown>> = [
      () => stockImport.applyImport({ rows, locationCode: 'IT-MAIN', mode: 'SET', target: 'WAREHOUSE' }),
    ]
    for (let i = 0; i < 6; i++) tasks.push(() => movement.applyStockMovement({ productId: p.productId, locationId, change: -1, reason: 'ORDER_PLACED' }))
    const r = await race(tasks)
    expect(r.errors).toEqual([])
    const after = await level(p.stockLevelId)
    // Whatever the order, the level must be what the ledger says happened.
    expect(after.quantity).toBe(10 + (await movedSum(p.productId)))
    expect(after.available).toBe(after.quantity - after.reserved)
  }, 60_000)

  it('A9 — two writers lock two products in opposite orders at once: both finish, no deadlock', async () => {
    const a = await seedProduct(10)
    const b = await seedProduct(10)
    const { lockProductStock } = await import('./stock-lock.js')
    const r = await race([
      () => database.client.$transaction(async (tx) => {
        await lockProductStock(tx, [a.productId, b.productId])
        await movement.applyStockMovement({ productId: a.productId, locationId, change: -1, reason: 'ORDER_PLACED', tx })
        await movement.applyStockMovement({ productId: b.productId, locationId, change: -1, reason: 'ORDER_PLACED', tx })
      }),
      () => database.client.$transaction(async (tx) => {
        await lockProductStock(tx, [b.productId, a.productId])
        await movement.applyStockMovement({ productId: b.productId, locationId, change: -1, reason: 'ORDER_PLACED', tx })
        await movement.applyStockMovement({ productId: a.productId, locationId, change: -1, reason: 'ORDER_PLACED', tx })
      }),
    ])
    expect(r.errors).toEqual([])
    expect(await level(a.stockLevelId)).toEqual({ quantity: 8, reserved: 0, available: 8 })
    expect(await level(b.stockLevelId)).toEqual({ quantity: 8, reserved: 0, available: 8 })
  }, 60_000)
})
