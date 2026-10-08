/**
 * Step 4 Send to FBA (Part C) — the races, on a REAL multi-connection PostgreSQL, through the real route, hooks and services.
 *
 *   1. A double-click on "Send to Amazon" (three POSTs with one Idempotency-Key at the same moment) sends the draft ONCE,
 *      with ONE set of holds; every answer is that plan or "still running".
 *   2. Holds are released at the click on cancel — two cancels at once release each hold once (one wins, the other is
 *      refused); a cancel racing a sale of the free units: both land, nothing stays held.
 *   3. "Mark shipped" twice at once (a double-click, two tabs): one FBA_TRANSFER_OUT, the units leave once.
 *   4. "Mark shipped" racing a sale on the same SKU: the units, the holds and the sealed cases end right in either order
 *      (Σ sealed cases × units per case never exceed the units).
 *   5. Drafts (Owner 2026-10-08): two "Add to draft" at once for one From + To make ONE draft holding both SKUs; two
 *      "Send to Amazon" at once without a shared key (two tabs) send it once and hold once.
 *
 * Why a real server: on PGlite (one connection) every transaction queues, so none of these can race there.
 * Part B's job (dispatchFbaPlan) is a spy: nothing reaches Amazon.
 *
 * 🔴 Needs a MULTI-CONNECTION PostgreSQL; without one the suite SKIPS. From the repo root:
 * `node scripts/run-real-postgres-tests.mjs --suites '[{"name":"fba send","file":"src/services/fba-inbound/fba-send-postgres.vitest.test.ts","expect":5}]'`
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { nextWorkingDay, type FbaShipmentBox } from '@nexus/shared/fba-send'
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
const s = vi.hoisted(() => ({ account: '' }))
vi.mock('../../lib/amazon-sp-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/amazon-sp-client.js')>()),
  amazonAccount: vi.fn(async () => { if (!s.account) throw new Error('no Amazon account'); return { id: s.account } }),
}))
vi.mock('../stock-movement.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../stock-movement.service.js')>()),
  recascadeProduct: vi.fn(async () => ({ ok: true })),
}))
/** The contract with the real Part C services behind it (loaded at call time) and Part B's job as a spy. */
vi.mock('./contract.js', () => {
  const HTTP: Record<string, number> = { NOT_FOUND: 404, REFUSED: 400, WRONG_STATE: 409, OPTION_UNKNOWN: 400, OPTIONS_EXPIRED: 409, NEEDS_PERSON: 403, TRACKING_INVALID: 400, LABELS_UNAVAILABLE: 409, DRAFT_EXISTS: 409, NOT_BUILT: 501 }
  class FbaSendError extends Error {
    constructor(readonly code: string, message: string, readonly problems: unknown[] = []) { super(message); this.name = 'FbaSendError' }
    get httpStatus() { return HTTP[this.code] }
  }
  const from = (file: string, name: string) => async (...args: unknown[]) => ((await import(file)) as any)[name](...args)
  return {
    FbaSendError, dispatchFbaPlan: vi.fn(async () => 'inline'),
    readSendDraft: from('./send.service.js', 'readSendDraft'), createSendPlan: from('./send.service.js', 'createSendPlan'),
    confirmChoice: from('./send.service.js', 'confirmChoice'), cancelPlan: from('./send.service.js', 'cancelPlan'), retryPlan: from('./send.service.js', 'retryPlan'),
    markShipped: from('./ship.service.js', 'markShipped'), labelsFor: from('./ship.service.js', 'labelsFor'),
    readPlans: from('./read.service.js', 'readPlans'), readPlan: from('./read.service.js', 'readPlan'), readPlanList: from('./read.service.js', 'readPlanList'),
    addToDraft: from('./draft.service.js', 'addToDraft'), updateDraft: from('./draft.service.js', 'updateDraft'),
    deleteDraft: from('./draft.service.js', 'deleteDraft'), sendDraft: from('./draft.service.js', 'sendDraft'),
  }
})

import { dispatchFbaPlan } from './contract.js'

const WS = 'nexus_legacy_workspace'
const UPC = 12
const flagBefore = process.env.NEXUS_WORKSPACES_ENABLED
const business = { workspaceId: WS, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inBusiness = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const q = async <T = Record<string, any>>(sql: string, params: unknown[] = []) => (await database.pool.query(sql, params)).rows as T[]
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const settled = async <T>(work: Promise<T>) => work.then((value) => ({ ok: true as const, value }), (error: any) => ({ ok: false as const, error }))
const person = { actor: 'race@example.test', userId: 'u-race' }

describe.skipIf(!concurrentDatabaseUrl())(`Step 4 Send to FBA — races on a real PostgreSQL (needs ${CONCURRENT_PG_ENV})`, () => {
  let app: FastifyInstance
  let send: typeof import('./send.service.js')
  let draft: typeof import('./draft.service.js')
  let ship: typeof import('./ship.service.js')
  let movement: typeof import('../stock-movement.service.js')
  let locationId = ''
  let n = 0

  /** A SKU with `quantity` units at the warehouse, 12 per case, `sealed` sealed cases, owners set and an Amazon IT listing. */
  const seed = async (quantity = 51, sealed = 4) => {
    const productId = randomUUID(), sku = `FBA-RACE-${++n}-${productId.slice(0, 6)}`
    await q(`INSERT INTO "Product" (id,"workspaceId",sku,name,"basePrice","totalStock","weightValue","weightUnit","updatedAt") VALUES ($1,$2,$3,$3,10,$4,0.5,'kg',now())`, [productId, WS, sku, quantity])
    const levelId = randomUUID()
    await q(`INSERT INTO "StockLevel" (id,"workspaceId","locationId","productId",quantity,reserved,available,"lastUpdatedAt") VALUES ($1,$2,$3,$4,$5,0,$5,now())`, [levelId, WS, locationId, productId, quantity])
    await q(`INSERT INTO "ProductPackage" (id,"workspaceId","productId","fbaPrepOwner","fbaLabelOwner","updatedAt") VALUES ($1,$2,$3,'SELLER','SELLER',now())`, [randomUUID(), WS, productId])
    const sizeId = randomUUID()
    await q(`INSERT INTO "ProductCaseSize" (id,"workspaceId","productId","unitsPerCase","caseLengthCm","caseWidthCm","caseHeightCm","caseWeightKg","updatedAt") VALUES ($1,$2,$3,$4,40,30,30,7,now())`, [sizeId, WS, productId, UPC])
    if (sealed > 0) await q(`INSERT INTO "StockCaseCount" (id,"workspaceId","stockLevelId","caseSizeId",cases,"updatedAt") VALUES ($1,$2,$3,$4,$5,now())`, [randomUUID(), WS, levelId, sizeId, sealed])
    await inBusiness(() => database.client.channelListing.create({ data: {
      productId, channel: 'AMAZON', marketplace: 'IT', region: 'IT', channelMarket: 'AMAZON_IT', channelConnectionId: s.account, aliasKey: '',
      listingStatus: 'ACTIVE', isPublished: true, fulfillmentMethod: 'FBA' } as never }))
    return { productId, sku, levelId }
  }
  const addBody = (productId: string, cases = 2, looseUnits = 3) => ({ from: 'IT-MAIN', market: 'IT', lines: [{ productId, cases: [{ unitsPerCase: UPC, cases }], looseUnits }] })
  const createBody = (productId: string, cases = 2, looseUnits = 3) => ({ from: 'IT-MAIN', market: 'IT', readyToShipOn: nextWorkingDay(send.romeToday()), lines: [{ productId, cases: [{ unitsPerCase: UPC, cases }], looseUnits }] })
  /** The level's units and holds, its STORED sealed count, and the ledger agreeing with itself. */
  const state = async (p: { productId: string; levelId: string }, start = 51) => {
    const [row] = await q<{ quantity: number; reserved: number; available: number; cases: number | null }>(
      `SELECT l.quantity, l.reserved, l.available, c.cases FROM "StockLevel" l LEFT JOIN "StockCaseCount" c ON c."stockLevelId" = l.id WHERE l.id = $1`, [p.levelId])
    const [{ moved }] = await q<{ moved: string }>(`SELECT COALESCE(SUM(change),0)::text AS moved FROM "StockMovement" WHERE "productId"=$1`, [p.productId])
    expect(row.quantity).toBe(start + Number(moved))
    expect(row.available).toBe(row.quantity - row.reserved)
    expect((row.cases ?? 0) * UPC).toBeLessThanOrEqual(row.quantity)
    const [{ open }] = await q<{ open: string }>(`SELECT COALESCE(SUM(r.quantity),0)::text AS open FROM "StockReservation" r WHERE r."stockLevelId" = $1 AND r."releasedAt" IS NULL AND r."consumedAt" IS NULL AND r.kind = 'HARD'`, [p.levelId])
    expect(row.reserved).toBe(Number(open))
    return { quantity: row.quantity, reserved: row.reserved, cases: row.cases }
  }
  const S_BOXES: FbaShipmentBox[] = [
    { boxId: 'B1', kind: 'case', lengthCm: 40, widthCm: 30, heightCm: 30, weightKg: 7, items: [] },
    { boxId: 'B2', kind: 'case', lengthCm: 40, widthCm: 30, heightCm: 30, weightKg: 7, items: [] },
    { boxId: 'B3', kind: 'mixed', lengthCm: 60, widthCm: 40, heightCm: 40, weightKg: 2.7, items: [] },
  ]
  /** A plan of 2 sealed cases + 3 loose units (27 held), confirmed by the job into one shipment, ready to ship. */
  const shippable = async () => {
    const p = await seed()
    const { planId } = await inBusiness(() => send.createSendPlan(createBody(p.productId), person, 'matrix'))
    const shipmentRowId = randomUUID(), confirmation = `FBA15${p.productId.slice(0, 8).toUpperCase()}`
    const boxes = S_BOXES.map((box, i) => ({ ...box, boxId: `${confirmation}U00000${i + 1}`, items: [{ msku: p.sku, quantity: box.kind === 'case' ? UPC : 3 }] }))
    await q(`INSERT INTO "FBAShipment" (id,"workspaceId","shipmentId",status,"destinationFC","planRowId","sourceLocationId",boxes,"updatedAt") VALUES ($1,$2,$3,'WORKING','MXP5',$4,$5,$6::jsonb,now())`,
      [shipmentRowId, WS, confirmation, planId, locationId, JSON.stringify(boxes)])
    await q(`INSERT INTO "FBAShipmentItem" (id,"workspaceId","shipmentId","productId","quantitySent") VALUES ($1,$2,$3,$4,27)`, [randomUUID(), WS, shipmentRowId, p.productId])
    await q(`UPDATE "FbaInboundPlanV2" SET status='READY_TO_SHIP', "currentStep"='TRACKING', "planId"=$2 WHERE id=$1`, [planId, `wf-${planId}`])
    return { ...p, planId, shipmentRowId, tracking: { tracking: boxes.map((box) => ({ boxId: box.boxId, trackingId: `T-${box.boxId}` })) } }
  }
  const outMoves = async (productId: string) => Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM "StockMovement" WHERE "productId"=$1 AND reason='FBA_TRANSFER_OUT'`, [productId]))[0].n)
  const sell = (productId: string, units: number) => inBusiness(() => movement.applyStockMovement({ productId, locationId, change: -units, reason: 'ORDER_PLACED' }))

  beforeAll(async () => {
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    database = await concurrentDatabase({ maxConnections: 24 })
    // Deployed databases carry these; schema.prisma cannot express them.
    await q(`ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_available_invariant" CHECK ("available" = "quantity" - "reserved")`)
    await q(`ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_quantity_nonneg" CHECK ("quantity" >= 0)`)
    await q(`CREATE UNIQUE INDEX "StockLevel_loc_prod_novar_unique" ON "StockLevel" ("workspaceId","locationId","productId") WHERE "variationId" IS NULL`)
    const warehouseId = randomUUID()
    locationId = randomUUID()
    await q(`INSERT INTO "Warehouse" (id,"workspaceId",code,name,"addressLine1",city,"postalCode",country,"isDefault","updatedAt") VALUES ($1,$2,'IT-MAIN','Main','Via Test 1','Testville','00000','IT',true,now())`, [warehouseId, WS])
    await q(`INSERT INTO "StockLocation" (id,"workspaceId",type,code,name,"warehouseId","updatedAt") VALUES ($1,$2,'WAREHOUSE','IT-MAIN','Main',$3,now())`, [locationId, WS, warehouseId])
    await q(`INSERT INTO "BrandSettings" (id,"workspaceId","companyName","contactPhone","updatedAt") VALUES ($1,$2,'Test Company','+39 000 000',now())`, [randomUUID(), WS])
    s.account = randomUUID()
    await q(`INSERT INTO "ChannelConnection" (id,"workspaceId","channelType","isActive","externalAccountId","updatedAt") VALUES ($1,$2,'AMAZON',true,'TEST-SELLER',now())`, [s.account, WS])
    await q(`INSERT INTO "Marketplace" (id,"workspaceId",channel,code,name,"marketplaceId",region,currency,language,"updatedAt") VALUES ($1,$2,'AMAZON','IT','Amazon Italy','TEST-MKT-IT','EU','EUR','it',now())`, [randomUUID(), WS])
    vi.stubEnv('NEXUS_ISSUER_NAME', '')
    vi.stubEnv('NEXUS_ISSUER_PHONE', '')
    send = await import('./send.service.js')
    draft = await import('./draft.service.js')
    ship = await import('./ship.service.js')
    movement = await import('../stock-movement.service.js')
    const { registerCommandIdempotency } = await import('../../lib/command-idempotency.js')
    app = Fastify()
    app.addHook('onRequest', (request, _reply, done) => {
      request.authUser = { id: 'u-race', email: 'race@example.test' } as never
      withWorkspace(business, done)
    })
    registerCommandIdempotency(app)
    await app.register((await import('../../routes/fba-send.routes.js')).default, { prefix: '/api' })
    await app.ready()
  }, 180_000)

  afterAll(async () => {
    vi.unstubAllEnvs()
    await app?.close()
    if (flagBefore === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
    else process.env.NEXUS_WORKSPACES_ENABLED = flagBefore
    await database?.close()
  }, 60_000)

  beforeEach(() => vi.mocked(dispatchFbaPlan).mockClear())

  it('1. a double-click on "Send to Amazon" (three POSTs, one Idempotency-Key, at once): ONE plan, ONE set of holds', async () => {
    const p = await seed()
    const added = await app.inject({ method: 'POST', url: '/api/fba/inbound/drafts', payload: addBody(p.productId) })
    expect(added.statusCode).toBe(200)
    const draftId = added.json().planId as string
    const post = () => app.inject({ method: 'POST', url: `/api/fba/inbound/plans/${draftId}/send`, payload: {}, headers: { 'idempotency-key': `send-${p.productId}` } })
    const answers = await Promise.all([post(), post(), post()])
    const statuses = answers.map((a) => a.statusCode)
    expect(statuses.every((code) => code === 202 || code === 409)).toBe(true)
    const created = answers.filter((a) => a.statusCode === 202).map((a) => a.json().planId)
    expect(created.length).toBeGreaterThanOrEqual(1)
    expect(new Set(created).size).toBe(1)
    const plans = await q<{ id: string }>(`SELECT p.id FROM "FbaInboundPlanV2" p JOIN "FbaInboundPlanLine" l ON l."planRowId" = p.id WHERE l."productId" = $1`, [p.productId])
    expect(plans.map((row) => row.id)).toEqual([created[0]])
    expect(created[0]).toBe(draftId)
    expect((await q<{ status: string }>(`SELECT status FROM "FbaInboundPlanV2" WHERE id = $1`, [draftId]))[0].status).toBe('QUEUED')
    expect(await state(p)).toEqual({ quantity: 51, reserved: 27, cases: 4 })
    expect(dispatchFbaPlan).toHaveBeenCalledTimes(1)
    // The same click again after it answered replays the plan, never a second one.
    const replay = await post()
    expect([replay.statusCode, replay.json().planId]).toEqual([202, created[0]])
    expect((await q(`SELECT 1 FROM "FbaInboundPlanLine" WHERE "productId" = $1`, [p.productId])).length).toBe(1)
  }, 60_000)

  it('2. cancel releases the holds at the click: two cancels at once release each hold once; a cancel racing a sale — both land, nothing stays held', async () => {
    const p = await seed()
    const { planId } = await inBusiness(() => send.createSendPlan(createBody(p.productId), person, 'matrix'))
    expect(await state(p)).toMatchObject({ reserved: 27 })
    const [x, y] = await Promise.all([settled(inBusiness(() => send.cancelPlan(planId, person))), settled(inBusiness(() => send.cancelPlan(planId, person)))])
    const wins = [x, y].filter((r) => r.ok)
    expect(wins).toHaveLength(1)
    expect((wins[0] as { value: { status: string } }).value.status).toBe('CANCELLED')
    expect(([x, y].find((r) => !r.ok) as { error: { code: string } }).error.code).toBe('WRONG_STATE')
    expect(await state(p)).toEqual({ quantity: 51, reserved: 0, cases: 4 })
    const released = await q<{ n: string }>(`SELECT count(*)::text AS n FROM "StockMovement" WHERE "productId"=$1 AND reason='RESERVATION_RELEASED'`, [p.productId])
    expect(Number(released[0].n)).toBe(1)

    // A plan Amazon has (CANCELLING) cancelled while a sale takes free units: both land.
    const r = await seed()
    const second = await inBusiness(() => send.createSendPlan(createBody(r.productId), person, 'matrix'))
    await q(`UPDATE "FbaInboundPlanV2" SET status='WAITING_FOR_CHOICE', "currentStep"='CONFIRM', "planId"=$2 WHERE id=$1`, [second.planId, `wf-${second.planId}`])
    const [cancelled, sold] = await Promise.all([settled(inBusiness(() => send.cancelPlan(second.planId, person))), settled(sell(r.productId, 20))])
    expect(cancelled.ok && (cancelled.value as { status: string }).status).toBe('CANCELLING')
    expect(sold.ok).toBe(true)
    expect(await state(r)).toMatchObject({ quantity: 31, reserved: 0 })
  }, 60_000)

  it('3. "Mark shipped" twice at once: one FBA_TRANSFER_OUT, the units and sealed cases leave once', async () => {
    const p = await shippable()
    const results = await Promise.all(Array.from({ length: 3 }, () => settled(inBusiness(() => ship.markShipped(p.shipmentRowId, p.tracking, person)))))
    expect(results.map((r) => (r.ok ? 'ok' : String(r.error?.message)))).toEqual(['ok', 'ok', 'ok'])
    expect(results.every((r) => r.ok && (r.value as { status: string }).status === 'SHIPPED')).toBe(true)
    expect(await outMoves(p.productId)).toBe(1)
    expect(await state(p)).toEqual({ quantity: 24, reserved: 0, cases: 2 })
    expect(Number((await q<{ s: string }>(`SELECT "shippedQuantity"::text AS s FROM "FbaInboundPlanLine" WHERE "planRowId"=$1`, [p.planId]))[0].s)).toBe(27)
  }, 60_000)

  it('4. "Mark shipped" racing a sale on the same SKU: units, holds and sealed cases end right in either order', async () => {
    // FORCED, sale first: the sale holds the product lock while Shipped starts; Shipped waits, then moves its 27 (2 cases).
    const a = await shippable()
    let pending: Promise<Awaited<ReturnType<typeof settled>>> | null = null
    await inBusiness(() => database.client.$transaction(async (tx) => {
      await movement.applyStockMovementInTx(tx, { productId: a.productId, locationId, change: -10, reason: 'ORDER_PLACED' })
      pending = settled(inBusiness(() => ship.markShipped(a.shipmentRowId, a.tracking, person)))
      await sleep(400)
    }, { timeout: 20_000 }))
    expect((await pending!).ok).toBe(true)
    expect(await state(a)).toEqual({ quantity: 14, reserved: 0, cases: 1 }) // 41 = 3 sealed + 5 → 2 leave sealed → 14 = 1 + 2

    // Plain pairs on more SKUs: whatever the order, 14 units, nothing held, 1 sealed case.
    const many = await Promise.all(Array.from({ length: 6 }, () => shippable()))
    await Promise.all(many.map(async (m) => {
      const [shipped, sold] = await Promise.all([settled(inBusiness(() => ship.markShipped(m.shipmentRowId, m.tracking, person))), settled(sell(m.productId, 10))])
      expect(shipped.ok).toBe(true)
      expect(sold.ok).toBe(true)
      expect(await outMoves(m.productId)).toBe(1)
      expect(await state(m)).toEqual({ quantity: 14, reserved: 0, cases: 1 })
    }))
  }, 120_000)

  it('5. two "Add to draft" at once make ONE draft with both SKUs; two "Send to Amazon" at once (no shared key) send it once, hold once', async () => {
    const a = await seed()
    const b = await seed()
    const adds = await Promise.all([
      settled(inBusiness(() => draft.addToDraft(addBody(a.productId), person, 'matrix'))),
      settled(inBusiness(() => draft.addToDraft(addBody(b.productId, 1, 0), person, 'claude'))),
    ])
    expect(adds.map((r) => (r.ok ? 'ok' : String(r.error?.message)))).toEqual(['ok', 'ok'])
    const planIds = new Set(adds.map((r) => (r as { value: { planId: string } }).value.planId))
    expect(planIds.size).toBe(1)
    const [planId] = [...planIds]
    const open = await q<{ n: string }>(`SELECT count(*)::text AS n FROM "FbaInboundPlanV2" WHERE status = 'DRAFT' AND source IS NOT NULL AND "sourceLocationId" = $1`, [locationId])
    expect(Number(open[0].n)).toBe(1)
    expect((await q(`SELECT 1 FROM "FbaInboundPlanLine" WHERE "planRowId" = $1`, [planId])).length).toBe(2)
    expect(await state(a)).toMatchObject({ reserved: 0 })

    const sends = await Promise.all([settled(inBusiness(() => draft.sendDraft(planId, {}, person))), settled(inBusiness(() => draft.sendDraft(planId, {}, person)))])
    expect(sends.map((r) => (r.ok ? (r.value as { planId: string }).planId : String(r.error?.message)))).toEqual([planId, planId])
    expect(await state(a)).toEqual({ quantity: 51, reserved: 27, cases: 4 })
    expect(await state(b)).toEqual({ quantity: 51, reserved: 12, cases: 4 })
    const holds = await q<{ n: string }>(`SELECT count(*)::text AS n FROM "StockReservation" WHERE "stockLevelId" = $1 AND "releasedAt" IS NULL`, [a.levelId])
    expect(Number(holds[0].n)).toBe(1)
    expect(dispatchFbaPlan).toHaveBeenCalledTimes(1)
  }, 60_000)
})
