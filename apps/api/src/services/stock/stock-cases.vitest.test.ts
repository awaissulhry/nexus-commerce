/**
 * Step 3 cases (Owner D2 = B) — the case keeper on every stock path, on a disposable PostgreSQL (PGlite) with the
 * generated production schema and policies, business profiles ON.
 *
 *   Owner decisions: sealed cases and loose units per location; a sale or hold takes loose units first, then opens a
 *   case; units that arrive (receive, return, transfer in, purchase order) arrive LOOSE; FBA and Shopify locations
 *   never hold case counts; lent (pool) stock follows the same clamp at the lender's level; a case-size change with
 *   sealed cases in stock is refused with the cases that would open, and a confirmed second call opens them (units
 *   unchanged, nothing pushed).
 *
 * Every path runs through the REAL services (applyStockMovement, transferStock, applyImport, settlePoolMovement,
 * setCasesInTx, setCasePacks); only queues and the display cache are faked. Races are in
 * stock-cases-postgres.vitest.test.ts (a real multi-connection server).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
vi.mock('../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []) }
  return { addJobSafely: vi.fn(async () => undefined), outboundSyncQueue: queue, readCacheQueue: queue,
    searchIndexQueue: queue, channelSyncQueue: queue, bulkJobQueue: queue, redis: { connection: null } }
})
vi.mock('../product-read-cache.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../product-read-cache.service.js')>()),
  productReadCacheService: { refresh: vi.fn(async () => undefined), refreshMany: vi.fn(async () => undefined), refreshInTransaction: vi.fn(async () => undefined) },
}))
vi.mock('../advertising/ads-cache.js', () => ({ cached: async (_k: string, _t: number, work: () => Promise<unknown>) => work(),
  peekCached: async () => undefined, putCached: () => undefined, flushAdsCache: async () => undefined }))

const A = 'ws_cases_a'
const B = 'ws_cases_b'
const flagBefore = process.env.NEXUS_WORKSPACES_ENABLED
const inA = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: A, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const inB = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: B, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const sql = async <T = Record<string, any>>(text: string, params: unknown[] = []) => (await database.db.query(text, params)).rows as T[]

describe('Step 3 cases — the case keeper on every stock path', () => {
  let movement: typeof import('../stock-movement.service.js')
  let levels: typeof import('../stock-level.service.js')
  let cases: typeof import('./stock-cases.service.js')
  let stockImport: typeof import('../stock-import.service.js')
  let pool: typeof import('../stock-pool/pool-tasks.js')
  const loc = { main: '', second: '', fba: '', bMain: '' }

  /** A product of business A with `quantity` units at IT-MAIN; `upc` units per case and `sealed` cases when given. */
  const seed = async (quantity: number, pack: { upc?: number; sealed?: number } = {}) => {
    const productId = randomUUID(), sku = `CASE-${productId.slice(0, 8)}`
    await sql(`INSERT INTO "Product" (id,"workspaceId",sku,name,"basePrice","totalStock","updatedAt") VALUES ($1,$2,$3,$3,10,$4,now())`, [productId, A, sku, quantity])
    const levelId = randomUUID()
    await sql(`INSERT INTO "StockLevel" (id,"workspaceId","locationId","productId",quantity,reserved,available,"lastUpdatedAt") VALUES ($1,$2,$3,$4,$5,0,$5,now())`,
      [levelId, A, loc.main, productId, quantity])
    if (pack.upc !== undefined) {
      await sql(`INSERT INTO "ProductPackage" (id,"workspaceId","productId","unitsPerCase","updatedAt") VALUES ($1,$2,$3,$4,now())`, [randomUUID(), A, productId, pack.upc])
    }
    if (pack.sealed !== undefined) {
      await sql(`INSERT INTO "StockCaseCount" (id,"workspaceId","stockLevelId",cases,"updatedAt") VALUES ($1,$2,$3,$4,now())`, [randomUUID(), A, levelId, pack.sealed])
    }
    return { productId, sku, levelId }
  }
  const stored = async (levelId: string) => (await sql<{ cases: number }>(`SELECT cases FROM "StockCaseCount" WHERE "stockLevelId"=$1`, [levelId]))[0]?.cases ?? null
  const units = async (levelId: string) => (await sql<{ quantity: number }>(`SELECT quantity FROM "StockLevel" WHERE id=$1`, [levelId]))[0]?.quantity
  const levelAt = async (productId: string, locationId: string) =>
    (await sql<{ id: string; quantity: number }>(`SELECT id, quantity FROM "StockLevel" WHERE "productId"=$1 AND "locationId"=$2`, [productId, locationId]))[0]
  const move = (productId: string, change: number, extra: Partial<import('../stock-movement.service.js').StockMovementInput> = {}) =>
    inA(() => movement.applyStockMovement({ productId, locationId: loc.main, change, reason: 'ORDER_PLACED', ...extra }))
  /** What a reader shows now (the stored count clamped by the units). */
  const sealedNow = async (productId: string, levelId: string) => {
    const quantity = await units(levelId)
    return (await inA(() => cases.sealedByLevel(database.client, [{ id: levelId, productId, quantity }]))).get(levelId)
  }
  const setCount = (productId: string, locationId: string, count: number) =>
    inA(() => database.client.$transaction((tx) => cases.setCasesInTx(tx, { productId, locationId, cases: count, reason: 'INVENTORY_COUNT', notes: 'TEST count', actor: 'test' })))
  const PACK = { unitsPerCase: 12, caseLengthCm: 60, caseWidthCm: 40, caseHeightCm: 35, caseWeightKg: 14.5, fbaPrepOwner: 'SELLER' as const, fbaLabelOwner: 'SELLER' as const }

  beforeAll(async () => {
    database = await formulaDatabase()
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    // Deployed databases carry these; schema.prisma cannot express them.
    await sql(`ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_available_invariant" CHECK ("available" = "quantity" - "reserved")`)
    await sql(`ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_quantity_nonneg" CHECK ("quantity" >= 0)`)
    for (const [ws, name] of [[A, 'Business A'], [B, 'Business B']]) {
      await sql(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1,$2,'active','cases',$1,CURRENT_TIMESTAMP)`, [ws, name])
    }
    const location = async (workspaceId: string, type: string, code: string) => {
      const id = randomUUID()
      await sql(`INSERT INTO "StockLocation" (id,"workspaceId",type,code,name,"updatedAt") VALUES ($1,$2,$3,$4,$4,now())`, [id, workspaceId, type, code])
      return id
    }
    loc.main = await location(A, 'WAREHOUSE', 'IT-MAIN')
    loc.second = await location(A, 'WAREHOUSE', 'MI-3PL')
    loc.fba = await location(A, 'AMAZON_FBA', 'AMAZON-EU-FBA')
    loc.bMain = await location(B, 'WAREHOUSE', 'B-MAIN')
    movement = await import('../stock-movement.service.js')
    levels = await import('../stock-level.service.js')
    cases = await import('./stock-cases.service.js')
    stockImport = await import('../stock-import.service.js')
    pool = await import('../stock-pool/pool-tasks.js')
  }, 180_000)

  afterAll(async () => {
    if (flagBefore === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
    else process.env.NEXUS_WORKSPACES_ENABLED = flagBefore
    await database?.close()
  })

  beforeEach(() => vi.clearAllMocks())

  it('a sale takes loose units first, then opens a case (4 cases + 3 loose at 12 / case)', async () => {
    const p = await seed(51, { upc: 12, sealed: 4 })
    await move(p.productId, -3)
    expect([await units(p.levelId), await stored(p.levelId)]).toEqual([48, 4]) // the 3 loose units went; 4 + 0
    await move(p.productId, -1)
    expect([await units(p.levelId), await stored(p.levelId)]).toEqual([47, 3]) // one case opened: 3 + 11
    await move(p.productId, -23)
    expect([await units(p.levelId), await stored(p.levelId)]).toEqual([24, 2])
    // A hold moves no units: the sealed count stays (holds count against loose units first — caseSplit).
    await inA(() => levels.reserveStock({ productId: p.productId, locationId: loc.main, quantity: 5, reason: 'MANUAL_HOLD', actor: 'test' }))
    expect(await stored(p.levelId)).toBe(2)
  })

  it('units that arrive stay loose: a receive and a transfer in change no sealed count; the transfer source opens what it must', async () => {
    const p = await seed(51, { upc: 12, sealed: 4 })
    await move(p.productId, 12, { reason: 'INBOUND_RECEIVED' })
    expect([await units(p.levelId), await stored(p.levelId)]).toEqual([63, 4]) // 4 + 15
    await move(p.productId, 2, { reason: 'RETURN_RESTOCKED' })
    expect([await units(p.levelId), await stored(p.levelId)]).toEqual([65, 4]) // 4 + 17
    await inA(() => levels.transferStock({ productId: p.productId, fromLocationId: loc.main, toLocationId: loc.second, quantity: 30, actor: 'test' }))
    expect([await units(p.levelId), await stored(p.levelId)]).toEqual([35, 2]) // source: 17 loose, then 1 case opened → 2 + 11
    const arrived = await levelAt(p.productId, loc.second)
    expect([arrived.quantity, await stored(arrived.id)]).toEqual([30, null]) // destination: 30 loose, no case row
  })

  it('whole cases moved say so (casesChange): the clamp alone would keep them; more than sealed, no case size or FBA is refused and nothing moves', async () => {
    const p = await seed(78, { upc: 12, sealed: 4 }) // 4 + 30
    await move(p.productId, -24, { reason: 'WRITE_OFF', casesChange: -2 })
    expect([await units(p.levelId), await stored(p.levelId)]).toEqual([54, 2]) // 2 + 30 (the clamp would have kept 4)
    await expect(move(p.productId, -36, { reason: 'WRITE_OFF', casesChange: -3 })).rejects.toMatchObject({ name: 'CaseCountError', code: 'INVALID_CASES' })
    expect([await units(p.levelId), await stored(p.levelId)]).toEqual([54, 2]) // rolled back with the movement
    await expect(move(p.productId, -12, { reason: 'WRITE_OFF', casesChange: 0.5 })).rejects.toMatchObject({ code: 'INVALID_CASES' })
    // Cases arriving sealed at a level that does not exist yet: the row is created with the level.
    await inA(() => movement.applyStockMovement({ productId: p.productId, locationId: loc.second, change: 24, reason: 'INBOUND_RECEIVED', casesChange: 2 }))
    const second = await levelAt(p.productId, loc.second)
    expect([second.quantity, await stored(second.id)]).toEqual([24, 2])
    await expect(inA(() => movement.applyStockMovement({ productId: p.productId, locationId: loc.second, change: 12, reason: 'INBOUND_RECEIVED', casesChange: 2 })))
      .rejects.toMatchObject({ code: 'CASES_EXCEED_UNITS' }) // 4 cases need 48 units; 36 on hand
    await expect(inA(() => movement.applyStockMovement({ productId: p.productId, locationId: loc.fba, change: 12, reason: 'SYNC_RECONCILIATION', casesChange: 1 })))
      .rejects.toMatchObject({ code: 'NOT_A_WAREHOUSE' })
    expect(await levelAt(p.productId, loc.fba)).toBeUndefined() // nothing written at FBA
    const loose = await seed(10)
    await expect(move(loose.productId, -5, { reason: 'WRITE_OFF', casesChange: -1 })).rejects.toMatchObject({ code: 'NO_CASE_SIZE' })
    expect(await units(loose.levelId)).toBe(10)
    // Without a case size or a case row a sale changes no count and writes no row.
    await move(loose.productId, -5)
    expect([await units(loose.levelId), await stored(loose.levelId)]).toEqual([5, null])
  })

  it('a bulk import that lowers units opens cases (the clamp); one that raises them changes nothing', async () => {
    const p = await seed(51, { upc: 12, sealed: 4 })
    const row = (quantity: number, current: number) => [{
      rowIndex: 0, raw: `${p.sku},${quantity}`, sku: p.sku, quantity, productId: p.productId, resolvedSku: p.sku,
      matchType: 'EXACT', confidence: 1, candidates: [], channel: null, marketplace: null, notes: null,
      currentWarehouseQty: current, wouldBeWarehouseQty: quantity, currentChannelQty: null, wouldBeChannelQty: null,
      channelListings: [], warnings: [], error: null,
    }] as unknown as import('../stock-import.service.js').PreviewRow[]
    const down = await inA(() => stockImport.applyImport({ rows: row(30, 51), locationCode: 'IT-MAIN', mode: 'SET', target: 'WAREHOUSE' }))
    expect(down.failed).toBe(0)
    expect([await units(p.levelId), await stored(p.levelId)]).toEqual([30, 2]) // 2 + 6
    const up = await inA(() => stockImport.applyImport({ rows: row(100, 30), locationCode: 'IT-MAIN', mode: 'SET', target: 'WAREHOUSE' }))
    expect(up.failed).toBe(0)
    expect([await units(p.levelId), await stored(p.levelId)]).toEqual([100, 2]) // arrived loose: 2 + 76
  })

  it('a shared-stock door sale is clamped at settle, at the lender\'s level and at the movement\'s own balance (a put-back cannot re-seal)', async () => {
    const p = await seed(51, { upc: 12, sealed: 4 })
    // What nexus_pool_take writes in the lender's ledger for a borrower's sale of 10, then a put-back of 10, before the settle.
    const movementId = randomUUID()
    await sql(`UPDATE "StockLevel" SET quantity = quantity - 10, available = available - 10 WHERE id=$1`, [p.levelId])
    await sql(`INSERT INTO "StockMovement" (id,"workspaceId","productId","locationId",change,"balanceAfter","quantityBefore",reason,"referenceType","createdAt")
               VALUES ($1,$2,$3,$4,-10,41,51,'ORDER_PLACED','Order',now())`, [movementId, A, p.productId, loc.main])
    expect(await sealedNow(p.productId, p.levelId)).toBe(3) // readers clamp before the settle: 41 = 3 + 5
    await sql(`UPDATE "StockLevel" SET quantity = quantity + 10, available = available + 10 WHERE id=$1`, [p.levelId])
    expect(await stored(p.levelId)).toBe(4) // not settled yet
    await inA(() => pool.settlePoolMovement(movementId))
    expect([await units(p.levelId), await stored(p.levelId)]).toEqual([51, 3]) // 3 + 15: the opened case stays open
    expect(await sealedNow(p.productId, p.levelId)).toBe(3)
    // Idempotent: a settled movement is left alone.
    await inA(() => pool.settlePoolMovement(movementId))
    expect(await stored(p.levelId)).toBe(3)
  })

  it('setCasesInTx: an absolute count writes the row, a 0-unit movement and inventory.cases_changed; equal is a noop', async () => {
    const p = await seed(51, { upc: 12 })
    expect(await setCount(p.productId, loc.main, 3)).toEqual({ noop: false, before: 0, after: 3 })
    expect(await stored(p.levelId)).toBe(3)
    expect(await units(p.levelId)).toBe(51) // units unchanged
    const moves = await sql(`SELECT change, "balanceAfter", "quantityBefore", reason::text AS reason, "referenceType", notes, actor FROM "StockMovement" WHERE "productId"=$1`, [p.productId])
    expect(moves).toEqual([{ change: 0, balanceAfter: 51, quantityBefore: 51, reason: 'INVENTORY_COUNT', referenceType: 'CaseCount', notes: 'Sealed cases 0 → 3 · 12 / case · TEST count', actor: 'test' }])
    const events = await sql(`SELECT payload, "workspaceId" FROM "EventOutbox" WHERE type='inventory.cases_changed' AND subject=$1`, [p.productId])
    expect(events).toEqual([{ workspaceId: A, payload: { productId: p.productId, locationId: loc.main, casesBefore: 0, casesAfter: 3, unitsPerCase: 12, reason: 'count' } }])
    expect(await setCount(p.productId, loc.main, 3)).toEqual({ noop: true, before: 3, after: 3 })
    expect(await setCount(p.productId, loc.main, 0)).toEqual({ noop: false, before: 3, after: 0 })
    expect(await sql(`SELECT 1 FROM "StockMovement" WHERE "productId"=$1`, [p.productId])).toHaveLength(2)
    expect(await sql(`SELECT 1 FROM "OutboundSyncQueue" WHERE "productId"=$1`, [p.productId])).toHaveLength(0) // nothing pushed
  })

  it('setCasesInTx refuses: FBA and Shopify locations, no case size, more cases than units, not a whole number — and writes nothing', async () => {
    const p = await seed(30, { upc: 12 })
    await expect(setCount(p.productId, loc.fba, 1)).rejects.toMatchObject({ name: 'CaseCountError', code: 'NOT_A_WAREHOUSE', message: 'Cases are counted at your own warehouses only' })
    await expect(setCount(p.productId, loc.main, 3)).rejects.toMatchObject({ code: 'CASES_EXCEED_UNITS', message: '3 cases need 36 units; on hand is 30' })
    await expect(setCount(p.productId, loc.main, -1)).rejects.toMatchObject({ code: 'INVALID_CASES' })
    await expect(setCount(p.productId, loc.main, 1.5)).rejects.toMatchObject({ code: 'INVALID_CASES' })
    await expect(setCount(p.productId, loc.second, 1)).rejects.toMatchObject({ code: 'CASES_EXCEED_UNITS' }) // no level there: 0 units
    const loose = await seed(30)
    await expect(setCount(loose.productId, loc.main, 1)).rejects.toMatchObject({ code: 'NO_CASE_SIZE' })
    expect(await setCount(loose.productId, loc.main, 0)).toEqual({ noop: true, before: 0, after: 0 }) // 0 is always allowed
    expect(await sql(`SELECT 1 FROM "StockCaseCount" WHERE "stockLevelId" = ANY($1::text[])`, [[p.levelId, loose.levelId]])).toHaveLength(0)
    expect(await sql(`SELECT 1 FROM "StockMovement" WHERE "productId" = ANY($1::text[])`, [[p.productId, loose.productId]])).toHaveLength(0)
  })

  it('setCasePacks: a size change with sealed cases is refused with the cases that would open; the confirmed call opens them (units unchanged, nothing pushed)', async () => {
    const p = await seed(51, { upc: 12, sealed: 4 })
    const q = await seed(20, { upc: 10, sealed: 2 })
    const save = (openSealedCases?: boolean) => inA(() => cases.setCasePacks({ productIds: [p.productId, q.productId], values: { ...PACK, unitsPerCase: 6 }, openSealedCases, actor: 'test', userId: null }))
    const refused = await save().then(() => null, (error) => error)
    expect(refused).toMatchObject({ name: 'CaseCountError', code: 'SEALED_CASES', message: '6 sealed cases at IT-MAIN become loose units. Count them again under Stock.' })
    expect(refused.detail).toEqual([
      { productId: p.productId, sku: p.sku, locationCode: 'IT-MAIN', cases: 4 },
      { productId: q.productId, sku: q.sku, locationCode: 'IT-MAIN', cases: 2 },
    ])
    expect([await stored(p.levelId), await stored(q.levelId)]).toEqual([4, 2]) // nothing written
    expect((await sql(`SELECT "unitsPerCase" FROM "ProductPackage" WHERE "productId"=$1`, [p.productId]))[0].unitsPerCase).toBe(12)

    const results = await save(true)
    expect(results).toEqual([
      { productId: p.productId, ok: true, opened: [{ locationCode: 'IT-MAIN', cases: 4 }] },
      { productId: q.productId, ok: true, opened: [{ locationCode: 'IT-MAIN', cases: 2 }] },
    ])
    expect([await stored(p.levelId), await stored(q.levelId)]).toEqual([null, null]) // opened: every unit is loose
    expect([await units(p.levelId), await units(q.levelId)]).toEqual([51, 20])
    const row = (await sql(`SELECT "unitsPerCase", "caseLengthCm"::text AS l, "caseWeightKg"::text AS kg, "fbaPrepOwner", "fbaLabelOwner", "updatedBy" FROM "ProductPackage" WHERE "productId"=$1`, [p.productId]))[0]
    expect(row).toEqual({ unitsPerCase: 6, l: '60.0', kg: '14.50', fbaPrepOwner: 'SELLER', fbaLabelOwner: 'SELLER', updatedBy: 'test' })
    expect(await sql(`SELECT 1 FROM "StockMovement" WHERE "productId" = ANY($1::text[])`, [[p.productId, q.productId]])).toHaveLength(0)
    expect(await sql(`SELECT 1 FROM "OutboundSyncQueue" WHERE "productId" = ANY($1::text[])`, [[p.productId, q.productId]])).toHaveLength(0)
    const events = await sql(`SELECT payload FROM "EventOutbox" WHERE type='inventory.cases_changed' AND subject=$1`, [p.productId])
    expect(events.map((e) => e.payload)).toEqual([{ productId: p.productId, locationId: null, casesBefore: null, casesAfter: null, unitsPerCase: 6, reason: 'case-pack' }])
    const audit = await sql(`SELECT "entityType", action, before, after, metadata FROM "AuditLog" WHERE "entityId"=$1`, [p.productId])
    expect(audit).toEqual([{ entityType: 'ProductPackage', action: 'update',
      before: { unitsPerCase: 12, caseLengthCm: null, caseWidthCm: null, caseHeightCm: null, caseWeightKg: null, fbaPrepOwner: null, fbaLabelOwner: null },
      after: { ...PACK, unitsPerCase: 6 }, metadata: { actor: 'test', openedSealedCases: [{ locationCode: 'IT-MAIN', cases: 4 }] } }])
    // Count again under the new size: 51 units hold 8 cases of 6.
    expect(await setCount(p.productId, loc.main, 8)).toEqual({ noop: false, before: 0, after: 8 })
  })

  it('setCasePacks: other fields save without touching cases; the same values are a noop; clearing removes the row; bad values and unknown products are answered', async () => {
    const p = await seed(51, { upc: 12, sealed: 4 })
    const save = (values: typeof PACK | Record<string, unknown>, productIds = [p.productId]) =>
      inA(() => cases.setCasePacks({ productIds, values: values as typeof PACK, actor: 'test' }))
    expect(await save({ ...PACK, caseLengthCm: 60.04 })).toEqual([{ productId: p.productId, ok: true }]) // same size: no case opens
    expect(await stored(p.levelId)).toBe(4)
    expect(await save({ ...PACK, caseLengthCm: 60.01 })).toEqual([{ productId: p.productId, ok: true, noop: true }]) // 60.0 as stored
    expect(await save({ ...PACK, unitsPerCase: 0 })).toEqual([{ productId: p.productId, ok: false, error: 'Units per case must be a whole number from 1 to 10000' }])
    expect(await save({ ...PACK, fbaPrepOwner: 'NONE' })).toEqual([{ productId: p.productId, ok: false, error: 'Prep by must be Amazon or Seller' }])
    const missing = randomUUID()
    expect(await save({ ...PACK, caseWeightKg: 15 }, [p.productId, missing])).toEqual([{ productId: p.productId, ok: true }, { productId: missing, ok: false, error: 'Product not found' }])
    const empty = { unitsPerCase: null, caseLengthCm: null, caseWidthCm: null, caseHeightCm: null, caseWeightKg: null, fbaPrepOwner: null, fbaLabelOwner: null }
    await expect(save(empty)).rejects.toMatchObject({ code: 'SEALED_CASES' }) // clearing the size would open 4 cases
    expect(await inA(() => cases.setCasePacks({ productIds: [p.productId], values: empty, openSealedCases: true, actor: 'test' })))
      .toEqual([{ productId: p.productId, ok: true, opened: [{ locationCode: 'IT-MAIN', cases: 4 }] }])
    expect(await sql(`SELECT 1 FROM "ProductPackage" WHERE "productId"=$1`, [p.productId])).toHaveLength(0)
    expect(await save(empty)).toEqual([{ productId: p.productId, ok: true, noop: true }])
    await expect(inA(() => cases.setCasePacks({ productIds: Array.from({ length: 201 }, () => randomUUID()), values: PACK, actor: 'test' }))).rejects.toThrow(/at most 200/)
  })

  it('another business can neither read the rows nor count or size this business\'s products', async () => {
    const p = await seed(51, { upc: 12, sealed: 4 })
    expect(await inA(() => database.client.stockCaseCount.findMany({ where: { stockLevelId: p.levelId } }))).toHaveLength(1)
    expect(await inA(() => database.client.productPackage.findMany({ where: { productId: p.productId } }))).toHaveLength(1)
    expect(await inB(() => database.client.stockCaseCount.findMany({ where: { stockLevelId: p.levelId } }))).toEqual([])
    expect(await inB(() => database.client.productPackage.findMany({ where: { productId: p.productId } }))).toEqual([])
    expect(await inB(() => database.client.stockCaseCount.findMany())).toEqual([])
    expect((await inB(() => cases.sealedByLevel(database.client, [{ id: p.levelId, productId: p.productId, quantity: 51 }]))).get(p.levelId)).toBe(0)
    expect(await inB(() => cases.setCasePacks({ productIds: [p.productId], values: { ...PACK, unitsPerCase: 6 }, actor: 'b' })))
      .toEqual([{ productId: p.productId, ok: false, error: 'Product not found' }])
    await expect(inB(() => database.client.$transaction((tx) => cases.setCasesInTx(tx, { productId: p.productId, locationId: loc.main, cases: 1, reason: 'INVENTORY_COUNT', actor: 'b' }))))
      .rejects.toMatchObject({ code: 'NOT_A_WAREHOUSE' }) // A's location does not exist for B
    expect([await stored(p.levelId), (await sql(`SELECT "unitsPerCase" FROM "ProductPackage" WHERE "productId"=$1`, [p.productId]))[0].unitsPerCase]).toEqual([4, 12])
  })
})
