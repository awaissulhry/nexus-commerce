import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedRoles } from '../seed/roles'
import { seed as seedWarehouseDepth, type WarehouseDepthSeed } from '../seed/warehouse-depth'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * The warehouse in depth (W2b-5, schema wave 36/44, B-W2b-277, …_warehouse_depth_w2b_guards) on a database built from the
 * migrations and seeded twice, through the real login and the scoped client:
 *   - locations: a customer's place names a customer, a bin label's code, a block that refuses moves until it ends;
 *   - lots: the lifecycle kept in step with the quality status, a parent lot, attributes typed per kind;
 *   - goods without a PO: held in a place for a buyer, posted only once a purchase order names them;
 *   - transfers: drafted, shipped onto the transit place with their DDT, received at the other site as its own lot, a
 *     difference with its reason; a transit place moves only with a transfer;
 *   - counts: frozen lines refuse moves, the floor counts by scan (its lock, ADDED lines, its columns), scans append-only, a
 *     recount and an approval by another person while the company's switch is on;
 *   - posting dates, the warehouse rules, default locations, schedules, the task inbox, substitutes;
 *   - grants: what the floor reads and does, what it does not.
 * The refusals are check_violation (23514); their messages are read through raw SQL.
 */

const NS = 'w2b-277-a'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let s: WarehouseDepthSeed

const key = (name: string): string => seedUuid(NS, name)
const A = {
  company: key('company:A'),
  companyB: key('company:B'),
  site: key('site:A1'),
  siteB: key('site:B1'),
  P1: key('party:P1'),
  P2: key('party:P2'),
  member: key('user:member'),
  lead: key('worker:A1:lead'),
  storeB: key('inventory:location:B1-STORE'),
  dock: key('inventory:location:A1-RCV'),
  lining: key('product:item:lining'),
  grey: key('product:item-colour:lining:GRY'),
}
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const floor = (actorId: string = s.workerId): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId, siteId: A.site })
const partner = (partyId: string): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: a.actorId, partyId })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const one = async (text: string, values: unknown[] = []) => (await admin(text, values))[0]!
/** INSERT a copy of row `id` of `table` with `changes` (a jsonb object of columns). */
const copyRow = (scope: FactoryScope, table: string, id: string, changes: Record<string, unknown>) =>
  run(scope, `INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`, JSON.stringify(changes), id)
/** UPDATE row `id` of `table`: `set` is the SET list. */
const update = (scope: FactoryScope, table: string, id: string, set: string, ...values: unknown[]) => run(scope, `UPDATE "${table}" SET ${set} WHERE id = $1::uuid`, id, ...values)
const tag = (prefix: string): string => `${prefix}-${randomUUID().slice(0, 8)}`
/** A stock move of the warehouse's own lining at A1 (the office's), with `changes`. */
const move = (changes: Record<string, unknown>, scope: FactoryScope = office()) =>
  run(
    scope,
    `INSERT INTO "StockMove" (id, "companyId", "siteId", reason, "itemId", "lotId", "fromLocationId", "toLocationId", quantity, uom, "baseQuantity", note, "idempotencyKey", "occurredAt", "transferLineId", "postingDate", "createdById")
     SELECT x.id, x."companyId", x."siteId", x.reason, x."itemId", x."lotId", x."fromLocationId", x."toLocationId", x.quantity, x.uom, x."baseQuantity", x.note, x."idempotencyKey", x."occurredAt", x."transferLineId", x."postingDate", x."createdById"
       FROM jsonb_populate_record(NULL::"StockMove", $1::jsonb) x`,
    JSON.stringify({
      id: randomUUID(),
      companyId: A.company,
      siteId: A.site,
      itemId: s.itemId,
      lotId: s.lotId,
      fromLocationId: null,
      toLocationId: null,
      quantity: '1.0000',
      uom: 'M',
      baseQuantity: '1.0000',
      note: 'Test move.',
      idempotencyKey: tag('t-move'),
      occurredAt: new Date().toISOString(),
      transferLineId: null,
      postingDate: null,
      createdById: a.actorId,
      ...changes,
    }),
  )
/** A new place of A1 (a bin under the store unless said). */
async function newPlace(changes: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  expect(await copyRow(office(), 'Location', s.locations.countBay, { id, code: tag('T-BIN'), labelCode: null, ...changes })).toBe(1)
  return id
}
/** Opening stock of the warehouse lining into `place` (the office's), so a test has its own stock. */
const stockInto = (place: string, quantity = '10.0000') => move({ reason: 'OPENING', toLocationId: place, quantity, baseQuantity: quantity, note: null })

beforeAll(async () => {
  db = await migratedDatabase('warehousedepthw2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  s = await seedWarehouseDepth({ db: factory, namespace: NS })
  // Run twice: every seed is idempotent. The roles seed gives the office roles a task is never for.
  await seedWarehouseDepth({ db: factory, namespace: NS })
  await seedRoles({ db: factory, namespace: NS })
}, 300_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('locations', () => {
  it('a customer place names a customer or a brand; a bin label code is a scannable code, once in the tenant', async () => {
    await expect(newPlace({ kind: 'CUSTOMER', partyId: null, parentId: null })).rejects.toThrow(/exactly when it names the party/)
    await expect(newPlace({ kind: 'CUSTOMER', partyId: A.P2, parentId: null })).rejects.toThrow(/customer or a brand/)
    expect(await newPlace({ kind: 'CUSTOMER', partyId: A.P1, parentId: null })).toBeTruthy()
    await expect(newPlace({ labelCode: 'BIN A1 9' })).rejects.toThrow(/label code/)
    await expect(newPlace({ labelCode: 'BIN-A1-PF-01' })).rejects.toThrow(/Location_tenantId_labelCode_key/)
    expect(await newPlace({ labelCode: tag('BIN-T') })).toBeTruthy()
  })

  it('a blocked place takes no move in or out but a count, until it is unblocked or its day passed', async () => {
    const place = await newPlace()
    expect(await stockInto(place)).toBe(1)
    await expect(update(office(), 'Location', place, `"blockedAt" = now()`)).rejects.toThrow(/blocked with when and why/)
    await expect(update(office(), 'Location', place, `"blockedAt" = now(), "blockReason" = 'OTHER'`)).rejects.toThrow(/blocked with when and why/)
    await expect(update(office(), 'Location', place, `"blockedAt" = now() + interval '1 day', "blockReason" = 'DAMAGE'`)).rejects.toThrow(/not in the future/)
    expect(await update(office(), 'Location', place, `"blockedAt" = now(), "blockedById" = $2::uuid, "blockReason" = 'CLEAN_UP'`, A.member)).toBe(1)
    await expect(move({ reason: 'TRANSFER', fromLocationId: place, toLocationId: s.locations.pickFace })).rejects.toThrow(/is blocked \(CLEAN_UP\)/)
    await expect(stockInto(place)).rejects.toThrow(/is blocked/)
    expect(await move({ reason: 'COUNT', fromLocationId: place, note: 'Found short while blocked.' })).toBe(1)
    // A block that ended yesterday takes moves again; unblocking clears it.
    expect(await update(office(), 'Location', place, `"blockedAt" = now() - interval '3 days', "blockedUntil" = (now() AT TIME ZONE 'Europe/Rome')::date - 1`)).toBe(1)
    expect(await move({ reason: 'TRANSFER', fromLocationId: place, toLocationId: s.locations.pickFace })).toBe(1)
    await expect(update(office(), 'Location', place, `"blockedAt" = NULL, "blockReason" = NULL`)).rejects.toThrow(/or not at all/)
    expect(await update(office(), 'Location', place, `"blockedAt" = NULL, "blockedById" = NULL, "blockReason" = NULL, "blockedUntil" = NULL`)).toBe(1)
  })
})

describe('lots', () => {
  const newLot = (changes: Record<string, unknown>) => copyRow(office(), 'Lot', s.childLotId, { id: randomUUID(), code: tag('T-LOT'), parentLotId: null, attributes: {}, ...changes })

  it('keep their lifecycle in step with their quality status', async () => {
    const id = randomUUID()
    expect(await newLot({ id, qualityStatus: 'QUARANTINE', qualityDecidedAt: null, qualityDecidedById: null, lifecycle: 'RELEASED' })).toBe(1)
    expect((await one(`SELECT lifecycle::text AS l FROM "Lot" WHERE id = $1`, [id])).l).toBe('QUARANTINE')
    await expect(update(office(), 'Lot', id, `lifecycle = 'IN_USE'`)).rejects.toThrow(/cannot be IN_USE/)
    expect(await update(office(), 'Lot', id, `"qualityStatus" = 'RELEASED', "qualityDecidedAt" = now()`)).toBe(1)
    expect((await one(`SELECT lifecycle::text AS l FROM "Lot" WHERE id = $1`, [id])).l).toBe('RELEASED')
    expect(await update(office(), 'Lot', id, `lifecycle = 'IN_USE'`)).toBe(1)
    expect(await update(office(), 'Lot', id, `"qualityStatus" = 'BLOCKED'`)).toBe(1)
    expect((await one(`SELECT lifecycle::text AS l FROM "Lot" WHERE id = $1`, [id])).l).toBe('BLOCKED')
    await expect(update(office(), 'Lot', id, `lifecycle = 'RELEASED'`)).rejects.toThrow(/cannot be RELEASED/)
    // A rejected lot is held until its stock left; then its lifecycle still moves (W1's guard lets only it and the note).
    expect(await update(office(), 'Lot', id, `"qualityStatus" = 'REJECTED', "qualityNote" = 'Rejected (test).'`)).toBe(1)
    expect((await one(`SELECT lifecycle::text AS l FROM "Lot" WHERE id = $1`, [id])).l).toBe('BLOCKED')
    expect(await update(office(), 'Lot', id, `lifecycle = 'RETURNED'`)).toBe(1)
    await expect(update(office(), 'Lot', id, `"supplierLotRef" = 'X'`)).rejects.toThrow(/REJECTED; only its quality note/)
  })

  it('name the lot they were split from once, of their colour, and attributes typed per kind', async () => {
    await expect(newLot({ parentLotId: s.childLotId })).rejects.toThrow(/not itself split from another/)
    const child = randomUUID()
    expect(await newLot({ id: child, parentLotId: s.lotId })).toBe(1)
    await expect(update(office(), 'Lot', child, `"parentLotId" = NULL`)).rejects.toThrow(/set when it is made, never changed/)
    await expect(newLot({ attributes: { tannage: 'CHROME' } })).rejects.toThrow(/not an attribute of a lot of LINING/)
    await expect(newLot({ attributes: { widthCm: 140 } })).rejects.toThrow(/widthCm as a decimal string/)
    expect(await newLot({ attributes: { widthCm: '150.5', weightGsm: '90', origin: 'Como, IT' } })).toBe(1)
    const leatherLot = (await one(`SELECT id::text AS id FROM "Lot" WHERE code = 'SEED-LOT-LEA-01' AND "tenantId" = $1`, [a.tenantId])).id as string
    await expect(update(office(), 'Lot', leatherLot, `attributes = '{"gradeMix": {"A": "60", "B": "50"}}'::jsonb`)).rejects.toThrow(/adds up to at most 100/)
    await expect(update(office(), 'Lot', leatherLot, `attributes = '{"thicknessMinMm": "1.2", "thicknessMaxMm": "1.0"}'::jsonb`)).rejects.toThrow(/minimum is above its maximum/)
    expect(await update(office(), 'Lot', leatherLot, `attributes = '{"thicknessMinMm": "1.0", "thicknessMaxMm": "1.2", "tannage": "CHROME", "finish": "aniline", "gradeMix": {"A": "60", "B": "40"}}'::jsonb`)).toBe(1)
  })
})

describe('goods without a PO', () => {
  const newReceipt = (changes: Record<string, unknown>, scope: FactoryScope = office()) =>
    copyRow(scope, 'GoodsReceipt', s.unplannedReceiptId, { id: randomUUID(), number: tag('T-GR'), buyerTaskId: null, ...changes })

  it('wait in a holding place, made without a purchase order, posted only once one names them', async () => {
    await expect(newReceipt({ holdingLocationId: null })).rejects.toThrow(/exactly when it is UNPLANNED/)
    await expect(newReceipt({ kind: 'STANDARD' })).rejects.toThrow(/exactly when it is UNPLANNED/)
    await expect(newReceipt({ holdingLocationId: s.locations.transit })).rejects.toThrow(/not archived and not a workshop's/)
    const [po] = await admin(`SELECT id::text AS id FROM "PurchaseOrder" WHERE "tenantId" = $1 AND "siteId" = $2 AND status IN ('SENT', 'CONFIRMED', 'PARTLY_RECEIVED') AND "partyId" = $3 LIMIT 1`, [a.tenantId, A.site, A.P2])
    expect(po, 'a purchase order of P2 still to receive (seed/supply.ts)').toBeDefined()
    await expect(newReceipt({ purchaseOrderId: po!.id })).rejects.toThrow(/made without a purchase order/)
    // The floor receives them; it does not name the buyer's task.
    const floorReceipt = randomUUID()
    expect(await newReceipt({ id: floorReceipt, createdById: s.workerId }, floor())).toBe(1)
    await expect(update(floor(), 'GoodsReceipt', floorReceipt, `"buyerTaskId" = $2::uuid`, s.buyerTaskId)).rejects.toThrow(/named by the office/)
    await expect(update(office(), 'GoodsReceipt', floorReceipt, `"buyerTaskId" = $2::uuid`, s.buyerTaskId)).rejects.toThrow(/a task on that receipt/)
    await expect(update(office(), 'GoodsReceipt', s.unplannedReceiptId, `kind = 'STANDARD', "holdingLocationId" = NULL, "buyerTaskId" = NULL`)).rejects.toThrow(/kind never changes/)
    await expect(update(office(), 'GoodsReceipt', s.unplannedReceiptId, `status = 'POSTED', "postedAt" = now(), "postedById" = $2::uuid`, A.member)).rejects.toThrow(/posted once a purchase order names them/)
  })
})

describe('transfers', () => {
  const newTransfer = (changes: Record<string, unknown> = {}) => {
    const id = randomUUID()
    return copyRow(office(), 'TransferOrder', s.transferIds.draft, { id, number: tag('T-TRF'), ...changes }).then(() => id)
  }
  const newLine = (transferId: string, changes: Record<string, unknown> = {}) => {
    const id = randomUUID()
    return copyRow(office(), 'TransferLine', s.transferLineIds.draft, { id, transferId, seq: 10, ...changes }).then(() => id)
  }
  const ddt = async (): Promise<Record<string, unknown>> => {
    const series = (await one(`SELECT id::text AS id FROM "NumberSeries" WHERE "tenantId" = $1 AND "companyId" = $2 AND kind = 'DDT' LIMIT 1`, [a.tenantId, A.company])).id
    return { ddtNumberSeriesId: series, ddtNumber: tag('T-DDT'), ddtDate: new Date().toISOString().slice(0, 10), transportBy: 'SENDER', packages: 1, grossWeightKg: '5.0000', appearance: 'Rolls' }
  }
  const ship = async (transferId: string, lineId: string, quantity: string) => {
    expect(await move({ reason: 'TRANSFER', fromLocationId: s.locations.bulk, toLocationId: s.locations.transit, quantity, baseQuantity: quantity, transferLineId: lineId })).toBe(1)
    expect(await update(office(), 'TransferLine', lineId, `"shippedQuantity" = $2::numeric`, quantity)).toBe(1)
    const d = await ddt()
    expect(
      await update(office(), 'TransferOrder', transferId, `status = 'SHIPPED', "shippedAt" = now(), "shippedById" = $2::uuid, "ddtNumberSeriesId" = $3::uuid, "ddtNumber" = $4, "ddtDate" = $5::date, "transportBy" = 'SENDER', packages = 1, "grossWeightKg" = 5, appearance = 'Rolls'`, A.member, d.ddtNumberSeriesId, d.ddtNumber, d.ddtDate),
    ).toBe(1)
  }

  it('are drafted to another site through a transit place of the sending one, and lines follow the item', async () => {
    await expect(newTransfer({ status: 'SHIPPED' })).rejects.toThrow(/drafted first/)
    await expect(newTransfer({ toCompanyId: A.company, toSiteId: A.site, toLocationId: null })).rejects.toThrow(/another site/)
    await expect(newTransfer({ transitLocationId: s.locations.bulk })).rejects.toThrow(/TRANSIT location of the sending site/)
    await expect(newTransfer({ ...(await ddt()) })).rejects.toThrow(/DDT when it is shipped, not before/)
    const id = await newTransfer()
    await expect(newLine(id, { lotId: null })).rejects.toThrow(/tracked by LOT/)
    await expect(newLine(id, { fromLocationId: s.locations.transit })).rejects.toThrow(/not archived and not a transit place/)
    await expect(newLine(id, { quantity: '0' })).rejects.toThrow(/quantities above 0/)
    await expect(newLine(id, { receivedQuantity: '1' })).rejects.toThrow(/what arrived 0 to what left/)
    expect(await newLine(id)).toBeTruthy()
  })

  it('ship onto the transit place with their DDT, then what was sent and the DDT never change', async () => {
    const id = await newTransfer()
    const line = await newLine(id, { quantity: '6.0000', baseQuantity: '6.0000' })
    await expect(update(office(), 'TransferOrder', id, `status = 'SHIPPED', "shippedAt" = now(), "shippedById" = $2::uuid`, A.member)).rejects.toThrow(/travels with its DDT/)
    const d = await ddt()
    await expect(
      update(office(), 'TransferOrder', id, `status = 'SHIPPED', "shippedAt" = now(), "shippedById" = $2::uuid, "ddtNumberSeriesId" = $3::uuid, "ddtNumber" = $4, "ddtDate" = $5::date, "transportBy" = 'SENDER', packages = 1, "grossWeightKg" = 5, appearance = 'Rolls'`, A.member, d.ddtNumberSeriesId, d.ddtNumber, d.ddtDate),
    ).rejects.toThrow(/every line says what left/)
    await expect(move({ reason: 'TRANSFER', fromLocationId: s.locations.bulk, toLocationId: s.locations.pickFace, quantity: '6.0000', baseQuantity: '6.0000', transferLineId: line })).rejects.toThrow(/onto the transfer's transit location/)
    await ship(id, line, '6.0000')
    await expect(update(office(), 'TransferLine', line, `quantity = 7, "baseQuantity" = 7`)).rejects.toThrow(/fixed once it left/)
    await expect(update(office(), 'TransferOrder', id, `"ddtNumber" = 'T-OTHER'`)).rejects.toThrow(/the ship and its DDT never change/)
    await expect(update(office(), 'TransferOrder', id, `status = 'CANCELLED', "cancelledAt" = now(), "cancelReason" = 'x'`)).rejects.toThrow(/not SHIPPED → CANCELLED/)
    expect(await update(office(), 'TransferOrder', id, `"trackingRef" = 'T-TRK', "trackingUrl" = 'https://tracking.example.com/T-TRK', "expectedOn" = "ddtDate" + 2`)).toBe(1)
    await expect(update(office(), 'TransferOrder', id, `"trackingUrl" = 'http://tracking.example.com/x'`)).rejects.toThrow(/https page/)
    await expect(admin(`DELETE FROM "TransferOrder" WHERE id = $1`, [id])).rejects.toThrow(/never deleted/)
    await expect(admin(`DELETE FROM "TransferLine" WHERE id = $1`, [line])).rejects.toThrow(/removed while the transfer is DRAFT/)
  })

  it('move a transit place only with a transfer, and only from the office', async () => {
    await expect(move({ reason: 'ADJUSTMENT', toLocationId: s.locations.transit })).rejects.toThrow(/transit location without its transfer/)
    await expect(move({ reason: 'TRANSFER_OUT', fromLocationId: s.locations.transit })).rejects.toThrow(/names its transfer line/)
    await expect(move({ reason: 'ADJUSTMENT', fromLocationId: s.locations.transit, transferLineId: s.transferLineIds.shipped }, floor())).rejects.toThrow(/posted by the office/)
    await expect(move({ reason: 'OPENING', toLocationId: s.locations.bulk, transferLineId: s.transferLineIds.shipped })).rejects.toThrow(/only a TRANSFER, TRANSFER_OUT, TRANSFER_IN or ADJUSTMENT/)
  })

  it('are received at the other site as its own lot, a difference with its reason, then RECEIVED', async () => {
    const id = await newTransfer()
    const line = await newLine(id, { quantity: '8.0000', baseQuantity: '8.0000' })
    await ship(id, line, '8.0000')
    // The receiving site's lot of the same goods (company B's plant B1).
    const lotB = randomUUID()
    expect(await copyRow(office(), 'Lot', s.lotId, { id: lotB, code: tag('T-LOT-B1'), companyId: A.companyB, siteId: A.siteB, parentLotId: null })).toBe(1)
    const atB = { companyId: A.companyB, siteId: A.siteB, lotId: lotB, toLocationId: A.storeB, transferLineId: line }
    await expect(move({ reason: 'TRANSFER_IN', ...atB, quantity: '5.0000', baseQuantity: '5.0000' })).rejects.toThrow(/as the lot and hide the line names there/)
    expect(await update(office(), 'TransferLine', line, `"toLotId" = $2::uuid`, lotB)).toBe(1)
    await expect(move({ reason: 'TRANSFER_OUT', fromLocationId: s.locations.bulk, transferLineId: line, quantity: '5.0000', baseQuantity: '5.0000' })).rejects.toThrow(/take them off it/)
    // The receipt of 5 m: off the transit place at A1, into B1's store, in one command.
    expect(await move({ reason: 'TRANSFER_OUT', fromLocationId: s.locations.transit, transferLineId: line, quantity: '5.0000', baseQuantity: '5.0000' })).toBe(1)
    expect(await move({ reason: 'TRANSFER_IN', ...atB, quantity: '5.0000', baseQuantity: '5.0000' })).toBe(1)
    await expect(update(office(), 'TransferLine', line, `"receivedQuantity" = 9`)).rejects.toThrow(/what arrived 0 to what left/)
    expect(await update(office(), 'TransferLine', line, `"receivedQuantity" = 5, "toLocationId" = $2::uuid`, A.storeB)).toBe(1)
    await expect(update(office(), 'TransferLine', line, `"receivedQuantity" = 4`)).rejects.toThrow(/never goes back/)
    expect(await update(office(), 'TransferOrder', id, `status = 'PARTLY_RECEIVED'`)).toBe(1)
    await expect(update(office(), 'TransferOrder', id, `status = 'RECEIVED', "receivedAt" = now(), "receivedById" = $2::uuid`, A.member)).rejects.toThrow(/says why it did not/)
    await expect(update(office(), 'TransferLine', line, `"differenceResolution" = 'ADJUSTMENT', "resolvedAt" = now()`)).rejects.toThrow(/after its reason/)
    expect(await update(office(), 'TransferLine', line, `"differenceReasonCode" = 'DAMAGED_IN_TRANSIT', "differenceNote" = 'A roll arrived wet (test).'`)).toBe(1)
    expect(await update(office(), 'TransferOrder', id, `status = 'RECEIVED', "receivedAt" = now(), "receivedById" = $2::uuid`, A.member)).toBe(1)
    // The 3 m that did not arrive stay on the transit place until they are written off, naming the line.
    const transit = await one(
      `SELECT coalesce(sum(CASE WHEN "toLocationId" = $1 THEN "baseQuantity" ELSE -"baseQuantity" END), 0)::text AS q FROM "StockMove"
        WHERE "transferLineId" = $2 AND ("toLocationId" = $1 OR "fromLocationId" = $1)`,
      [s.locations.transit, line],
    )
    expect(transit.q).toBe('3.0000')
    expect(await move({ reason: 'ADJUSTMENT', fromLocationId: s.locations.transit, transferLineId: line, quantity: '3.0000', baseQuantity: '3.0000', note: 'Lost in transit (test).' })).toBe(1)
    expect(await update(office(), 'TransferLine', line, `"differenceResolution" = 'ADJUSTMENT', "resolvedAt" = now(), "resolvedById" = $2::uuid`, A.member)).toBe(1)
    await expect(update(office(), 'TransferLine', line, `"differenceResolution" = 'CARRIER_CLAIM'`)).rejects.toThrow(/settled once/)
    await expect(update(office(), 'TransferOrder', id, `"expectedOn" = "expectedOn"`)).resolves.toBe(1)
    await expect(update(office(), 'TransferOrder', id, `"trackingRef" = 'late'`)).rejects.toThrow(/RECEIVED and never changes/)
  })
})

describe('counts', () => {
  it('a frozen line refuses moves of its item at its place until it is counted', async () => {
    await expect(stockInto(s.locations.countBay)).rejects.toThrow(/SEED-CNT-W36-01 is counting this material/)
    await expect(move({ reason: 'TRANSFER', fromLocationId: s.locations.countBay, toLocationId: s.locations.bulk })).rejects.toThrow(/frozen line/)
    // The count's own COUNT move is no move to freeze.
    expect(await move({ reason: 'COUNT', toLocationId: s.locations.countBay, note: 'Count (test).' })).toBe(1)
    await expect(update(office(), 'StockCount', s.countId, `"freezeMoves" = false`)).rejects.toThrow(/chosen while it was DRAFT/)
    const draftCount = randomUUID()
    expect(await copyRow(office(), 'StockCount', s.countId, { id: draftCount, number: tag('T-CNT'), status: 'DRAFT', startedAt: null, snapshotAt: null, freezeMoves: false })).toBe(1)
    await expect(copyRow(office(), 'StockCountLine', s.countLineIds.added, { id: randomUUID(), countId: draftCount, seq: 50 })).rejects.toThrow(/frozen only when its count freezes moves/)
  })

  it('the floor counts by scan: it reads the count, adds what it found, writes its count and nothing else', async () => {
    const counted = await sql(floor(), `SELECT number FROM "StockCount" WHERE id = $1::uuid`, s.countId)
    expect(counted).toEqual([{ number: 'SEED-CNT-W36-01' }])
    await expect(sql(floor(), `SELECT "differenceAmount" FROM "StockCount" LIMIT 1`)).rejects.toThrow(/permission denied/)
    await expect(copyRow(floor(), 'StockCountLine', s.countLineIds.frozen, { id: randomUUID(), seq: 60 })).rejects.toThrow(/only what it found that was not expected/)
    expect(await copyRow(floor(), 'StockCountLine', s.countLineIds.added, { id: randomUUID(), seq: 70, lotId: s.lotId, countedQuantity: '1.0000' })).toBe(1)
    await expect(update(floor(), 'StockCountLine', s.countLineIds.frozen, `"reasonCode" = 'COUNT_ERROR'`)).rejects.toThrow(/writes what it counted and recounted/)
    // The frozen line is counted from the floor: then its place moves again.
    expect(await update(floor(), 'StockCountLine', s.countLineIds.frozen, `"countedQuantity" = 10, "countedAt" = now()`)).toBe(1)
    expect(await move({ reason: 'TRANSFER', fromLocationId: s.locations.countBay, toLocationId: s.locations.bulk, quantity: '0.5000', baseQuantity: '0.5000' })).toBe(1)
  })

  it('a scan is kept as made, adds above 0, into a COUNTING count; a recount is asked first, and another person scans it', async () => {
    const scan = (changes: Record<string, unknown>, scope: FactoryScope = floor()) => copyRow(scope, 'StockCountScan', s.scanIds[0], { id: randomUUID(), scannedAt: new Date().toISOString(), ...changes })
    await expect(run(office(), `UPDATE "StockCountScan" SET quantity = quantity WHERE id = $1::uuid`, s.scanIds[0])).rejects.toThrow(/permission denied/)
    await expect(admin(`UPDATE "StockCountScan" SET quantity = 3 WHERE id = $1`, [s.scanIds[0]])).rejects.toThrow(/append-only: UPDATE/)
    await expect(admin(`DELETE FROM "StockCountScan" WHERE id = $1`, [s.scanIds[0]])).rejects.toThrow(/append-only: DELETE/)
    await expect(scan({ quantity: '0' })).rejects.toThrow(/adds above 0/)
    await expect(scan({ scannedByWorkerId: null, scannedById: A.member })).rejects.toThrow(/a floor session as its worker/)
    await expect(scan({ code: 'two words' })).rejects.toThrow(/by its code/)
    await expect(scan({ pass: 'RECOUNT' })).rejects.toThrow(/whose recount was not asked/)
    expect(await update(office(), 'StockCountLine', s.countLineIds.added, `"recountRequestedAt" = now(), "recountRequestedById" = $2::uuid`, A.member)).toBe(1)
    await expect(scan({ pass: 'RECOUNT' })).rejects.toThrow(/its recount is another person's/)
    expect(await scan({ pass: 'RECOUNT', scannedByWorkerId: A.lead, createdById: A.lead }, floor(A.lead))).toBe(1)
    // The company's switch off (with its reason): the same person may recount.
    await expect(update(office(), 'InventorySettings', s.settingsIds.companyA, `"counterNotApprover" = false`)).rejects.toThrow(/exactly with the reason/)
    expect(await update(office(), 'InventorySettings', s.settingsIds.companyA, `"counterNotApprover" = false, "separationOffReason" = 'One person runs the store this month (test).'`)).toBe(1)
    try {
      expect(await scan({ pass: 'RECOUNT', code: 'SEED-LOT-W36-01A-AGAIN' })).toBe(1)
    } finally {
      expect(await update(office(), 'InventorySettings', s.settingsIds.companyA, `"counterNotApprover" = NULL, "separationOffReason" = NULL`)).toBe(1)
    }
  }, 60_000)

  it('the counter never approves their own variance, a scan of theirs included, while the switch is on', async () => {
    // A count of the bulk rack's lining by the member (a scan as an office user), differing; submitted by another person.
    const count = randomUUID()
    expect(await copyRow(office(), 'StockCount', s.countId, { id: count, number: tag('T-CNT'), locationId: s.locations.bulk, freezeMoves: false })).toBe(1)
    const line = randomUUID()
    expect(await copyRow(office(), 'StockCountLine', s.countLineIds.frozen, { id: line, countId: count, locationId: s.locations.bulk, frozenAt: null, expectedQuantity: '1.0000', countedQuantity: '2.0000', countedAt: new Date().toISOString(), countedById: null })).toBe(1)
    expect(await copyRow(office(), 'StockCountScan', s.scanIds[1], { id: randomUUID(), countId: count, lineId: line, scannedByWorkerId: null, scannedById: A.member, deviceId: null, scannedAt: new Date().toISOString(), quantity: '2.0000' })).toBe(1)
    expect(await update(office(), 'StockCount', count, `status = 'SUBMITTED', "submittedAt" = now(), "submittedById" = $2::uuid, "differenceAmount" = 210, "approvalRequired" = true`, a.actorId)).toBe(1)
    await expect(update(office(), 'StockCount', count, `status = 'APPROVED', "approvedAt" = now(), "approvedById" = $2::uuid`, A.member)).rejects.toThrow(/never approves their own variance/)
    // The floor writes nothing into a count that left COUNTING.
    await expect(update(floor(), 'StockCountLine', line, `"countedQuantity" = 3`)).rejects.toThrow(/counts while the count is COUNTING, not SUBMITTED/)
    expect(await update(office(), 'StockCount', count, `status = 'APPROVED', "approvedAt" = now(), "approvedById" = $2::uuid`, a.actorId)).toBe(1)
  })
})

describe('posting dates', () => {
  const rome = async (days: number): Promise<string> => (await one(`SELECT ((now() AT TIME ZONE 'Europe/Rome')::date + $1::int)::text AS d`, [days])).d as string

  it('are not after the day the move is entered, nor further back than the company allows; the floor posts today', async () => {
    await expect(stockInto(s.locations.pickFace).then(() => move({ reason: 'TRANSFER', fromLocationId: s.locations.pickFace, toLocationId: s.locations.bulk, postingDate: '2999-01-01' }))).rejects.toThrow(/not after the day it is entered/)
    // Company A allows 3 days back (its row wins over the tenant's 7).
    await expect(move({ reason: 'TRANSFER', fromLocationId: s.locations.pickFace, toLocationId: s.locations.bulk, postingDate: await rome(-4) })).rejects.toThrow(/further than its company allows \(3 days/)
    expect(await move({ reason: 'TRANSFER', fromLocationId: s.locations.pickFace, toLocationId: s.locations.bulk, postingDate: await rome(-3) })).toBe(1)
    await expect(move({ reason: 'TRANSFER', fromLocationId: s.locations.pickFace, toLocationId: s.locations.bulk, postingDate: await rome(-1), createdById: s.workerId }, floor())).rejects.toThrow(/posted from the floor counts on the day it is entered/)
    expect(await move({ reason: 'TRANSFER', fromLocationId: s.locations.pickFace, toLocationId: s.locations.bulk, postingDate: await rome(0), createdById: s.workerId }, floor())).toBe(1)
  })

  it("count in a closed period by the posting date: the period lock reads it", async () => {
    const lock = randomUUID()
    const today = await rome(0)
    const first = (await one(`SELECT date_trunc('month', $1::date)::date::text AS d`, [today])).d as string
    const last = (await one(`SELECT (date_trunc('month', $1::date) + interval '1 month' - interval '1 day')::date::text AS d`, [today])).d as string
    await admin(`INSERT INTO "PeriodLock" (id, "tenantId", "companyId", "periodStart", "periodEnd", level, status, "lockedAt", "lockedById") VALUES ($1, $2, $3, $4::date, $5::date, 'HARD', 'LOCKED', now(), $6)`, [lock, a.tenantId, A.company, first, last, A.member])
    try {
      await expect(move({ reason: 'TRANSFER', fromLocationId: s.locations.bulk, toLocationId: s.locations.pickFace, occurredAt: '2026-01-15T10:00:00.000Z', postingDate: today })).rejects.toThrow(/inside the closed period/)
    } finally {
      await admin(`UPDATE "PeriodLock" SET status = 'UNLOCKED', "unlockedAt" = now(), "unlockedById" = $2, "unlockReason" = 'Test over.' WHERE id = $1`, [lock, A.member])
    }
    expect(await move({ reason: 'TRANSFER', fromLocationId: s.locations.bulk, toLocationId: s.locations.pickFace, postingDate: today })).toBe(1)
  })
})

describe('the warehouse rules and default places', () => {
  it('rules: 0 to 366 days back, a threshold of 0 or more, a separation switched off only with its reason', async () => {
    await expect(update(office(), 'InventorySettings', s.settingsIds.tenant, `"backDatingDays" = 400`)).rejects.toThrow(/0 to 366 days back/)
    await expect(update(office(), 'InventorySettings', s.settingsIds.companyA, `"adjustmentApprovalAmount" = -1`)).rejects.toThrow(/threshold of 0 or more/)
    await expect(update(office(), 'InventorySettings', s.settingsIds.tenant, `"receiverNotMatcher" = false`)).rejects.toThrow(/exactly with the reason/)
    await expect(update(office(), 'InventorySettings', s.settingsIds.tenant, `"separationOffReason" = 'why'`)).rejects.toThrow(/exactly with the reason/)
    await expect(update(office(), 'InventorySettings', s.settingsIds.tenant, `"companyId" = $2::uuid`, A.company)).rejects.toThrow(/never change/)
    await expect(admin(`DELETE FROM "InventorySettings" WHERE id = $1`, [s.settingsIds.tenant])).rejects.toThrow(/never deleted/)
  })

  it('defaults: one active per site, kind and purpose, a usable place, the key fixed', async () => {
    const add = (changes: Record<string, unknown>) => copyRow(office(), 'DefaultLocation', s.defaultIds.putAway, { id: randomUUID(), ...changes })
    await expect(add({})).rejects.toThrow(/DefaultLocation_one_active_per_kind/)
    await expect(copyRow(office(), 'DefaultLocation', s.defaultIds.receiving, { id: randomUUID() })).rejects.toThrow(/DefaultLocation_one_active_fallback/)
    await expect(add({ itemKind: 'TRIM', locationId: s.locations.transit })).rejects.toThrow(/not a workshop's, a customer's or a transit place/)
    expect(await add({ itemKind: 'TRIM', locationId: s.locations.pickFace })).toBe(1)
    await expect(update(office(), 'DefaultLocation', s.defaultIds.putAway, `purpose = 'ISSUE'`)).rejects.toThrow(/never change/)
    expect(await update(office(), 'DefaultLocation', s.defaultIds.putAway, `"locationId" = $2::uuid, "updatedById" = $3::uuid`, s.locations.pickFace, A.member)).toBe(1)
  })

  it('schedules: at least one scope, every 1 to 366 days, the last count a closed one', async () => {
    const add = (changes: Record<string, unknown>) => copyRow(office(), 'CountSchedule', s.scheduleIds.monthly, { id: randomUUID(), ...changes })
    await expect(add({ locationId: null })).rejects.toThrow(/at least one/)
    await expect(add({ everyDays: 0 })).rejects.toThrow(/every 1 to 366 days/)
    await expect(add({ locationId: s.locations.transit })).rejects.toThrow(/not a workshop's/)
    await expect(add({ lastCountId: s.countId, lastCountedOn: '2026-11-05' })).rejects.toThrow(/closed \(APPLIED or SIGNED_OFF\)/)
    expect(await add({ abcClass: 'B', itemKind: 'LINING', locationId: null, everyDays: 14 })).toBe(1)
  })
})

describe('the task inbox', () => {
  const add = (changes: Record<string, unknown>, scope: FactoryScope = office()) => {
    const id = randomUUID()
    return copyRow(scope, 'WarehouseTask', s.taskIds.open, { id, ...changes }).then(() => id)
  }

  it('is made OPEN, for a floor role or a worker, and the floor takes, gives back and does', async () => {
    await expect(add({ status: 'TAKEN', takenAt: new Date().toISOString(), takenByWorkerId: s.workerId })).rejects.toThrow(/made OPEN/)
    await expect(add({ assignedWorkerId: s.workerId })).rejects.toThrow(/a role or a worker \(not both\)/)
    const officeRole = (await one(`SELECT id::text AS id FROM "Role" WHERE "tenantId" = $1 AND audience = 'OFFICE' LIMIT 1`, [a.tenantId])).id
    await expect(add({ assignedRoleId: officeRole })).rejects.toThrow(/a floor role/)
    await expect(add({ sourceType: 'GoodsReceipt', sourceId: null })).rejects.toThrow(/both or neither/)
    const id = await add({ createdById: s.workerId }, floor())
    await expect(update(floor(), 'WarehouseTask', id, `status = 'TAKEN', "takenAt" = now(), "takenById" = $2::uuid`, A.member)).rejects.toThrow(/signed-in worker/)
    expect(await update(floor(), 'WarehouseTask', id, `status = 'TAKEN', "takenAt" = now(), "takenByWorkerId" = $2::uuid`, s.workerId)).toBe(1)
    await expect(update(floor(), 'WarehouseTask', id, `"toLocationId" = $2::uuid`, s.locations.pickFace)).rejects.toThrow(/taken, given back or done/)
    await expect(update(floor(), 'WarehouseTask', id, `status = 'CANCELLED', "cancelledAt" = now(), "cancelReason" = 'x'`)).rejects.toThrow(/taken, given back or done/)
    expect(await update(floor(A.lead), 'WarehouseTask', id, `status = 'OPEN', "takenAt" = NULL, "takenByWorkerId" = NULL`)).toBe(1)
    expect(await update(floor(A.lead), 'WarehouseTask', id, `status = 'DONE', "doneAt" = now(), "doneByWorkerId" = $2::uuid`, A.lead)).toBe(1)
    await expect(update(office(), 'WarehouseTask', id, `"dueAt" = now()`)).rejects.toThrow(/DONE and never changes/)
    await expect(admin(`DELETE FROM "WarehouseTask" WHERE id = $1`, [id])).rejects.toThrow(/never deleted/)
  })
})

describe('substitutes', () => {
  const add = (changes: Record<string, unknown>, scope: FactoryScope = office()) => {
    const id = randomUUID()
    return copyRow(scope, 'MaterialSubstitution', s.substitutionIds.waiting, { id, approvalTaskId: null, ...changes }).then(() => id)
  }

  it('are asked WAITING, another lot of the material or an alternate of the line, and nobody decides their own', async () => {
    await expect(add({ status: 'APPROVED', decidedAt: new Date().toISOString() })).rejects.toThrow(/asked first/)
    await expect(add({ toLotId: null })).rejects.toThrow(/another lot of the line's own material/)
    const protector = (await one(`SELECT id::text AS id FROM "Item" WHERE "tenantId" = $1 AND code = 'SEED-PRO-300'`, [a.tenantId])).id
    await expect(add({ toItemId: protector, toItemColourId: null, toLotId: null })).rejects.toThrow(/alternate of its BOM line/)
    await expect(add({ ruleAnswer: { held: [] } })).rejects.toThrow(/"may": true \| false/)
    await expect(add({ requestedByWorkerId: null, requestedById: A.member }, floor())).rejects.toThrow(/a floor session as its worker/)
    const asked = await add({ requestedByWorkerId: null, requestedById: A.member, createdById: A.member })
    await expect(update(office(), 'MaterialSubstitution', asked, `status = 'APPROVED', "decidedAt" = now(), "decidedById" = $2::uuid`, A.member)).rejects.toThrow(/nobody decides their own request/)
    await expect(update(office(), 'MaterialSubstitution', asked, `status = 'REFUSED', "decidedAt" = now(), "decidedById" = $2::uuid`, a.actorId)).rejects.toThrow(/a no with who and why/)
    expect(await update(office(), 'MaterialSubstitution', asked, `"approvalTaskId" = $2::uuid`, randomUUID())).toBe(1)
    await expect(update(office(), 'MaterialSubstitution', asked, `"approvalTaskId" = $2::uuid`, randomUUID())).rejects.toThrow(/named once/)
    await expect(update(office(), 'MaterialSubstitution', asked, `status = 'APPROVED', "decidedAt" = now()`)).rejects.toThrow(/by whom when a yes was asked/)
    expect(await update(office(), 'MaterialSubstitution', asked, `status = 'APPROVED', "decidedAt" = now(), "decidedById" = $2::uuid`, a.actorId)).toBe(1)
    await expect(update(office(), 'MaterialSubstitution', asked, `quantity = 5, "baseQuantity" = 5`)).rejects.toThrow(/never change/)
  })

  it('are issued with ISSUE moves of the work order and the substitute; the floor asks and issues only', async () => {
    const asked = await add({ createdById: s.workerId }, floor())
    await expect(update(floor(), 'MaterialSubstitution', asked, `status = 'APPROVED', "decidedAt" = now(), "decidedById" = $2::uuid`, A.member)).rejects.toThrow(/asked for and, once approved, issued/)
    expect(await update(office(), 'MaterialSubstitution', asked, `status = 'APPROVED', "decidedAt" = now()`)).toBe(1)
    // The substitute's lot has stock at the bulk rack; the floor issues 4 m to WO-0001.
    await admin(`INSERT INTO "StockMove" (id, "tenantId", "companyId", "siteId", reason, "itemId", "itemColourId", "lotId", "toLocationId", quantity, uom, "baseQuantity", "idempotencyKey", "occurredAt") VALUES ($1, $2, $3, $4, 'OPENING', $5, $6, $7, $8, 10, 'M', 10, $9, now())`, [randomUUID(), a.tenantId, A.company, A.site, A.lining, A.grey, s.substituteLotId, s.locations.bulk, tag('t-open')])
    const issue = randomUUID()
    expect(
      await run(
        floor(),
        `INSERT INTO "StockMove" (id, "companyId", "siteId", reason, "itemId", "itemColourId", "lotId", "fromLocationId", quantity, uom, "baseQuantity", "workOrderId", "idempotencyKey", "occurredAt", "createdById") VALUES ($1::uuid, $2::uuid, $3::uuid, 'ISSUE', $4::uuid, $5::uuid, $6::uuid, $7::uuid, 4, 'M', 4, $8::uuid, $9, now(), $10::uuid)`,
        issue, A.company, A.site, A.lining, A.grey, s.substituteLotId, s.locations.bulk, s.workOrderId, tag('t-issue'), s.workerId,
      ),
    ).toBe(1)
    await expect(update(floor(), 'MaterialSubstitution', asked, `status = 'ISSUED', "issuedAt" = now(), "moveIds" = ARRAY[$2::uuid]`, s.shipMoveId)).rejects.toThrow(/ISSUE moves of its work order and of the substitute/)
    expect(await update(floor(), 'MaterialSubstitution', asked, `status = 'ISSUED', "issuedAt" = now(), "moveIds" = ARRAY[$2::uuid]`, issue)).toBe(1)
    await expect(update(office(), 'MaterialSubstitution', asked, `status = 'WITHDRAWN', "withdrawnAt" = now(), "withdrawReason" = 'x'`)).rejects.toThrow(/not ISSUED → WITHDRAWN/)
    await expect(update(office(), 'MaterialSubstitution', asked, `reason = 'Changed.'`)).rejects.toThrow(/never change/)
  })
})

describe('grants', () => {
  it('the floor reads its defaults, tasks, scans, counts and the rules but the threshold; transfers and schedules are the office\'s', async () => {
    expect((await sql(floor(), `SELECT count(*)::int AS n FROM "DefaultLocation"`))[0]!.n).toBeGreaterThan(0)
    expect((await sql(floor(), `SELECT count(*)::int AS n FROM "WarehouseTask"`))[0]!.n).toBeGreaterThan(0)
    expect((await sql(floor(), `SELECT "backDatingDays", "counterNotApprover" FROM "InventorySettings" WHERE id = $1::uuid`, s.settingsIds.companyA))).toHaveLength(1)
    await expect(sql(floor(), `SELECT "adjustmentApprovalAmount" FROM "InventorySettings" LIMIT 1`)).rejects.toThrow(/permission denied/)
    for (const table of ['TransferOrder', 'TransferLine', 'CountSchedule']) {
      await expect(sql(floor(), `SELECT 1 FROM "${table}" LIMIT 1`)).rejects.toThrow(/permission denied/)
    }
    for (const table of ['DefaultLocation', 'TransferOrder', 'TransferLine', 'CountSchedule', 'StockCountScan', 'InventorySettings', 'WarehouseTask', 'MaterialSubstitution']) {
      await expect(sql(partner(A.P1), `SELECT 1 FROM "${table}" LIMIT 1`)).rejects.toThrow(/permission denied/)
    }
    await expect(admin(`TRUNCATE "WarehouseTask"`)).rejects.toThrow(/TRUNCATE on "WarehouseTask" is refused/)
  })
})
