/**
 * Step 3 cases — the sealed-case invariant (Σ sealed cases × units per case ≤ units) under concurrency, on a REAL
 * multi-connection PostgreSQL, through the real services (applyStockMovement, setCasesInTx, setCasePacks).
 *
 * Why a real server: no database CHECK holds the invariant (test and fresh databases carry none); the case keeper
 * does, under the product lock every stock writer takes first. On PGlite (one connection) every transaction queues,
 * so a race cannot happen and these arms would pass whether or not the lock is taken.
 *
 * Each race runs twice: once FORCED (the first writer holds the product lock open while the second starts, so the
 * second can only be right if it waited and read the committed state), and once as many plain simultaneous pairs on
 * separate products, each checked against the invariant.
 *
 * 🔴 Needs a MULTI-CONNECTION PostgreSQL; without one the suite SKIPS. From the repo root:
 * `node scripts/run-real-postgres-tests.mjs --suites '[{"name":"cases","file":"src/services/stock/stock-cases-postgres.vitest.test.ts","expect":3}]'`
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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
  return { addJobSafely: vi.fn(async () => undefined), outboundSyncQueue: queue, readCacheQueue: queue,
    searchIndexQueue: queue, channelSyncQueue: queue, bulkJobQueue: queue, redis: { connection: null } }
})
vi.mock('../product-read-cache.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../product-read-cache.service.js')>()),
  productReadCacheService: { refresh: vi.fn(async () => undefined), refreshMany: vi.fn(async () => undefined) },
}))

const WS = 'nexus_legacy_workspace'
const UPC = 12
const flagBefore = process.env.NEXUS_WORKSPACES_ENABLED
const inBusiness = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: WS, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const q = async <T = Record<string, any>>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const settled = async <T>(work: Promise<T>) => work.then((value) => ({ ok: true as const, value }), (error: any) => ({ ok: false as const, error }))

describe.skipIf(!concurrentDatabaseUrl())(`Step 3 cases — the sealed-case invariant under concurrency (needs ${CONCURRENT_PG_ENV})`, () => {
  let movement: typeof import('../stock-movement.service.js')
  let cases: typeof import('./stock-cases.service.js')
  let locationId = ''

  /** `quantity` units at IT-MAIN, 12 per case, `sealed` cases (no row when undefined). */
  const seed = async (quantity: number, sealed?: number) => {
    const productId = randomUUID(), sku = `CASE-RACE-${productId.slice(0, 8)}`
    await q(`INSERT INTO "Product" (id,"workspaceId",sku,name,"basePrice","totalStock","updatedAt") VALUES ($1,$2,$3,$3,10,$4,now())`, [productId, WS, sku, quantity])
    const levelId = randomUUID()
    await q(`INSERT INTO "StockLevel" (id,"workspaceId","locationId","productId",quantity,reserved,available,"lastUpdatedAt") VALUES ($1,$2,$3,$4,$5,0,$5,now())`, [levelId, WS, locationId, productId, quantity])
    const sizeId = randomUUID()
    await q(`INSERT INTO "ProductCaseSize" (id,"workspaceId","productId","unitsPerCase","updatedAt") VALUES ($1,$2,$3,$4,now())`, [sizeId, WS, productId, UPC])
    if (sealed !== undefined) await q(`INSERT INTO "StockCaseCount" (id,"workspaceId","stockLevelId","caseSizeId",cases,"updatedAt") VALUES ($1,$2,$3,$4,$5,now())`, [randomUUID(), WS, levelId, sizeId, sealed])
    return { productId, sku, levelId }
  }
  /** The level's units, its STORED sealed cases (null = no row) and the case size now (one size in these races). */
  const state = async (p: { productId: string; levelId: string }) => {
    const [row] = await q<{ quantity: number; cases: number | null; upc: number | null; sealedUnits: number }>(
      `SELECT l.quantity,
              (SELECT SUM(c.cases)::int FROM "StockCaseCount" c WHERE c."stockLevelId" = l.id) AS cases,
              (SELECT MAX("unitsPerCase") FROM "ProductCaseSize" WHERE "productId" = l."productId") AS upc,
              (SELECT COALESCE(SUM(c.cases * s."unitsPerCase"), 0)::int FROM "StockCaseCount" c JOIN "ProductCaseSize" s ON s.id = c."caseSizeId" WHERE c."stockLevelId" = l.id) AS "sealedUnits"
       FROM "StockLevel" l WHERE l.id = $1`, [p.levelId])
    return row
  }
  /** The ledger agrees with itself and the stored counts never claim more units than the level holds. */
  const holds = async (p: { productId: string; levelId: string }, start: number) => {
    const { sealedUnits, ...s } = await state(p)
    const [{ moved }] = await q<{ moved: string }>(`SELECT COALESCE(SUM(change),0)::text AS moved FROM "StockMovement" WHERE "productId"=$1`, [p.productId])
    expect(s.quantity).toBe(start + Number(moved))
    expect(sealedUnits).toBeLessThanOrEqual(s.quantity)
    return s
  }
  const sell = (productId: string, units: number) =>
    inBusiness(() => movement.applyStockMovement({ productId, locationId, change: -units, reason: 'ORDER_PLACED' }))
  const count = (productId: string, value: number) =>
    inBusiness(() => database.client.$transaction((tx) => cases.setCasesInTx(tx, { productId, locationId, cases: [{ unitsPerCase: UPC, cases: value }], reason: 'INVENTORY_COUNT', actor: 'race' })))
  /** Replace the SKU's case size with another (the old size's sealed cases open). */
  const resize = (productId: string, unitsPerCase: number) =>
    inBusiness(() => cases.setCasePacks({ productIds: [productId], sizes: [{ unitsPerCase, caseLengthCm: null, caseWidthCm: null, caseHeightCm: null, caseWeightKg: null }], openSealedCases: true, actor: 'race' }))
  /** Run `first` inside a transaction that keeps the product lock for `holdMs` after it, and start `second` meanwhile. */
  const forced = async <T>(first: (tx: any) => Promise<unknown>, second: () => Promise<T>, holdMs = 400) => {
    let pending: Promise<{ ok: true; value: T } | { ok: false; error: any }> | null = null
    await inBusiness(() => database.client.$transaction(async (tx) => {
      await first(tx)
      pending = settled(second())
      await sleep(holdMs)
    }, { timeout: 20_000 }))
    return await pending!
  }

  beforeAll(async () => {
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    database = await concurrentDatabase({ maxConnections: 24 })
    // Deployed databases carry these; schema.prisma cannot express them.
    await q(`ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_available_invariant" CHECK ("available" = "quantity" - "reserved")`)
    await q(`ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_quantity_nonneg" CHECK ("quantity" >= 0)`)
    await q(`CREATE UNIQUE INDEX "StockLevel_loc_prod_novar_unique" ON "StockLevel" ("workspaceId","locationId","productId") WHERE "variationId" IS NULL`)
    locationId = randomUUID()
    await q(`INSERT INTO "StockLocation" (id,"workspaceId",type,code,name,"updatedAt") VALUES ($1,$2,'WAREHOUSE','IT-MAIN','Main',now())`, [locationId, WS])
    movement = await import('../stock-movement.service.js')
    cases = await import('./stock-cases.service.js')
  }, 180_000)

  afterAll(async () => {
    if (flagBefore === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
    else process.env.NEXUS_WORKSPACES_ENABLED = flagBefore
    await database?.close()
  }, 60_000)

  beforeEach(() => vi.clearAllMocks())

  it('1. ten sales at once on 4 cases + 3 loose (51 at 12 / case): every sale lands and the sealed count ends at floor(units / 12)', async () => {
    const p = await seed(51, 4)
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => sell(p.productId, 3)))
    expect(results.filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason))).toEqual([])
    const s = await holds(p, 51)
    expect(s).toEqual({ quantity: 21, cases: 1, upc: UPC }) // 1 sealed + 9 loose: three cases opened, none twice, none missed
    // Plain pairs on more products: whatever the order, each ends at floor(units / 12).
    const many = await Promise.all(Array.from({ length: 6 }, () => seed(51, 4)))
    await Promise.all(many.flatMap((m) => Array.from({ length: 5 }, (_, i) => sell(m.productId, i + 1)))) // 15 units each
    for (const m of many) expect(await holds(m, 51)).toEqual({ quantity: 36, cases: 3, upc: UPC })
  }, 60_000)

  it('2. a case count racing a sale: checked against the units the sale left, or the sale opens the counted case — never more sealed than units', async () => {
    // FORCED, sale first: the count waits for the lock and sees 46 units, so 4 cases (48 units) are refused.
    const a = await seed(51)
    const afterSale = await forced((tx) => movement.applyStockMovementInTx(tx, { productId: a.productId, locationId, change: -5, reason: 'ORDER_PLACED' }), () => count(a.productId, 4))
    expect(afterSale.ok).toBe(false)
    expect(afterSale.ok ? null : afterSale.error).toMatchObject({ name: 'CaseCountError', code: 'CASES_EXCEED_UNITS', message: '4 cases need 48 units; on hand is 46' })
    expect(await holds(a, 51)).toEqual({ quantity: 46, cases: null, upc: UPC })
    // FORCED, count first: the sale waits, then opens one of the 4 counted cases (46 = 3 + 10).
    const b = await seed(51)
    const afterCount = await forced((tx) => cases.setCasesInTx(tx, { productId: b.productId, locationId, cases: [{ unitsPerCase: UPC, cases: 4 }], reason: 'INVENTORY_COUNT', actor: 'race' }), () => sell(b.productId, 5))
    expect(afterCount.ok).toBe(true)
    expect(await holds(b, 51)).toEqual({ quantity: 46, cases: 3, upc: UPC })
    // Plain pairs: either outcome, never a broken invariant.
    const pairs = await Promise.all(Array.from({ length: 8 }, () => seed(51)))
    const outcomes = await Promise.all(pairs.map(async (m) => {
      const [counted, sold] = await Promise.all([settled(count(m.productId, 4)), settled(sell(m.productId, 5))])
      expect(sold.ok).toBe(true)
      if (!counted.ok) expect(counted.error).toMatchObject({ code: 'CASES_EXCEED_UNITS' })
      const s = await holds(m, 51)
      expect(s.cases ?? 0).toBe(counted.ok ? 3 : 0)
      return counted.ok
    }))
    expect(outcomes).toHaveLength(8)
  }, 60_000)

  it('3. a case size replaced while a sale runs: the change opens exactly the cases the sale left sealed, and the sale never writes a count for the old size', async () => {
    // FORCED, sale first: the size change waits, then sees 3 sealed (41 = 3 + 5) and opens those 3.
    const a = await seed(51, 4)
    const afterSale = await forced((tx) => movement.applyStockMovementInTx(tx, { productId: a.productId, locationId, change: -10, reason: 'ORDER_PLACED' }), () => resize(a.productId, 6))
    expect(afterSale).toEqual({ ok: true, value: [{ productId: a.productId, ok: true, opened: [{ locationCode: 'IT-MAIN', unitsPerCase: UPC, cases: 3 }] }] })
    expect(await holds(a, 51)).toEqual({ quantity: 41, cases: null, upc: 6 })
    // FORCED, size first: a holder keeps the product lock while the size change queues on it, then the sale queues
    // behind the change. The change opens all 4; the sale then finds no case row and writes none.
    const b = await seed(51, 4)
    const { lockProductStock } = await import('../stock-lock.js')
    let resized: Promise<Awaited<ReturnType<typeof settled<Awaited<ReturnType<typeof resize>>>>>> | null = null
    let sold: Promise<Awaited<ReturnType<typeof settled<unknown>>>> | null = null
    await inBusiness(() => database.client.$transaction(async (tx) => {
      await lockProductStock(tx, [b.productId])
      resized = settled(resize(b.productId, 6))
      await sleep(250)
      sold = settled(sell(b.productId, 10))
      await sleep(250)
    }, { timeout: 20_000 }))
    expect(await resized!).toEqual({ ok: true, value: [{ productId: b.productId, ok: true, opened: [{ locationCode: 'IT-MAIN', unitsPerCase: UPC, cases: 4 }] }] })
    expect((await sold!).ok).toBe(true)
    expect(await holds(b, 51)).toEqual({ quantity: 41, cases: null, upc: 6 })
    // Plain pairs: both always succeed; no case row survives; the units are the sale's.
    const pairs = await Promise.all(Array.from({ length: 8 }, () => seed(51, 4)))
    await Promise.all(pairs.map(async (m) => {
      const [resized, sold] = await Promise.all([settled(resize(m.productId, 6)), settled(sell(m.productId, 10))])
      expect(sold.ok).toBe(true)
      expect(resized.ok).toBe(true)
      const opened = resized.ok ? resized.value[0].opened : null
      expect(opened?.length === 1 && [3, 4].includes(opened[0].cases)).toBe(true) // 3 when the sale came first, 4 otherwise
      expect(await holds(m, 51)).toEqual({ quantity: 41, cases: null, upc: 6 })
    }))
  }, 60_000)
})
