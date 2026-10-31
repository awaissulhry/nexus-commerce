import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedHolds, type HoldsSeed } from '../seed/holds'
import { seed as seedReturns, type ReturnsSeed } from '../seed/returns'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * The W2b schema follow-ups (B-W2b-F1, …_followups_f1_w2b_guards) on a database built from the migrations and seeded,
 * through the real login and the scoped client:
 *   - a new hold comes numbered (the seeded one is HLD-2026-0001, from company A's HOLD series);
 *   - a shipment's garments are received back once, while it is RETURNED; then its lines no longer count against its
 *     cells' releases (the same cell ships again) and its SHIPPED serials go back to RELEASED, unpacked;
 *   - a customer's return (ReturnAuthorisation) is a source of the PPE register, one entry per return.
 * The refusals are check_violation (SQLSTATE 23514); their messages are read through raw SQL.
 */

const NS = 'w2b-f1-a'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let holds: HoldsSeed
let returns: ReturnsSeed

const key = (name: string): string => seedUuid(NS, name)
const A = { companyA: key('company:A'), siteA: key('site:A1'), holdSeries: `ffffffff${key('series:A:HOLD:MAIN:2026').slice(8)}` }

const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: randomUUID(), siteId: A.siteA })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
/** A write past the database's guards (the seed's facts only: never what the test then proves). */
async function force(text: string, values: unknown[] = []): Promise<void> {
  await admin('SET session_replication_role = replica')
  try {
    await admin(text, values)
  } finally {
    await admin('SET session_replication_role = DEFAULT')
  }
}
/** INSERT a copy of a row of `table` (the first one `where` finds) with `changes` (a jsonb object of columns). */
const copyRow = (scope: FactoryScope, table: string, where: string, changes: Record<string, unknown>, ...values: unknown[]) =>
  run(scope, `INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE ${where} LIMIT 1))`, JSON.stringify(changes), ...values)

beforeAll(async () => {
  db = await migratedDatabase('followupsw2bf1')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  holds = await seedHolds({ db: factory, namespace: NS })
  returns = await seedReturns({ db: factory, namespace: NS })
}, 180_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('a new hold comes numbered (B-W2b-17 numbers every hold it places)', () => {
  it('the seeded hold took HLD-2026-0001 of company A’s HOLD series on the cutting table’s tablet', async () => {
    expect(await admin(`SELECT number FROM "QualityHold" WHERE id = $1`, [holds.holdId])).toEqual([{ number: 'HLD-2026-0001' }])
    expect(await admin(`SELECT formatted, "recordType", "recordId", "seriesId" FROM "NumberAllocation" WHERE kind = 'HOLD' AND "tenantId" = $1`, [a.tenantId])).toEqual([
      { formatted: 'HLD-2026-0001', recordType: 'QualityHold', recordId: holds.holdId, seriesId: A.holdSeries },
    ])
    expect(await admin(`SELECT "nextValue" FROM "NumberSeries" WHERE id = $1`, [A.holdSeries])).toEqual([{ nextValue: 2 }])
  })

  it('an insert without a number is refused for the office and the floor; with one it is written', async () => {
    const changes = (number: string | null) => ({ id: randomUUID(), number, version: 1 })
    await expect(copyRow(office(), 'QualityHold', 'id = $2::uuid', changes(null), holds.holdId)).rejects.toThrow(/hold .* is numbered when it is placed/)
    await expect(copyRow(floor(), 'QualityHold', 'id = $2::uuid', changes(null), holds.holdId)).rejects.toThrow(/hold .* is numbered when it is placed/)
    expect(await copyRow(office(), 'QualityHold', 'id = $2::uuid', changes(`HLD-T-${randomUUID().slice(0, 8)}`), holds.holdId)).toBe(1)
  })
})

describe('a carrier-returned shipment’s garments ship again (the B-W2b-19 gap)', () => {
  const sh1 = () => returns.money.shipping.shipmentId
  const cellOf = async (lineId: string) => String((await admin(`SELECT "workOrderSizeId" FROM "ShipmentLine" WHERE id = $1`, [lineId]))[0]!.workOrderSizeId)
  /** The garments a cell may still put on shipments: released less reversed less on shipments that are not CANCELLED. */
  const freeOf = async (cellId: string) =>
    Number(
      (
        await admin(
          `SELECT (SELECT coalesce(sum(quantity), 0) FROM "QualityRelease" WHERE "workOrderSizeId" = $1)
                - (SELECT coalesce(sum(quantity), 0) FROM "QualityReleaseReversal" WHERE "workOrderSizeId" = $1)
                - (SELECT coalesce(sum(l.quantity), 0) FROM "ShipmentLine" l JOIN "Shipment" s ON s.id = l."shipmentId" WHERE l."workOrderSizeId" = $1 AND s.status <> 'CANCELLED') AS free`,
          [cellId],
        )
      )[0]!.free,
    )
  let draft: string

  it('the time is set only on a RETURNED shipment, by the office, once; it never changes or clears', async () => {
    await expect(run(office(), `UPDATE "Shipment" SET "carrierReturnReceivedAt" = now() WHERE id = $1::uuid`, sh1())).rejects.toThrow(/received back once, after the carrier returned it/)
    // The carrier's tracking says it came back (SHIPPED → RETURNED, as the webhook records it).
    expect(await run(office(), `UPDATE "Shipment" SET status = 'RETURNED', "returnedAt" = now() WHERE id = $1::uuid`, sh1())).toBe(1)
    await expect(run(floor(), `UPDATE "Shipment" SET "carrierReturnReceivedAt" = now() WHERE id = $1::uuid`, sh1())).rejects.toThrow(/the floor packs and unpacks shipment/)
    // A new shipment never starts with it.
    await expect(copyRow(office(), 'Shipment', 'id = $2::uuid', { id: randomUUID(), number: `SH-T-${randomUUID().slice(0, 8)}`, status: 'DRAFT', packedAt: null, shippedAt: null, returnedAt: null, transportEvidence: 'NOT_NEEDED', transportEvidenceAt: null, transportEvidenceById: null, carrierReturnReceivedAt: new Date().toISOString(), version: 1 }, sh1())).rejects.toThrow(
      /received back only once the carrier returned it/,
    )

    // A DRAFT of the same order: SH-0001's BLK 50 cell has no released garment left for it while SH-0001 holds its own.
    draft = randomUUID()
    expect(await copyRow(office(), 'Shipment', 'id = $2::uuid', { id: draft, number: `SH-T-${randomUUID().slice(0, 8)}`, status: 'DRAFT', packedAt: null, shippedAt: null, returnedAt: null, transportEvidence: 'NOT_NEEDED', transportEvidenceAt: null, transportEvidenceById: null, carrierShipmentId: null, version: 1 }, sh1())).toBe(1)
    const line = returns.money.shipping.lineIds[0]
    const cell = await cellOf(line)
    const wanted = (await freeOf(cell)) + 1
    await expect(copyRow(office(), 'ShipmentLine', 'id = $2::uuid', { id: randomUUID(), shipmentId: draft, parcelId: null, quantity: wanted, version: 1 }, line)).rejects.toThrow(/only released garments ship/)

    expect(await run(office(), `UPDATE "Shipment" SET "carrierReturnReceivedAt" = now() WHERE id = $1::uuid`, sh1())).toBe(1)
    await expect(run(office(), `UPDATE "Shipment" SET "carrierReturnReceivedAt" = now() + interval '1 hour' WHERE id = $1::uuid`, sh1())).rejects.toThrow(/that time never changes/)
    await expect(run(office(), `UPDATE "Shipment" SET "carrierReturnReceivedAt" = NULL WHERE id = $1::uuid`, sh1())).rejects.toThrow(/that time never changes/)
    // Its internal note still changes (the RETURNED rules stand).
    expect(await run(office(), `UPDATE "Shipment" SET "internalNote" = 'Back at the dock (made up).' WHERE id = $1::uuid`, sh1())).toBe(1)

    // Received back: SH-0001's line no longer holds the garment, so the same cell ships it again.
    expect(await copyRow(office(), 'ShipmentLine', 'id = $2::uuid', { id: randomUUID(), shipmentId: draft, parcelId: null, quantity: wanted, version: 1 }, line)).toBe(1)
    // And never one more than that.
    await expect(copyRow(office(), 'ShipmentLine', 'id = $2::uuid', { id: randomUUID(), shipmentId: draft, parcelId: null, quantity: 1, version: 1 }, line)).rejects.toThrow(/only released garments ship/)
  })

  it('a SHIPPED serial goes back to RELEASED, unpacked, only once its shipment was received back; the office’s', async () => {
    // SH-0002 (the serial-tracked jacket) left with a released serial and came back with the carrier (the seed's facts).
    const sh2 = returns.money.shipping.draftShipmentId
    const [serial] = await admin(`SELECT id FROM "GarmentSerial" WHERE "workOrderSizeId" = $1 AND status = 'RELEASED' AND "shipmentLineId" IS NULL ORDER BY serial LIMIT 1`, [returns.money.shipping.quality.serialCellId])
    const serialId = String(serial!.id)
    await force(`UPDATE "Shipment" SET status = 'RETURNED', "packedAt" = now(), "shippedAt" = now(), "returnedAt" = now() WHERE id = $1`, [sh2])
    await force(`UPDATE "GarmentSerial" SET status = 'SHIPPED', "shipmentLineId" = $2 WHERE id = $1`, [serialId, returns.money.shipping.draftLineId])
    const unpack = `UPDATE "GarmentSerial" SET status = 'RELEASED', "shipmentLineId" = NULL, version = version + 1 WHERE id = $1::uuid`
    await expect(run(office(), unpack, serialId)).rejects.toThrow(/is SHIPPED; it never changes/)

    expect(await run(office(), `UPDATE "Shipment" SET "carrierReturnReceivedAt" = now() WHERE id = $1::uuid`, sh2)).toBe(1)
    await expect(run(floor(), unpack, serialId)).rejects.toThrow(/taking back and shipping serial .* are the office's/)
    // Nothing else changes with it.
    await expect(run(office(), `UPDATE "GarmentSerial" SET status = 'RELEASED', "shipmentLineId" = NULL, "voidReason" = 'Back from the carrier' WHERE id = $1::uuid`, serialId)).rejects.toThrow(/is SHIPPED; it never changes/)
    await expect(run(office(), `UPDATE "GarmentSerial" SET status = 'MADE', "shipmentLineId" = NULL WHERE id = $1::uuid`, serialId)).rejects.toThrow(/is SHIPPED; it never changes/)

    expect(await run(office(), unpack, serialId)).toBe(1)
    expect(await admin(`SELECT status::text AS status, "shipmentLineId", "releaseId" IS NOT NULL AS released FROM "GarmentSerial" WHERE id = $1`, [serialId])).toEqual([{ status: 'RELEASED', shipmentLineId: null, released: true }])
  })
})

describe('the customer’s return is a source of the PPE register (Z4:02)', () => {
  it('one entry per return; an unknown source type is still refused', async () => {
    const rma = returns.waitingReturnId
    const entry = (sourceType: string, sourceId: string) => ({ id: randomUUID(), reference: `REG-T-${randomUUID().slice(0, 8)}`, sourceType, sourceId, status: 'OPEN', version: 1 })
    const seeded = 'reference = $2'
    expect(await copyRow(office(), 'PpeRegisterEntry', seeded, entry('ReturnAuthorisation', rma), 'SEED-REG-2026-001')).toBe(1)
    await expect(copyRow(office(), 'PpeRegisterEntry', seeded, entry('ReturnAuthorisation', rma), 'SEED-REG-2026-001')).rejects.toThrow(/PpeRegisterEntry_tenantId_sourceType_sourceId_key|Unique constraint/)
    await expect(copyRow(office(), 'PpeRegisterEntry', seeded, entry('ReturnLine', returns.waitingLineId), 'SEED-REG-2026-001')).rejects.toThrow(/names its source as a known record type/)
  })
})
