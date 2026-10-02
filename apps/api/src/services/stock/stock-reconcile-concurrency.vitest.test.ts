/**
 * MCP full control 08 S6 — a stock count reconciled by Claude's reconcile-stock-count while sales land, on a REAL
 * multi-connection PostgreSQL.
 *
 * The reconcile moves stock by counted − expected (one INVENTORY_COUNT movement per item) through the same writer as
 * a sale, which locks the product first: whichever comes first, the other reads the level after it. Nothing is lost
 * and nothing goes below zero: on hand + units sold − the variance = the start, always.
 *
 * 🔴 Needs a MULTI-CONNECTION PostgreSQL (NEXUS_TEST_CONCURRENT_PG_URL; scripts/run-real-postgres-tests.mjs supplies
 * one). PGlite serialises every transaction, so nothing could race there. Without a server the suite SKIPS with that
 * reason; it never pretends to have measured anything.
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
// Post-commit BullMQ adds must not reach a real Redis (a local .env may name the shared one).
vi.mock('../../lib/queue.js', () => {
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

describe.skipIf(!serverUrl)(`08 S6 — a count reconciled while sales land (needs ${CONCURRENT_PG_ENV})`, () => {
  let movement: typeof import('../stock-movement.service.js')
  let reconcile: NonNullable<import('../agents/tool-types.js').AgentTool['execute']>
  let location = ''

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await database.pool.query(sql, params)).rows as T[]

  /** A product with `onHand` at the warehouse, and an IN_PROGRESS count of it: expected `onHand`, counted `counted`. */
  const seed = async (onHand: number, counted: number) => {
    const productId = randomUUID()
    const sku = `TEST-SKU-S6R-${productId.slice(0, 8)}`
    await q(`INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", "totalStock", "updatedAt") VALUES ($1,$2,$3,$3,10,$4,now())`, [productId, WS, sku, onHand])
    await q(`INSERT INTO "StockLevel" (id, "workspaceId", "locationId", "productId", quantity, reserved, available, "lastUpdatedAt") VALUES ($1,$2,$3,$4,$5,0,$5,now())`, [randomUUID(), WS, location, productId, onHand])
    const countId = randomUUID()
    await q(`INSERT INTO "CycleCount" (id, "workspaceId", "locationId", status, "updatedAt") VALUES ($1,$2,$3,'IN_PROGRESS',now())`, [countId, WS, location])
    await q(`INSERT INTO "CycleCountItem" (id, "workspaceId", "cycleCountId", "productId", sku, "expectedQuantity", "countedQuantity", status, "updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,'COUNTED',now())`, [randomUUID(), WS, countId, productId, sku, onHand, counted])
    return { productId, countId }
  }

  /** ONE statement: on hand, units sold, and the count's applied variance. */
  const snapshot = async (productId: string) => {
    const [row] = await q<{ onHand: number; sold: number; counted: number; countMoves: number }>(
      `SELECT (SELECT quantity FROM "StockLevel" WHERE "productId" = $1 AND "locationId" = $2)::int AS "onHand",
              (SELECT COALESCE(SUM(-change), 0) FROM "StockMovement" WHERE "productId" = $1 AND reason = 'ORDER_PLACED')::int AS sold,
              (SELECT COALESCE(SUM(change), 0) FROM "StockMovement" WHERE "productId" = $1 AND reason = 'INVENTORY_COUNT')::int AS counted,
              (SELECT count(*) FROM "StockMovement" WHERE "productId" = $1 AND reason = 'INVENTORY_COUNT')::int AS "countMoves"`,
      [productId, location],
    )
    return row
  }

  beforeAll(async () => {
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    database = await concurrentDatabase({ maxConnections: 24 })
    // Deployed databases carry these; schema.prisma cannot express them (as stock-concurrency.vitest.test.ts does).
    await q(`ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_available_invariant" CHECK ("available" = "quantity" - "reserved")`)
    await q(`ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_quantity_nonneg" CHECK ("quantity" >= 0)`)
    await q(`ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_reserved_nonneg" CHECK ("reserved" >= 0)`)
    await q(`CREATE UNIQUE INDEX "StockLevel_loc_prod_novar_unique" ON "StockLevel" ("workspaceId", "locationId", "productId") WHERE "variationId" IS NULL`)
    location = randomUUID()
    await q(`INSERT INTO "StockLocation" (id, "workspaceId", type, code, name, "updatedAt") VALUES ($1,$2,'WAREHOUSE','IT-MAIN','Main',now())`, [location, WS])
    movement = await import('../stock-movement.service.js')
    const { getTool } = await import('../agents/tool-registry.js')
    reconcile = getTool('reconcile-stock-count')!.execute!
  }, 180_000)

  afterAll(async () => {
    if (flagBefore === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
    else process.env.NEXUS_WORKSPACES_ENABLED = flagBefore
    await database?.close()
  }, 60_000)

  const sell = (productId: string) => inBusiness(() => movement.applyStockMovement({ productId, locationId: location, change: -1, reason: 'ORDER_PLACED' }))
  /** What the approval runs: the tool's execute, as the gate calls it after a person approved. */
  const runReconcile = (countId: string) => inBusiness(() => reconcile({ countId }, { userId: null, can: () => true, via: 'claude' }))

  it('CONTROL — a reconcile then a sale, one after the other: the harness counts right', async () => {
    const { productId, countId } = await seed(10, 8)
    expect(await runReconcile(countId)).toMatchObject({ ok: true })
    await sell(productId)
    expect(await snapshot(productId)).toEqual({ onHand: 7, sold: 1, counted: -2, countMoves: 1 })
  }, 60_000)

  it('R1 — a reconcile while 6 sales land: the variance is applied once, every sale counts, nothing is lost', async () => {
    const { productId, countId } = await seed(20, 17)
    const sales = (async () => { for (let i = 0; i < 6; i++) await sell(productId) })()
    const [, ran] = await Promise.all([sales, runReconcile(countId)])
    expect(ran).toMatchObject({ ok: true })
    const after = await snapshot(productId)
    expect(after).toEqual({ onHand: 20 - 3 - 6, sold: 6, counted: -3, countMoves: 1 })
  }, 120_000)

  it('R2 — the last units: a reconcile of −2 and 3 sales on 3 units at the same moment never go below zero, and the ledger adds up', async () => {
    const { productId, countId } = await seed(3, 1)
    const results = await Promise.allSettled([runReconcile(countId), sell(productId), sell(productId), sell(productId)])
    const after = await snapshot(productId)
    expect(after.onHand).toBeGreaterThanOrEqual(0)
    expect(after.onHand + after.sold - after.counted).toBe(3)
    expect(after.countMoves).toBeLessThanOrEqual(1)
    // Whichever wins, the other side's refusals are shortfalls (a sale below zero, or a reconcile that no longer fits).
    for (const r of results.slice(1)) if (r.status === 'rejected') expect(String((r.reason as Error).message)).toMatch(/negative|insufficient/i)
    const ran = results[0]
    if (ran.status === 'fulfilled' && !(ran.value as { ok: boolean }).ok) expect(after.countMoves).toBe(0)
  }, 60_000)
})
