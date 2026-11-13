import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedPacking, type PackingSeed } from '../seed/packing'
import { seed as seedShipping, type ShippingSeed } from '../seed/shipping'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * Packing and the shipment queue (W2b-6, schema wave 46/57, B-W2b-364, …_packing_w2b_guards) on a database built from the
 * migrations and seeded twice, through the real login and the scoped client:
 *   - packaging types (their rules, never deleted, the cost not for the floor) and defaults per style or size run (one live
 *     per company, kind and scope);
 *   - a carton's contents and serials: written while the shipment is a DRAFT, the size the line's, a serial into a carton of
 *     its line's shipment while RELEASED (cleared with its line), and the move to PACKED only with every line counted
 *     exactly, each serial in a carton that holds its line and the cartons numbered "n of N" right;
 *   - holds on a shipment: placed before it left, released once with why, one in force per reason, and while one is in force
 *     nothing goes into its cartons, no carrier label, no move to PACKED or SHIPPED;
 *   - split shipments, carton mark templates and cut-offs per carrier;
 *   - who reads what: the floor without the cost or a hold's words, a portal session its own carton contents, no hold.
 * The refusals are check_violation (23514) in words, or a unique key (23505); their messages are read through raw SQL.
 */

const NS = 'w2b-364-a'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let s: PackingSeed
let shipping: ShippingSeed

const key = (name: string): string => seedUuid(NS, name)
const SITE_A1 = key('site:A1')
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: randomUUID(), siteId: SITE_A1 })
const partner = (): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: a.actorId, partyId: key('party:P1') })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
/** INSERT a copy of row `id` of `table` with `changes` (a jsonb object of columns). */
const copyText = (table: string) => `INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`
const copyRow = (scope: FactoryScope, table: string, id: string, changes: Record<string, unknown>) => run(scope, copyText(table), JSON.stringify(changes), id)
const update = (scope: FactoryScope, table: string, id: string, set: string, ...values: unknown[]) => run(scope, `UPDATE "${table}" SET ${set} WHERE id = $1::uuid`, id, ...values)

beforeAll(async () => {
  db = await migratedDatabase('packingw2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  s = await seedPacking({ db: factory, namespace: NS })
  // Run twice: every seed is idempotent.
  await seedPacking({ db: factory, namespace: NS })
  shipping = await seedShipping({ db: factory, namespace: NS })
}, 300_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

/**
 * A DRAFT shipment of its own for SEED-SO-0003 (the serial-tracked jacket), with one parcel and one line holding the
 * cell's other released garment (SH-0002 holds the first): a copy of SH-0002, its parcel and line.
 */
async function newShipment(): Promise<{ shipmentId: string; parcelId: string; lineId: string }> {
  const shipmentId = randomUUID()
  const parcelId = randomUUID()
  const lineId = randomUUID()
  expect(await copyRow(office(), 'Shipment', s.shipmentId, { id: shipmentId, number: `SH-T-${shipmentId.slice(0, 8)}`, version: 1 })).toBe(1)
  expect(await copyRow(office(), 'Parcel', s.parcelId, { id: parcelId, shipmentId, seq: 1, packagingTypeId: null, cartonNumber: null, cartonCount: null, marksPrintedAt: null })).toBe(1)
  expect(await copyRow(office(), 'ShipmentLine', s.shipmentLineId, { id: lineId, shipmentId, parcelId })).toBe(1)
  return { shipmentId, parcelId, lineId }
}
/** Cancels a test's shipment, so the cell's released garment ships on the next one (its serial unpacked first). */
const cancel = (shipmentId: string) =>
  update(office(), 'Shipment', shipmentId, `status = 'CANCELLED', "cancelledAt" = now(), "cancelReason" = 'Test: done', version = version + 1`)
const contents = (scope: FactoryScope, shipmentId: string, parcelId: string, lineId: string, changes: Record<string, unknown> = {}) =>
  copyRow(scope, 'ParcelLine', s.parcelLineId, { id: randomUUID(), shipmentId, parcelId, shipmentLineId: lineId, ...changes })
const hold = (shipmentId: string, changes: Record<string, unknown> = {}) =>
  copyRow(office(), 'ShipmentHold', s.holdIds.balance, { id: randomUUID(), shipmentId, reason: 'CREDIT', words: null, placedAt: new Date().toISOString(), releasedAt: null, releasedById: null, releaseWords: null, version: 1, ...changes })

describe('packaging types and defaults (LOG-008, FIN-011)', () => {
  const newType = (changes: Record<string, unknown>) => copyRow(office(), 'PackagingType', s.packagingTypeIds.carton, { id: randomUUID(), name: `Test ${randomUUID().slice(0, 8)}`, ...changes })

  it('keep their sizes, weights, pallet kind and cost in order, their company and kind fixed', async () => {
    await expect(newType({ name: 'two\nlines' })).rejects.toThrow(/name of 1 to 100 characters on one line/)
    await expect(newType({ innerHeightCm: null })).rejects.toThrow(/all three or none/)
    await expect(newType({ innerWidthCm: 0 })).rejects.toThrow(/above 0 cm/)
    await expect(newType({ maxWeightKg: '0.5000' })).rejects.toThrow(/more full .* than empty/)
    await expect(newType({ palletKind: 'EUR' })).rejects.toThrow(/pallet kind exactly when it is a PALLET/)
    await expect(newType({ kind: 'PALLET' })).rejects.toThrow(/pallet kind exactly when it is a PALLET/)
    await expect(newType({ costCurrency: null })).rejects.toThrow(/ISO 4217 currency \(both or neither\)/)
    await expect(newType({ costPerUnit: '-1' })).rejects.toThrow(/0 or more/)
    await expect(newType({ name: 'Seed carton 60x40x40' })).rejects.toThrow(/PackagingType_tenantId_companyId_name_key/)
    expect(await newType({ kind: 'PALLET', palletKind: 'OTHER', innerLengthCm: null, innerWidthCm: null, innerHeightCm: null })).toBe(1)
    await expect(update(office(), 'PackagingType', s.packagingTypeIds.carton, `kind = 'BOX'`)).rejects.toThrow(/company, kind and creation of packaging type .* never change/)
    expect(await update(office(), 'PackagingType', s.packagingTypeIds.carton, `"maxWeightKg" = 24, version = version + 1`)).toBe(1)
    await expect(admin(`DELETE FROM "PackagingType" WHERE id = $1::uuid`, [s.packagingTypeIds.oldBox])).rejects.toThrow(/kept, never deleted/)
  })

  it('show the floor everything but the cost', async () => {
    await expect(sql(floor(), `SELECT "costPerUnit" FROM "PackagingType" LIMIT 1`)).rejects.toThrow(/permission denied/)
    await expect(sql(floor(), `SELECT "costCurrency" FROM "PackagingType" LIMIT 1`)).rejects.toThrow(/permission denied/)
    expect((await sql(floor(), `SELECT name FROM "PackagingType" WHERE id = $1::uuid`, s.packagingTypeIds.carton))[0]).toEqual({ name: 'Seed carton 60x40x40' })
    await expect(sql(partner(), `SELECT id FROM "PackagingType" LIMIT 1`)).rejects.toThrow(/permission denied/)
  })

  it('default by a style or a size run of its scale, one live per company, kind and scope', async () => {
    const newDefault = (changes: Record<string, unknown>) => copyRow(office(), 'PackagingDefault', s.defaultIds.runCarton, { id: randomUUID(), active: false, ...changes })
    await expect(newDefault({ styleId: null, sizeScaleId: null, fromSize: null, toSize: null })).rejects.toThrow(/for a style or a size run/)
    await expect(newDefault({ toSize: null })).rejects.toThrow(/from one size to another .* both or neither/)
    await expect(newDefault({ fromSize: '54', toSize: '50' })).rejects.toThrow(/the first not after the last/)
    await expect(newDefault({ fromSize: '48', toSize: '99' })).rejects.toThrow(/sizes of scale/)
    // A style's run is of the style's own scale.
    const otherScale = randomUUID()
    expect(await copyRow(office(), 'SizeScale', key('product:size-scale:EU-JKT'), { id: otherScale, code: `T-${otherScale.slice(0, 8)}` })).toBe(1)
    await expect(newDefault({ styleId: key('product:style:JKT-01'), sizeScaleId: otherScale, fromSize: null, toSize: null })).rejects.toThrow(/style's own scale/)
    // A live one names an ACTIVE packaging, and only one is live per scope.
    await expect(newDefault({ active: true, packagingTypeId: s.packagingTypeIds.oldBox, kind: 'BOX' })).rejects.toThrow(/which is switched off/)
    await expect(newDefault({ active: true })).rejects.toThrow(/PackagingDefault_one_live/)
    await expect(newDefault({ packagingTypeId: s.packagingTypeIds.polybag })).rejects.toThrow(/foreign key|PackagingDefault_tenantId_companyId_kind_packagingTypeId_fkey/)
    expect(await newDefault({ active: true, kind: 'HANGER', packagingTypeId: s.packagingTypeIds.hanger })).toBe(1)
    await expect(update(office(), 'PackagingDefault', s.defaultIds.styleCarton, `kind = 'BOX', "packagingTypeId" = $2::uuid`, s.packagingTypeIds.oldBox)).rejects.toThrow(/company, kind and creation of packaging default .* never change/)
    expect((await sql(floor(), `SELECT count(*)::int AS n FROM "PackagingDefault" WHERE active`))[0]!.n).toBeGreaterThan(0)
  })
})

describe('a carton and its contents (LOG-003, LOG-007, LOG-010, LOG-013)', () => {
  it('fills while the shipment is a DRAFT, and packs only with every line counted, every serial in its carton, "n of N" right', async () => {
    const { shipmentId, parcelId, lineId } = await newShipment()
    const serial = shipping.quality.serialIds[2]
    // The floor fills the carton: the line's size, a garment or more.
    await expect(contents(floor(), shipmentId, parcelId, lineId, { size: '50' })).rejects.toThrow(/of size 52: that size, not 50/)
    await expect(contents(floor(), shipmentId, parcelId, lineId, { quantity: 0 })).rejects.toThrow(/at least one garment/)
    const filled = randomUUID()
    expect(await contents(floor(), shipmentId, parcelId, lineId, { id: filled, quantity: 2 })).toBe(1)
    // The serial goes into a carton of its line's shipment, with when (and who), only with its line.
    await expect(update(floor(), 'GarmentSerial', serial, `"parcelId" = $2::uuid, "packedAt" = now()`, parcelId)).rejects.toThrow(/only on a shipment line/)
    await expect(update(floor(), 'GarmentSerial', serial, `"shipmentLineId" = $2::uuid, "parcelId" = $3::uuid`, lineId, parcelId)).rejects.toThrow(/with the time it was packed/)
    await expect(update(floor(), 'GarmentSerial', serial, `"shipmentLineId" = $2::uuid, "parcelId" = $3::uuid, "packedAt" = now()`, lineId, shipping.draftParcelId)).rejects.toThrow(/carton of its shipment line's shipment/)
    await expect(update(floor(), 'GarmentSerial', serial, `"shipmentLineId" = $2::uuid, "parcelId" = $3::uuid, "packedAt" = now() + interval '1 hour'`, lineId, parcelId)).rejects.toThrow(/not in the future/)
    expect(await update(floor(), 'GarmentSerial', serial, `"shipmentLineId" = $2::uuid, "parcelId" = $3::uuid, "packedAt" = now(), "packedById" = $4::uuid`, lineId, parcelId, randomUUID())).toBe(1)
    await expect(update(floor(), 'GarmentSerial', serial, `"packedAt" = now() - interval '1 minute'`)).rejects.toThrow(/change only with its carton/)
    // The weighed carton: "n of N" as printed, both or neither, n at most N.
    expect(await update(floor(), 'Parcel', parcelId, `"grossWeightKg" = 2.5, "packagingTypeId" = $2::uuid`, s.packagingTypeIds.carton)).toBe(1)
    await expect(update(floor(), 'Parcel', parcelId, `"cartonNumber" = 2, "cartonCount" = 1`)).rejects.toThrow(/carton n of N as printed/)
    await expect(update(floor(), 'Parcel', parcelId, `"cartonNumber" = 1`)).rejects.toThrow(/both or neither/)
    expect(await update(floor(), 'Parcel', parcelId, `"cartonNumber" = 1, "cartonCount" = 2, "marksPrintedAt" = now()`)).toBe(1)
    // Packed: the contents add up to the line (2 ≠ 1), then the marks say "of 2" for one carton.
    await expect(update(floor(), 'Shipment', shipmentId, `status = 'PACKED', "packedAt" = now()`)).rejects.toThrow(/adding up to each line they hold \(1 line\(s\) do not\)/)
    expect(await update(floor(), 'ParcelLine', filled, `quantity = 1`)).toBe(1)
    await expect(update(floor(), 'Shipment', shipmentId, `status = 'PACKED', "packedAt" = now()`)).rejects.toThrow(/of N = its 1 carton\(s\) \(reprint the marks\)/)
    expect(await update(floor(), 'Parcel', parcelId, `"cartonCount" = 1, "marksPrintedAt" = now()`)).toBe(1)
    expect(await update(floor(), 'Shipment', shipmentId, `status = 'PACKED', "packedAt" = now()`)).toBe(1)
    // Packed: the contents are frozen with the lines.
    await expect(contents(floor(), shipmentId, parcelId, lineId)).rejects.toThrow(/is PACKED; its cartons' contents change only while it is a DRAFT/)
    await expect(update(office(), 'ParcelLine', filled, `quantity = 1, version = version + 1`)).rejects.toThrow(/change only while it is a DRAFT/)
    // Unpacked: the serial leaves its line, and the database takes it out of its carton too.
    expect(await update(floor(), 'Shipment', shipmentId, `status = 'DRAFT', "packedAt" = NULL`)).toBe(1)
    expect(await update(floor(), 'GarmentSerial', serial, `"shipmentLineId" = NULL`)).toBe(1)
    expect(await admin(`SELECT "parcelId", "packedAt", "packedById" FROM "GarmentSerial" WHERE id = $1::uuid`, [serial])).toEqual([{ parcelId: null, packedAt: null, packedById: null }])
    // A carton (and a line) with contents is not removed before they are taken out.
    await expect(run(office(), `DELETE FROM "Parcel" WHERE id = $1::uuid`, parcelId)).rejects.toThrow(/holds carton contents or packed serials; take them out first/)
    await expect(run(office(), `DELETE FROM "ShipmentLine" WHERE id = $1::uuid`, lineId)).rejects.toThrow(/has carton contents; take them out first/)
    expect(await run(floor(), `DELETE FROM "ParcelLine" WHERE id = $1::uuid`, filled)).toBe(1)
    expect(await cancel(shipmentId)).toBe(1)
  })

  it('packs no serial outside a carton that holds its line', async () => {
    const { shipmentId, parcelId, lineId } = await newShipment()
    const serial = shipping.quality.serialIds[2]
    const second = randomUUID()
    expect(await copyRow(office(), 'Parcel', parcelId, { id: second, seq: 2, grossWeightKg: '1.0000' })).toBe(1)
    expect(await update(office(), 'Parcel', parcelId, `"grossWeightKg" = 1.5`)).toBe(1)
    expect(await contents(office(), shipmentId, parcelId, lineId, { quantity: 1 })).toBe(1)
    // The serial lies in the second carton, which holds none of its line.
    expect(await update(office(), 'GarmentSerial', serial, `"shipmentLineId" = $2::uuid, "parcelId" = $3::uuid, "packedAt" = now()`, lineId, second)).toBe(1)
    await expect(update(office(), 'Shipment', shipmentId, `status = 'PACKED', "packedAt" = now()`)).rejects.toThrow(/1 carton\(s\) holding more serials of a line than its contents/)
    expect(await update(office(), 'GarmentSerial', serial, `"parcelId" = $2::uuid, "packedAt" = now()`, parcelId)).toBe(1)
    expect(await update(office(), 'Shipment', shipmentId, `status = 'PACKED', "packedAt" = now()`)).toBe(1)
    expect(await update(office(), 'Shipment', shipmentId, `status = 'DRAFT', "packedAt" = NULL`)).toBe(1)
    expect(await update(office(), 'GarmentSerial', serial, `"shipmentLineId" = NULL`)).toBe(1)
    expect(await cancel(shipmentId)).toBe(1)
  })

  it('is a carton, box or pallet of the shipment\'s company, switched on, when typed', async () => {
    const { shipmentId, parcelId } = await newShipment()
    await expect(update(office(), 'Parcel', parcelId, `"packagingTypeId" = $2::uuid`, s.packagingTypeIds.polybag)).rejects.toThrow(/a CARTON, a BOX or a PALLET, not a POLYBAG/)
    await expect(update(office(), 'Parcel', parcelId, `"packagingTypeId" = $2::uuid`, s.packagingTypeIds.oldBox)).rejects.toThrow(/which is switched off/)
    await expect(update(office(), 'Parcel', parcelId, `"packagingTypeId" = $2::uuid`, s.packagingTypeIds.cartonB)).rejects.toThrow(/of another company than its shipment's/)
    await expect(update(office(), 'Parcel', parcelId, `"marksPrintedAt" = now() + interval '1 hour'`)).rejects.toThrow(/printed at a time not in the future/)
    expect(await update(office(), 'Parcel', parcelId, `"packagingTypeId" = $2::uuid`, s.packagingTypeIds.pallet)).toBe(1)
    expect(await cancel(shipmentId)).toBe(1)
  })

  it('is read by the portal of its own party (the packing list), never who wrote it', async () => {
    expect(await sql(partner(), `SELECT size, quantity FROM "ParcelLine" WHERE id = $1::uuid`, s.parcelLineId)).toEqual([{ size: '52', quantity: 1 }])
    await expect(sql(partner(), `SELECT "createdById" FROM "ParcelLine" LIMIT 1`)).rejects.toThrow(/permission denied/)
    await expect(admin(`TRUNCATE "ParcelLine"`)).rejects.toThrow(/TRUNCATE on "ParcelLine" is refused/)
  })
})

describe('holds on a shipment (LOG-017, FIN-079)', () => {
  it('are placed before it left, never edited, released once with why, one in force per reason', async () => {
    const { shipmentId } = await newShipment()
    await expect(hold(shipmentId, { reason: 'OTHER' })).rejects.toThrow(/says why in words .*required for OTHER/)
    await expect(hold(shipmentId, { placedAt: new Date(Date.now() + 3_600_000).toISOString() })).rejects.toThrow(/placed at a time not in the future/)
    await expect(hold(shipping.shipmentId, { siteId: SITE_A1 })).rejects.toThrow(/is SHIPPED; a hold is placed only on a shipment that has not left/)
    const held = randomUUID()
    expect(await hold(shipmentId, { id: held, words: 'Test: over the credit limit' })).toBe(1)
    await expect(hold(shipmentId)).rejects.toThrow(/ShipmentHold_one_in_force/)
    expect(await hold(shipmentId, { reason: 'QUALITY' })).toBe(1)
    await expect(update(office(), 'ShipmentHold', held, `words = 'Test: changed'`)).rejects.toThrow(/never edited/)
    await expect(update(office(), 'ShipmentHold', held, `"releasedAt" = now()`)).rejects.toThrow(/released with when and why/)
    await expect(update(office(), 'ShipmentHold', held, `"releasedAt" = now() - interval '1 day', "releaseWords" = 'Test: paid'`)).rejects.toThrow(/not before it was placed/)
    expect(await update(office(), 'ShipmentHold', held, `"releasedAt" = now(), "releaseWords" = 'Test: the credit was approved', "releasedById" = $2::uuid, version = version + 1`, a.actorId)).toBe(1)
    await expect(update(office(), 'ShipmentHold', held, `"releaseWords" = 'Test: again'`)).rejects.toThrow(/was released and never changes/)
    await expect(admin(`DELETE FROM "ShipmentHold" WHERE id = $1::uuid`, [held])).rejects.toThrow(/kept, never deleted/)
    expect(await cancel(shipmentId)).toBe(1)
  })

  it('keep the shipment from being packed, labelled or sent while one is in force', async () => {
    const { shipmentId, parcelId, lineId } = await newShipment()
    const serial = shipping.quality.serialIds[2]
    expect(await update(office(), 'Parcel', parcelId, `"grossWeightKg" = 1.2`)).toBe(1)
    const held = randomUUID()
    expect(await hold(shipmentId, { id: held, reason: 'BALANCE_UNPAID' })).toBe(1)
    await expect(contents(floor(), shipmentId, parcelId, lineId)).rejects.toThrow(/is on hold \(BALANCE_UNPAID\); nothing more goes into its cartons/)
    await expect(update(floor(), 'GarmentSerial', serial, `"shipmentLineId" = $2::uuid, "parcelId" = $3::uuid, "packedAt" = now()`, lineId, parcelId)).rejects.toThrow(/is on hold \(BALANCE_UNPAID\)/)
    expect(await update(floor(), 'ShipmentLine', lineId, `"parcelId" = NULL`)).toBe(1)
    await expect(update(floor(), 'ShipmentLine', lineId, `"parcelId" = $2::uuid`, parcelId)).rejects.toThrow(/nothing more goes into its parcels/)
    await expect(update(office(), 'Parcel', parcelId, `"trackingNumber" = 'T-HELD-1', "labelledAt" = now()`)).rejects.toThrow(/its parcels get no carrier label until the hold is released/)
    // The floor sees the hold and its reason, not its words.
    expect(await sql(floor(), `SELECT reason::text AS reason FROM "ShipmentHold" WHERE id = $1::uuid`, held)).toEqual([{ reason: 'BALANCE_UNPAID' }])
    await expect(sql(floor(), `SELECT words FROM "ShipmentHold" LIMIT 1`)).rejects.toThrow(/permission denied/)
    await expect(sql(partner(), `SELECT id FROM "ShipmentHold" LIMIT 1`)).rejects.toThrow(/permission denied/)
    // Released: the floor packs; held again once PACKED: it does not leave.
    expect(await update(office(), 'ShipmentHold', held, `"releasedAt" = now(), "releaseWords" = 'Test: the balance came in'`)).toBe(1)
    expect(await update(floor(), 'ShipmentLine', lineId, `"parcelId" = $2::uuid`, parcelId)).toBe(1)
    expect(await update(floor(), 'GarmentSerial', serial, `"shipmentLineId" = $2::uuid`, lineId)).toBe(1)
    expect(await update(floor(), 'Shipment', shipmentId, `status = 'PACKED', "packedAt" = now()`)).toBe(1)
    expect(await hold(shipmentId, { reason: 'CUSTOMER_REQUEST' })).toBe(1)
    await expect(update(office(), 'Shipment', shipmentId, `status = 'SHIPPED', "shippedAt" = now(), "ddtRequired" = false`)).rejects.toThrow(/is on hold \(CUSTOMER_REQUEST\); it is not sent until the hold is released/)
    await expect(update(office(), 'Parcel', parcelId, `"trackingNumber" = 'T-HELD-2', "labelledAt" = now()`)).rejects.toThrow(/no carrier label/)
    // Unpacking is not packing.
    expect(await update(floor(), 'Shipment', shipmentId, `status = 'DRAFT', "packedAt" = NULL`)).toBe(1)
    await expect(update(floor(), 'Shipment', shipmentId, `status = 'PACKED', "packedAt" = now()`)).rejects.toThrow(/it is not packed until the hold is released/)
    expect(await update(floor(), 'GarmentSerial', serial, `"shipmentLineId" = NULL`)).toBe(1)
    expect(await cancel(shipmentId)).toBe(1)
  })
})

describe('split shipments (LOG-005)', () => {
  const split = (from: string, changes: Record<string, unknown> = {}) => {
    const id = randomUUID()
    return copyRow(office(), 'Shipment', s.shipmentId, { id, number: `SH-S-${id.slice(0, 8)}`, splitFromId: from, splitReason: 'PART_READY', version: 1, ...changes })
  }

  it('name an open shipment of the same order and why, given once', async () => {
    await expect(split(s.shipmentId, { splitReason: null })).rejects.toThrow(/split from and why .* both or neither/)
    await expect(split(s.shipmentId, { splitReason: 'part ready' })).rejects.toThrow(/without spaces/)
    const self = randomUUID()
    await expect(split(self, { id: self, number: `SH-S-${self.slice(0, 8)}` })).rejects.toThrow(/not split from itself/)
    await expect(split(shipping.shipmentId)).rejects.toThrow(/ships another sales order/)
    await expect(copyRow(office(), 'Shipment', shipping.shipmentId, {
      id: randomUUID(), number: `SH-S-${randomUUID().slice(0, 8)}`, status: 'DRAFT', packedAt: null, shippedAt: null, transportEvidence: 'NOT_NEEDED', freightCost: null, freightCostCurrency: null, transportMode: null,
      splitFromId: shipping.shipmentId, splitReason: 'PART_READY', version: 1,
    })).rejects.toThrow(/which is SHIPPED; only a shipment that has not left is split/)
    const child = randomUUID()
    expect(await split(s.shipmentId, { id: child, number: `SH-S-${child.slice(0, 8)}` })).toBe(1)
    await expect(update(office(), 'Shipment', child, `"splitReason" = 'CUSTOMER_REQUEST'`)).rejects.toThrow(/was split from, and why, never change/)
    expect((await sql(partner(), `SELECT "splitFromId"::text AS id FROM "Shipment" WHERE id = $1::uuid`, child))[0]).toEqual({ id: s.shipmentId })
  })
})

describe('carton mark templates (LOG-013)', () => {
  const newTemplate = (changes: Record<string, unknown>) => copyRow(office(), 'ShippingMarkTemplate', s.markTemplateIds.old, { id: randomUUID(), ...changes })

  it('show their fields once each, in a language, for a customer or brand, one live per customer and one default', async () => {
    await expect(newTemplate({ fields: ['SHIP_TO', 'SHIP_TO'] })).rejects.toThrow(/1 to 16 fields, each once/)
    await expect(newTemplate({ fields: [] })).rejects.toThrow(/1 to 16 fields, each once/)
    await expect(newTemplate({ language: 'ITA' })).rejects.toThrow(/two lower-case letters/)
    await expect(newTemplate({ partyId: key('party:P2') })).rejects.toThrow(/a customer or brand of its company or of every company, not archived/)
    await expect(newTemplate({ active: true })).rejects.toThrow(/ShippingMarkTemplate_one_live/)
    await expect(newTemplate({ active: true, partyId: key('party:P1') })).rejects.toThrow(/ShippingMarkTemplate_one_live/)
    expect(await newTemplate({ active: true, partyId: key('party:P4'), language: 'de' })).toBe(1)
    await expect(update(office(), 'ShippingMarkTemplate', s.markTemplateIds.old, `"partyId" = $2::uuid`, key('party:P1'))).rejects.toThrow(/company, customer and creation of mark template .* never change/)
    expect(await update(office(), 'ShippingMarkTemplate', s.markTemplateIds.brandP1, `fields = ARRAY['SHIP_TO','CARTON_NUMBER']::"ShippingMarkField"[], version = version + 1`)).toBe(1)
    expect((await sql(floor(), `SELECT language FROM "ShippingMarkTemplate" WHERE id = $1::uuid`, s.markTemplateIds.brandP1))[0]).toEqual({ language: 'en' })
  })
})

describe('cut-offs per carrier and weekday (LOG-018, LOG-110)', () => {
  it('are a time of day per site, carrier and weekday', async () => {
    const [monday] = s.cutOffIds
    const newCutOff = (changes: Record<string, unknown>) => copyRow(office(), 'CarrierCutOff', monday!, { id: randomUUID(), ...changes })
    await expect(newCutOff({ weekday: 'SUNDAY', cutOffTime: '24:00' })).rejects.toThrow(/HH:MM \(24 hours\)/)
    await expect(newCutOff({ weekday: 'SUNDAY', carrierCode: 'seed express' })).rejects.toThrow(/without spaces/)
    await expect(newCutOff({})).rejects.toThrow(/CarrierCutOff_tenantId_siteId_carrierCode_weekday_key/)
    const sunday = randomUUID()
    expect(await newCutOff({ id: sunday, weekday: 'SUNDAY', cutOffTime: '09:30' })).toBe(1)
    await expect(update(office(), 'CarrierCutOff', sunday, `"siteId" = $2::uuid`, key('site:A2'))).rejects.toThrow(/site and creation of cut-off .* never change|foreign key/)
    expect(await sql(floor(), `SELECT "cutOffTime" FROM "CarrierCutOff" WHERE id = $1::uuid`, sunday)).toEqual([{ cutOffTime: '09:30' }])
    expect(await run(office(), `DELETE FROM "CarrierCutOff" WHERE id = $1::uuid`, sunday)).toBe(1)
  })
})
