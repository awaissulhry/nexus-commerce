/**
 * Shared stock step 7 (plan risk 7) — the stock lock under a rush of orders from two businesses at once.
 * Opt-in; it measures, it does not guard (the race suite guards). Needs NEXUS_TEST_CONCURRENT_PG_URL and:
 *
 *   POOL_RUSH=<orders started per second>  [POOL_RUSH_SECONDS=20] [POOL_RUSH_PRODUCTS=1] [POOL_RUSH_BURST=<orders at one instant>]
 *   [POOL_RUSH_CONNECTIONS=8 (the API's pool)] [POOL_RUSH_FILE=<file the result line is appended to>]
 *
 * Lender A lends its main warehouse to borrower B; every product is linked, and B's eBay listing follows the
 * pool through the real pool worker (its poller runs during the rush, as in the API). Orders are started on a
 * clock (open loop: a slow answer does not slow the arrivals), spread over POOL_RUSH_PRODUCTS products — 1 is
 * the worst case, every order on one product lock. The mix, per order:
 *
 *   B hold → ship     25%  pool door HOLD, then 0.1–1.5 s later TAKE OUT (90%) or GIVE BACK (10%)   (Amazon in B)
 *   B sale            20%  pool door TAKE OUT at once; 10% are later PUT BACK (a cancellation or a return) (eBay in B)
 *   A sale            30%  A's own writer applyStockMovement(−1)                                   (eBay in A)
 *   A hold → ship     20%  A's own reserveStock, then consumeReservation (90%) or releaseReservation (10%) (Amazon in A)
 *   A restock          5%  A's own writer applyStockMovement(+3)
 *
 * Reported: orders started and finished, the achieved rate, p50/p95/p99/max per step, the most sessions waiting
 * on a lock at one moment, and errors by kind. Checked: every step finished; nothing failed (the stock is large,
 * so even "not enough" would be a finding); per product, quantity and reserved equal the start plus every
 * successful step (the caller's own books: a lost update shows here), quantity = start + every movement,
 * reserved = the open holds, the lender total = its level; the borrower's movements in the lender's ledger =
 * its successful takes minus its put-backs; B's listing shows the pool's number once the worker drains. A
 * control then changes one level behind the writers' backs and the same check must see it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { Pool } from 'pg'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../test-support/concurrent-database.js'
import { withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
/** Seeding, read-backs and the lock sampler: their own connections, outside the measured pool. */
let side: Pool
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

const RATE = Number(process.env.POOL_RUSH ?? 0)
const SECONDS = Math.max(1, Number(process.env.POOL_RUSH_SECONDS ?? 20))
const PRODUCTS = Math.max(1, Number(process.env.POOL_RUSH_PRODUCTS ?? 1))
const BURST = Math.max(0, Number(process.env.POOL_RUSH_BURST ?? 0))
/** One API process: NEXUS_DATABASE_POOL_MAX defaults to 8 there (apps/api/src/env.ts). */
const CONNECTIONS = Math.max(2, Number(process.env.POOL_RUSH_CONNECTIONS ?? 8))
const START = 100_000
const A = 'ws_a_pool_rush'
const B = 'ws_b_pool_rush'

type Step = 'B.hold' | 'B.ship' | 'B.giveBack' | 'B.take' | 'B.putBack' | 'A.sale' | 'A.hold' | 'A.ship' | 'A.release' | 'A.restock'
/** What a successful step does to quantity and reserved (the caller's own books). */
const EFFECT: Record<Step, [number, number]> = {
  'B.hold': [0, 1], 'B.ship': [-1, -1], 'B.giveBack': [0, -1], 'B.take': [-1, 0], 'B.putBack': [1, 0],
  'A.sale': [-1, 0], 'A.hold': [0, 1], 'A.ship': [-1, -1], 'A.release': [0, -1], 'A.restock': [3, 0],
}

describe.skipIf(!concurrentDatabaseUrl() || !(RATE > 0 || BURST > 0))('Shared stock step 7 — the stock lock under a rush (opt-in: POOL_RUSH / POOL_RUSH_BURST)', () => {
  let movement: typeof import('../stock-movement.service.js')
  let levels: typeof import('../stock-level.service.js')
  let doors: typeof import('./pool-doors.js')
  let tasks: typeof import('./pool-tasks.js')
  const user = { ownerA: randomUUID(), ownerB: randomUUID() }
  const products: Array<{ source: string; target: string; levelId: string; listingId: string }> = []
  let locationId = ''

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await side.query(sql, params)).rows as T[]
  const as = <T>(workspaceId: string, work: () => Promise<T>) => withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)
  const inContext = async (workspaceId: string, actor: string, statements: Array<[string, unknown[]]>) => {
    const client = await side.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('nexus.workspace_id', $1, true), set_config('nexus.actor_id', $2, true)`, [workspaceId, actor])
      for (const [text, params] of statements) await client.query(text, params)
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const door = async <T>(work: Promise<{ ok: boolean; refusal?: { code: string } } & T>) => {
    const r = await work
    if (!r.ok) throw new Error(`refused: ${r.refusal?.code}`)
    return r
  }

  beforeAll(async () => {
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    database = await concurrentDatabase({ maxConnections: CONNECTIONS })
    const url = new URL(concurrentDatabaseUrl()!.toString())
    url.pathname = `/${database.name}`
    side = new Pool({ connectionString: url.toString(), max: 3 })
    // The production database's own checks on stock (as in the race suite).
    await q(`ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_available_invariant" CHECK ("available" = "quantity" - "reserved")`)
    await q(`ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_quantity_nonneg" CHECK ("quantity" >= 0)`)
    await q(`ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_reserved_nonneg" CHECK ("reserved" >= 0)`)
    await q(`CREATE UNIQUE INDEX "StockLevel_loc_prod_novar_unique" ON "StockLevel" ("workspaceId", "locationId", "productId") WHERE "variationId" IS NULL`)
    const ownerRole = randomUUID()
    await q(`INSERT INTO "Role" (id, key, name, "isSystem", "updatedAt") VALUES ($1,'OWNER','Owner',true,now())`, [ownerRole])
    for (const [key, id] of Object.entries(user)) await q(`INSERT INTO "UserProfile" (id, email, status, "updatedAt") VALUES ($1,$2,'active',now())`, [id, `${key}@example.test`])
    await q(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1,'Lender A','active','rush',$1,now()), ($2,'Borrower B','active','rush',$2,now())`, [A, B])
    for (const [workspaceId, userId] of [[A, user.ownerA], [B, user.ownerA], [B, user.ownerB]]) {
      const id = randomUUID()
      await q(`INSERT INTO "WorkspaceMembership" (id, "workspaceId", "userId", status, "updatedAt") VALUES ($1,$2,$3,'active',now())`, [id, workspaceId, userId])
      await q(`INSERT INTO "WorkspaceMemberRole" ("membershipId","roleId") VALUES ($1,$2)`, [id, ownerRole])
    }
    locationId = randomUUID()
    await q(`INSERT INTO "StockLocation" (id, "workspaceId", type, code, name, "updatedAt") VALUES ($1,$2,'WAREHOUSE','IT-MAIN','Main',now())`, [locationId, A])
    const assortmentId = randomUUID(), shareId = randomUUID(), grantId = randomUUID()
    await inContext(A, user.ownerA, [
      [`INSERT INTO "Assortment" (id, "workspaceId", name, selection, "updatedAt") VALUES ($1,$2,'Rush','list',now())`, [assortmentId, A]],
      [`INSERT INTO "AssortmentShare" (id, "assortmentId", "ownerWorkspaceId", "workspaceId", "fieldGroups", "createdByUserId", "updatedAt") VALUES ($1,$2,$3,$4,ARRAY['identity'],$5,now())`, [shareId, assortmentId, A, B, user.ownerA]],
      [`INSERT INTO "StockPoolGrant" (id, "ownerWorkspaceId", "workspaceId", "locationIds", "createdByUserId", "updatedAt") VALUES ($1,$2,$3,$4,$5,now())`, [grantId, A, B, [locationId], user.ownerA]],
    ])
    await inContext(B, user.ownerB, [
      [`SELECT nexus_assortment_share_respond($1,'accept',1)`, [shareId]],
      [`SELECT nexus_stock_pool_grant_respond($1,'accept',1)`, [grantId]],
    ])
    for (let p = 0; p < PRODUCTS; p++) {
      const source = randomUUID(), target = randomUUID(), catalogId = randomUUID(), levelId = randomUUID(), listingId = randomUUID()
      const sku = `RUSH-${p}`
      await q(`INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", "totalStock", "updatedAt") VALUES ($1,$2,$3,$3,10,$4,now())`, [source, A, sku, START])
      await q(`INSERT INTO "Product" (id, "workspaceId", sku, name, "basePrice", "updatedAt") VALUES ($1,$2,$3,$3,10,now())`, [target, B, sku])
      await q(`INSERT INTO "StockLevel" (id, "workspaceId", "locationId", "productId", quantity, reserved, available, "lastUpdatedAt") VALUES ($1,$2,$3,$4,$5,0,$5,now())`, [levelId, A, locationId, source, START])
      await q(`INSERT INTO "AssortmentMember" (id, "workspaceId", "assortmentId", "productId", mode) VALUES ($1,$2,$3,$4,'include')`, [randomUUID(), A, assortmentId, source])
      await inContext(B, user.ownerB, [
        [`INSERT INTO "CatalogLink" (id, "shareId", "sourceWorkspaceId", "sourceProductId", "targetWorkspaceId", "targetProductId", "linkedBy", "sourceVersion", "updatedAt") VALUES ($1,$2,$3,$4,$5,$6,'created',1,now())`, [catalogId, shareId, A, source, B, target]],
        [`INSERT INTO "StockPoolLink" (id, "workspaceId", "grantId", "catalogLinkId", "productId", "sourceProductId", "createdByUserId", "updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,now())`, [randomUUID(), B, grantId, catalogId, target, source, user.ownerB]],
      ])
      await q(`INSERT INTO "ChannelListing" (id, "workspaceId", "productId", channel, marketplace, region, "channelMarket", "listingStatus", "externalListingId", quantity, "updatedAt")
        VALUES ($1,$2,$3,'EBAY','IT','IT','EBAY_IT','ACTIVE',$4,$5,now())`, [listingId, B, target, `ext-${listingId.slice(0, 6)}`, START])
      products.push({ source, target, levelId, listingId })
    }
    movement = await import('../stock-movement.service.js')
    levels = await import('../stock-level.service.js')
    doors = await import('./pool-doors.js')
    tasks = await import('./pool-tasks.js')
  }, 300_000)

  afterAll(async () => { await side?.end(); await database?.close() }, 60_000)

  /** One rush: starts orders on a clock (or all at once), waits for every step, then checks the books. */
  const rush = async (label: string, plan: { rate: number; seconds: number } | { burst: number }) => {
    const timings = new Map<Step, number[]>()
    const failures = new Map<string, number>()
    const books = new Map<string, { quantity: number; reserved: number; bTaken: number; bPutBack: number }>(
      products.map((p) => [p.levelId, { quantity: 0, reserved: 0, bTaken: 0, bPutBack: 0 }]))
    const before = new Map<string, { quantity: number; reserved: number }>()
    for (const p of products) before.set(p.levelId, (await q<{ quantity: number; reserved: number }>(`SELECT quantity, reserved FROM "StockLevel" WHERE id = $1`, [p.levelId]))[0])
    const movementsBefore = new Map<string, number>()
    for (const p of products) movementsBefore.set(p.source, Number((await q<{ s: string }>(`SELECT COALESCE(SUM(change),0)::text AS s FROM "StockMovement" WHERE "productId" = $1`, [p.source]))[0].s))
    const bLedgerBefore = Number((await q<{ s: string }>(`SELECT COALESCE(SUM(change),0)::text AS s FROM "StockMovement" WHERE "consumerWorkspaceId" = $1`, [B]))[0].s)

    const step = async <T>(name: Step, product: (typeof products)[number], work: () => Promise<T>): Promise<T | null> => {
      const started = performance.now()
      try {
        const value = await work()
        const list = timings.get(name) ?? []
        list.push(performance.now() - started)
        timings.set(name, list)
        const book = books.get(product.levelId)!
        book.quantity += EFFECT[name][0]
        book.reserved += EFFECT[name][1]
        if (name === 'B.take' || name === 'B.ship') book.bTaken += 1
        if (name === 'B.putBack') book.bPutBack += 1
        return value
      } catch (error) {
        const key = `${name}: ${String(error instanceof Error ? error.message : error).replace(/[0-9a-f-]{36}/g, '<id>').slice(0, 120)}`
        failures.set(key, (failures.get(key) ?? 0) + 1)
        return null
      }
    }
    let serial = 0
    const order = async (random: number) => {
      const n = serial++
      const product = products[n % products.length]
      const ref = `${label}-${n}`
      if (random < 0.25) {
        if (await step('B.hold', product, () => as(B, () => door(doors.poolReserve(database.client as never, { productId: product.target, quantity: 1, orderRef: ref }))))) {
          await sleep(100 + Math.random() * 1400)
          if (Math.random() < 0.9) await step('B.ship', product, () => as(B, () => door(doors.poolConsume(database.client as never, { orderRef: ref }))))
          else await step('B.giveBack', product, () => as(B, () => door(doors.poolRelease(database.client as never, { orderRef: ref }))))
        }
      } else if (random < 0.45) {
        if (await step('B.take', product, () => as(B, () => door(doors.poolTake(database.client as never, { productId: product.target, quantity: 1, orderRef: ref })))) && Math.random() < 0.1) {
          await sleep(200 + Math.random() * 1300)
          const reason = Math.random() < 0.5 ? 'ORDER_CANCELLED' as const : 'RETURN_RESTOCKED' as const
          await step('B.putBack', product, () => as(B, () => door(doors.poolPutBack(database.client as never, { productId: product.target, quantity: 1, orderRef: ref, putBackRef: `${ref}-back`, reason }))))
        }
      } else if (random < 0.75) {
        await step('A.sale', product, () => as(A, () => movement.applyStockMovement({ productId: product.source, locationId, change: -1, reason: 'ORDER_PLACED', orderId: ref })))
      } else if (random < 0.95) {
        const hold = await step('A.hold', product, () => as(A, () => levels.reserveStock({ productId: product.source, locationId, quantity: 1, orderId: ref })))
        if (hold) {
          await sleep(100 + Math.random() * 1400)
          if (Math.random() < 0.9) await step('A.ship', product, () => as(A, () => levels.consumeReservation(hold.id)))
          else await step('A.release', product, () => as(A, () => levels.releaseReservation(hold.id)))
        }
      } else {
        await step('A.restock', product, () => as(A, () => movement.applyStockMovement({ productId: product.source, locationId, change: 3, reason: 'INBOUND_RECEIVED' })))
      }
    }

    // Sessions waiting on a lock, sampled every 100 ms on a connection of its own.
    let lockPeak = 0, lockSamples = 0, lockSum = 0, sampling = true
    const sampler = (async () => {
      while (sampling) {
        const n = Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`))[0].n)
        lockPeak = Math.max(lockPeak, n); lockSum += n; lockSamples++
        await sleep(100)
      }
    })()
    const stopWorker = tasks.startStockPoolWorker()
    const began = performance.now()
    const inFlight: Array<Promise<void>> = []
    if ('burst' in plan) {
      for (let i = 0; i < plan.burst; i++) inFlight.push(order(Math.random()))
    } else {
      const total = Math.round(plan.rate * plan.seconds)
      while (serial < total) {
        const due = Math.min(total, Math.floor(((performance.now() - began) / 1000) * plan.rate))
        while (serial < due) inFlight.push(order(Math.random()))
        await sleep(5)
      }
    }
    const startedFor = (performance.now() - began) / 1000
    await Promise.all(inFlight)
    const finishedAfter = (performance.now() - began) / 1000
    sampling = false
    await sampler

    // Drain the pool worker (what the poller does), then stop it.
    for (let i = 0; i < 20 && Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM "StockPoolTask"`))[0].n) > 0; i++) await tasks.kickStockPoolWork()
    stopWorker()

    const all = [...timings.values()].flat().sort((x, y) => x - y)
    const at = (list: number[], p: number) => (list.length ? list[Math.min(list.length - 1, Math.ceil(list.length * p) - 1)] : 0)
    const perStep = Object.fromEntries([...timings.entries()].sort().map(([name, list]) => {
      list.sort((x, y) => x - y)
      return [name, { n: list.length, p50: Math.round(at(list, 0.5)), p95: Math.round(at(list, 0.95)), p99: Math.round(at(list, 0.99)), max: Math.round(list.at(-1) ?? 0) }]
    }))
    const report: Record<string, unknown> = {
      label, products: PRODUCTS, connections: CONNECTIONS,
      load: 'burst' in plan ? `${plan.burst} orders at one instant` : `${plan.rate} orders/s for ${plan.seconds} s`,
      orders: serial, steps: all.length, startedFor: +startedFor.toFixed(1), finishedAfter: +finishedAfter.toFixed(1),
      stepsPerSecond: +(all.length / finishedAfter).toFixed(1),
      allSteps: { p50: Math.round(at(all, 0.5)), p95: Math.round(at(all, 0.95)), p99: Math.round(at(all, 0.99)), max: Math.round(all.at(-1) ?? 0) },
      lockWaiters: { peak: lockPeak, mean: +(lockSum / Math.max(1, lockSamples)).toFixed(2) },
      failures: Object.fromEntries(failures), perStep,
    }
    const check = async () => {
      const problems: string[] = []
      let bTaken = 0, bPutBack = 0
      for (const p of products) {
        const book = books.get(p.levelId)!
        const start = before.get(p.levelId)!
        const level = (await q<{ quantity: number; reserved: number; available: number }>(`SELECT quantity, reserved, available FROM "StockLevel" WHERE id = $1`, [p.levelId]))[0]
        const moved = Number((await q<{ s: string }>(`SELECT COALESCE(SUM(change),0)::text AS s FROM "StockMovement" WHERE "productId" = $1`, [p.source]))[0].s) - movementsBefore.get(p.source)!
        const held = Number((await q<{ s: string }>(`SELECT COALESCE(SUM(quantity),0)::text AS s FROM "StockReservation" WHERE "stockLevelId" = $1 AND "releasedAt" IS NULL AND "consumedAt" IS NULL AND kind = 'HARD'`, [p.levelId]))[0].s)
        const total = Number((await q<{ t: number }>(`SELECT "totalStock" AS t FROM "Product" WHERE id = $1`, [p.source]))[0].t)
        const listing = Number((await q<{ quantity: number }>(`SELECT quantity FROM "ChannelListing" WHERE id = $1`, [p.listingId]))[0].quantity)
        if (level.quantity !== start.quantity + book.quantity) problems.push(`${p.levelId}: quantity ${level.quantity}, the writers' books say ${start.quantity + book.quantity}`)
        if (level.reserved !== start.reserved + book.reserved) problems.push(`${p.levelId}: reserved ${level.reserved}, the writers' books say ${start.reserved + book.reserved}`)
        if (level.quantity !== start.quantity + moved) problems.push(`${p.levelId}: quantity ${level.quantity}, the movements say ${start.quantity + moved}`)
        if (level.reserved !== held) problems.push(`${p.levelId}: reserved ${level.reserved}, open holds ${held}`)
        if (total !== level.quantity) problems.push(`${p.source}: lender total ${total}, level ${level.quantity}`)
        if (listing !== level.available) problems.push(`${p.listingId}: B's listing ${listing}, the pool has ${level.available}`)
        bTaken += book.bTaken; bPutBack += book.bPutBack
      }
      const bLedger = Number((await q<{ s: string }>(`SELECT COALESCE(SUM(change),0)::text AS s FROM "StockMovement" WHERE "consumerWorkspaceId" = $1`, [B]))[0].s) - bLedgerBefore
      if (bLedger !== bPutBack - bTaken) problems.push(`the lender's ledger names B for ${bLedger}, B's own steps say ${bPutBack - bTaken}`)
      return problems
    }
    // The books are checked whatever happened: a step that failed must have changed nothing.
    report.problems = await check()
    const line = `[pool rush] ${JSON.stringify(report)}`
    console.log(line)
    if (process.env.POOL_RUSH_FILE) appendFileSync(process.env.POOL_RUSH_FILE, `${new Date().toISOString()} ${line}\n`)
    return { report, check }
  }

  it.skipIf(!(RATE > 0))(`a rush of ${RATE} orders/s for ${SECONDS} s on ${PRODUCTS} product(s): every order finishes, nothing is lost`, async () => {
    const { report, check } = await rush('rate', { rate: RATE, seconds: SECONDS })
    expect(report.problems, 'units lost or wrong').toEqual([])
    expect(report.failures, 'steps that failed (each changed nothing: see the line above)').toEqual({})
    // Control: one level changed behind the writers' backs — the same check must see it.
    await q(`UPDATE "StockLevel" SET quantity = quantity - 1, available = available - 1 WHERE id = $1`, [products[0].levelId])
    expect((await check()).length, 'the check cannot see a lost unit').toBeGreaterThan(0)
    await q(`UPDATE "StockLevel" SET quantity = quantity + 1, available = available + 1 WHERE id = $1`, [products[0].levelId])
    expect(await check()).toEqual([])
  }, 1_800_000)

  it.skipIf(!(BURST > 0))(`a burst of ${BURST} orders at one instant on ${PRODUCTS} product(s): every order finishes, nothing is lost`, async () => {
    const { report } = await rush('burst', { burst: BURST })
    expect(report.problems, 'units lost or wrong').toEqual([])
    expect(report.failures, 'steps that failed (each changed nothing: see the line above)').toEqual({})
  }, 1_800_000)
})
