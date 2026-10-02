/**
 * MCP full control 08 S2 (F8) — a transfer racing sales on a REAL multi-connection PostgreSQL.
 *
 * `transferStock` was two transactions (TRANSFER_OUT, then TRANSFER_IN). Between them the units had left the source
 * and arrived nowhere: every reader saw them missing, and when the second step failed they stayed missing. Now the
 * two movements commit together or not at all.
 *
 * 🔴 Needs a MULTI-CONNECTION PostgreSQL (NEXUS_TEST_CONCURRENT_PG_URL; scripts/run-real-postgres-tests.mjs supplies
 * one). PGlite serialises every transaction, so no reader could ever land between the two steps there. Without a
 * server the suite SKIPS with that reason; it never pretends to have measured anything.
 *
 * Every arm checks the product's units against the ledger: on hand (both warehouses) + units sold = the start.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
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
    outboundSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, channelSyncQueue: queue, bulkJobQueue: queue,
    redis: { connection: null },
  }
})

const WS = 'nexus_legacy_workspace'
const serverUrl = concurrentDatabaseUrl()
const flagBefore = process.env.NEXUS_WORKSPACES_ENABLED
const inBusiness = <T>(work: () => Promise<T>) =>
  withWorkspace({ workspaceId: WS, actorUserId: null, membershipId: null, roleKeys: [] }, work)

describe.skipIf(!serverUrl)(`08 S2 — a transfer racing sales (needs ${CONCURRENT_PG_ENV})`, () => {
  let movement: typeof import('./stock-movement.service.js')
  let levels: typeof import('./stock-level.service.js')
  const loc = { a: '', b: '' }

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await database.pool.query(sql, params)).rows as T[]

  const seedProduct = async (atA: number) => {
    const productId = randomUUID()
    const sku = `TEST-SKU-S2T-${productId.slice(0, 8)}`
    await q(`INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", "totalStock", "updatedAt") VALUES ($1,$2,$3,$3,10,$4,now())`, [productId, WS, sku, atA])
    for (const [location, quantity] of [[loc.a, atA], [loc.b, 0]] as const) {
      await q(
        `INSERT INTO "StockLevel" (id, "workspaceId", "locationId", "productId", quantity, reserved, available, "lastUpdatedAt")
         VALUES ($1,$2,$3,$4,$5,0,$5,now())`,
        [randomUUID(), WS, location, productId, quantity],
      )
    }
    return productId
  }

  /** ONE statement, so one snapshot: units on hand in both warehouses, and units sold so far. */
  const snapshot = async (productId: string) => {
    const [row] = await q<{ a: number; b: number; sold: number }>(
      `SELECT (SELECT quantity FROM "StockLevel" WHERE "productId" = $1 AND "locationId" = $2)::int AS a,
              (SELECT quantity FROM "StockLevel" WHERE "productId" = $1 AND "locationId" = $3)::int AS b,
              (SELECT COALESCE(SUM(-change), 0) FROM "StockMovement" WHERE "productId" = $1 AND reason = 'ORDER_PLACED')::int AS sold`,
      [productId, loc.a, loc.b],
    )
    return row
  }

  /** Reads the snapshot over and over until `work` settles; returns every reading where units were missing. */
  const watchWhile = async (productId: string, start: number, work: Promise<unknown>) => {
    let done = false
    const missing: Array<{ a: number; b: number; sold: number }> = []
    let readings = 0
    const reader = (async () => {
      while (!done) {
        const s = await snapshot(productId)
        readings++
        if (s.a + s.b + s.sold !== start) missing.push(s)
      }
    })()
    try { await work } finally { done = true; await reader }
    return { missing, readings }
  }

  beforeAll(async () => {
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    database = await concurrentDatabase({ maxConnections: 24 })
    // Deployed databases carry these; schema.prisma cannot express them (same as stock-concurrency.vitest.test.ts).
    await q(`ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_available_invariant" CHECK ("available" = "quantity" - "reserved")`)
    await q(`ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_quantity_nonneg" CHECK ("quantity" >= 0)`)
    await q(`ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_reserved_nonneg" CHECK ("reserved" >= 0)`)
    await q(`CREATE UNIQUE INDEX "StockLevel_loc_prod_novar_unique" ON "StockLevel" ("workspaceId", "locationId", "productId") WHERE "variationId" IS NULL`)
    loc.a = randomUUID()
    loc.b = randomUUID()
    await q(`INSERT INTO "StockLocation" (id, "workspaceId", type, code, name, "updatedAt") VALUES ($1,$2,'WAREHOUSE','IT-MAIN','Main',now())`, [loc.a, WS])
    await q(`INSERT INTO "StockLocation" (id, "workspaceId", type, code, name, "updatedAt") VALUES ($1,$2,'WAREHOUSE','TEST-WH-B','Second',now())`, [loc.b, WS])
    movement = await import('./stock-movement.service.js')
    levels = await import('./stock-level.service.js')
  }, 180_000)

  afterAll(async () => {
    if (flagBefore === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
    else process.env.NEXUS_WORKSPACES_ENABLED = flagBefore
    await database?.close()
  }, 60_000)

  const sell = (productId: string) => inBusiness(() => movement.applyStockMovement({ productId, locationId: loc.a, change: -1, reason: 'ORDER_PLACED' }))
  const transfer = (productId: string, toLocationId: string, quantity = 1) =>
    inBusiness(() => levels.transferStock({ productId, fromLocationId: loc.a, toLocationId, quantity }))

  it('CONTROL — a transfer then a sale, one after the other: the harness counts right', async () => {
    const p = await seedProduct(10)
    await transfer(p, loc.b, 3)
    await sell(p)
    expect(await snapshot(p)).toEqual({ a: 6, b: 3, sold: 1 })
  }, 60_000)

  it('T1 — 12 transfers while 8 sales land: no reader ever sees units in flight, and none are lost', async () => {
    const p = await seedProduct(30)
    const transfers = (async () => { for (let i = 0; i < 12; i++) await transfer(p, loc.b) })()
    const sales = (async () => { for (let i = 0; i < 8; i++) await sell(p) })()
    const watched = await watchWhile(p, 30, Promise.all([transfers, sales]))
    expect(watched.readings).toBeGreaterThan(0)
    expect(watched.missing).toEqual([])
    expect(await snapshot(p)).toEqual({ a: 30 - 12 - 8, b: 12, sold: 8 })
  }, 120_000)

  it('T2 — transfers whose arriving side fails, racing sales: the source loses only what was sold', async () => {
    const p = await seedProduct(20)
    const missingDestination = `missing-${randomUUID()}`
    const transfers = (async () => {
      let failed = 0
      for (let i = 0; i < 6; i++) await transfer(p, missingDestination, 2).catch(() => { failed++ })
      return failed
    })()
    const sales = (async () => { for (let i = 0; i < 5; i++) await sell(p) })()
    const [failed] = await Promise.all([transfers, sales])
    expect(failed).toBe(6)
    expect(await snapshot(p)).toEqual({ a: 15, b: 0, sold: 5 })
    expect(await q(`SELECT 1 FROM "StockMovement" WHERE "productId" = $1 AND reason IN ('TRANSFER_OUT', 'TRANSFER_IN')`, [p])).toEqual([])
  }, 120_000)

  it('T3 — a transfer of the last 5 units and 5 sales at the same moment: every unit is counted once, none below zero', async () => {
    const p = await seedProduct(5)
    const results = await Promise.allSettled([
      transfer(p, loc.b, 5),
      ...Array.from({ length: 5 }, () => sell(p)),
    ])
    const after = await snapshot(p)
    expect(after.a).toBeGreaterThanOrEqual(0)
    expect(after.a + after.b + after.sold).toBe(5)
    const transferred = results[0].status === 'fulfilled'
    expect(after.b).toBe(transferred ? 5 : 0)
    // The transfer and the sales serialise on the product: whichever wins, the other side's refusals are shortfalls.
    for (const r of results) if (r.status === 'rejected') expect(String((r.reason as Error).message)).toMatch(/negative|insufficient/i)
  }, 60_000)
})
