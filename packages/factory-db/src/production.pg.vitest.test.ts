import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedLinks } from '../seed/links'
import { seed as seedProduction, type ProductionSeed } from '../seed/production'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { classifiedModels } from './ownership'
import { FLOOR_ROLE, PARTNER_ROLE, RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'
import { loadOwnership, loadSchema } from './tools'

/**
 * The production walls beyond the generated isolation tests (plan A1 §2.1, §2.2, §2.5, §2.6, §3.8; PLAN §2.8 "Limits
 * on monitoring workers", §4.7 stages 10-work-order, 11b-cut, 12-scans; features MES-005, MES-007, MES-056, MES-065,
 * MES-069, MES-073, MES-076, MES-095, MES-096, MES-278, PLT-208), on a database built from the migrations and seeded
 * twice (tenants A and B), through the real login and the scoped client:
 *   - the floor (factory_floor_runtime) reads only its own site's production rows, none of them holds a cost, price or
 *     wages column, and it never changes a work order or its parts;
 *   - a work order is released only with a RELEASED revision of its style, that revision's label template, a batch
 *     number of its own, its cells and its routing; from then on its specification never changes;
 *   - a cut takes a hide of a RELEASED lot that was issued to the work order, within the area it has there, also when
 *     two cuts race;
 *   - no scan names a worker who has not acknowledged the information notice (Statuto dei Lavoratori art. 4), and a site
 *     that records stations names none;
 *   - an offline resend is applied once (the device's client scan id); a bundle is reported once per operation, and an
 *     undo or a correction voids a scan, which stays;
 *   - cut logs, scans and acknowledgements are append-only for every login, the owner included;
 *   - an issue to a work order or a return from it names one of its site, an issue only a RELEASED or IN_PROGRESS one,
 *     and a cancel and an issue at once take turns (…_inventory_issue_work_order_guards);
 *   - the seeds are idempotent.
 * The refusals are check_violation (SQLSTATE 23514); their messages are read through the scoped client's raw SQL.
 */

const DENIED = /permission denied/
const FILE = 'production.prisma'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let b: CoreSeed
let seeded: ProductionSeed
/** The released revision's routing: seq, code, name, minutes and the kind of work centre. */
let routing: { seq: number; code: string; name: string; standardMinutes: string; kind: string }[]

const key = (namespace: string, name: string): string => seedUuid(namespace, name)
const A = {
  companyA: key('production-a', 'company:A'),
  siteA: key('production-a', 'site:A1'),
  P1: key('production-a', 'party:P1'),
  styleJkt01: key('production-a', 'product:style:JKT-01'),
  revisionJkt01: key('production-a', 'product:revision:JKT-01:1'),
  colourwayBLK: key('production-a', 'production:colourway:JKT-02:BLK'),
  lineBLK: key('production-a', 'production:sales-order:SO-0002:10'),
  draftCell: `00000000${key('production-a', 'production:WO-0002:cell:BLK:52').slice(8)}`,
  bin: key('production-a', 'inventory:location:A1-STORE-01'),
  leather: key('production-a', 'product:item:leather'),
  leatherBLK: key('production-a', 'product:item-colour:leather:BLK'),
  centre: (code: string): string => key('production-a', `site:A1:work-centre:${code}`),
  station: (code: string): string => key('production-a', `site:A1:station:${code}`),
}
const CENTRE_OF_KIND: Readonly<Record<string, string>> = { CUTTING: 'CUT', SEWING: 'SEW', INSPECTION: 'QC', PACKING: 'PACK' }

const office = (core: CoreSeed = a): FactoryScope => ({ audience: 'office', tenantId: core.tenantId, actorId: core.actorId })
const floor = (site = 0): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: randomUUID(), siteId: a.sites[site]!.id })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const count = async (text: string, values: unknown[] = []) => Number((await admin(text, values))[0]!.n)

/** `INSERT INTO "<table>" (<the row's columns>) …`: the columns it leaves out take their defaults (tenantId too). */
const insertSql = (table: string, row: Record<string, unknown>): [string, string] => {
  const columns = Object.keys(row)
    .map((column) => `"${column}"`)
    .join(', ')
  return [`INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`, JSON.stringify(row)]
}
const insert = (scope: FactoryScope, table: string, row: Record<string, unknown>) => run(scope, ...insertSql(table, row))
const tag = (): string => randomUUID().slice(0, 8)

beforeAll(async () => {
  db = await migratedDatabase('production')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: 'production-a' })
  b = await seedCore({ db: factory, namespace: 'production-b' })
  await seedLinks({ db: factory, namespace: 'production-a' })
  await seedLinks({ db: factory, namespace: 'production-b' })
  seeded = await seedProduction({ db: factory, namespace: 'production-a' })
  await seedProduction({ db: factory, namespace: 'production-b' })
  routing = (await admin(
    `SELECT seq, code, name, "standardMinutes"::text AS "standardMinutes", "workCentreKind"::text AS kind FROM "RoutingOperation" WHERE "revisionId" = $1 ORDER BY seq`,
    [seeded.revisionId],
  )) as typeof routing
}, 60_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

// --- helpers --------------------------------------------------------------------------------------------------------

interface DraftWorkOrder {
  readonly workOrderId: string
  readonly cellId: string
  /** Operation id by routing seq (when made with its routing). */
  readonly operations: Readonly<Record<number, string>>
}

/** A DRAFT work order of the released jacket on A1 with one cell (BLK 50, from SEED-SO-0002), with or without its routing. */
async function draftWorkOrder(options: { withCell?: boolean; withRouting?: boolean } = {}): Promise<DraftWorkOrder> {
  const { withCell = true, withRouting = true } = options
  const ids = { workOrderId: randomUUID(), cellId: randomUUID(), operations: Object.fromEntries(routing.map((step) => [step.seq, randomUUID()])) as Record<number, string> }
  await as(office(), (client) =>
    client.$transaction(async (tx) => {
      const exec = (table: string, row: Record<string, unknown>) => tx.$executeRawUnsafe(...insertSql(table, row))
      await exec('WorkOrder', { id: ids.workOrderId, companyId: A.companyA, siteId: A.siteA, number: `T-WO-${tag()}`, kind: 'SIZE_GRID', styleId: seeded.styleId, styleRevisionId: seeded.revisionId })
      if (withCell) {
        await exec('WorkOrderSize', {
          id: ids.cellId,
          siteId: A.siteA,
          workOrderId: ids.workOrderId,
          styleId: seeded.styleId,
          colourwayId: A.colourwayBLK,
          size: '50',
          quantity: 1,
          salesOrderLineId: A.lineBLK,
          partyId: A.P1,
        })
      }
      if (withRouting) {
        for (const step of routing) await exec('WorkOrderOperation', operationRow(ids.workOrderId, step, ids.operations[step.seq]!))
      }
    }),
  )
  return ids
}

const operationRow = (workOrderId: string, step: (typeof routing)[number], id: string = randomUUID()) => ({
  id,
  siteId: A.siteA,
  workOrderId,
  styleRevisionId: seeded.revisionId,
  seq: step.seq,
  routingSeq: step.seq,
  code: step.code,
  name: step.name,
  standardMinutes: step.standardMinutes,
  workCentreId: A.centre(CENTRE_OF_KIND[step.kind]!),
})

/** The release command's change: the frozen spec (the revision's label template) and a batch number of its own. */
const release = (workOrderId: string, extra: { labelTemplateId?: string | null; batchNumber?: string | null } = {}) =>
  run(
    office(),
    `UPDATE "WorkOrder" SET status = 'RELEASED', "labelTemplateId" = $2::uuid, "batchNumber" = $3, "releasedAt" = now() WHERE id = $1::uuid`,
    workOrderId,
    extra.labelTemplateId === undefined ? seeded.labelTemplateId : extra.labelTemplateId,
    extra.batchNumber === undefined ? `T-BT-${tag()}` : extra.batchNumber,
  )

/** A bundle of `quantity` garments of a cell of a work order, made on the floor of A1. */
async function bundle(options: { workOrderId?: string; cellId?: string; quantity?: number; scope?: FactoryScope } = {}): Promise<string> {
  const id = randomUUID()
  await insert(options.scope ?? floor(), 'Bundle', {
    id,
    siteId: A.siteA,
    workOrderId: options.workOrderId ?? seeded.workOrderId,
    workOrderSizeId: options.cellId ?? seeded.cellIds['RED-50'],
    code: `T-BN-${tag()}`,
    quantity: options.quantity ?? 1,
    deviceId: seeded.deviceId,
  })
  return id
}

/** A REPORT of a bundle of WO-0001 at sewing by the operator (who acknowledged the notice) on the cutting tablet. */
const scanRow = (extra: Record<string, unknown>): Record<string, unknown> => ({
  id: randomUUID(),
  siteId: A.siteA,
  workOrderId: seeded.workOrderId,
  workOrderOperationId: seeded.operationIds.sew,
  kind: 'REPORT',
  goodQuantity: 1,
  workerId: seeded.operatorId,
  deviceId: seeded.deviceId,
  clientScanId: `t-${randomUUID()}`,
  deviceTime: new Date().toISOString(),
  ...extra,
})

/** A cut of hide `hideId` of the seeded lot for WO-0001, by the operator, in ft² (the leather's base unit). */
const cutRow = (hideId: string, area: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: randomUUID(),
  siteId: A.siteA,
  workOrderId: seeded.workOrderId,
  lotId: seeded.inventory.leatherLotId,
  hideId,
  uom: 'FT2',
  areaUsed: area,
  baseAreaUsed: area,
  workerId: seeded.operatorId,
  deviceId: seeded.deviceId,
  clientEventId: `t-${randomUUID()}`,
  deviceTime: new Date().toISOString(),
  ...extra,
})

/** Two transactions that insert at once: the first holds its transaction open after its insert; the second waits. */
async function race(scope: FactoryScope, table: string, first: Record<string, unknown>, second: Record<string, unknown>): Promise<PromiseSettledResult<unknown>[]> {
  let firstInserted!: () => void
  const inserted = new Promise<void>((resolve) => {
    firstInserted = resolve
  })
  const one = as(scope, (client) =>
    client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(...insertSql(table, first))
      firstInserted()
      await new Promise((resolve) => setTimeout(resolve, 300))
    }),
  )
  await inserted
  const two = insert(scope, table, second)
  return Promise.allSettled([one, two])
}

// --- the floor --------------------------------------------------------------------------------------------------------

describe('the floor', () => {
  const models = classifiedModels(loadSchema(), loadOwnership()).filter(({ model }) => model.file === FILE)

  it('never reads or writes a cost, price or wages column: no production table holds one, nor a productivity figure', () => {
    expect(models.map(({ model }) => model.name).sort()).toEqual([
      'Bundle',
      'CutLog',
      'CutLogPiece',
      'FloorScanRefusal',
      'GarmentLabelPrint',
      'OperationScan',
      'OperationScanDefect',
      'ProductionSettings',
      'ScanCorrectionRequest',
      'ScrapReason',
      'WorkOrder',
      'WorkOrderMaterial',
      'WorkOrderOperation',
      'WorkOrderSize',
      'WorkerNoticeAck',
    ])
    for (const { model, ownership } of models) {
      expect(model.fields.filter((field) => field.tags.some((entry) => entry.startsWith('@grain'))), model.name).toEqual([])
      // Nor a column that looks like money or scores a worker (Statuto dei Lavoratori art. 4, Q16: no per-person figures).
      expect(model.columns.filter((column) => /cost|margin|price|amount|total|wage|earning|rate|efficien|productiv|score|bonus/i.test(column)), model.name).toEqual([])
      const access = ownership.access[FLOOR_ROLE]
      // The reason list is the tenant's (no site key): every floor device reads it (the operation screen's tiles).
      expect(access?.scopedBy, model.name).toEqual(model.name === 'ScrapReason' ? undefined : ['site'])
      // No money is walled off; only the floor rules' legal basis is hidden from the floor (B-W1-37: the floor reads who
      // its records name, never the basis, its reference or who recorded it, when).
      expect(access?.hiddenColumns ?? [], model.name).toEqual(model.name === 'ProductionSettings' ? ['monitoringBasis', 'monitoringReference', 'monitoringRecordedAt', 'monitoringRecordedById'] : [])
      expect(ownership.access[PARTNER_ROLE], model.name).toBeUndefined()
    }
  })

  it('reads only its own site’s work orders, bundles, scans and floor rules', async () => {
    const seen = async (scope: FactoryScope) => ({
      workOrders: (await as(scope, (client) => client.workOrder.findMany({ where: { number: { startsWith: 'SEED-' } }, orderBy: { number: 'asc' } }))).map((row) => row.number),
      bundles: (await as(scope, (client) => client.bundle.findMany({ where: { code: { startsWith: 'SEED-' } }, orderBy: { code: 'asc' } }))).map((row) => row.code),
      scans: (await as(scope, (client) => client.operationScan.findMany({ where: { clientScanId: { startsWith: 'seed-' } } }))).length,
      // The floor names what it reads of the floor rules: the legal basis columns are hidden from it.
      rules: (await as(scope, (client) => client.productionSettings.findMany({ select: { scanSubject: true } }))).map((row) => row.scanSubject),
    })
    // Prisma's default select names every column: the floor holds them all here (none is walled), but the floor rules'.
    expect(await seen(floor(0))).toEqual({ workOrders: ['SEED-WO-0001', 'SEED-WO-0002'], bundles: ['SEED-BN-0001', 'SEED-BN-0002'], scans: 3, rules: ['WORKER'] })
    // The plant of company B (site B1) sees its own floor rules only.
    expect(await seen(floor(1))).toEqual({ workOrders: [], bundles: [], scans: 0, rules: ['STATION'] })
  })

  it('never changes a work order or its parts, and never removes a floor record', async () => {
    await expect(run(floor(), `UPDATE "WorkOrder" SET note = 'x' WHERE id = $1::uuid`, seeded.workOrderId)).rejects.toThrow(DENIED)
    await expect(run(floor(), `UPDATE "WorkOrderSize" SET quantity = 9 WHERE id = $1::uuid`, seeded.cellIds['BLK-50'])).rejects.toThrow(DENIED)
    await expect(run(floor(), `UPDATE "WorkOrderOperation" SET "workCentreId" = "workCentreId" WHERE id = $1::uuid`, seeded.operationIds.sew)).rejects.toThrow(DENIED)
    await expect(insert(floor(), 'WorkOrderOperation', operationRow(seeded.draftWorkOrderId, routing[0]!))).rejects.toThrow(DENIED)
    await expect(run(floor(), 'DELETE FROM "Bundle" WHERE id = $1::uuid', seeded.bundleIds[0])).rejects.toThrow(DENIED)
    await expect(run(floor(), `UPDATE "OperationScan" SET reason = 'x' WHERE id = $1::uuid`, seeded.scanIds[2])).rejects.toThrow(DENIED)
    await expect(run(floor(), 'DELETE FROM "CutLog" WHERE id = $1::uuid', seeded.cutLogId)).rejects.toThrow(DENIED)
    await expect(run(floor(), `UPDATE "ProductionSettings" SET "scanSubject" = 'STATION' WHERE id = $1::uuid`, A.siteA)).rejects.toThrow(DENIED)
  })
})

// --- the work order ---------------------------------------------------------------------------------------------------

describe('a work order', () => {
  it('is released only with a RELEASED revision of its style, its label template, a batch number of its own, its cells and its routing', async () => {
    // The product seed's jacket: its revision is a DRAFT.
    const onDraftRevision = randomUUID()
    await insert(office(), 'WorkOrder', { id: onDraftRevision, companyId: A.companyA, siteId: A.siteA, number: `T-WO-${tag()}`, kind: 'SIZE_GRID', styleId: A.styleJkt01, styleRevisionId: A.revisionJkt01 })
    await expect(release(onDraftRevision, { labelTemplateId: null })).rejects.toThrow(/revision .* is DRAFT; work order .* is released only with a RELEASED revision of its style/)
    // Another style's revision: the reference refuses it.
    await expect(
      insert(office(), 'WorkOrder', { id: randomUUID(), companyId: A.companyA, siteId: A.siteA, number: `T-WO-${tag()}`, kind: 'SIZE_GRID', styleId: A.styleJkt01, styleRevisionId: seeded.revisionId }),
    ).rejects.toThrow(/foreign key/)
    // A work order starts as DRAFT.
    await expect(
      insert(office(), 'WorkOrder', { id: randomUUID(), companyId: A.companyA, siteId: A.siteA, number: `T-WO-${tag()}`, kind: 'SIZE_GRID', styleId: seeded.styleId, status: 'RELEASED' }),
    ).rejects.toThrow(/starts as DRAFT/)

    const empty = await draftWorkOrder({ withCell: false })
    await expect(release(empty.workOrderId)).rejects.toThrow(/released with its cells/)

    const draft = await draftWorkOrder({ withRouting: false })
    await expect(release(draft.workOrderId, { labelTemplateId: null })).rejects.toThrow(/carries the label template of its revision/)
    await expect(release(draft.workOrderId)).rejects.toThrow(/every step of its revision's routing as an operation .* \(4 step\(s\) missing\)/)
    for (const step of routing.slice(0, 3)) await insert(office(), 'WorkOrderOperation', operationRow(draft.workOrderId, step))
    await expect(release(draft.workOrderId)).rejects.toThrow(/\(1 step\(s\) missing\)/)
    // An operation is a copy of its routing step, at a work centre of the step's kind.
    const last = routing.at(-1)!
    await expect(insert(office(), 'WorkOrderOperation', { ...operationRow(draft.workOrderId, last), standardMinutes: '1.000' })).rejects.toThrow(/is a copy of routing step/)
    await expect(insert(office(), 'WorkOrderOperation', { ...operationRow(draft.workOrderId, last), workCentreId: A.centre('SEW') })).rejects.toThrow(/of kind PACKING/)
    await insert(office(), 'WorkOrderOperation', operationRow(draft.workOrderId, last))
    // One batch number per work order (MES-076), set at release.
    await expect(release(draft.workOrderId, { batchNumber: null })).rejects.toThrow(/release time, revision and batch number \(MES-076\) are set exactly from RELEASED on/)
    const batch = `T-BT-${tag()}`
    expect(await release(draft.workOrderId, { batchNumber: batch })).toBe(1)
    const other = await draftWorkOrder()
    await expect(release(other.workOrderId, { batchNumber: batch })).rejects.toThrow(/WorkOrder_tenantId_batchNumber_key/)
    expect(await release(other.workOrderId)).toBe(1)
    // A DRAFT has no batch number yet.
    const early = await draftWorkOrder()
    await expect(run(office(), `UPDATE "WorkOrder" SET "batchNumber" = 'T-EARLY' WHERE id = $1::uuid`, early.workOrderId)).rejects.toThrow(/set exactly from RELEASED on/)
  })

  it('keeps its frozen specification once released: revision, label template, batch number, cells, operations and materials (MES-005)', async () => {
    const wo = seeded.workOrderId
    for (const change of [`"batchNumber" = 'T-OTHER'`, `"labelTemplateId" = NULL`, `"styleRevisionId" = NULL`, `"releasedAt" = now()`]) {
      await expect(run(office(), `UPDATE "WorkOrder" SET ${change} WHERE id = $1::uuid`, wo), change).rejects.toThrow(/frozen specification .* never change/)
    }
    // Planning columns still move.
    expect(await run(office(), `UPDATE "WorkOrder" SET priority = 2, note = 'rush', "dueDate" = '2026-12-01' WHERE id = $1::uuid`, wo)).toBe(1)

    await expect(run(office(), 'UPDATE "WorkOrderSize" SET quantity = 5 WHERE id = $1::uuid', seeded.cellIds['BLK-50'])).rejects.toThrow(/size quantities are frozen \(MES-005\)/)
    await expect(run(office(), 'DELETE FROM "WorkOrderSize" WHERE id = $1::uuid', seeded.cellIds['RED-54'])).rejects.toThrow(/size quantities are frozen/)
    await expect(
      insert(office(), 'WorkOrderSize', { id: randomUUID(), siteId: A.siteA, workOrderId: wo, styleId: seeded.styleId, colourwayId: A.colourwayBLK, size: '56', quantity: 1, salesOrderLineId: A.lineBLK, partyId: A.P1 }),
    ).rejects.toThrow(/size quantities are frozen/)

    await expect(run(office(), `UPDATE "WorkOrderOperation" SET "standardMinutes" = 1 WHERE id = $1::uuid`, seeded.operationIds.sew)).rejects.toThrow(/operations are frozen/)
    await expect(run(office(), 'DELETE FROM "WorkOrderOperation" WHERE id = $1::uuid', seeded.operationIds.pack)).rejects.toThrow(/operations are frozen/)
    // Only the work centre changes: another of the same kind on the site.
    const centre = randomUUID()
    await insert(office(), 'WorkCentre', { id: centre, companyId: A.companyA, siteId: A.siteA, code: `T-SEW-${tag()}`, name: 'Second sewing line', kind: 'SEWING' })
    await expect(run(office(), `UPDATE "WorkOrderOperation" SET "workCentreId" = $2::uuid WHERE id = $1::uuid`, seeded.operationIds.sew, A.centre('CUT'))).rejects.toThrow(/of kind SEWING .* not CUTTING/)
    expect(await run(office(), `UPDATE "WorkOrderOperation" SET "workCentreId" = $2::uuid WHERE id = $1::uuid`, seeded.operationIds.sew, centre)).toBe(1)
    expect(await run(office(), `UPDATE "WorkOrderOperation" SET "workCentreId" = $2::uuid WHERE id = $1::uuid`, seeded.operationIds.sew, A.centre('SEW'))).toBe(1)

    await expect(run(office(), 'UPDATE "WorkOrderMaterial" SET quantity = quantity + 1, "baseQuantity" = "baseQuantity" + 1 WHERE "workOrderId" = $1::uuid', wo)).rejects.toThrow(
      /planned materials are frozen/,
    )
    await expect(run(office(), 'DELETE FROM "WorkOrderMaterial" WHERE "workOrderId" = $1::uuid', wo)).rejects.toThrow(/planned materials are frozen/)

    // A DRAFT's parts still change.
    expect(await run(office(), 'UPDATE "WorkOrderSize" SET quantity = 2 WHERE id = $1::uuid', A.draftCell)).toBe(1)
    expect(await run(office(), 'UPDATE "WorkOrderSize" SET quantity = 1 WHERE id = $1::uuid', A.draftCell)).toBe(1)
    // A cell makes its order line: its style, colourway and kind.
    const draft = await draftWorkOrder({ withCell: false })
    await expect(
      insert(office(), 'WorkOrderSize', {
        id: randomUUID(),
        siteId: A.siteA,
        workOrderId: draft.workOrderId,
        styleId: seeded.styleId,
        colourwayId: key('production-a', 'production:colourway:JKT-02:RED'),
        size: '50',
        quantity: 1,
        salesOrderLineId: A.lineBLK,
        partyId: A.P1,
      }),
    ).rejects.toThrow(/makes its sales order line/)
  })

  it('moves only along its states, is cancelled with a reason, and is never deleted (MES-007)', async () => {
    for (const status of ['DRAFT', 'RELEASED', 'CLOSED']) {
      await expect(run(office(), `UPDATE "WorkOrder" SET status = '${status}' WHERE id = $1::uuid`, seeded.workOrderId), status).rejects.toThrow(/cannot move from IN_PROGRESS/)
    }
    await expect(run(office(), `UPDATE "WorkOrder" SET status = 'COMPLETED' WHERE id = $1::uuid`, seeded.workOrderId)).rejects.toThrow(/wrong start, completion or closing time/)
    const draft = await draftWorkOrder()
    await expect(run(office(), `UPDATE "WorkOrder" SET status = 'CANCELLED', "cancelledAt" = now() WHERE id = $1::uuid`, draft.workOrderId)).rejects.toThrow(/wrong cancellation/)
    expect(await run(office(), `UPDATE "WorkOrder" SET status = 'CANCELLED', "cancelledAt" = now(), "cancelReason" = 'Order line moved' WHERE id = $1::uuid`, draft.workOrderId)).toBe(1)
    await expect(run(office(), `UPDATE "WorkOrder" SET status = 'DRAFT', "cancelledAt" = NULL, "cancelReason" = NULL WHERE id = $1::uuid`, draft.workOrderId)).rejects.toThrow(
      /cannot move from CANCELLED to DRAFT/,
    )
    await expect(run(office(), 'UPDATE "WorkOrder" SET priority = 9 WHERE id = $1::uuid', draft.workOrderId)).rejects.toThrow(/is CANCELLED; only its note changes/)
    expect(await run(office(), `UPDATE "WorkOrder" SET note = 'kept for the record' WHERE id = $1::uuid`, draft.workOrderId)).toBe(1)
    await expect(run(office(), 'DELETE FROM "WorkOrder" WHERE id = $1::uuid', draft.workOrderId)).rejects.toThrow(DENIED)
    await expect(admin('DELETE FROM "WorkOrder" WHERE id = $1', [draft.workOrderId])).rejects.toThrow(/is cancelled, never deleted/)
  })
})

// --- the cut log ------------------------------------------------------------------------------------------------------

describe('the cut log', () => {
  it('cuts a hide of a RELEASED lot issued to the work order, within the area it has there; a reversal gives it back', async () => {
    const [hide1, hide2] = seeded.inventory.hideIds
    // The second hide was never issued to the work order.
    await expect(insert(floor(), 'CutLog', cutRow(hide2, '1.0000'))).rejects.toThrow(/has 0 \(base unit\) at work order .* does not fit/)
    // A blocked lot is not cut (REACH Annex XVII entry 47), and a DRAFT work order cuts nothing.
    expect(await run(office(), `UPDATE "Lot" SET "qualityStatus" = 'BLOCKED', "qualityNote" = 'test' WHERE id = $1::uuid`, seeded.inventory.leatherLotId)).toBe(1)
    await expect(insert(floor(), 'CutLog', cutRow(hide1, '1.0000'))).rejects.toThrow(/lot that is BLOCKED; only RELEASED leather is cut/)
    expect(await run(office(), `UPDATE "Lot" SET "qualityStatus" = 'RELEASED' WHERE id = $1::uuid`, seeded.inventory.leatherLotId)).toBe(1)
    await expect(insert(floor(), 'CutLog', cutRow(hide1, '1.0000', { workOrderId: seeded.draftWorkOrderId }))).rejects.toThrow(/is DRAFT; hides are cut only for a RELEASED or IN_PROGRESS/)
    // Hide 1 (53.2 ft²) is at the work order and 20 ft² of it was cut.
    await expect(insert(floor(), 'CutLog', cutRow(hide1, '33.3000'))).rejects.toThrow(/has 53\.2000 \(base unit\) at work order .* and 20\.0000 of it was cut; a cut of 33\.3000 does not fit/)
    await expect(insert(floor(), 'CutLog', cutRow(hide1, '1.0000', { baseAreaUsed: '2.0000' }))).rejects.toThrow(/entered in the base unit FT2; its areas are its base areas/)
    const rest = cutRow(hide1, '33.2000')
    expect(await insert(floor(), 'CutLog', rest)).toBe(1)
    await insert(floor(), 'CutLogPiece', { id: randomUUID(), siteId: A.siteA, workOrderId: seeded.workOrderId, cutLogId: rest.id, workOrderSizeId: seeded.cellIds['BLK-54'], part: 'front', pieces: 2 })
    await expect(insert(floor(), 'CutLog', cutRow(hide1, '0.0100'))).rejects.toThrow(/does not fit/)
    // A wrong entry is reversed by a mirror, once; a reversal takes no pieces; then the area is back.
    await expect(insert(floor(), 'CutLog', cutRow(hide1, '33.0000', { reversalOfId: rest.id }))).rejects.toThrow(/reverses entry .*: the same work order, hide, unit and areas/)
    const reversal = cutRow(hide1, '33.2000', { reversalOfId: rest.id })
    expect(await insert(floor(), 'CutLog', reversal)).toBe(1)
    await expect(insert(floor(), 'CutLog', cutRow(hide1, '33.2000', { reversalOfId: rest.id }))).rejects.toThrow(/is reversed already/)
    await expect(insert(floor(), 'CutLog', cutRow(hide1, '33.2000', { reversalOfId: reversal.id }))).rejects.toThrow(/is itself a reversal; it is not reversed/)
    for (const cutLogId of [rest.id, reversal.id]) {
      await expect(
        insert(floor(), 'CutLogPiece', { id: randomUUID(), siteId: A.siteA, workOrderId: seeded.workOrderId, cutLogId, workOrderSizeId: seeded.cellIds['BLK-54'], part: 'back', pieces: 1 }),
      ).rejects.toThrow(/is a reversal or reversed; it takes no pieces/)
    }
    expect(await insert(floor(), 'CutLog', cutRow(hide1, '33.2000'))).toBe(1)
  })

  it('serialises two cuts of one hide: the one that no longer fits is refused', async () => {
    const [, hide2] = seeded.inventory.hideIds
    // Hide 2, whole (51.8 ft²), issued to the work order from the bin.
    await insert(floor(), 'StockMove', {
      id: randomUUID(),
      companyId: A.companyA,
      siteId: A.siteA,
      reason: 'ISSUE',
      itemId: A.leather,
      itemColourId: A.leatherBLK,
      lotId: seeded.inventory.leatherLotId,
      hideId: hide2,
      fromLocationId: A.bin,
      quantity: '51.8000',
      uom: 'FT2',
      baseQuantity: '51.8000',
      workOrderId: seeded.workOrderId,
      idempotencyKey: `t-${randomUUID()}`,
      occurredAt: new Date().toISOString(),
    })
    const results = await race(floor(), 'CutLog', cutRow(hide2, '30.0000'), cutRow(hide2, '30.0000'))
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(String((results[1] as PromiseRejectedResult).reason)).toMatch(/has 51\.8000 .* and 30\.0000 of it was cut; a cut of 30\.0000 does not fit/)
  })

  it('is append-only, for every login, and so are its pieces', async () => {
    await expect(run(office(), `UPDATE "CutLog" SET note = 'x' WHERE id = $1::uuid`, seeded.cutLogId)).rejects.toThrow(DENIED)
    await expect(admin(`UPDATE "CutLog" SET note = 'x' WHERE id = $1`, [seeded.cutLogId])).rejects.toThrow(/append-only: UPDATE on "CutLog" is refused/)
    await expect(admin('DELETE FROM "CutLog" WHERE id = $1', [seeded.cutLogId])).rejects.toThrow(/append-only: DELETE on "CutLog" is refused/)
    await expect(admin('TRUNCATE "CutLog" CASCADE')).rejects.toThrow(/append-only: TRUNCATE on "CutLog(Piece)?" is refused/)
    await expect(admin(`UPDATE "CutLogPiece" SET pieces = 9 WHERE "cutLogId" = $1`, [seeded.cutLogId])).rejects.toThrow(/append-only: UPDATE on "CutLogPiece" is refused/)
    await expect(admin('DELETE FROM "CutLogPiece" WHERE "cutLogId" = $1', [seeded.cutLogId])).rejects.toThrow(/append-only: DELETE on "CutLogPiece" is refused/)
  })
})

// --- the scans --------------------------------------------------------------------------------------------------------

describe('the scans', () => {
  it('refuse a worker who has not acknowledged the information notice (Statuto dei Lavoratori art. 4, GDPR art. 13)', async () => {
    const bundleId = await bundle()
    const byLead = scanRow({ bundleId, workerId: seeded.leadId })
    await expect(insert(floor(), 'OperationScan', byLead)).rejects.toThrow(/worker .* has not acknowledged the information notice in force \(version 2026-10\); no scan names a worker before that \(Statuto dei Lavoratori art\. 4 c\.3/)
    await expect(insert(floor(), 'CutLog', cutRow(seeded.inventory.hideIds[0], '0.5000', { workerId: seeded.leadId }))).rejects.toThrow(/has not acknowledged the information notice/)
    // A site that records workers names the signed-in one.
    await expect(insert(floor(), 'OperationScan', scanRow({ bundleId, workerId: null }))).rejects.toThrow(/records the worker; scan .* names the signed-in worker/)
    // The team leader acknowledges the worker notice in force (the privacy seed's 2026-10) on the tablet, with the
    // fingerprint of its English text; then the scan is taken.
    const [english] = await admin(`SELECT sha256 FROM "PrivacyNoticeText" WHERE "noticeId" = $1 AND locale = 'en'`, [seeded.workerNoticeId])
    const ack = {
      id: randomUUID(),
      siteId: A.siteA,
      workerId: seeded.leadId,
      noticeId: seeded.workerNoticeId,
      noticeVersion: '2026-10',
      locale: 'en',
      noticeSha256: english!.sha256 as string,
      channel: 'DEVICE',
      deviceId: seeded.deviceId,
      deviceTime: new Date().toISOString(),
    }
    await expect(insert(floor(), 'WorkerNoticeAck', { ...ack, deviceId: null })).rejects.toThrow(/names its device exactly when it was given on one/)
    await expect(insert(floor(), 'WorkerNoticeAck', { ...ack, noticeSha256: 'not-a-hash' })).rejects.toThrow(/SHA-256 of the text as shown/)
    await expect(insert(floor(), 'WorkerNoticeAck', { ...ack, noticeId: null })).rejects.toThrow(/names the worker notice it acknowledges/)
    await expect(insert(floor(), 'WorkerNoticeAck', { ...ack, noticeSha256: 'a'.repeat(64) })).rejects.toThrow(/stores the fingerprint of notice/)
    expect(await insert(floor(), 'WorkerNoticeAck', ack)).toBe(1)
    await expect(insert(floor(), 'WorkerNoticeAck', { ...ack, id: randomUUID() })).rejects.toThrow(/WorkerNoticeAck_tenantId_workerId_noticeVersion_key/)
    expect(await insert(floor(), 'OperationScan', byLead)).toBe(1)
  })

  it('name the station and no worker where the site records stations (the monitoring switch, MES-278)', async () => {
    const bundleId = await bundle()
    expect(await run(office(), `UPDATE "ProductionSettings" SET "scanSubject" = 'STATION' WHERE id = $1::uuid`, A.siteA)).toBe(1)
    try {
      await expect(insert(floor(), 'OperationScan', scanRow({ bundleId, stationId: A.station('SEW-01') }))).rejects.toThrow(/records the station, not the worker .* names its station and no worker/)
      await expect(insert(floor(), 'OperationScan', scanRow({ bundleId, workerId: null }))).rejects.toThrow(/names its station and no worker/)
      expect(await insert(floor(), 'OperationScan', scanRow({ bundleId, workerId: null, stationId: A.station('SEW-01') }))).toBe(1)
    } finally {
      expect(await run(office(), `UPDATE "ProductionSettings" SET "scanSubject" = 'WORKER' WHERE id = $1::uuid`, A.siteA)).toBe(1)
    }
    // A legal basis is recorded with its reference and time, or not at all.
    await expect(run(office(), `UPDATE "ProductionSettings" SET "monitoringReference" = NULL WHERE id = $1::uuid`, A.siteA)).rejects.toThrow(/legal basis with its reference and time/)
  })

  it('apply an offline resend once: the device’s client scan id is unique per device', async () => {
    const [first, second] = [await bundle(), await bundle()]
    const device2 = randomUUID()
    await insert(office(), 'Device', { id: device2, companyId: A.companyA, siteId: A.siteA, name: `T-tablet-${tag()}` })
    const scan = scanRow({ bundleId: first, clientScanId: 'offline-0001' })
    expect(await insert(floor(), 'OperationScan', scan)).toBe(1)
    // The worker undid it at once; then the device, offline, sends the report again (it never saw the answer): the
    // client scan id refuses it, so the undone report is not applied a second time.
    expect(await insert(floor(), 'OperationScan', scanRow({ bundleId: first, kind: 'UNDO', goodQuantity: 0, correctsId: scan.id, clientScanId: 'offline-0002' }))).toBe(1)
    await expect(insert(floor(), 'OperationScan', { ...scan, id: randomUUID() })).rejects.toThrow(/OperationScan_tenantId_deviceId_clientScanId_key/)
    expect(await count(`SELECT count(*) AS n FROM "OperationScan" WHERE "clientScanId" = 'offline-0001' AND "deviceId" = $1`, [seeded.deviceId])).toBe(1)
    // Another device's own counter may produce the same client id.
    expect(await insert(floor(), 'OperationScan', scanRow({ bundleId: second, deviceId: device2, clientScanId: 'offline-0001' }))).toBe(1)
    // The same event from two sync calls at once (A1 §3.8): applied once.
    const once = scanRow({ bundleId: second, workOrderOperationId: seeded.operationIds.qc, clientScanId: 'offline-0003' })
    const results = await race(floor(), 'OperationScan', once, { ...once, id: randomUUID() })
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(await count(`SELECT count(*) AS n FROM "OperationScan" WHERE "clientScanId" = 'offline-0003'`)).toBe(1)
  })

  it('report a bundle once per operation; an undo or a lead-approved correction voids a scan, which stays (MES-069, MES-095, MES-096)', async () => {
    const bundleId = await bundle({ cellId: seeded.cellIds['RED-52'], quantity: 1 })
    const report = scanRow({ bundleId })
    expect(await insert(floor(), 'OperationScan', report)).toBe(1)
    await expect(insert(floor(), 'OperationScan', scanRow({ bundleId }))).rejects.toThrow(/is reported at operation .* already \(scan .* at .*\); one scan per bundle per operation \(MES-069\)/)
    await expect(insert(floor(), 'OperationScan', scanRow({ bundleId: await bundle(), goodQuantity: 2 }))).rejects.toThrow(/reports from 1 to the 1 garment\(s\)/)
    await expect(insert(floor(), 'OperationScan', scanRow({ bundleId: await bundle(), goodQuantity: 0 }))).rejects.toThrow(/reports from 1 to the 1 garment\(s\)/)
    // Undo at once (MES-095): no counts, the same bundle, operation and worker; once.
    const undo = scanRow({ bundleId, kind: 'UNDO', goodQuantity: 0, correctsId: report.id, reason: 'wrong bundle' })
    await expect(insert(floor(), 'OperationScan', { ...undo, goodQuantity: 1 })).rejects.toThrow(/undo .* carries no counts/)
    await expect(insert(floor(), 'OperationScan', { ...undo, workerId: seeded.leadId })).rejects.toThrow(/same bundle, operation, worker and station/)
    expect(await insert(floor(), 'OperationScan', undo)).toBe(1)
    await expect(insert(floor(), 'OperationScan', { ...undo, id: randomUUID(), clientScanId: `t-${randomUUID()}` })).rejects.toThrow(/is undone or corrected already/)
    await expect(insert(floor(), 'OperationScan', scanRow({ bundleId, kind: 'UNDO', goodQuantity: 0, correctsId: undo.id }))).rejects.toThrow(/an UNDO; only a report or a correction/)
    // Reported again after the undo; a correction approved by a lead replaces it (MES-096).
    const again = scanRow({ bundleId, scrapQuantity: 0 })
    expect(await insert(floor(), 'OperationScan', again)).toBe(1)
    const correction = scanRow({ bundleId, kind: 'CORRECTION', correctsId: again.id, goodQuantity: 0, scrapQuantity: 1, scrapReason: 'SCRATCH' })
    await expect(insert(office(), 'OperationScan', correction)).rejects.toThrow(/says why and who approved it \(MES-096\)/)
    expect(await insert(office(), 'OperationScan', { ...correction, reason: 'Scrap found at inspection', approvedById: a.actorId, deviceId: null })).toBe(1)
    await expect(insert(floor(), 'OperationScan', scanRow({ bundleId }))).rejects.toThrow(/MES-069/)
    // A REPORT names no scan; an UNDO names one.
    await expect(insert(floor(), 'OperationScan', scanRow({ bundleId: await bundle(), correctsId: report.id }))).rejects.toThrow(/only they, name the scan they void/)
    // All four rows stay: the ledger keeps what happened.
    expect(await count('SELECT count(*) AS n FROM "OperationScan" WHERE "bundleId" = $1', [bundleId])).toBe(4)
  })

  it('serialise two devices reporting one bundle at one operation: the second is refused (MES-069)', async () => {
    const bundleId = await bundle()
    const device2 = randomUUID()
    await insert(office(), 'Device', { id: device2, companyId: A.companyA, siteId: A.siteA, name: `T-tablet-${tag()}` })
    const results = await race(floor(), 'OperationScan', scanRow({ bundleId }), scanRow({ bundleId, deviceId: device2 }))
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(String((results[1] as PromiseRejectedResult).reason)).toMatch(/one scan per bundle per operation \(MES-069\)/)
  })

  it('are taken only while the work order is RELEASED or IN_PROGRESS, on an ACTIVE bundle', async () => {
    // A bundle is made only for a released work order.
    await expect(bundle({ workOrderId: seeded.draftWorkOrderId, cellId: A.draftCell })).rejects.toThrow(/is DRAFT; bundles are made only for a RELEASED or IN_PROGRESS work order/)
    const draft = await draftWorkOrder()
    expect(await release(draft.workOrderId)).toBe(1)
    const bundleId = await bundle({ workOrderId: draft.workOrderId, cellId: draft.cellId })
    const sew = draft.operations[20]!
    expect(await insert(floor(), 'OperationScan', scanRow({ workOrderId: draft.workOrderId, workOrderOperationId: sew, bundleId }))).toBe(1)
    expect(await run(office(), `UPDATE "WorkOrder" SET status = 'IN_PROGRESS', "startedAt" = now() WHERE id = $1::uuid`, draft.workOrderId)).toBe(1)
    expect(await run(office(), `UPDATE "WorkOrder" SET status = 'COMPLETED', "completedAt" = now() WHERE id = $1::uuid`, draft.workOrderId)).toBe(1)
    await expect(insert(floor(), 'OperationScan', scanRow({ workOrderId: draft.workOrderId, workOrderOperationId: draft.operations[30]!, bundleId }))).rejects.toThrow(
      /is COMPLETED; scans are taken only while it is RELEASED or IN_PROGRESS/,
    )
    // A void bundle is not scanned.
    const voided = await bundle()
    expect(await run(floor(), `UPDATE "Bundle" SET status = 'VOID', "voidedAt" = now(), "voidReason" = 'made twice' WHERE id = $1::uuid`, voided)).toBe(1)
    await expect(insert(floor(), 'OperationScan', scanRow({ bundleId: voided }))).rejects.toThrow(/is VOID; it is not scanned/)
  })

  it('are append-only, for every login, and so are the notice acknowledgements', async () => {
    const scan = seeded.scanIds[2]
    await expect(run(office(), `UPDATE "OperationScan" SET reason = 'x' WHERE id = $1::uuid`, scan)).rejects.toThrow(DENIED)
    await expect(run(office(), 'DELETE FROM "OperationScan" WHERE id = $1::uuid', scan)).rejects.toThrow(DENIED)
    await expect(admin(`UPDATE "OperationScan" SET "goodQuantity" = 0 WHERE id = $1`, [scan])).rejects.toThrow(/append-only: UPDATE on "OperationScan" is refused/)
    await expect(admin('DELETE FROM "OperationScan" WHERE id = $1', [scan])).rejects.toThrow(/append-only: DELETE on "OperationScan" is refused/)
    // Its lines, correction requests and refused scans name it (B-W1-42): a TRUNCATE cascading to them is refused too.
    await expect(admin('TRUNCATE "OperationScan" CASCADE')).rejects.toThrow(/TRUNCATE on "(OperationScan|OperationScanDefect|ScanCorrectionRequest|FloorScanRefusal)" is refused/)
    await expect(admin('TRUNCATE "OperationScanDefect"')).rejects.toThrow(/append-only: TRUNCATE on "OperationScanDefect" is refused/)
    await expect(run(office(), `UPDATE "WorkerNoticeAck" SET locale = 'de' WHERE id = $1::uuid`, seeded.ackId)).rejects.toThrow(DENIED)
    await expect(admin(`UPDATE "WorkerNoticeAck" SET locale = 'de' WHERE id = $1`, [seeded.ackId])).rejects.toThrow(/append-only: UPDATE on "WorkerNoticeAck" is refused/)
    await expect(admin('DELETE FROM "WorkerNoticeAck" WHERE id = $1', [seeded.ackId])).rejects.toThrow(/append-only: DELETE on "WorkerNoticeAck" is refused/)
    await expect(admin('TRUNCATE "WorkerNoticeAck"')).rejects.toThrow(/append-only: TRUNCATE on "WorkerNoticeAck" is refused/)
  })
})

// --- the bundles ------------------------------------------------------------------------------------------------------

describe('a bundle', () => {
  it('gets a new code when its ticket is reprinted, is voided with a reason, and is never deleted (MES-065, MES-073)', async () => {
    await expect(bundle({ quantity: 0 })).rejects.toThrow(/at least one garment/)
    await expect(
      insert(floor(), 'Bundle', { id: randomUUID(), siteId: A.siteA, workOrderId: seeded.workOrderId, workOrderSizeId: seeded.cellIds['RED-50'], code: `T-BN-${tag()}`, quantity: 1, cutLogIds: [randomUUID()] }),
    ).rejects.toThrow(/names cut log entries of its work order/)
    const id = await bundle()
    const [{ code }] = (await sql(floor(), 'SELECT code FROM "Bundle" WHERE id = $1::uuid', id)) as [{ code: string }]
    await expect(run(floor(), `UPDATE "Bundle" SET code = 'T-NEW-1' WHERE id = $1::uuid`, id)).rejects.toThrow(/gives its ticket a new code and voids the old one \(MES-073\)/)
    expect(await run(floor(), `UPDATE "Bundle" SET code = 'T-NEW-${id}', "replacedCodes" = "replacedCodes" || code WHERE id = $1::uuid`, id)).toBe(1)
    expect(await sql(floor(), 'SELECT "replacedCodes" FROM "Bundle" WHERE id = $1::uuid', id)).toEqual([{ replacedCodes: [code] }])
    await expect(run(floor(), 'UPDATE "Bundle" SET quantity = 2 WHERE id = $1::uuid', id)).rejects.toThrow(/changes only by a reprint of its ticket or by being voided/)
    await expect(run(floor(), `UPDATE "Bundle" SET status = 'VOID', "voidedAt" = now() WHERE id = $1::uuid`, id)).rejects.toThrow(/wrong void/)
    expect(await run(floor(), `UPDATE "Bundle" SET status = 'VOID', "voidedAt" = now(), "voidReason" = 'ticket lost twice' WHERE id = $1::uuid`, id)).toBe(1)
    await expect(run(floor(), `UPDATE "Bundle" SET "voidReason" = 'x' WHERE id = $1::uuid`, id)).rejects.toThrow(/is VOID; it never changes/)
    await expect(admin('DELETE FROM "Bundle" WHERE id = $1', [id])).rejects.toThrow(/is voided, never deleted/)
  })
})

// --- the seeds --------------------------------------------------------------------------------------------------------

describe('the seeds', () => {
  it('are idempotent', async () => {
    const tables = ['ProductionSettings', 'WorkOrder', 'WorkOrderSize', 'WorkOrderOperation', 'WorkOrderMaterial', 'CutLog', 'CutLogPiece', 'Bundle', 'OperationScan', 'WorkerNoticeAck', 'StyleRevision', 'SalesOrder']
    const counts = async () => {
      const out: number[] = []
      for (const table of tables) out.push(await count(`SELECT count(*) AS n FROM "${table}" WHERE "tenantId" = $1`, [b.tenantId]))
      return out
    }
    const before = await counts()
    expect(before).toEqual([2, 2, 7, 8, 21, 1, 2, 2, 3, 1, 2, 2])
    await seedProduction({ db: factory, namespace: 'production-b' })
    expect(await counts()).toEqual(before)
    expect(await admin(`SELECT number, status::text, "batchNumber" FROM "WorkOrder" WHERE "tenantId" = $1 ORDER BY number`, [b.tenantId])).toEqual([
      { number: 'SEED-WO-0001', status: 'IN_PROGRESS', batchNumber: 'SEED-BT-0001' },
      { number: 'SEED-WO-0002', status: 'DRAFT', batchNumber: null },
    ])
  })
})

// --- issues to a work order and returns from it (…_inventory_issue_work_order_guards, B-W1-39) ---------------------------

describe('a stock move to a work order names one of its site, in the state it needs; a cancel and an issue take turns', () => {
  const lining = { item: key('production-a', 'product:item:lining'), colour: key('production-a', 'product:item-colour:lining:GRY') }
  /** One metre of the seeded grey lining (opening stock, RELEASED) to or from a work order, at A1's bin. */
  const liningMove = (reason: 'ISSUE' | 'RETURN', workOrderId: string | null, extra: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    companyId: A.companyA,
    siteId: A.siteA,
    reason,
    itemId: lining.item,
    itemColourId: lining.colour,
    lotId: seeded.inventory.liningLotId,
    ...(reason === 'ISSUE' ? { fromLocationId: A.bin } : { toLocationId: A.bin }),
    quantity: '1.0000',
    uom: 'M',
    baseQuantity: '1.0000',
    workOrderId,
    idempotencyKey: `t-${randomUUID()}`,
    occurredAt: new Date().toISOString(),
    ...extra,
  })
  const released = async () => {
    const { workOrderId } = await draftWorkOrder()
    expect(await release(workOrderId)).toBe(1)
    return workOrderId
  }
  const moveTo = (workOrderId: string, status: 'IN_PROGRESS' | 'COMPLETED' | 'CLOSED' | 'CANCELLED') =>
    run(
      office(),
      `UPDATE "WorkOrder" SET status = $2::"WorkOrderStatus", "startedAt" = CASE WHEN $2 IN ('IN_PROGRESS', 'COMPLETED', 'CLOSED') THEN coalesce("startedAt", now()) END,
         "completedAt" = CASE WHEN $2 IN ('COMPLETED', 'CLOSED') THEN coalesce("completedAt", now()) END, "closedAt" = CASE WHEN $2 = 'CLOSED' THEN now() END,
         "cancelledAt" = CASE WHEN $2 = 'CANCELLED' THEN now() END, "cancelReason" = CASE WHEN $2 = 'CANCELLED' THEN 'The customer cancelled' END,
         version = version + 1 WHERE id = $1::uuid`,
      workOrderId,
      status,
    )
  const cancelSql = `UPDATE "WorkOrder" SET status = 'CANCELLED', "cancelledAt" = now(), "cancelReason" = 'The customer cancelled', version = version + 1 WHERE id = $1::uuid`
  const advisoryWaiters = () =>
    count(`SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)
  async function untilWaiting(n: number, what: string) {
    for (let tries = 0; (await advisoryWaiters()) < n; tries++) {
      if (tries > 250) throw new Error(`${what} never waited for the work order's issue lock`)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  /** A transaction that does `work` and stays open until released. */
  function held(scope: FactoryScope, work: (tx: Parameters<Parameters<FactoryClient['$transaction']>[0]>[0]) => Promise<unknown>) {
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    let done!: () => void
    const did = new Promise<void>((resolve) => (done = resolve))
    const transaction = as(scope, (client) =>
      client.$transaction(
        async (tx) => {
          await work(tx)
          done()
          await released
        },
        { timeout: 20_000 },
      ),
    )
    return { did, release, transaction }
  }

  it('an issue names a work order of its tenant and site that is RELEASED or IN_PROGRESS; nothing goes to or from a DRAFT', async () => {
    expect(await insert(floor(), 'StockMove', liningMove('ISSUE', seeded.workOrderId))).toBe(1)
    const workOrderId = await released()
    expect(await insert(floor(), 'StockMove', liningMove('ISSUE', workOrderId))).toBe(1)
    await expect(insert(floor(), 'StockMove', liningMove('ISSUE', randomUUID()))).rejects.toThrow(/which is not a work order of its site/)
    await expect(insert(office(), 'StockMove', liningMove('ISSUE', seeded.draftWorkOrderId))).rejects.toThrow(/is DRAFT; nothing is issued to it or returned from it/)
    await expect(insert(office(), 'StockMove', liningMove('RETURN', seeded.draftWorkOrderId))).rejects.toThrow(/is DRAFT/)
    // Another site's move never names A1's work order (here B1's own lining, at its store).
    const lotB = randomUUID()
    const storeB = key('production-a', 'inventory:location:B1-STORE')
    await admin(
      `INSERT INTO "Lot" (id, "tenantId", "companyId", "siteId", "itemId", "itemColourId", code, "qualityStatus", "qualityDecidedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, 'RELEASED', now())`,
      [lotB, a.tenantId, a.companies[1]!.id, a.sites[1]!.id, lining.item, lining.colour, `T-LOT-${tag()}`],
    )
    const atB = { companyId: a.companies[1]!.id, siteId: a.sites[1]!.id, lotId: lotB }
    expect(await insert(office(), 'StockMove', liningMove('RETURN', null, { ...atB, reason: 'OPENING', toLocationId: storeB, workOrderId: null }))).toBe(1)
    await expect(insert(office(), 'StockMove', liningMove('ISSUE', seeded.workOrderId, { ...atB, fromLocationId: storeB }))).rejects.toThrow(/which is not a work order of its site/)
    // Without a work order, the ledger's own check speaks.
    await expect(insert(office(), 'StockMove', liningMove('ISSUE', null))).rejects.toThrow(/without its work order/)
  })

  it('takes returns and reversals from a completed, closed or cancelled work order, never a new issue', async () => {
    for (const status of ['COMPLETED', 'CLOSED', 'CANCELLED'] as const) {
      const workOrderId = await released()
      const issue = liningMove('ISSUE', workOrderId, { quantity: '2.0000', baseQuantity: '2.0000' })
      expect(await insert(floor(), 'StockMove', issue)).toBe(1)
      if (status !== 'CANCELLED') expect(await moveTo(workOrderId, 'IN_PROGRESS')).toBe(1)
      if (status === 'CLOSED') expect(await moveTo(workOrderId, 'COMPLETED')).toBe(1)
      expect(await moveTo(workOrderId, status)).toBe(1)
      await expect(insert(floor(), 'StockMove', liningMove('ISSUE', workOrderId))).rejects.toThrow(new RegExp(`is ${status}; stock is issued only to a RELEASED or IN_PROGRESS work order`))
      expect(await insert(floor(), 'StockMove', liningMove('RETURN', workOrderId))).toBe(1)
      // The issue's reversal (one mirror move) puts a wrong record right on any of them.
      const reversal = { ...liningMove('ISSUE', workOrderId, { quantity: '2.0000', baseQuantity: '2.0000' }), fromLocationId: null, toLocationId: A.bin, reversalOfId: issue.id, note: 'Wrong work order' }
      expect(await insert(office(), 'StockMove', reversal)).toBe(1)
    }
  })

  it('a cancel waits for an issue in flight, which goes through first (READ COMMITTED, the issue lock)', async () => {
    const workOrderId = await released()
    const issue = held(floor(), (tx) => tx.$executeRawUnsafe(...insertSql('StockMove', liningMove('ISSUE', workOrderId))))
    await issue.did
    const cancelled = run(office(), cancelSql, workOrderId)
    await untilWaiting(1, 'the cancel')
    issue.release()
    await issue.transaction
    expect(await cancelled).toBe(1)
    expect(await admin(`SELECT status::text FROM "WorkOrder" WHERE id = $1`, [workOrderId])).toEqual([{ status: 'CANCELLED' }])
    expect(await count(`SELECT count(*) AS n FROM "StockMove" WHERE "workOrderId" = $1 AND reason = 'ISSUE'`, [workOrderId])).toBe(1)
  })

  it('an issue waits for a cancel in flight, then sees it and is refused', async () => {
    const workOrderId = await released()
    const cancel = held(office(), (tx) => tx.$executeRawUnsafe(cancelSql, workOrderId))
    await cancel.did
    const issued = insert(floor(), 'StockMove', liningMove('ISSUE', workOrderId))
    await untilWaiting(1, 'the issue')
    cancel.release()
    await cancel.transaction
    await expect(issued).rejects.toThrow(/is CANCELLED; stock is issued only to a RELEASED or IN_PROGRESS work order/)
    expect(await count(`SELECT count(*) AS n FROM "StockMove" WHERE "workOrderId" = $1`, [workOrderId])).toBe(0)
  })
})
