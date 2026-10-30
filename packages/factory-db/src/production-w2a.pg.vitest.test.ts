import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedSchedule, type ScheduleSeed } from '../seed/schedule'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { classifiedModels, partnerWalledColumns } from './ownership'
import { FLOOR_ROLE, OFFICE_ROLE, PARTNER_ROLE, RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'
import { loadOwnership, loadSchema } from './tools'

/**
 * W2a schema wave 5/7 (production and schedule) beyond the generated isolation tests, on a database built from the
 * migrations and seeded twice (tenants A and B), through the real login and the scoped client:
 *   - the walls: the floor reads ONLY published plans and their slots (Owner answer P3), opens and moves rework (it is
 *     scanned on the floor), never sees a replacement; no partner reads anything here; no cost column;
 *   - a published version is frozen for every login (the owner included): no change, no removal, no slot added; a
 *     publish is complete at commit; versions go up; one working plan per site, whose slots move and go;
 *   - a work order ON_HOLD refuses floor work (scans, cuts, bundles), finished-goods receipts and rework progress until
 *     the hold is lifted, back only to the status it was held from; a hold waits for the gated work in flight;
 *   - a REPAIR work order is released with the operations it needs; the line it is allocated to;
 *   - a bundle split keeps a garment in the parent, its cell, part and genealogy;
 *   - finished goods: a FINISHED item is one SKU for good; a production receipt is of the work order's SKU, into
 *     finished-goods stock, never more than its cell;
 *   - rework and replacements move only as their states allow;
 *   - the seeds are idempotent.
 * The refusals are check_violation (SQLSTATE 23514); their messages are read through raw SQL.
 */

const DENIED = /permission denied/
const FILES = new Set(['rework.prisma', 'schedule.prisma'])

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let seeded: ScheduleSeed

const NS = 'w2a5-a'
const key = (name: string): string => seedUuid(NS, name)
const A = {
  companyA: key('company:A'),
  siteA: key('site:A1'),
  siteB: key('site:B1'),
  line: key('site:A1:line:L1'),
  cut: key('site:A1:work-centre:CUT'),
  sew: key('site:A1:work-centre:SEW'),
  workshop: key('party:P2'),
  store: key('inventory:location:A1-STORE'),
}

const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: randomUUID(), siteId: A.siteA })
const partner = (): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: randomUUID(), partyId: key('party:P1') })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const count = async (text: string, values: unknown[] = []) => Number((await admin(text, values))[0]!.n)
const insert = (scope: FactoryScope, table: string, row: Record<string, unknown>) => {
  const columns = Object.keys(row)
    .map((column) => `"${column}"`)
    .join(', ')
  return run(scope, `INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`, JSON.stringify(row))
}
const tag = (): string => randomUUID().slice(0, 8)
const status = async (table: string, id: string) => String((await admin(`SELECT status::text AS s FROM "${table}" WHERE id = $1`, [id]))[0]!.s)

beforeAll(async () => {
  db = await migratedDatabase('productionw2a')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  await seedCore({ db: factory, namespace: 'w2a5-b' })
  seeded = await seedSchedule({ db: factory, namespace: NS })
  await seedSchedule({ db: factory, namespace: 'w2a5-b' })
}, 180_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

// --- helpers --------------------------------------------------------------------------------------------------------

const wo = () => seeded.production.workOrderId
const hold = (workOrderId: string, from: string, reason = 'Seam strength in doubt: wait for the lab.') =>
  run(office(), `UPDATE "WorkOrder" SET status = 'ON_HOLD', "heldFromStatus" = $2::"WorkOrderStatus", "heldAt" = now(), "heldById" = $3::uuid, "holdReason" = $4 WHERE id = $1::uuid`, workOrderId, from, a.actorId, reason)
const lift = (workOrderId: string, to: string) =>
  run(office(), `UPDATE "WorkOrder" SET status = $2::"WorkOrderStatus", "heldFromStatus" = NULL, "heldAt" = NULL, "heldById" = NULL, "holdReason" = NULL WHERE id = $1::uuid`, workOrderId, to)
/** A floor REPORT of the sleeves bundle of BLK 52 at sewing (as the operator on the cutting tablet). */
const scan = () =>
  insert(floor(), 'OperationScan', {
    id: randomUUID(),
    siteId: A.siteA,
    workOrderId: wo(),
    workOrderOperationId: seeded.production.operationIds.pack,
    bundleId: seeded.production.bundleIds[1],
    kind: 'REPORT',
    goodQuantity: 1,
    workerId: seeded.production.operatorId,
    deviceId: seeded.production.deviceId,
    clientScanId: `t-${tag()}`,
  })
/** A production receipt of `quantity` finished garments of the seed's SKU (BLK 52) from WO-0001. */
const receipt = (quantity: number, extra: Record<string, unknown> = {}) => {
  const id = randomUUID()
  return {
    id,
    done: insert(office(), 'StockMove', {
      id,
      companyId: A.companyA,
      siteId: A.siteA,
      reason: 'PRODUCTION_RECEIPT',
      itemId: seeded.finishedItemId,
      toLocationId: seeded.finishedLocationId,
      quantity: String(quantity),
      uom: 'PCS',
      baseQuantity: String(quantity),
      workOrderId: wo(),
      idempotencyKey: `t-${id}`,
      occurredAt: new Date().toISOString(),
      ...extra,
    }),
  }
}

// --- the walls ------------------------------------------------------------------------------------------------------

describe('the walls', () => {
  const models = classifiedModels(loadSchema(), loadOwnership()).filter(({ model }) => FILES.has(model.file))

  it('the floor reads published plans and moves rework; no partner reads anything; no cost column', async () => {
    expect(models.map(({ model }) => model.name).sort()).toEqual(['PlanVersion', 'ReplacementRequest', 'ReworkOrder', 'ScheduleSlot'])
    const floorAccess = Object.fromEntries(models.map(({ model, ownership }) => [model.name, ownership.access[FLOOR_ROLE]?.privileges ?? []]))
    expect(floorAccess).toEqual({ PlanVersion: ['select'], ReplacementRequest: [], ReworkOrder: ['select', 'insert', 'update'], ScheduleSlot: ['select'] })
    for (const { model, ownership } of models) {
      expect(ownership.access[OFFICE_ROLE], model.name).toBeDefined()
      expect(ownership.access[PARTNER_ROLE], model.name).toBeUndefined()
      await expect(sql(partner(), `SELECT 1 FROM "${model.table}" LIMIT 1`), model.name).rejects.toThrow(DENIED)
      expect(partnerWalledColumns(model), model.name).toEqual([])
    }
    await expect(sql(floor(), 'SELECT 1 FROM "ReplacementRequest" LIMIT 1')).rejects.toThrow(DENIED)
    await expect(run(floor(), 'DELETE FROM "ReworkOrder" WHERE false')).rejects.toThrow(DENIED)
  })

  it('the floor never reads the working plan (P3): only its site’s published versions and their slots', async () => {
    const plans = await sql(floor(), 'SELECT id, kind::text AS kind, number FROM "PlanVersion"')
    expect(plans).toEqual([{ id: seeded.publishedPlanId, kind: 'PUBLISHED', number: 1 }])
    expect(await sql(floor(), `SELECT id FROM "PlanVersion" WHERE kind = 'WORKING'`)).toEqual([])
    const slots = await sql(floor(), 'SELECT "planVersionId", "planKind"::text AS kind FROM "ScheduleSlot"')
    expect(slots).toHaveLength(4)
    expect(new Set(slots.map((row) => row.planVersionId))).toEqual(new Set([seeded.publishedPlanId]))
    expect(await sql(floor(), 'SELECT id FROM "ScheduleSlot" WHERE "planVersionId" = $1::uuid', seeded.workingPlanId)).toEqual([])
    // The office sees both: the working plan has 5 slots (WO-0002 added since v1).
    expect(await count('SELECT count(*) AS n FROM "ScheduleSlot" WHERE "planVersionId" = $1', [seeded.workingPlanId])).toBe(5)
    expect((await sql(office(), 'SELECT id FROM "ScheduleSlot" WHERE "planVersionId" = $1::uuid', seeded.workingPlanId)).length).toBe(5)
    await expect(run(floor(), `UPDATE "ScheduleSlot" SET note = 'x' WHERE false`)).rejects.toThrow(DENIED)
    await expect(run(floor(), `UPDATE "PlanVersion" SET note = 'x' WHERE false`)).rejects.toThrow(DENIED)
  })
})

// --- the planning board ---------------------------------------------------------------------------------------------

describe('plan versions and slots', () => {
  it('a published version and its slots are frozen for every login, the owner included', async () => {
    const v1 = seeded.publishedPlanId
    const [slot] = await admin('SELECT id FROM "ScheduleSlot" WHERE "planVersionId" = $1 LIMIT 1', [v1])
    await expect(run(office(), `UPDATE "PlanVersion" SET note = 'changed' WHERE id = $1::uuid`, v1)).rejects.toThrow(/is published; it never changes/)
    await expect(admin(`UPDATE "PlanVersion" SET "coversTo" = '2026-11-30' WHERE id = $1`, [v1])).rejects.toThrow(/is published; it never changes/)
    await expect(admin('DELETE FROM "PlanVersion" WHERE id = $1', [v1])).rejects.toThrow(/never deleted/)
    await expect(admin(`UPDATE "ScheduleSlot" SET "endAt" = "endAt" + interval '1 hour' WHERE id = $1`, [slot!.id])).rejects.toThrow(/is of a published version; it never changes/)
    await expect(admin('DELETE FROM "ScheduleSlot" WHERE id = $1', [slot!.id])).rejects.toThrow(/is of published version/)
    await expect(admin('TRUNCATE "ScheduleSlot"')).rejects.toThrow(/TRUNCATE on "ScheduleSlot" is refused/)
    await expect(admin('TRUNCATE "ReplacementRequest"')).rejects.toThrow(/TRUNCATE on "ReplacementRequest" is refused/)
    await expect(
      insert(office(), 'ScheduleSlot', {
        id: randomUUID(),
        siteId: A.siteA,
        planVersionId: v1,
        planKind: 'PUBLISHED',
        workOrderId: wo(),
        workCentreId: A.cut,
        startAt: '2026-11-20T08:00:00Z',
        endAt: '2026-11-20T09:00:00Z',
        minutes: '10',
      }),
    ).rejects.toThrow(/is published; it takes no more slots/)
    // A no-op update passes (the generated isolation tests touch rows that way).
    expect(await run(office(), 'UPDATE "PlanVersion" SET note = note WHERE id = $1::uuid', v1)).toBe(1)
  })

  it('a publish is one transaction: the version, its slots, then publishedAt; versions go up', async () => {
    const working = await admin('SELECT * FROM "ScheduleSlot" WHERE "planVersionId" = $1', [seeded.workingPlanId])
    const publish = (number: number, publishedAt: string | null, previousId: string | null = seeded.publishedPlanId) =>
      as(office(), (client) =>
        client.$transaction(async (tx) => {
          const id = randomUUID()
          await tx.$executeRawUnsafe(
            `INSERT INTO "PlanVersion" (id, "companyId", "siteId", kind, number, "previousId", "coversFrom", "coversTo", "effectiveFrom") VALUES ($1::uuid, $2::uuid, $3::uuid, 'PUBLISHED', $4, $5::uuid, '2026-11-23', '2026-11-27', '2026-11-23T05:00:00Z')`,
            id,
            A.companyA,
            A.siteA,
            number,
            previousId,
          )
          for (const slot of working) {
            await tx.$executeRawUnsafe(
              `INSERT INTO "ScheduleSlot" (id, "siteId", "planVersionId", "planKind", "workOrderId", "workOrderOperationId", "lineId", "workCentreId", "partyId", "startAt", "endAt", minutes) VALUES ($1::uuid, $2::uuid, $3::uuid, 'PUBLISHED', $4::uuid, $5::uuid, $6::uuid, $7::uuid, $8::uuid, $9::timestamptz, $10::timestamptz, $11::numeric)`,
              randomUUID(),
              A.siteA,
              id,
              slot.workOrderId,
              slot.workOrderOperationId,
              slot.lineId,
              slot.workCentreId,
              slot.partyId,
              slot.startAt,
              slot.endAt,
              String(slot.minutes),
            )
          }
          if (publishedAt) await tx.$executeRawUnsafe(`UPDATE "PlanVersion" SET "publishedAt" = $2::timestamptz, "publishedById" = $3::uuid WHERE id = $1::uuid`, id, publishedAt, a.actorId)
          return id
        }),
      )
    await expect(publish(2, null)).rejects.toThrow(/made and published in one transaction/)
    await expect(publish(1, '2026-11-22T16:00:00Z')).rejects.toThrow(/the site's versions go up|unique/i)
    const v2 = await publish(2, '2026-11-22T16:00:00Z')
    expect(await count('SELECT count(*) AS n FROM "ScheduleSlot" WHERE "planVersionId" = $1', [v2])).toBe(5)
    // The floor now sees v1 and v2, and still no working slot.
    expect((await sql(floor(), 'SELECT number FROM "PlanVersion" ORDER BY number')).map((row) => row.number)).toEqual([1, 2])
    // A version follows a published one of its site, with a lower number.
    await expect(publish(3, '2026-11-29T16:00:00Z', seeded.workingPlanId)).rejects.toThrow(/follows plan .*, a published version of its site with a lower number/)
  })

  it('one working plan per site; its slots move, book one lane, and go back to the tray', async () => {
    await expect(insert(office(), 'PlanVersion', { id: randomUUID(), companyId: A.companyA, siteId: A.siteA, kind: 'WORKING' })).rejects.toThrow(/PlanVersion_one_working|duplicate key/)
    await expect(insert(office(), 'PlanVersion', { id: randomUUID(), companyId: A.companyA, siteId: A.siteA, kind: 'WORKING', number: 9 })).rejects.toThrow(/has no number, range or publication/)
    const [slot] = await admin(`SELECT id FROM "ScheduleSlot" WHERE "planVersionId" = $1 AND "lineId" IS NOT NULL LIMIT 1`, [seeded.workingPlanId])
    const move = (set: string, ...values: unknown[]) => run(office(), `UPDATE "ScheduleSlot" SET ${set} WHERE id = $1::uuid`, slot!.id, ...values)
    expect(await move(`"startAt" = "startAt" + interval '1 day', "endAt" = "endAt" + interval '1 day', "overloadReason" = 'Overtime agreed with the line.', "updatedById" = $2::uuid`, a.actorId)).toBe(1)
    await expect(move(`"workCentreId" = $2::uuid`, A.sew)).rejects.toThrow(/books exactly one lane/)
    expect(await move(`"lineId" = NULL, "partyId" = $2::uuid`, A.workshop)).toBe(1)
    await expect(move(`"endAt" = "startAt"`)).rejects.toThrow(/ends after it starts/)
    await expect(move(`"workOrderId" = $2::uuid`, seeded.production.draftWorkOrderId)).rejects.toThrow(/never change; a move changes its lane/)
    await expect(move(`"overloadReason" = '  '`)).rejects.toThrow(/a reason to keep it over is not blank/)
    // A lane that is not a workshop is refused (P1 is the brand, not a subcontractor).
    await expect(move(`"partyId" = $2::uuid`, key('party:P1'))).rejects.toThrow(/placed on an ACTIVE lane/)
    expect(await run(office(), 'DELETE FROM "ScheduleSlot" WHERE id = $1::uuid', slot!.id)).toBe(1)
  })
})

// --- the hold -------------------------------------------------------------------------------------------------------

describe('a work order on hold', () => {
  it('moves on nowhere until the hold is lifted, back only to where it was held from', async () => {
    await expect(run(office(), `UPDATE "WorkOrder" SET status = 'ON_HOLD', "heldFromStatus" = 'IN_PROGRESS', "heldAt" = now() WHERE id = $1::uuid`, wo())).rejects.toThrow(/wrong hold/)
    await expect(hold(wo(), 'RELEASED')).rejects.toThrow(/is held from the status it is in \(IN_PROGRESS\)/)
    expect(await hold(wo(), 'IN_PROGRESS')).toBe(1)

    await expect(scan()).rejects.toThrow(/is ON_HOLD \(Seam strength in doubt: wait for the lab\.\); OperationScan .* waits until the hold is lifted/)
    await expect(
      insert(floor(), 'Bundle', { id: randomUUID(), siteId: A.siteA, workOrderId: wo(), workOrderSizeId: seeded.production.cellIds['BLK-50'], code: `T-BN-${tag()}`, quantity: 1, cutLogIds: [seeded.production.cutLogId] }),
    ).rejects.toThrow(/is ON_HOLD/)
    await expect(receipt(1).done).rejects.toThrow(/is ON_HOLD/)
    await expect(run(floor(), `UPDATE "ReworkOrder" SET status = 'IN_PROGRESS', "startedAt" = now() WHERE id = $1::uuid`, seeded.reworkOrderId)).rejects.toThrow(/is ON_HOLD/)
    // New rework may still be opened (a hold's disposition), and the hold's reason put right.
    expect(await run(office(), `UPDATE "WorkOrder" SET "holdReason" = 'Seam strength: lab report due Friday.', "holdRecordType" = 'Nonconformance', "holdRecordId" = $2::uuid WHERE id = $1::uuid`, wo(), randomUUID())).toBe(1)
    await expect(run(office(), `UPDATE "WorkOrder" SET "heldAt" = now() - interval '1 day' WHERE id = $1::uuid`, wo())).rejects.toThrow(/keeps where it was held from, when and by whom/)
    await expect(run(office(), `UPDATE "WorkOrder" SET status = 'COMPLETED', "completedAt" = now(), "heldFromStatus" = NULL, "heldAt" = NULL, "heldById" = NULL, "holdReason" = NULL, "holdRecordType" = NULL, "holdRecordId" = NULL WHERE id = $1::uuid`, wo())).rejects.toThrow(
      /cannot move from ON_HOLD to COMPLETED \(lifting its hold puts it back to IN_PROGRESS/,
    )
    await expect(lift(wo(), 'IN_PROGRESS')).rejects.toThrow(/wrong hold/)
    expect(await run(office(), `UPDATE "WorkOrder" SET status = 'IN_PROGRESS', "heldFromStatus" = NULL, "heldAt" = NULL, "heldById" = NULL, "holdReason" = NULL, "holdRecordType" = NULL, "holdRecordId" = NULL WHERE id = $1::uuid`, wo())).toBe(1)
    // Lifted: the work goes on.
    const lifted = receipt(1)
    expect(await lifted.done).toBe(1)
    await admin(`SET session_replication_role = 'replica'; DELETE FROM "StockMove" WHERE id = '${lifted.id}'; SET session_replication_role = 'origin'`)
  })

  it('a held draft is not released; a completed work order is not held', async () => {
    const draft = seeded.production.draftWorkOrderId
    expect(await hold(draft, 'DRAFT')).toBe(1)
    await expect(run(office(), `UPDATE "WorkOrder" SET status = 'RELEASED' WHERE id = $1::uuid`, draft)).rejects.toThrow(/cannot move from ON_HOLD to RELEASED/)
    // Its parts are frozen while it is held.
    await expect(run(office(), 'UPDATE "WorkOrderSize" SET quantity = quantity + 1 WHERE "workOrderId" = $1::uuid', draft)).rejects.toThrow(/is ON_HOLD; its size quantities are frozen/)
    expect(await lift(draft, 'DRAFT')).toBe(1)
    await expect(hold(wo(), 'COMPLETED')).rejects.toThrow(/held from the status it is in/)
  })

  it('a hold waits for the gated work in flight', async () => {
    const inFlight = new pg.Client({ connectionString: db.url('postgres') })
    const holder = new pg.Client({ connectionString: db.url('postgres') })
    await inFlight.connect()
    await holder.connect()
    try {
      await inFlight.query('BEGIN')
      // What a scan's trigger takes: the work order's gate, shared.
      await inFlight.query(`SELECT pg_advisory_xact_lock_shared(hashtextextended(concat_ws('|', 'factory.work-order-gate', $1::uuid, $2::uuid), 0))`, [a.tenantId, wo()])
      let done = false
      const holding = holder
        .query(`UPDATE "WorkOrder" SET status = 'ON_HOLD', "heldFromStatus" = 'IN_PROGRESS', "heldAt" = now(), "holdReason" = 'Wait.' WHERE id = $1`, [wo()])
        .then((result) => {
          done = true
          return result
        })
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(done).toBe(false)
      await inFlight.query('COMMIT')
      expect((await holding).rowCount).toBe(1)
      await holder.query(`UPDATE "WorkOrder" SET status = 'IN_PROGRESS', "heldFromStatus" = NULL, "heldAt" = NULL, "holdReason" = NULL WHERE id = $1`, [wo()])
    } finally {
      await inFlight.end()
      await holder.end()
    }
  })
})

// --- repair, line, split --------------------------------------------------------------------------------------------

describe('repair work orders, lines and bundle splits', () => {
  it('a REPAIR work order is released with the operations the repair needs, its cells of any order line', async () => {
    const [cell] = await admin('SELECT "salesOrderLineId", "partyId", "colourwayId", size FROM "WorkOrderSize" WHERE id = $1', [seeded.production.cellIds['BLK-52']])
    const [revision] = await admin('SELECT "routingSeq", code, name, "standardMinutes", "workCentreId" FROM "WorkOrderOperation" WHERE id = $1', [seeded.production.operationIds.sew])
    const make = async (kind: string) => {
      const id = randomUUID()
      await insert(office(), 'WorkOrder', { id, companyId: A.companyA, siteId: A.siteA, number: `T-WO-${tag()}`, kind, styleId: seeded.production.styleId, styleRevisionId: seeded.production.revisionId, labelTemplateId: seeded.production.labelTemplateId })
      await insert(office(), 'WorkOrderSize', { id: randomUUID(), siteId: A.siteA, workOrderId: id, styleId: seeded.production.styleId, colourwayId: cell!.colourwayId, size: cell!.size, quantity: 1, salesOrderLineId: cell!.salesOrderLineId, partyId: cell!.partyId })
      await insert(office(), 'WorkOrderOperation', { id: randomUUID(), siteId: A.siteA, workOrderId: id, styleRevisionId: seeded.production.revisionId, seq: 10, ...revision })
      return id
    }
    const release = (id: string) => run(office(), `UPDATE "WorkOrder" SET status = 'RELEASED', "releasedAt" = now(), "batchNumber" = $2 WHERE id = $1::uuid`, id, `T-BT-${tag()}`)
    const grid = await make('SIZE_GRID')
    await expect(release(grid)).rejects.toThrow(/step\(s\) missing/)
    const repair = await make('REPAIR')
    expect(await release(repair)).toBe(1)
    expect(await status('WorkOrder', repair)).toBe('RELEASED')
  })

  it('a work order is allocated to an ACTIVE line of its site', async () => {
    const archived = randomUUID()
    await insert(office(), 'Line', { id: archived, companyId: A.companyA, siteId: A.siteA, code: `T-L-${tag()}`, name: 'Old line', status: 'ARCHIVED' })
    await expect(run(office(), 'UPDATE "WorkOrder" SET "lineId" = $2::uuid WHERE id = $1::uuid', wo(), archived)).rejects.toThrow(/is ARCHIVED; work order .* is allocated to an ACTIVE line/)
    await expect(run(office(), 'UPDATE "WorkOrder" SET "lineId" = $2::uuid WHERE id = $1::uuid', wo(), key('site:B1:line:L1'))).rejects.toThrow(/foreign key/)
    expect(await run(office(), 'UPDATE "WorkOrder" SET "lineId" = $2::uuid WHERE id = $1::uuid', wo(), A.line)).toBe(1)
  })

  it('a split leaves a garment in the parent, of its cell and part, and keeps its genealogy', async () => {
    const parent = seeded.production.bundleIds[1]
    const child = (extra: Record<string, unknown> = {}) =>
      insert(floor(), 'Bundle', {
        id: randomUUID(),
        siteId: A.siteA,
        workOrderId: wo(),
        workOrderSizeId: seeded.production.cellIds['BLK-52'],
        code: `T-BN-${tag()}`,
        quantity: 1,
        part: 'SLEEVES',
        cutLogIds: [seeded.production.cutLogId],
        parentBundleId: parent,
        deviceId: seeded.production.deviceId,
        clientEventId: `t-${tag()}`,
        ...extra,
      })
    await expect(child({ workOrderSizeId: seeded.production.cellIds['BLK-50'] })).rejects.toThrow(/of the same cell and part/)
    await expect(child({ cutLogIds: [randomUUID()] })).rejects.toThrow(/cut log entries/)
    await expect(child({ quantity: 2 })).rejects.toThrow(/leaves none in it/)
    expect(await child()).toBe(1)
    await expect(child()).rejects.toThrow(/1 split off already/)
    await expect(run(office(), `UPDATE "Bundle" SET status = 'VOID', "voidedAt" = now(), "voidReason" = 'Made by mistake.' WHERE id = $1::uuid`, parent)).rejects.toThrow(/has ACTIVE bundles split from it/)
    await expect(run(office(), 'UPDATE "Bundle" SET "parentBundleId" = NULL WHERE "parentBundleId" = $1::uuid', parent)).rejects.toThrow(/changes only by a reprint/)
  })
})

// --- finished goods -------------------------------------------------------------------------------------------------

describe('finished goods', () => {
  it('a FINISHED item is one SKU for good, in pieces, never on a BOM line', async () => {
    const item = (extra: Record<string, unknown>) =>
      insert(office(), 'Item', { id: randomUUID(), code: `T-FG-${tag()}`, name: 'Finished', kind: 'FINISHED', sourcing: 'MAKE', baseUom: 'PCS', purchaseUom: 'PCS', consumptionUom: 'PCS', ...extra })
    await expect(item({})).rejects.toThrow(/FINISHED garment exactly when it names its SKU/)
    await expect(item({ kind: 'TRIM', variantId: key('production:variant:JKT-02:RED:50') })).rejects.toThrow(/FINISHED garment exactly when it names its SKU/)
    await expect(item({ variantId: key('production:variant:JKT-02:RED:50'), baseUom: 'M' })).rejects.toThrow(/counts pieces/)
    await expect(item({ variantId: key('production:variant:JKT-02:BLK:52') })).rejects.toThrow(/duplicate key|Item_tenantId_variantId_key/)
    await expect(run(office(), 'UPDATE "Item" SET "variantId" = $2::uuid WHERE id = $1::uuid', seeded.finishedItemId, key('production:variant:JKT-02:RED:50'))).rejects.toThrow(/keeps its kind and SKU/)
    await expect(run(office(), `UPDATE "Item" SET kind = 'TRIM', "variantId" = NULL WHERE id = $1::uuid`, seeded.finishedItemId)).rejects.toThrow(/keeps its kind and SKU/)
    // A line of SEED-JKT-01's DRAFT revision (the product seed's) cannot name it, for any login.
    await expect(
      admin('UPDATE "BomLine" SET "itemId" = $1 WHERE id = (SELECT id FROM "BomLine" WHERE "tenantId" = $2 AND "revisionId" = $3 ORDER BY id LIMIT 1)', [seeded.finishedItemId, a.tenantId, key('product:revision:JKT-01:1')]),
    ).rejects.toThrow(/a finished garment's item; a BOM line names a material/)
  })

  it('a production receipt puts the work order’s SKU into finished-goods stock, never more than its cell', async () => {
    await expect(receipt(1, { toLocationId: A.store }).done).rejects.toThrow(/is not finished-goods stock/)
    await expect(receipt(1, { itemId: key('product:item:lining'), uom: 'M' }).done).rejects.toThrow(/not a FINISHED item/)
    await expect(receipt(1, { workOrderId: null }).done).rejects.toThrow(/without its work order/)
    await expect(receipt(1, { toLocationId: null, fromLocationId: seeded.finishedLocationId }).done).rejects.toThrow(/only enters stock/)
    await expect(receipt(1, { quantity: '0.5', baseQuantity: '0.5' }).done).rejects.toThrow(/whole pieces/)
    // The DRAFT WO-0002 makes BLK 52 too, but nothing of it goes into stock before it is in progress.
    await expect(receipt(1, { workOrderId: seeded.production.draftWorkOrderId }).done).rejects.toThrow(/is DRAFT; its finished garments go into stock while it is IN_PROGRESS or COMPLETED/)
    // A SKU the work order does not make (SEED-JKT-01's, the product seed's style).
    const other = randomUUID()
    await insert(office(), 'Item', { id: other, code: `T-FG-${tag()}`, name: 'Other style', kind: 'FINISHED', sourcing: 'MAKE', baseUom: 'PCS', purchaseUom: 'PCS', consumptionUom: 'PCS', variantId: key('product:variant:JKT-01:BLK:52') })
    await expect(receipt(1, { itemId: other }).done).rejects.toThrow(/SKU of another style/)
    // BLK 52 makes 2: one, then one more, then no third; a reversal gives one back.
    const first = receipt(1)
    expect(await first.done).toBe(1)
    expect(await receipt(1).done).toBe(1)
    await expect(receipt(1).done).rejects.toThrow(/makes 2 garment\(s\) of item .*; 2(\.0+)? went into stock already/)
    const reversal = randomUUID()
    expect(
      await insert(office(), 'StockMove', {
        id: reversal,
        companyId: A.companyA,
        siteId: A.siteA,
        reason: 'PRODUCTION_RECEIPT',
        itemId: seeded.finishedItemId,
        fromLocationId: seeded.finishedLocationId,
        quantity: '1',
        uom: 'PCS',
        baseQuantity: '1',
        workOrderId: wo(),
        reversalOfId: first.id,
        idempotencyKey: `t-${reversal}`,
        occurredAt: new Date().toISOString(),
      }),
    ).toBe(1)
    expect(await receipt(1).done).toBe(1)
  })
})

// --- rework and replacement -----------------------------------------------------------------------------------------

describe('rework and replacements', () => {
  const rework = (extra: Record<string, unknown> = {}) => {
    const id = randomUUID()
    return {
      id,
      done: insert(floor(), 'ReworkOrder', {
        id,
        companyId: A.companyA,
        siteId: A.siteA,
        workOrderId: wo(),
        workOrderSizeId: seeded.production.cellIds['BLK-52'],
        bundleId: seeded.production.bundleIds[1],
        foundAtOperationId: seeded.production.operationIds.qc,
        reworkAtOperationId: seeded.production.operationIds.sew,
        quantity: 1,
        reasonCode: 'RESTITCH',
        ...extra,
      }),
    }
  }

  it('rework is opened on the floor and moves OPEN → IN_PROGRESS → DONE with a result that adds up', async () => {
    await expect(rework({ reasonCode: 'STAIN' }).done).rejects.toThrow(/not an active REWORK reason/)
    await expect(rework({ reworkAtOperationId: seeded.production.operationIds.pack }).done).rejects.toThrow(/goes back to an operation at or before/)
    await expect(rework({ quantity: 3 }).done).rejects.toThrow(/carries at least its 3 garment/)
    await expect(rework({ status: 'DONE', goodQuantity: 1 }).done).rejects.toThrow(/starts OPEN/)
    await expect(rework({ sourceScanId: seeded.production.scanIds[2] }).done).rejects.toThrow(/a REPORT or CORRECTION of its work order with rework/)
    const opened = rework()
    expect(await opened.done).toBe(1)
    const update = (set: string) => run(floor(), `UPDATE "ReworkOrder" SET ${set} WHERE id = $1::uuid`, opened.id)
    expect(await update(`status = 'IN_PROGRESS', "startedAt" = now()`)).toBe(1)
    await expect(update(`quantity = 2`)).rejects.toThrow(/is IN_PROGRESS; what it is .* changes only while OPEN/)
    await expect(update(`status = 'DONE', "doneAt" = now(), "goodQuantity" = 1, "scrapQuantity" = 1`)).rejects.toThrow(/add up to them/)
    expect(await update(`status = 'DONE', "doneAt" = now(), "scrapQuantity" = 1`)).toBe(1)
    await expect(update(`status = 'OPEN', "doneAt" = NULL, "startedAt" = NULL, "scrapQuantity" = 0`)).rejects.toThrow(/only its note changes/)
    await expect(admin('DELETE FROM "ReworkOrder" WHERE id = $1', [opened.id])).rejects.toThrow(/never deleted/)

    // Its scrap is replaced by a recut of the cell (the office's): done by a cut log entry with pieces of the cell.
    const id = randomUUID()
    await expect(insert(floor(), 'ReplacementRequest', { id, companyId: A.companyA, siteId: A.siteA, workOrderId: wo(), workOrderSizeId: seeded.production.cellIds['BLK-52'], kind: 'RECUT', quantity: 1, reason: 'x' })).rejects.toThrow(DENIED)
    expect(await insert(office(), 'ReplacementRequest', { id, companyId: A.companyA, siteId: A.siteA, workOrderId: wo(), workOrderSizeId: seeded.production.cellIds['BLK-52'], kind: 'RECUT', quantity: 1, part: 'sleeve', reworkOrderId: opened.id, reason: 'Scrapped in rework.' })).toBe(1)
    const set = (text: string, ...values: unknown[]) => run(office(), `UPDATE "ReplacementRequest" SET ${text} WHERE id = $1::uuid`, id, ...values)
    await expect(set(`status = 'APPROVED', "decidedAt" = now(), "decidedById" = $2::uuid`, randomUUID())).rejects.toThrow(/cannot move from OPEN to APPROVED/)
    await expect(set(`status = 'DONE', "doneAt" = now()`)).rejects.toThrow(/DONE exactly with its cut log entry/)
    expect(await set(`status = 'DONE', "doneAt" = now(), "cutLogId" = $2::uuid`, seeded.production.cutLogId)).toBe(1)
  })

  it('a reduction is decided by another person, a refusal says why', async () => {
    const asker = randomUUID()
    const reduce = async () => {
      const id = randomUUID()
      await insert(office(), 'ReplacementRequest', { id, companyId: A.companyA, siteId: A.siteA, workOrderId: wo(), workOrderSizeId: seeded.production.cellIds['BLK-50'], kind: 'REDUCE', quantity: 1, reason: 'The customer takes one less.', createdById: asker })
      return id
    }
    const id = await reduce()
    const set = (text: string, ...values: unknown[]) => run(office(), `UPDATE "ReplacementRequest" SET ${text} WHERE id = $1::uuid`, id, ...values)
    await expect(insert(office(), 'ReplacementRequest', { id: randomUUID(), companyId: A.companyA, siteId: A.siteA, workOrderId: wo(), workOrderSizeId: seeded.production.cellIds['BLK-50'], kind: 'REDUCE', quantity: 2, reason: 'Too many.' })).rejects.toThrow(/its cell makes 1/)
    await expect(set(`status = 'APPROVED', "decidedAt" = now(), "decidedById" = $2::uuid`, asker)).rejects.toThrow(/another person than the one who asked/)
    await expect(set(`status = 'REFUSED', "decidedAt" = now(), "decidedById" = $2::uuid`, a.actorId)).rejects.toThrow(/a refusal says why/)
    await expect(set(`status = 'DONE', "doneAt" = now()`)).rejects.toThrow(/cannot move from OPEN to DONE/)
    expect(await set(`status = 'APPROVED', "decidedAt" = now(), "decidedById" = $2::uuid, "decisionNote" = 'Agreed with the brand.'`, a.actorId)).toBe(1)
    await expect(set(`"decisionNote" = 'changed'`)).rejects.toThrow(/decided once/)
    expect(await set(`status = 'DONE', "doneAt" = now()`)).toBe(1)
    const refused = await reduce()
    expect(await run(office(), `UPDATE "ReplacementRequest" SET status = 'REFUSED', "decidedAt" = now(), "decidedById" = $2::uuid, "decisionNote" = 'We recut instead.' WHERE id = $1::uuid`, refused, a.actorId)).toBe(1)
    expect(await status('ReplacementRequest', refused)).toBe('REFUSED')
  })
})

// --- the seeds ------------------------------------------------------------------------------------------------------

describe('the seeds', () => {
  it('are idempotent', async () => {
    const tables = ['PlanVersion', 'ScheduleSlot', 'ReworkOrder', 'ReplacementRequest', 'Item', 'Location']
    const counts = async () => {
      const found: number[] = []
      for (const table of tables) found.push(await count(`SELECT count(*) AS n FROM "${table}"`))
      return found
    }
    const before = await counts()
    await seedSchedule({ db: factory, namespace: 'w2a5-b' })
    expect(await counts()).toEqual(before)
  })
})
