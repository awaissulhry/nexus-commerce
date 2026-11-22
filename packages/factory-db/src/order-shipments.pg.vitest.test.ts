import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedShipping, type ShippingSeed } from '../seed/shipping'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * The order shipments tab's schema wave ("order shipments 1/1", …_order_shipments_guards; B-OS-020, B-OS-021, B-OS-024) on a
 * database built from the migrations, through the real login and the scoped client, the core and shipping seeds (SEED-SH-0001
 * left with carrier labels for SEED-SO-0002; SEED-SH-0002 a DRAFT of SEED-SO-0003's jacket, one parcel):
 *   - a tracking number typed by hand per parcel: only on an unlabelled CARRIER parcel from PACKED on, still after the goods left
 *     (nothing else of the parcel changes then), never beside a label, hidden from the floor (which never writes a label either),
 *     read by the customer's own portal; a parcel holding one is not removed, its shipment does not leave CARRIER;
 *   - a split child is made for one of its own orders: the parent's first order or the order of a line it carries; at commit a
 *     child that carries garments carries one of that order (X1-B1);
 *   - a shipment that travels without a DDT gets none, and the choice waits until its live DDT is cancelled (L13).
 * Every name and number is made up. The refusals are check_violation (23514) in words; their messages are read through raw SQL.
 * Run with `node scripts/factory/run-pg-tests.mjs order-shipments`.
 */

const NS = 'os-order-shipments'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let s: ShippingSeed

const key = (name: string): string => seedUuid(NS, name)
const SITE_A1 = key('site:A1')
const P1 = key('party:P1')
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: randomUUID(), siteId: SITE_A1 })
const partner = (party = P1): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: a.actorId, partyId: party })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
/** INSERT a copy of row `id` of `table` with `changes` (a jsonb object of columns). */
const copyText = (table: string) => `INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`
const copyRow = (scope: FactoryScope, table: string, id: string, changes: Record<string, unknown>) => run(scope, copyText(table), JSON.stringify(changes), id)
const update = (scope: FactoryScope, table: string, id: string, set: string, ...values: unknown[]) => run(scope, `UPDATE "${table}" SET ${set} WHERE id = $1::uuid`, id, ...values)
/** Past the guards (the world's made-up facts only: never what the test then proves). */
const force = (statement: string) => admin(`BEGIN; SET LOCAL session_replication_role = replica; ${statement}; COMMIT;`)
const tag = (): string => randomUUID().slice(0, 8)

/** A DRAFT shipment of its own: a copy of SEED-SH-0002 (SEED-SO-0003's, CARRIER) with no line and no parcel. */
async function draftShipment(changes: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  const fresh = {
    id,
    number: `SH-OS-${tag()}`,
    status: 'DRAFT',
    packedAt: null,
    shippedAt: null,
    deliveredAt: null,
    returnedAt: null,
    transportEvidence: 'NOT_NEEDED',
    transportEvidenceAt: null,
    transportEvidenceById: null,
    manualTrackingNumber: null,
    manualTrackingUrl: null,
    manifestId: null,
    splitFromId: null,
    splitReason: null,
    version: 1,
  }
  expect(await copyRow(office(), 'Shipment', s.draftShipmentId, { ...fresh, ...changes })).toBe(1)
  return id
}
/** A parcel of `shipmentId` with no label (a copy of SEED-SH-0002's). */
async function parcelOf(shipmentId: string, seq = 1): Promise<string> {
  const id = randomUUID()
  expect(await copyRow(office(), 'Parcel', s.draftParcelId, { id, shipmentId, seq, trackingNumber: null, carrierParcelId: null, trackingUrl: null, labelledAt: null, manualTrackingNumber: null, manualTrackingUrl: null, version: 1 })).toBe(1)
  return id
}
/** One garment of a work order cell onto a shipment (the line guard, the release and order caps hold). */
const lineText = `INSERT INTO "ShipmentLine" (id, "tenantId", "siteId", "partyId", "shipmentId", "workOrderId", "workOrderSizeId", "salesOrderLineId", size, quantity)
  SELECT $1::uuid, c."tenantId", c."siteId", s."partyId", s.id, c."workOrderId", c.id, c."salesOrderLineId", c.size, 1 FROM "WorkOrderSize" c, "Shipment" s WHERE c.id = $2::uuid AND s.id = $3::uuid`

beforeAll(async () => {
  db = await migratedDatabase('ordershipments')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  s = await seedShipping({ db: factory, namespace: NS })
}, 300_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

// ---- B-OS-020 -------------------------------------------------------------------------------------------------------------------
describe('B-OS-020: a tracking number typed by hand per parcel', () => {
  it('only on an unlabelled CARRIER parcel from PACKED on; once the goods left it still changes, nothing else of the parcel does', async () => {
    const shipment = await draftShipment()
    const parcel = await parcelOf(shipment)
    await expect(update(office(), 'Parcel', parcel, `"manualTrackingNumber" = 'AWB 157-12345675'`)).rejects.toThrow(/only when a carrier carries its shipment and it is packed or left/)
    // The goods left (made up past the guards).
    await force(`UPDATE "Shipment" SET status = 'SHIPPED', "packedAt" = now() - interval '2 days', "shippedAt" = now() - interval '1 day' WHERE id = '${shipment}'`)
    expect(await update(office(), 'Parcel', parcel, `"manualTrackingNumber" = 'AWB 157-12345675', version = version + 1`)).toBe(1)
    expect(await update(office(), 'Parcel', parcel, `"manualTrackingUrl" = 'https://track.example.com/157-12345675', version = version + 1`)).toBe(1)
    await expect(update(office(), 'Parcel', parcel, `"manualTrackingNumber" = $2`, 'x'.repeat(101))).rejects.toThrow(/1 to 100 characters on one line/)
    await expect(update(office(), 'Parcel', parcel, `"manualTrackingUrl" = 'http://track.example.com/x'`)).rejects.toThrow(/https, up to 500 characters/)
    await expect(update(office(), 'Parcel', parcel, `"manualTrackingNumber" = NULL`)).rejects.toThrow(/a tracking link only with it/)
    // Nothing else of a parcel changes once its goods left (the parcel guard's words stay).
    await expect(update(office(), 'Parcel', parcel, `"declaredValue" = 1000`)).rejects.toThrow(/change until it leaves/)
    await expect(update(office(), 'Parcel', parcel, `"grossWeightKg" = 9, "manualTrackingNumber" = 'AWB 2'`)).rejects.toThrow(/change until it leaves/)
    // Corrected and cleared after leaving.
    expect(await update(office(), 'Parcel', parcel, `"manualTrackingNumber" = 'AWB 157-12345686', version = version + 1`)).toBe(1)
    // The customer's own portal reads it; another customer reads no parcel of it.
    expect(await sql(partner(), `SELECT "manualTrackingNumber", "manualTrackingUrl" FROM "Parcel" WHERE id = $1::uuid`, parcel)).toEqual([{ manualTrackingNumber: 'AWB 157-12345686', manualTrackingUrl: 'https://track.example.com/157-12345675' }])
    expect(await sql(partner(key('party:P3')), `SELECT id FROM "Parcel" WHERE id = $1::uuid`, parcel)).toEqual([])
  })

  it('never beside a carrier label; a CANCELLED shipment’s parcels never change', async () => {
    const [labelled] = s.parcelIds
    await expect(update(office(), 'Parcel', labelled, `"manualTrackingNumber" = 'AWB 999'`)).rejects.toThrow(/a label and a tracking number typed by hand never both/)
    const cancelled = await draftShipment()
    const parcel = await parcelOf(cancelled)
    await force(`UPDATE "Shipment" SET status = 'CANCELLED', "cancelledAt" = now(), "cancelReason" = 'Test: made up' WHERE id = '${cancelled}'`)
    await expect(update(office(), 'Parcel', parcel, `"manualTrackingNumber" = 'AWB 1'`)).rejects.toThrow(/its parcels are added and removed while it is a DRAFT, and change until it leaves/)
  })

  it('the floor neither reads nor writes it, and never writes a carrier label (it packs)', async () => {
    await expect(sql(floor(), `SELECT "manualTrackingNumber" FROM "Parcel" LIMIT 1`)).rejects.toThrow(/permission denied/)
    await expect(sql(floor(), `SELECT "manualTrackingUrl" FROM "Parcel" LIMIT 1`)).rejects.toThrow(/permission denied/)
    const shipment = await draftShipment()
    const parcel = await parcelOf(shipment)
    await expect(update(floor(), 'Parcel', parcel, `"manualTrackingNumber" = 'X'`)).rejects.toThrow(/permission denied/)
    await expect(update(floor(), 'Parcel', parcel, `"trackingNumber" = 'FLOOR-1', "labelledAt" = now()`)).rejects.toThrow(/written by the office; the floor packs it/)
    // It still weighs and measures.
    expect(await update(floor(), 'Parcel', parcel, `"grossWeightKg" = 2.5, version = version + 1`)).toBe(1)
  })

  it('a parcel holding one is not removed, and its shipment does not leave CARRIER (L12: a trigger on transportBy only)', async () => {
    const shipment = await draftShipment()
    const parcel = await parcelOf(shipment)
    await force(`UPDATE "Shipment" SET status = 'PACKED', "packedAt" = now() WHERE id = '${shipment}'`)
    expect(await update(office(), 'Parcel', parcel, `"manualTrackingNumber" = 'COURIER-0001', version = version + 1`)).toBe(1)
    await expect(update(office(), 'Shipment', shipment, `"transportBy" = 'SENDER', "carrierCode" = NULL, "carrierName" = NULL, "serviceCode" = NULL`)).rejects.toThrow(/clear the parcels' numbers before it travels another way/)
    // The floor still packs and unpacks it: a status update reads none of the new columns.
    expect(await update(floor(), 'Shipment', shipment, `status = 'DRAFT', "packedAt" = NULL, version = version + 1`)).toBe(1)
    await expect(run(office(), `DELETE FROM "Parcel" WHERE id = $1::uuid`, parcel)).rejects.toThrow(/clear its number first/)
    expect(await update(office(), 'Parcel', parcel, `"manualTrackingNumber" = NULL, version = version + 1`)).toBe(1)
    expect(await run(office(), `DELETE FROM "Parcel" WHERE id = $1::uuid`, parcel)).toBe(1)
  })
})

// ---- B-OS-021 -------------------------------------------------------------------------------------------------------------------
describe('B-OS-021: a split child is made for one of its own orders (X1-B1)', () => {
  const so2 = () => s.quality.production.salesOrderId
  const so3 = () => s.quality.serialSalesOrderId
  const child = (parent: string, salesOrderId: string, id = randomUUID()) => ({ text: copyText('Shipment'), changes: { id, number: `SH-OS-${id.slice(0, 8)}`, splitFromId: parent, splitReason: 'PART_READY', salesOrderId, version: 1 }, id })

  it('the parent’s first order, or the order of a line it carries; at commit a child with garments carries one of its order', async () => {
    // A DRAFT of SEED-SO-0003 carrying its free jacket and SEED-SO-0002's free BLK 52 (the same customer, address and terms).
    const parent = await draftShipment()
    const jacketLine = randomUUID()
    expect(await run(office(), lineText, jacketLine, s.quality.serialCellId, parent)).toBe(1)
    expect(await run(office(), lineText, randomUUID(), s.quality.production.cellIds['BLK-52'], parent)).toBe(1)

    // A child for SEED-SO-0002, an order of a line the parent carries: made (before this wave: "ships another sales order").
    const forSo2 = child(parent, so2())
    expect(await run(office(), forSo2.text, JSON.stringify(forSo2.changes), parent)).toBe(1)

    // A child made for SEED-SO-0002 that ends up carrying only SEED-SO-0003's jacket: refused at commit.
    const wrong = child(parent, so2())
    await admin('BEGIN')
    try {
      await admin(wrong.text, [JSON.stringify(wrong.changes), parent])
      await admin(`DELETE FROM "ShipmentLine" WHERE id = $1::uuid`, [jacketLine])
      await admin(lineText, [randomUUID(), s.quality.serialCellId, wrong.id])
      await expect(admin('COMMIT')).rejects.toThrow(/a split shipment is made for one of its own orders/)
    } finally {
      await admin('ROLLBACK').catch(() => null)
    }
    expect(await admin(`SELECT id FROM "Shipment" WHERE id = $1::uuid`, [wrong.id])).toEqual([])

    // The same move, the child made for SEED-SO-0003 (the parent's first order): committed.
    const right = child(parent, so3())
    await admin('BEGIN')
    await admin(right.text, [JSON.stringify(right.changes), parent])
    await admin(`DELETE FROM "ShipmentLine" WHERE id = $1::uuid`, [jacketLine])
    await admin(lineText, [randomUUID(), s.quality.serialCellId, right.id])
    await admin('COMMIT')
    expect(await admin(`SELECT "salesOrderId"::text AS "salesOrderId" FROM "Shipment" WHERE id = $1::uuid`, [right.id])).toEqual([{ salesOrderId: so3() }])
  })
})

// ---- B-OS-024 -------------------------------------------------------------------------------------------------------------------
describe('B-OS-024: a shipment that travels without a DDT gets none (L13)', () => {
  const ddtCopy = (shipmentId: string) => copyRow(office(), 'Ddt', s.ddtId, { id: randomUUID(), shipmentId, number: `OS-${tag()}/2026` })

  it('no "without" while a DDT lives; no DDT while it travels without one; put back, a DDT again', async () => {
    const shipment = await draftShipment()
    await force(`UPDATE "Shipment" SET status = 'PACKED', "packedAt" = now() WHERE id = '${shipment}'`)
    const live = randomUUID()
    expect(await copyRow(office(), 'Ddt', s.ddtId, { id: live, shipmentId: shipment, number: `OS-${tag()}/2026` })).toBe(1)
    await expect(update(office(), 'Shipment', shipment, `"ddtRequired" = false`)).rejects.toThrow(/has a live DDT; it travels without one only once that DDT is cancelled/)
    expect(await copyRow(office(), 'DdtCancellation', s.cancellationId, { id: randomUUID(), ddtId: live })).toBe(1)
    expect(await update(office(), 'Shipment', shipment, `"ddtRequired" = false, version = version + 1`)).toBe(1)
    await expect(ddtCopy(shipment)).rejects.toThrow(/travels without a DDT; no DDT of it is issued/)
    expect(await update(office(), 'Shipment', shipment, `"ddtRequired" = true, version = version + 1`)).toBe(1)
    expect(await ddtCopy(shipment)).toBe(1)
  })
})
