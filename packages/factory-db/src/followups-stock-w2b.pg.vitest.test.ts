import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedHolds, type HoldsSeed } from '../seed/holds'
import { seed as seedProduction, type ProductionSeed } from '../seed/production'
import { seed as seedShipping, type ShippingSeed } from '../seed/shipping'
import { seed as seedSourcing } from '../seed/sourcing'
import { seed as seedReturns, type ReturnsSeed } from '../seed/returns'
import { seed as seedSchedule } from '../seed/schedule'
import { seed as seedSubcontractReceipts, type SubcontractReceiptsSeed } from '../seed/subcontract-receipts'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * W2b schema wave 1/7 (B-W2b-01: the W2a follow-ups for stock, receiving, claims, returns, shipping and subcontracting)
 * beyond the generated isolation tests, on a database built from the migrations and seeded twice (tenants A and B),
 * through the real login and the scoped client:
 *   - stock moves: CUSTOMER_RETURN, SUPPLIER_RETURN and SHIPMENT with their directions and lines, a reversal names the
 *     same line, a reason code may say why;
 *   - hides: the database keeps the state a hide had when it is SCRAPPED or RETURNED, and it comes back to exactly that
 *     state only with its move reversed (and the reversal of that move opens it in the same transaction);
 *   - a system release of a reservation only once its demand is done;
 *   - a posted receipt's supplier DDT corrected with when, who and why;
 *   - discrepancy and claim reason codes, a claim's NCR, a claim line's DDT moving to the replacement of a cancelled one;
 *   - a shipment's freight basis, freight cost and transport mode; a DDT's language;
 *   - generated documents (append-only), subcontract bundles, receipts and lines (append-only), an outside operation
 *     reported by its receipt line (never by the floor, never naming a person);
 *   - scrap reason words, a split bundle's reason, work-order kits (the floor marks its own);
 *   - the seeds are idempotent.
 * The refusals are check_violation (SQLSTATE 23514); their messages are read through raw SQL.
 */

const DENIED = /permission denied/
const NS = 'w2b1-a'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let b: CoreSeed
let production: ProductionSeed
let shipping: ShippingSeed
let holds: HoldsSeed
let returns: ReturnsSeed
let receipts: SubcontractReceiptsSeed

const key = (name: string): string => seedUuid(NS, name)
const A = {
  companyA: key('company:A'),
  siteA: key('site:A1'),
  P2: key('party:P2'),
  operator: key('worker:A1:operator'),
  leather: key('product:item:leather'),
  leatherBLK: key('product:item-colour:leather:BLK'),
  lining: key('product:item:lining'),
  liningGRY: key('product:item-colour:lining:GRY'),
  liningLot: key('inventory:lot:LIN-01'),
  bin: key('inventory:location:A1-STORE-01'),
  store: key('inventory:location:A1-STORE'),
  cutting: key('inventory:location:A1-CUT'),
  workshop: key('subcontract:location:A1-TERZ-P2'),
}

const office = (core: CoreSeed = a): FactoryScope => ({ audience: 'office', tenantId: core.tenantId, actorId: core.actorId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: A.operator, siteId: a.sites[0]!.id })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const one = async (text: string, values: unknown[] = []) => (await admin(text, values))[0]!
const columnsOf = (row: Record<string, unknown>) =>
  Object.keys(row)
    .map((column) => `"${column}"`)
    .join(', ')
const insertSql = (table: string, row: Record<string, unknown>) => `INSERT INTO "${table}" (${columnsOf(row)}) SELECT ${columnsOf(row)} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`
const insert = (scope: FactoryScope, table: string, row: Record<string, unknown>) => run(scope, insertSql(table, row), JSON.stringify(row))
/** Several statements in ONE transaction of the scope (deferred checks run at its commit). */
const inOne = (scope: FactoryScope, statements: readonly (readonly [string, ...unknown[]])[]) =>
  as(scope, (client) =>
    client.$transaction(async (tx) => {
      for (const [text, ...values] of statements) await tx.$executeRawUnsafe(text, ...values)
    }),
  )
/** Rows written by the test admin with every trigger off for its own transaction (set-up only). */
async function bypass(statements: readonly (readonly [string, readonly unknown[]])[]): Promise<void> {
  await db.admin.query('BEGIN')
  try {
    await db.admin.query("SET LOCAL session_replication_role = 'replica'")
    for (const [text, values] of statements) await db.admin.query(text, [...values])
    await db.admin.query('COMMIT')
  } catch (error) {
    await db.admin.query('ROLLBACK')
    throw error
  }
}
const tag = (): string => randomUUID().slice(0, 8)
const now = (): string => new Date().toISOString()

beforeAll(async () => {
  db = await migratedDatabase('followupsw2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  b = await seedCore({ db: factory, namespace: 'w2b1-b' })
  for (const namespace of [NS, 'w2b1-b']) {
    await seedHolds({ db: factory, namespace })
    await seedSourcing({ db: factory, namespace })
    await seedSubcontractReceipts({ db: factory, namespace })
    // The finished item of SEED-JKT-02-BLK-52 (finished goods, wave 5/7).
    await seedSchedule({ db: factory, namespace })
  }
  // The seeds again (idempotent) for their answers.
  holds = await seedHolds({ db: factory, namespace: NS })
  returns = await seedReturns({ db: factory, namespace: NS })
  shipping = await seedShipping({ db: factory, namespace: NS })
  production = await seedProduction({ db: factory, namespace: NS })
  receipts = await seedSubcontractReceipts({ db: factory, namespace: NS })
}, 180_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

// --- helpers --------------------------------------------------------------------------------------------------------

const finishedItem = async (): Promise<string> => String((await one(`SELECT id FROM "Item" WHERE "tenantId" = $1 AND code = 'SEED-JKT-02-BLK-52'`, [a.tenantId])).id)

/** A stock move of company A at A1, as the office posts it. */
const move = (fields: Record<string, unknown>) => ({
  id: randomUUID(),
  companyId: A.companyA,
  siteId: A.siteA,
  quantity: '1',
  uom: 'PCS',
  baseQuantity: '1',
  idempotencyKey: `test:${tag()}`,
  occurredAt: now(),
  createdById: a.actorId,
  ...fields,
})

/** A new hide of the leather (BLK) in its own new lot, with its opening stock (20 ft²) in the bin. */
async function hideInStock(): Promise<{ hideId: string; lotId: string }> {
  const lotId = randomUUID()
  const hideId = randomUUID()
  await insert(office(), 'Lot', { id: lotId, companyId: A.companyA, siteId: A.siteA, itemId: A.leather, itemColourId: A.leatherBLK, code: `T-LOT-${tag()}`, requiresCrViTest: true, crViLimitMgKg: '3', crViStatus: 'PENDING' })
  await insert(office(), 'Hide', { id: hideId, siteId: A.siteA, lotId, itemId: A.leather, code: `T-HIDE-${tag()}`, area: '20', areaUom: 'FT2', baseArea: '20' })
  await insert(office(), 'StockMove', move({ reason: 'OPENING', itemId: A.leather, itemColourId: A.leatherBLK, lotId, hideId, toLocationId: A.bin, quantity: '20', uom: 'FT2', baseQuantity: '20', note: 'Test opening stock' }))
  return { hideId, lotId }
}
const hideMove = (hide: { hideId: string; lotId: string }, fields: Record<string, unknown>) =>
  move({ itemId: A.leather, itemColourId: A.leatherBLK, lotId: hide.lotId, hideId: hide.hideId, quantity: '20', uom: 'FT2', baseQuantity: '20', ...fields })
const hideState = async (hideId: string) => one(`SELECT state::text AS state, "previousState"::text AS previous FROM "Hide" WHERE id = $1`, [hideId])

// --- walls ----------------------------------------------------------------------------------------------------------

describe('walls', () => {
  it('keeps the subcontract receipts, lines and bundles for the office; the floor reads its site’s documents and kits', async () => {
    for (const table of ['SubcontractBundle', 'SubcontractReceipt', 'SubcontractReceiptLine']) {
      await expect(sql(floor(), `SELECT id FROM "${table}" LIMIT 1`)).rejects.toThrow(DENIED)
    }
    expect((await sql(floor(), 'SELECT id FROM "GeneratedDocument"')).map((row) => row.id)).toContain(receipts.jobSheetId)
    expect((await sql(floor(), 'SELECT id FROM "WorkOrderKit"')).map((row) => row.id)).toEqual([production.kitId])
    await expect(sql(floor(), 'SELECT "freightCost" FROM "Shipment" LIMIT 1')).rejects.toThrow(DENIED)
    await expect(sql(floor(), 'SELECT "freightCostCurrency" FROM "Shipment" LIMIT 1')).rejects.toThrow(DENIED)
    expect(await sql(office(), `SELECT "freightCost", "freightCostCurrency", "transportMode"::text AS mode FROM "Shipment" WHERE id = $1::uuid`, shipping.shipmentId)).toEqual([{ freightCost: 1850, freightCostCurrency: 'EUR', mode: 'ROAD' }])
  })
})

// --- stock moves ----------------------------------------------------------------------------------------------------

describe('stock moves (W2b reasons, lines and reason codes)', () => {
  it('puts a customer’s goods back with CUSTOMER_RETURN naming the return line, and ships them out with SHIPMENT naming the shipment line', async () => {
    const item = await finishedItem()
    const line = await one(`SELECT id, "partyId" FROM "ReturnLine" WHERE id = $1`, [returns.inspectedLineId])
    const back = move({ reason: 'CUSTOMER_RETURN', itemId: item, toLocationId: A.store, returnLineId: line.id, returnPartyId: line.partyId, reasonCode: 'SIZE', note: 'Restocked' })
    expect(await insert(office(), 'StockMove', back)).toBe(1)
    const out = move({ reason: 'SHIPMENT', itemId: item, fromLocationId: A.store, shipmentLineId: shipping.lineIds[0], workOrderId: production.workOrderId, reference: 'SEED-SH-0001' })
    expect(await insert(office(), 'StockMove', out)).toBe(1)
  })

  it('refuses the wrong direction, a missing line, a line on another reason, another batch’s garments', async () => {
    const item = await finishedItem()
    const line = await one(`SELECT id, "partyId" FROM "ReturnLine" WHERE id = $1`, [returns.inspectedLineId])
    await expect(insert(office(), 'StockMove', move({ reason: 'CUSTOMER_RETURN', itemId: item, fromLocationId: A.store, returnLineId: line.id, returnPartyId: line.partyId }))).rejects.toThrow(/wrong locations/)
    await expect(insert(office(), 'StockMove', move({ reason: 'CUSTOMER_RETURN', itemId: item, toLocationId: A.store }))).rejects.toThrow(/names its return line/)
    await expect(insert(office(), 'StockMove', move({ reason: 'ADJUSTMENT', itemId: item, toLocationId: A.store, note: 'x', returnLineId: line.id, returnPartyId: line.partyId }))).rejects.toThrow(/names its return line/)
    await expect(insert(office(), 'StockMove', move({ reason: 'CUSTOMER_RETURN', itemId: item, toLocationId: A.store, returnLineId: line.id }))).rejects.toThrow(/names its return line/)
    await expect(insert(office(), 'StockMove', move({ reason: 'SHIPMENT', itemId: item, toLocationId: A.store, shipmentLineId: shipping.lineIds[0] }))).rejects.toThrow(/wrong locations/)
    await expect(insert(office(), 'StockMove', move({ reason: 'SHIPMENT', itemId: item, fromLocationId: A.store }))).rejects.toThrow(/names its shipment line/)
    await expect(insert(office(), 'StockMove', move({ reason: 'SUPPLIER_RETURN', itemId: item, toLocationId: A.store }))).rejects.toThrow(/wrong locations/)
    // Another work order's garments never leave for this shipment line.
    await insert(office(), 'StockMove', move({ reason: 'CUSTOMER_RETURN', itemId: item, toLocationId: A.store, returnLineId: line.id, returnPartyId: line.partyId }))
    await expect(
      insert(office(), 'StockMove', move({ reason: 'SHIPMENT', itemId: item, fromLocationId: A.store, shipmentLineId: shipping.lineIds[0], workOrderId: production.draftWorkOrderId })),
    ).rejects.toThrow(/garments of the line's work order/)
  })

  it('lets a reason code say why, refuses one with spaces and still wants a why', async () => {
    const lining = { itemId: A.lining, itemColourId: A.liningGRY, lotId: A.liningLot, uom: 'M' }
    expect(await insert(office(), 'StockMove', move({ reason: 'ADJUSTMENT', ...lining, fromLocationId: A.bin, reasonCode: 'DAMAGED' }))).toBe(1)
    await expect(insert(office(), 'StockMove', move({ reason: 'ADJUSTMENT', ...lining, fromLocationId: A.bin, reasonCode: 'NOT A CODE' }))).rejects.toThrow(/reason code without spaces/)
    await expect(insert(office(), 'StockMove', move({ reason: 'SCRAP', ...lining, fromLocationId: A.bin }))).rejects.toThrow(/says why \(SCM-192\)/)
    // Goods back to the supplier leave with SUPPLIER_RETURN and its CLAIM code.
    expect(await insert(office(), 'StockMove', move({ reason: 'SUPPLIER_RETURN', ...lining, fromLocationId: A.bin, reasonCode: 'QUALITY', reference: 'CLM-TEST' }))).toBe(1)
  })

  it('reverses a CUSTOMER_RETURN only naming the same return line', async () => {
    const item = await finishedItem()
    const line = await one(`SELECT id, "partyId" FROM "ReturnLine" WHERE id = $1`, [returns.inspectedLineId])
    const back = move({ reason: 'CUSTOMER_RETURN', itemId: item, toLocationId: A.store, returnLineId: line.id, returnPartyId: line.partyId })
    await insert(office(), 'StockMove', back)
    const reversal = { reason: 'CUSTOMER_RETURN', itemId: item, fromLocationId: A.store, reversalOfId: back.id }
    await expect(insert(office(), 'StockMove', move(reversal))).rejects.toThrow(/names its return line|reverses move/)
    expect(await insert(office(), 'StockMove', move({ ...reversal, returnLineId: line.id, returnPartyId: line.partyId }))).toBe(1)
  })
})

// --- hides ----------------------------------------------------------------------------------------------------------

describe('hides: SCRAPPED and RETURNED come back to the state they had', () => {
  it('keeps the previous state itself, whatever the update says', async () => {
    const hide = await hideInStock()
    const scrap = hideMove(hide, { reason: 'SCRAP', fromLocationId: A.bin, reasonCode: 'DAMAGED' })
    await inOne(office(), [
      [insertSql('StockMove', scrap), JSON.stringify(scrap)],
      [`UPDATE "Hide" SET state = 'SCRAPPED', "previousState" = 'REMNANT', version = version + 1 WHERE id = $1::uuid`, hide.hideId],
    ])
    expect(await hideState(hide.hideId)).toEqual({ state: 'SCRAPPED', previous: 'FULL' })
  })

  it('opens a written-off hide again with its scrap reversed, to exactly its previous state, in the same transaction', async () => {
    const hide = await hideInStock()
    const scrap = hideMove(hide, { reason: 'SCRAP', fromLocationId: A.bin, note: 'DAMAGED: torn' })
    await inOne(office(), [
      [insertSql('StockMove', scrap), JSON.stringify(scrap)],
      [`UPDATE "Hide" SET state = 'SCRAPPED' WHERE id = $1::uuid`, hide.hideId],
    ])
    const reversal = hideMove(hide, { reason: 'SCRAP', toLocationId: A.bin, reversalOfId: scrap.id, note: 'Written off by mistake' })
    // Without opening the hide: refused at commit (stock never sits on a scrapped hide).
    await expect(inOne(office(), [[insertSql('StockMove', reversal), JSON.stringify(reversal)]])).rejects.toThrow(/comes back to the state it had \(FULL\) in the same transaction/)
    // Not without the reversal, not to another state.
    await expect(run(office(), `UPDATE "Hide" SET state = 'FULL', "previousState" = NULL WHERE id = $1::uuid`, hide.hideId)).rejects.toThrow(/once its SCRAP move is reversed/)
    await expect(
      inOne(office(), [
        [insertSql('StockMove', reversal), JSON.stringify(reversal)],
        [`UPDATE "Hide" SET state = 'PARTLY_CUT', "previousState" = NULL WHERE id = $1::uuid`, hide.hideId],
      ]),
    ).rejects.toThrow(/back to the state it had \(FULL\)/)
    await inOne(office(), [
      [insertSql('StockMove', reversal), JSON.stringify(reversal)],
      [`UPDATE "Hide" SET state = 'FULL', "previousState" = NULL, version = version + 1 WHERE id = $1::uuid`, hide.hideId],
    ])
    expect(await hideState(hide.hideId)).toEqual({ state: 'FULL', previous: null })
  })

  it('sends a hide back to the tannery (RETURNED), not reservable, and back again with its SUPPLIER_RETURN reversed', async () => {
    const hide = await hideInStock()
    const out = hideMove(hide, { reason: 'SUPPLIER_RETURN', fromLocationId: A.bin, reasonCode: 'QUALITY' })
    await inOne(office(), [
      [insertSql('StockMove', out), JSON.stringify(out)],
      [`UPDATE "Hide" SET state = 'RETURNED' WHERE id = $1::uuid`, hide.hideId],
    ])
    expect(await hideState(hide.hideId)).toEqual({ state: 'RETURNED', previous: 'FULL' })
    await expect(
      insert(office(), 'Reservation', { id: randomUUID(), companyId: A.companyA, siteId: A.siteA, kind: 'HIDE', itemId: A.leather, itemColourId: A.leatherBLK, lotId: hide.lotId, hideId: hide.hideId, quantity: '20', workOrderId: production.workOrderId }),
    ).rejects.toThrow(/is RETURNED; nothing of it can be reserved/)
    await expect(run(office(), `UPDATE "Hide" SET grade = 'B' WHERE id = $1::uuid`, hide.hideId)).rejects.toThrow(/it never changes, but back/)
    const back = hideMove(hide, { reason: 'SUPPLIER_RETURN', toLocationId: A.bin, reversalOfId: out.id, note: 'The tannery sent it back' })
    await inOne(office(), [
      [insertSql('StockMove', back), JSON.stringify(back)],
      [`UPDATE "Hide" SET state = 'FULL', "previousState" = NULL WHERE id = $1::uuid`, hide.hideId],
    ])
    expect(await hideState(hide.hideId)).toEqual({ state: 'FULL', previous: null })
  })

  it('keeps a hide scrapped before W2b (no previous state) as it is', async () => {
    const hide = await hideInStock()
    const scrap = hideMove(hide, { reason: 'SCRAP', fromLocationId: A.bin, note: 'old write-off' })
    await insert(office(), 'StockMove', scrap)
    await bypass([[`UPDATE "Hide" SET state = 'SCRAPPED', "previousState" = NULL WHERE id = $1::uuid`, [hide.hideId]]])
    const reversal = hideMove(hide, { reason: 'SCRAP', toLocationId: A.bin, reversalOfId: scrap.id, note: 'too late' })
    await expect(
      inOne(office(), [
        [insertSql('StockMove', reversal), JSON.stringify(reversal)],
        [`UPDATE "Hide" SET state = 'FULL' WHERE id = $1::uuid`, hide.hideId],
      ]),
    ).rejects.toThrow(/not recorded/)
  })

  it('gives a new hide no previous state', async () => {
    await expect(
      insert(office(), 'Hide', { id: randomUUID(), siteId: A.siteA, lotId: A.liningLot, itemId: A.leather, code: `T-HIDE-${tag()}`, area: '1', areaUom: 'FT2', baseArea: '1', previousState: 'FULL' }),
    ).rejects.toThrow(/no previous state|lot|violates/)
  })
})

// --- reservations -----------------------------------------------------------------------------------------------------

describe('reservations: a system release only once the demand is done', () => {
  const reservation = (workOrderId: string) => ({ id: randomUUID(), companyId: A.companyA, siteId: A.siteA, kind: 'QUANTITY', itemId: A.lining, itemColourId: A.liningGRY, quantity: '2', workOrderId })

  it('refuses a release without a person while the work order is open; a person releases it', async () => {
    const row = reservation(production.workOrderId)
    await insert(office(), 'Reservation', row)
    await expect(
      run(office(), `UPDATE "Reservation" SET status = 'RELEASED', "releasedAt" = now(), "releaseReason" = 'Work order done' WHERE id = $1::uuid`, row.id),
    ).rejects.toThrow(/released by the system only once its work order .* is done/)
    expect(await run(office(), `UPDATE "Reservation" SET status = 'RELEASED', "releasedAt" = now(), "releasedById" = $2::uuid, "releaseReason" = 'Not needed' WHERE id = $1::uuid`, row.id, a.actorId)).toBe(1)
  })

  it('lets the system release the rest once the work order is cancelled (still with the reason)', async () => {
    const row = reservation(production.draftWorkOrderId)
    await insert(office(), 'Reservation', row)
    await run(office(), `UPDATE "WorkOrder" SET status = 'CANCELLED', "cancelledAt" = now(), "cancelReason" = 'Test: not made' WHERE id = $1::uuid`, production.draftWorkOrderId)
    await expect(run(office(), `UPDATE "Reservation" SET status = 'RELEASED', "releasedAt" = now() WHERE id = $1::uuid`, row.id)).rejects.toThrow(/RELEASED exactly with when, by whom and why/)
    expect(await run(office(), `UPDATE "Reservation" SET status = 'RELEASED', "releasedAt" = now(), "releaseReason" = 'Work order cancelled' WHERE id = $1::uuid`, row.id)).toBe(1)
  })
})

// --- receiving --------------------------------------------------------------------------------------------------------

describe('a posted receipt’s supplier DDT', () => {
  const receiptId = () => production.inventory.receiptId

  it('changes only with a new correction (when, who, why), and a correction only with a change', async () => {
    await expect(run(office(), `UPDATE "GoodsReceipt" SET "supplierDdtNumber" = 'DDT-FIX-1' WHERE id = $1::uuid`, receiptId())).rejects.toThrow(/corrected with a new correction/)
    expect(
      await run(
        office(),
        `UPDATE "GoodsReceipt" SET "supplierDdtNumber" = 'DDT-FIX-1', "supplierDdtCorrectedAt" = '2026-11-20T10:00:00Z', "supplierDdtCorrectedById" = $2::uuid, "supplierDdtCorrectionReason" = 'Typed wrong at the dock' WHERE id = $1::uuid`,
        receiptId(),
        a.actorId,
      ),
    ).toBe(1)
    await expect(run(office(), `UPDATE "GoodsReceipt" SET "supplierDdtCorrectionReason" = 'Another reason' WHERE id = $1::uuid`, receiptId())).rejects.toThrow(/corrected with a new correction/)
    await expect(
      run(office(), `UPDATE "GoodsReceipt" SET "supplierDdtDate" = '2026-11-01', "supplierDdtCorrectedAt" = '2026-11-19T10:00:00Z', "supplierDdtCorrectionReason" = 'Date' WHERE id = $1::uuid`, receiptId()),
    ).rejects.toThrow(/corrected with a new correction/)
    expect(
      await run(office(), `UPDATE "GoodsReceipt" SET "supplierDdtDate" = '2026-11-01', "supplierDdtCorrectedAt" = '2026-11-21T10:00:00Z', "supplierDdtCorrectionReason" = 'Date' WHERE id = $1::uuid`, receiptId()),
    ).toBe(1)
    await expect(run(office(), `UPDATE "GoodsReceipt" SET "supplierDdtCorrectedById" = NULL, "supplierDdtNumber" = 'X' WHERE id = $1::uuid`, receiptId())).rejects.toThrow(/correction/)
    // What was received stays frozen.
    await expect(run(office(), `UPDATE "GoodsReceipt" SET "receivedAt" = now() WHERE id = $1::uuid`, receiptId())).rejects.toThrow(/changes only while it is OPEN/)
  })

  it('records no correction on an OPEN receipt', async () => {
    await expect(
      run(
        office(),
        `UPDATE "GoodsReceipt" SET "supplierDdtCorrectedAt" = now(), "supplierDdtCorrectedById" = $2::uuid, "supplierDdtCorrectionReason" = 'x' WHERE id = $1::uuid`,
        production.inventory.openReceiptId,
        a.actorId,
      ),
    ).rejects.toThrow(/only once it is POSTED/)
  })
})

describe('discrepancy and claim reason codes, a claim’s NCR, a claim line’s replacement DDT', () => {
  it('sets a discrepancy’s reason code while OPEN only', async () => {
    const id = randomUUID()
    await expect(insert(office(), 'ReceiptDiscrepancy', { id, siteId: A.siteA, receiptId: production.inventory.receiptId, seq: 900, supplierId: A.P2, kind: 'DAMAGED', reasonCode: 'BAD CODE' })).rejects.toThrow(
      /reason code without spaces/,
    )
    expect(await insert(office(), 'ReceiptDiscrepancy', { id, siteId: A.siteA, receiptId: production.inventory.receiptId, seq: 900, supplierId: A.P2, kind: 'DAMAGED', reasonCode: 'DAMAGED' })).toBe(1)
    await run(office(), `UPDATE "ReceiptDiscrepancy" SET "reasonCode" = 'SHORT' WHERE id = $1::uuid`, id)
    await run(office(), `UPDATE "ReceiptDiscrepancy" SET status = 'SENT', "sentAt" = now(), "sentById" = $2::uuid WHERE id = $1::uuid`, id, a.actorId)
    await expect(run(office(), `UPDATE "ReceiptDiscrepancy" SET "reasonCode" = 'DAMAGED' WHERE id = $1::uuid`, id)).rejects.toThrow(/changes only while it is OPEN/)
  })

  it('fixes a claim’s reason code once sent and names an NCR of its site', async () => {
    const id = randomUUID()
    const claim = { id, companyId: A.companyA, siteId: A.siteA, number: `T-CLM-${tag()}`, partyId: A.P2, kind: 'CLAIM', foundAt: 'CUTTING', reason: 'Grain crack', reasonCode: 'QUALITY', ncrId: holds.ncrId }
    expect(await insert(office(), 'SupplierClaim', claim)).toBe(1)
    await expect(insert(office(), 'SupplierClaim', { ...claim, id: randomUUID(), number: `T-CLM-${tag()}`, ncrId: randomUUID() })).rejects.toThrow(/foreign key|violates/)
    await run(office(), `UPDATE "SupplierClaim" SET "reasonCode" = 'COLOUR' WHERE id = $1::uuid`, id)
    await run(office(), `UPDATE "SupplierClaim" SET status = 'SENT', remedy = 'CREDIT', "sentAt" = now(), "sentById" = $2::uuid WHERE id = $1::uuid`, id, a.actorId)
    await expect(run(office(), `UPDATE "SupplierClaim" SET "reasonCode" = 'QUALITY' WHERE id = $1::uuid`, id)).rejects.toThrow(/fixed once it is sent/)
    await expect(run(office(), `UPDATE "SupplierClaim" SET "reasonCode" = 'BAD CODE' WHERE id = $1::uuid`, id)).rejects.toThrow(/without spaces/)
  })

  it('moves a claim line’s DDT only from a cancelled one to the claim’s live replacement that lists the line', async () => {
    const claimId = randomUUID()
    const lineId = randomUUID()
    const [cancelled, replacement, unlisted] = [randomUUID(), randomUUID(), randomUUID()]
    const ddt = (id: string, number: string, lines: unknown[]) => [
      `INSERT INTO "Ddt" (id, "tenantId", "companyId", "siteId", "partyId", "sourceType", "sourceId", "numberSeriesId", number, "documentDate", reason, "transportBy", "startAt", appearance, packages, "grossWeightKg", sender, recipient, lines, "issuedAt")
       VALUES ($1, $2, $3, $4, $5, 'SupplierClaim', $6, $7, $8, '2026-11-20', 'RETURN', 'SENDER', now(), 'Box', 1, 2, '{}', '{}', $9::jsonb, now())`,
      [id, a.tenantId, A.companyA, A.siteA, A.P2, claimId, shipping.ddtSeriesId, number, JSON.stringify(lines)],
    ] as const
    await bypass([
      [
        `INSERT INTO "SupplierClaim" (id, "tenantId", "companyId", "siteId", number, "partyId", kind, "foundAt", reason, status, remedy, "sentAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, 'RETURN', 'RECEIPT', 'Wrong colour', 'SENT', 'CREDIT', now(), now())`,
        [claimId, a.tenantId, A.companyA, A.siteA, `T-CLM-${tag()}`, A.P2],
      ],
      ddt(cancelled, `T-${tag()}`, [{ seq: 1, sourceLineId: lineId }]),
      ddt(replacement, `T-${tag()}`, [{ seq: 1, sourceLineId: lineId }]),
      ddt(unlisted, `T-${tag()}`, [{ seq: 1, sourceLineId: randomUUID() }]),
      [`INSERT INTO "DdtCancellation" (id, "tenantId", "siteId", "partyId", "ddtId", reason, "cancelledAt") VALUES ($1, $2, $3, $4, $5, 'Wrong weight', now())`, [randomUUID(), a.tenantId, A.siteA, A.P2, cancelled]],
      [
        `INSERT INTO "SupplierClaimLine" (id, "tenantId", "siteId", "partyId", "claimId", seq, "itemId", "itemColourId", "lotId", quantity, uom, "baseQuantity", "ddtId", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, 10, $6, $7, $8, 1, 'M', 1, $9, now())`,
        [lineId, a.tenantId, A.siteA, A.P2, claimId, A.lining, A.liningGRY, A.liningLot, cancelled],
      ],
    ])
    const moveTo = (ddtId: string | null) => run(office(), `UPDATE "SupplierClaimLine" SET "ddtId" = $2::uuid WHERE id = $1::uuid`, lineId, ddtId)
    await expect(moveTo(unlisted)).rejects.toThrow(/live DDT of its claim that replaced it and lists the line/)
    await expect(moveTo(null)).rejects.toThrow(/set once/)
    expect(await moveTo(replacement)).toBe(1)
    // From a live DDT it moves no more.
    await expect(moveTo(cancelled)).rejects.toThrow(/set once/)
  })
})

// --- shipping ---------------------------------------------------------------------------------------------------------

describe('shipping: freight basis and cost, transport mode, the DDT’s language', () => {
  it('records the carrier’s cost and the transport mode after the goods left; the basis only with a charge', async () => {
    expect(await run(office(), `UPDATE "Shipment" SET "freightCost" = 2100, "freightCostCurrency" = 'EUR', "transportMode" = 'AIR' WHERE id = $1::uuid`, shipping.shipmentId)).toBe(1)
    await expect(run(office(), `UPDATE "Shipment" SET "freightCostCurrency" = NULL WHERE id = $1::uuid`, shipping.shipmentId)).rejects.toThrow(/freight cost .*both or neither/)
    await expect(run(office(), `UPDATE "Shipment" SET "freightCost" = -1 WHERE id = $1::uuid`, shipping.shipmentId)).rejects.toThrow(/freight cost/)
    await expect(run(office(), `UPDATE "Shipment" SET "freightBasis" = 'RULE' WHERE id = $1::uuid`, shipping.shipmentId)).rejects.toThrow(/only when it has one/)
    expect(await run(office(), `UPDATE "Shipment" SET "freightCharge" = 1200, "freightBasis" = 'RULE' WHERE id = $1::uuid`, shipping.shipmentId)).toBe(1)
    // The floor still changes nothing but DRAFT ⇄ PACKED.
    await expect(run(floor(), `UPDATE "Shipment" SET "transportMode" = 'ROAD' WHERE id = $1::uuid`, shipping.draftShipmentId)).rejects.toThrow(/DRAFT ⇄ PACKED/)
  })

  it('keeps a DDT’s language as a two-letter code', async () => {
    const row = (await admin(`SELECT to_jsonb(d) AS row FROM "Ddt" d WHERE id = $1`, [shipping.ddtId]))[0]!.row as Record<string, unknown>
    const copy = (language: string) => ({ ...row, id: randomUUID(), number: `${String(row.number)}-copy-${tag()}`, language })
    const put = (data: Record<string, unknown>) => run(office(), `INSERT INTO "Ddt" SELECT * FROM jsonb_populate_record(NULL::"Ddt", $1::jsonb)`, JSON.stringify(data))
    await expect(put(copy('ITA'))).rejects.toThrow(/two-letter code/)
    expect(await put(copy('en'))).toBe(1)
  })
})

// --- generated documents --------------------------------------------------------------------------------------------

describe('generated documents', () => {
  const doc = (fields: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    companyId: A.companyA,
    siteId: A.siteA,
    recordType: 'SubcontractOrder',
    recordId: receipts.orderId,
    kind: 'JOB_SHEET',
    version: 2,
    fingerprint: createHash('sha256').update(tag()).digest('hex'),
    language: 'it',
    fileId: receipts.jobSheetFileId,
    ...fields,
  })

  it('records a new version and refuses a duplicate, a wrong kind, another record’s site or file, a bad fingerprint', async () => {
    expect(await insert(office(), 'GeneratedDocument', doc())).toBe(1)
    await expect(insert(office(), 'GeneratedDocument', doc())).rejects.toThrow(/unique|duplicate/i)
    await expect(insert(office(), 'GeneratedDocument', doc({ version: 3, kind: 'PACKING_LIST' }))).rejects.toThrow(/a packing list is a Shipment/)
    await expect(insert(office(), 'GeneratedDocument', doc({ version: 3, companyId: b.companies[0]!.id, siteId: a.sites[1]!.id }))).rejects.toThrow(/violates|company and site/)
    await expect(insert(office(), 'GeneratedDocument', doc({ version: 3, companyId: a.sites[1]!.companyId, siteId: a.sites[1]!.id }))).rejects.toThrow(/of the company and site of its SubcontractOrder/)
    const companyFile = await one(`SELECT id FROM "StoredFile" WHERE "tenantId" = $1 AND "recordType" = 'Company' LIMIT 1`, [a.tenantId])
    await expect(insert(office(), 'GeneratedDocument', doc({ version: 3, fileId: companyFile.id }))).rejects.toThrow(/a file of its own record/)
    await expect(insert(office(), 'GeneratedDocument', doc({ version: 3, fingerprint: 'ABC' }))).rejects.toThrow(/SHA-256 fingerprint/)
    await expect(insert(office(), 'GeneratedDocument', doc({ version: 0 }))).rejects.toThrow(/version from 1/)
  })

  it('is append-only for every login, the owner included; the floor reads but never writes', async () => {
    await expect(admin(`UPDATE "GeneratedDocument" SET language = 'en' WHERE id = $1`, [receipts.jobSheetId])).rejects.toThrow(/append-only/)
    await expect(admin(`DELETE FROM "GeneratedDocument" WHERE id = $1`, [receipts.jobSheetId])).rejects.toThrow(/append-only/)
    await expect(run(office(), `UPDATE "GeneratedDocument" SET language = 'en' WHERE id = $1::uuid`, receipts.jobSheetId)).rejects.toThrow(DENIED)
    await expect(insert(floor(), 'GeneratedDocument', doc({ version: 9 }))).rejects.toThrow(DENIED)
  })
})

// --- subcontracting ---------------------------------------------------------------------------------------------------

describe('subcontract bundles, receipts and lines', () => {
  const bundleRow = (fields: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    siteId: A.siteA,
    workOrderId: production.workOrderId,
    subcontractOrderId: receipts.orderId,
    bundleId: production.bundleIds[0],
    quantity: 1,
    sentAt: now(),
    ...fields,
  })
  const receiptRow = (fields: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    siteId: A.siteA,
    workOrderId: production.workOrderId,
    subcontractOrderId: receipts.orderId,
    seq: 100 + Math.floor(Math.random() * 100_000),
    receivedAt: now(),
    ...fields,
  })
  const lineRow = (receiptId: string, fields: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    siteId: A.siteA,
    workOrderId: production.workOrderId,
    receiptId,
    seq: 10,
    subcontractOperationId: receipts.operationId,
    ...fields,
  })

  it('sends a bundle with an issued order only, never more than it holds, then never changes it; removes it while nothing came back', async () => {
    await expect(insert(office(), 'SubcontractBundle', bundleRow({ subcontractOrderId: receipts.subcontract.orderId }))).rejects.toThrow(/bundles go out with an ISSUED, AT_WORKSHOP or PARTLY_RECEIVED order/)
    await expect(insert(office(), 'SubcontractBundle', bundleRow({ quantity: 2 }))).rejects.toThrow(/with 1 up to its 1 garment/)
    const row = bundleRow()
    expect(await insert(office(), 'SubcontractBundle', row)).toBe(1)
    await expect(run(office(), `UPDATE "SubcontractBundle" SET quantity = 1 WHERE id = $1::uuid`, row.id)).rejects.toThrow(DENIED)
    await expect(admin(`UPDATE "SubcontractBundle" SET quantity = 2 WHERE id = $1`, [row.id])).rejects.toThrow(/stays as it went out/)
    expect(await run(office(), `DELETE FROM "SubcontractBundle" WHERE id = $1::uuid`, row.id)).toBe(1)
    await expect(run(office(), `DELETE FROM "SubcontractBundle" WHERE id = $1::uuid`, receipts.subcontractBundleId)).rejects.toThrow(/came back \(in part\)/)
  })

  it('takes a receipt from an order at the workshop, with the workshop’s DDT and TRANSFERs out of its place; append-only', async () => {
    await expect(insert(office(), 'SubcontractReceipt', receiptRow({ subcontractOrderId: receipts.subcontract.orderId }))).rejects.toThrow(/goods come back from an order AT_WORKSHOP or PARTLY_RECEIVED/)
    await expect(insert(office(), 'SubcontractReceipt', receiptRow({ workshopDdtDate: '2026-11-20' }))).rejects.toThrow(/DDT number when it gives its date/)
    const opening = production.inventory.openingMoveId
    await expect(insert(office(), 'SubcontractReceipt', receiptRow({ returnMoveIds: [opening] }))).rejects.toThrow(/not TRANSFERs out of its order's workshop location/)
    await expect(insert(office(), 'SubcontractReceipt', receiptRow({ returnMoveIds: [opening, opening] }))).rejects.toThrow(/each material move once/)
    await expect(admin(`UPDATE "SubcontractReceipt" SET note = 'x' WHERE id = $1`, [receipts.receiptId])).rejects.toThrow(/append-only/)
    await expect(admin(`DELETE FROM "SubcontractReceiptLine" WHERE id = $1`, [receipts.receiptLineId])).rejects.toThrow(/append-only/)
  })

  it('counts pieces back per operation of the order, never more than the bundle holds over every receipt', async () => {
    const receipt = receiptRow({ workshopDdtNumber: `W-${tag()}` })
    await insert(office(), 'SubcontractReceipt', receipt)
    await expect(insert(office(), 'SubcontractReceiptLine', lineRow(receipt.id))).rejects.toThrow(/at least one in all/)
    await expect(insert(office(), 'SubcontractReceiptLine', lineRow(receipt.id, { goodQuantity: 1, reasonCode: 'BAD CODE' }))).rejects.toThrow(/without spaces/)
    await expect(insert(office(), 'SubcontractReceiptLine', lineRow(receipt.id, { goodQuantity: 1, subcontractOperationId: receipts.subcontract.operationId }))).rejects.toThrow(/an operation of its receipt's subcontract order/)
    // SEED-BN-0002 holds 2 sleeve sets and 1 came back already for this operation.
    await expect(insert(office(), 'SubcontractReceiptLine', lineRow(receipt.id, { bundleId: receipts.bundleId, goodQuantity: 1, scrappedQuantity: 1 }))).rejects.toThrow(/holds 2 garment\(s\); 1 came back already/)
    expect(await insert(office(), 'SubcontractReceiptLine', lineRow(receipt.id, { bundleId: receipts.bundleId, defectiveQuantity: 1, reasonCode: 'STITCHING', reasonNote: 'Loose seam' }))).toBe(1)
  })

  it('reports the outside operation from its receipt line: no worker, station or device, the line’s counts; never from the floor', async () => {
    const receipt = receiptRow({ workshopDdtNumber: `W-${tag()}` })
    await insert(office(), 'SubcontractReceipt', receipt)
    const line = lineRow(receipt.id, { bundleId: production.bundleIds[0], goodQuantity: 1 })
    await insert(office(), 'SubcontractReceiptLine', line)
    const scan = (fields: Record<string, unknown> = {}) => ({
      id: randomUUID(),
      siteId: A.siteA,
      workOrderId: production.workOrderId,
      workOrderOperationId: production.operationIds.pack,
      bundleId: production.bundleIds[0],
      kind: 'REPORT',
      goodQuantity: 1,
      subcontractReceiptLineId: line.id,
      clientScanId: `receipt-line:${line.id}:${tag()}`,
      ...fields,
    })
    await expect(insert(floor(), 'OperationScan', scan())).rejects.toThrow(/a floor session never reports an outside operation/)
    await expect(insert(office(), 'OperationScan', scan({ workerId: A.operator }))).rejects.toThrow(/names no worker, station or device/)
    await expect(insert(office(), 'OperationScan', scan({ goodQuantity: 0, reworkQuantity: 1 }))).rejects.toThrow(/the line's bundle, its operation of the work order, and its counts/)
    await expect(insert(office(), 'OperationScan', scan({ workOrderOperationId: production.operationIds.qc }))).rejects.toThrow(/the line's bundle, its operation/)
    const report = scan()
    expect(await insert(office(), 'OperationScan', report)).toBe(1)
    await expect(insert(office(), 'OperationScan', scan({ kind: 'UNDO', goodQuantity: 0, correctsId: report.id }))).rejects.toThrow(/only a REPORT names the subcontract receipt line/)
  })
})

// --- production -------------------------------------------------------------------------------------------------------

describe('scrap reason words, a split bundle’s reason, work-order kits', () => {
  it('keeps a scrap reason’s icon, colour, other languages and needs detail like a reason code', async () => {
    const reason = await one(`SELECT id FROM "ScrapReason" WHERE "tenantId" = $1 AND code = 'OTHER' AND kind = 'SCRAP'`, [a.tenantId])
    const set = (assignments: string) => run(office(), `UPDATE "ScrapReason" SET ${assignments} WHERE id = $1::uuid`, reason.id)
    await expect(set(`icon = 'Not An Icon'`)).rejects.toThrow(/icon by its id/)
    await expect(set(`colour = 'red'`)).rejects.toThrow(/#RRGGBB/)
    await expect(set(`"labelI18n" = '{"RO": "Altele"}'`)).rejects.toThrow(/keyed by language code/)
    expect(await set(`icon = 'camera', colour = '#B45309', "labelI18n" = '{"ro": "Altele"}', "needsDetail" = true`)).toBe(1)
  })

  it('says why a bundle was split only on a split bundle', async () => {
    const parent = await one(`SELECT "workOrderSizeId", "cutLogIds" FROM "Bundle" WHERE id = $1`, [production.bundleIds[1]])
    const bundle = (fields: Record<string, unknown>) => ({
      id: randomUUID(),
      siteId: A.siteA,
      workOrderId: production.workOrderId,
      workOrderSizeId: parent.workOrderSizeId,
      code: `T-BN-${tag()}`,
      quantity: 1,
      part: 'SLEEVES',
      cutLogIds: parent.cutLogIds,
      ...fields,
    })
    await expect(insert(office(), 'Bundle', bundle({ splitReason: 'REWORK' }))).rejects.toThrow(/only when it is split from another/)
    await expect(insert(office(), 'Bundle', bundle({ parentBundleId: production.bundleIds[1], splitReason: 'TWO WORDS' }))).rejects.toThrow(/a code without spaces/)
    expect(await insert(office(), 'Bundle', bundle({ parentBundleId: production.bundleIds[1], splitReason: 'REWORK' }))).toBe(1)
  })

  it('stages a kit at a place of the site, marks it complete with who, never deletes it; the floor marks its own', async () => {
    const kitId = production.kitId
    await expect(run(office(), `UPDATE "WorkOrderKit" SET "completedById" = NULL WHERE id = $1::uuid`, kitId)).rejects.toThrow(/both or neither/)
    await expect(run(office(), `UPDATE "WorkOrderKit" SET "stagingLocationId" = $2::uuid WHERE id = $1::uuid`, kitId, A.workshop)).rejects.toThrow(/not a workshop's/)
    await expect(run(office(), `UPDATE "WorkOrderKit" SET "workOrderId" = $2::uuid WHERE id = $1::uuid`, kitId, production.draftWorkOrderId)).rejects.toThrow(/keeps its work order/)
    await expect(admin(`DELETE FROM "WorkOrderKit" WHERE id = $1`, [kitId])).rejects.toThrow(/never deleted/)
    expect(await run(floor(), `UPDATE "WorkOrderKit" SET "completedAt" = NULL, "completedById" = NULL WHERE id = $1::uuid`, kitId)).toBe(1)
    expect(await run(floor(), `UPDATE "WorkOrderKit" SET "completedAt" = now(), "completedById" = $2::uuid, "stagingLocationId" = $3::uuid WHERE id = $1::uuid`, kitId, A.operator, A.bin)).toBe(1)
    // The draft work order was cancelled above: no kit is staged for it.
    await expect(insert(office(), 'WorkOrderKit', { id: production.draftWorkOrderId, siteId: A.siteA, workOrderId: production.draftWorkOrderId })).rejects.toThrow(/a kit is staged only for an open work order/)
  })
})

// --- seeds ------------------------------------------------------------------------------------------------------------

it('keeps the seeds idempotent', async () => {
  const counts = async () => (await admin(`SELECT (SELECT count(*) FROM "WorkOrderKit")::int AS kits, (SELECT count(*) FROM "SubcontractOrder" WHERE number = 'SEED-SC-0002')::int AS orders, (SELECT count(*) FROM "GeneratedDocument" WHERE kind = 'JOB_SHEET' AND version = 1)::int AS sheets`))[0]
  const before = await counts()
  await seedSubcontractReceipts({ db: factory, namespace: NS })
  await seedProduction({ db: factory, namespace: NS })
  expect(await counts()).toEqual(before)
  expect(before).toEqual({ kits: 2, orders: 2, sheets: 2 })
}, 60_000)
