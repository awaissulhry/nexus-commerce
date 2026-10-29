import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedAuth } from '../seed/auth'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedLinks } from '../seed/links'
import { seed as seedShipping, type ShippingSeed } from '../seed/shipping'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { classifiedModels } from './ownership'
import { FLOOR_ROLE, PARTNER_ROLE, RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'
import { loadOwnership, loadSchema } from './tools'

/**
 * The quality and shipping walls beyond the generated isolation tests (plan A1 §2.1, §2.2, §2.5 "Final release",
 * "Shipment", §2.6; PLAN §2.8 "PPE", "DDT", "Limits on monitoring workers", §4.7 stages 13a-labels, 13b-release,
 * 14-ship; Q19, Q31; features QHS-050, QHS-058, QHS-073, QHS-118, LOG-001, LOG-039, LOG-054, LOG-059), on a database
 * built from the migrations and seeded twice (tenants A and B), through the real login and the scoped client:
 *   - no quality or shipping table holds money; the floor reads only its own site's rows, a portal or link session only
 *     its own party's shipments, DDTs and tracking, never an internal column;
 *   - a final inspection starts OPEN, is decided once (PASSED only within its sampling plan) and never changes after;
 *     its inspector made none of the garments (four-eyes), or signed that statement where the floor records the station;
 *   - a release comes from a PASSED inspection, never passes the cell's pieces nor the inspection's lot, is signed by
 *     someone who made none of the garments, names the certificates that cover the cell (the certificate gate), and is
 *     append-only;
 *   - serials only for a SERIAL-tracked style (Q31), unique in the tenant, never more live ones than pieces, released by
 *     a release of their cell, packed only while released, shipped with their shipment; the style's setting is fixed
 *     once its work orders have serials or releases;
 *   - a release reversal takes garments back before they ship (corrective action), never those a shipment holds, never
 *     beyond the release; shipping is then limited to the remainder; a serial-tracked one moves its named serials back
 *     to MADE or VOID in the same transaction, and a reversed garment is released again only from a new inspection;
 *   - only released garments ship, also when two packers race; a shipment moves DRAFT → PACKED → SHIPPED → DELIVERED,
 *     the floor only packs, and it leaves only with a DDT that is not cancelled;
 *   - a DDT carries every DPR 472/1996 field, is numbered once in its series and never changes (a cancellation row);
 *     tracking events are append-only;
 *   - the PPE register keeps its entries; the seeds are idempotent.
 * The refusals are check_violation (SQLSTATE 23514); their messages are read through the scoped client's raw SQL.
 */

const DENIED = /permission denied/
const SIGNED = 'a'.repeat(64)
const CHECKLIST = JSON.stringify([
  { code: 'CE_MARK', ok: true },
  { code: 'CARE_LABEL', ok: true },
])

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let b: CoreSeed
let seeded: ShippingSeed
/** The released revision's routing of SEED-JKT-02: seq, code, name, minutes and the kind of work centre. */
let routing: { seq: number; code: string; name: string; standardMinutes: string; kind: string }[]

const key = (namespace: string, name: string): string => seedUuid(namespace, name)
const A = {
  companyA: key('qs-a', 'company:A'),
  siteA: key('qs-a', 'site:A1'),
  P1: key('qs-a', 'party:P1'),
  P3: key('qs-a', 'party:P3'),
  member: key('qs-a', 'user:member'),
  operator: key('qs-a', 'worker:A1:operator'),
  lead: key('qs-a', 'worker:A1:lead'),
  device: key('qs-a', 'device:A1:cutting'),
  colourway: { BLK: key('qs-a', 'production:colourway:JKT-02:BLK'), RED: key('qs-a', 'production:colourway:JKT-02:RED') },
  orderLine: { BLK: key('qs-a', 'production:sales-order:SO-0002:10'), RED: key('qs-a', 'production:sales-order:SO-0002:20') },
  invoiceSeries: key('qs-a', 'series:A:INVOICE:MAIN:2026'),
  styleJkt01: key('qs-a', 'product:style:JKT-01'),
  centre: (code: string): string => key('qs-a', `site:A1:work-centre:${code}`),
  station: (code: string): string => key('qs-a', `site:A1:station:${code}`),
}
const B = { P1: key('qs-b', 'party:P1') }
const CENTRE_OF_KIND: Readonly<Record<string, string>> = { CUTTING: 'CUT', SEWING: 'SEW', INSPECTION: 'QC', PACKING: 'PACK' }

const office = (core: CoreSeed = a): FactoryScope => ({ audience: 'office', tenantId: core.tenantId, actorId: core.actorId })
const floor = (site = 0): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: randomUUID(), siteId: a.sites[site]!.id })
const partner = (partyId: string, core: CoreSeed = a): FactoryScope => ({ audience: 'partner', tenantId: core.tenantId, actorId: randomUUID(), partyId })
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
  db = await migratedDatabase('quality_shipping')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: 'qs-a' })
  b = await seedCore({ db: factory, namespace: 'qs-b' })
  await seedAuth({ db: factory, namespace: 'qs-a' })
  await seedLinks({ db: factory, namespace: 'qs-a' })
  await seedLinks({ db: factory, namespace: 'qs-b' })
  seeded = await seedShipping({ db: factory, namespace: 'qs-a' })
  await seedShipping({ db: factory, namespace: 'qs-b' })
  routing = (await admin(
    `SELECT seq, code, name, "standardMinutes"::text AS "standardMinutes", "workCentreKind"::text AS kind FROM "RoutingOperation" WHERE "revisionId" = $1 ORDER BY seq`,
    [seeded.quality.production.revisionId],
  )) as typeof routing
}, 90_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

// --- helpers --------------------------------------------------------------------------------------------------------

const production = () => seeded.quality.production
const cell = (name: keyof ShippingSeed['quality']['production']['cellIds']) => production().cellIds[name]

/** A RELEASED work order of SEED-JKT-02 on A1 with one cell (from SEED-SO-0002) and its routing. */
async function releasedWorkOrder(colour: 'BLK' | 'RED' = 'RED', quantity = 1): Promise<{ workOrderId: string; cellId: string; operations: Record<number, string> }> {
  const ids = { workOrderId: randomUUID(), cellId: randomUUID(), operations: Object.fromEntries(routing.map((step) => [step.seq, randomUUID()])) as Record<number, string> }
  await as(office(), (client) =>
    client.$transaction(async (tx) => {
      const exec = (table: string, row: Record<string, unknown>) => tx.$executeRawUnsafe(...insertSql(table, row))
      await exec('WorkOrder', { id: ids.workOrderId, companyId: A.companyA, siteId: A.siteA, number: `T-WO-${tag()}`, kind: 'SIZE_GRID', styleId: production().styleId, styleRevisionId: production().revisionId })
      await exec('WorkOrderSize', {
        id: ids.cellId,
        siteId: A.siteA,
        workOrderId: ids.workOrderId,
        styleId: production().styleId,
        colourwayId: A.colourway[colour],
        size: '50',
        quantity,
        salesOrderLineId: A.orderLine[colour],
        partyId: A.P1,
      })
      for (const step of routing) {
        await exec('WorkOrderOperation', {
          id: ids.operations[step.seq],
          siteId: A.siteA,
          workOrderId: ids.workOrderId,
          styleRevisionId: production().revisionId,
          seq: step.seq,
          routingSeq: step.seq,
          code: step.code,
          name: step.name,
          standardMinutes: step.standardMinutes,
          workCentreId: A.centre(CENTRE_OF_KIND[step.kind]!),
        })
      }
      await tx.$executeRawUnsafe(
        `UPDATE "WorkOrder" SET status = 'RELEASED', "labelTemplateId" = $2::uuid, "batchNumber" = $3, "releasedAt" = now() WHERE id = $1::uuid`,
        ids.workOrderId,
        production().labelTemplateId,
        `T-BT-${tag()}`,
      )
    }),
  )
  return ids
}

/** An OPEN final inspection of a work order on A1 by the plant's team leader (who made none of WO-0001's garments). */
const inspectionRow = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: randomUUID(),
  companyId: A.companyA,
  siteId: A.siteA,
  workOrderId: production().workOrderId,
  lotSize: 1,
  sampleSize: 1,
  inspectionLevel: 'II',
  aqlMajor: '2.500',
  aqlMinor: '4.000',
  acceptMajor: 0,
  acceptMinor: 0,
  inspectorWorkerId: A.lead,
  ...extra,
})
const defectRow = (inspectionId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: randomUUID(),
  siteId: A.siteA,
  workOrderId: production().workOrderId,
  inspectionId,
  defectClass: 'MINOR',
  code: `T-${tag()}`,
  quantity: 1,
  ...extra,
})
/** The decision: its time, the signature and (when none is recorded yet) a checklist. */
const decide = (scope: FactoryScope, inspectionId: string, status: 'PASSED' | 'FAILED' = 'PASSED') =>
  run(
    scope,
    `UPDATE "Inspection" SET status = '${status}', "decidedAt" = now(), "signatureSha256" = '${SIGNED}', checklist = coalesce(checklist, '${CHECKLIST}'::jsonb) WHERE id = $1::uuid`,
    inspectionId,
  )
/** A PASSED inspection of a lot of a work order, recorded on the floor by the team leader. */
async function passedInspection(workOrderId: string, lotSize = 1): Promise<string> {
  const row = inspectionRow({ workOrderId, lotSize, sampleSize: 1 })
  await insert(floor(), 'Inspection', row)
  expect(await decide(floor(), row.id as string)).toBe(1)
  return row.id as string
}
const releaseRow = (extra: Record<string, unknown>): Record<string, unknown> => ({
  id: randomUUID(),
  companyId: A.companyA,
  siteId: A.siteA,
  workOrderId: production().workOrderId,
  quantity: 1,
  certificateIds: [seeded.quality.certificateId],
  releasedById: a.actorId,
  releasedAt: new Date().toISOString(),
  signatureSha256: SIGNED,
  ...extra,
})
/** A reversal of `quantity` garments of a release of a cell of WO-0001 (or of another work order, in `extra`). */
const reversalRow = (releaseId: string, workOrderSizeId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: randomUUID(),
  companyId: A.companyA,
  siteId: A.siteA,
  workOrderId: production().workOrderId,
  workOrderSizeId,
  releaseId,
  quantity: 1,
  reason: 'A defect found after release',
  reversedById: a.actorId,
  reversedAt: new Date().toISOString(),
  ...extra,
})
const shipmentRow = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: randomUUID(),
  companyId: A.companyA,
  siteId: A.siteA,
  partyId: A.P1,
  salesOrderId: production().salesOrderId,
  number: `T-SH-${tag()}`,
  shipTo: { name: 'Test workshop', line1: 'Via Test 1', postalCode: '00000', city: 'Testville', country: 'IT' },
  ...extra,
})
const lineRow = (shipmentId: string, extra: Record<string, unknown>): Record<string, unknown> => ({
  id: randomUUID(),
  siteId: A.siteA,
  partyId: A.P1,
  shipmentId,
  workOrderId: production().workOrderId,
  quantity: 1,
  ...extra,
})
/** A line of a cell of WO-0001 (its order line and size come with it). */
const lineOf = (shipmentId: string, name: 'BLK-50' | 'BLK-52' | 'BLK-54' | 'RED-50' | 'RED-52' | 'RED-54', extra: Record<string, unknown> = {}) =>
  lineRow(shipmentId, { workOrderSizeId: cell(name), salesOrderLineId: A.orderLine[name.slice(0, 3) as 'BLK' | 'RED'], size: name.slice(4), ...extra })
const parcelRow = (shipmentId: string, seq: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: randomUUID(),
  siteId: A.siteA,
  partyId: A.P1,
  shipmentId,
  seq,
  grossWeightKg: '2.5000',
  ...extra,
})
const ddtRow = (shipmentId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: randomUUID(),
  companyId: A.companyA,
  siteId: A.siteA,
  partyId: A.P1,
  shipmentId,
  numberSeriesId: seeded.ddtSeriesId,
  number: `T-${tag()}/2026`,
  documentDate: '2026-11-30',
  reason: 'SALE',
  transportBy: 'CARRIER',
  carrier: { name: 'Test Express' },
  startAt: new Date().toISOString(),
  appearance: 'Scatole di cartone',
  packages: 1,
  grossWeightKg: '2.5000',
  sender: { name: 'Seed Factory A S.r.l.' },
  recipient: { name: 'Seed Customer One S.r.l.' },
  lines: [{ seq: 1, description: 'Giacca SEED-JKT-02', quantity: '1', uom: 'PCS' }],
  issuedAt: new Date().toISOString(),
  ...extra,
})
/** A DRAFT shipment of SEED-SO-0002 with one weighed parcel holding one line of a cell (packed on the floor). */
async function packedDraft(lineExtra: Record<string, unknown>, shipmentExtra: Record<string, unknown> = {}): Promise<{ shipmentId: string; parcelId: string; lineId: string }> {
  const shipment = shipmentRow(shipmentExtra)
  await insert(office(), 'Shipment', shipment)
  const parcel = parcelRow(shipment.id as string, 1)
  await insert(floor(), 'Parcel', parcel)
  const line = lineRow(shipment.id as string, { parcelId: parcel.id, ...lineExtra })
  await insert(floor(), 'ShipmentLine', line)
  return { shipmentId: shipment.id as string, parcelId: parcel.id as string, lineId: line.id as string }
}
const pack = (scope: FactoryScope, shipmentId: string) => run(scope, `UPDATE "Shipment" SET status = 'PACKED', "packedAt" = now() WHERE id = $1::uuid`, shipmentId)
const ship = (shipmentId: string) => run(office(), `UPDATE "Shipment" SET status = 'SHIPPED', "shippedAt" = now() WHERE id = $1::uuid`, shipmentId)

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

// --- the walls ------------------------------------------------------------------------------------------------------

describe('the walls', () => {
  const models = classifiedModels(loadSchema(), loadOwnership()).filter(({ model }) => model.file === 'quality.prisma' || model.file === 'shipping.prisma')

  it('no quality or shipping table holds money; the floor is kept to its site, the partner to its party and away from internal columns', () => {
    expect(models.map(({ model }) => model.name).sort()).toEqual([
      'Ddt',
      'DdtCancellation',
      'GarmentSerial',
      'Inspection',
      'InspectionDefect',
      'LabResult',
      'LotDocument',
      'Parcel',
      'PpeRegisterEntry',
      'QualityRelease',
      'QualityReleaseReversal',
      'QualitySettings',
      'Shipment',
      'ShipmentLine',
      'ShippingSettings',
      'TrackingEvent',
    ])
    for (const { model, ownership } of models) {
      expect(model.fields.filter((field) => field.tags.some((entry) => entry.startsWith('@grain'))), model.name).toEqual([])
      expect(model.columns.filter((column) => /cost|margin|price|amount|total|wage/i.test(column)), model.name).toEqual([])
      const floorAccess = ownership.access[FLOOR_ROLE]
      if (floorAccess) {
        expect(floorAccess.scopedBy, model.name).toEqual(['site'])
        expect(floorAccess.hiddenColumns ?? [], model.name).toEqual([])
      }
      const partnerAccess = ownership.access[PARTNER_ROLE]
      if (model.file === 'quality.prisma') expect(partnerAccess, model.name).toBeUndefined()
      if (partnerAccess) {
        expect(partnerAccess.privileges, model.name).toEqual(['select'])
        expect(partnerAccess.hiddenColumns, model.name).toContain('createdById')
      }
    }
    const partnerTables = models.filter(({ ownership }) => ownership.access[PARTNER_ROLE]).map(({ model }) => model.name)
    expect(partnerTables.sort()).toEqual(['Ddt', 'DdtCancellation', 'Parcel', 'Shipment', 'ShipmentLine', 'TrackingEvent'])
  })

  it('the floor reads only its own site’s inspections, releases, serials, shipments and DDTs', async () => {
    const seen = async (scope: FactoryScope) => ({
      inspections: (await sql(scope, 'SELECT id FROM "Inspection"')).length,
      releases: (await sql(scope, 'SELECT id FROM "QualityRelease"')).length,
      reversals: (await sql(scope, 'SELECT id FROM "QualityReleaseReversal"')).length,
      serials: (await sql(scope, `SELECT serial FROM "GarmentSerial" WHERE serial LIKE 'SEED-%' ORDER BY serial`)).map((row) => row.serial),
      shipments: (await sql(scope, `SELECT number FROM "Shipment" WHERE number LIKE 'SEED-%' ORDER BY number`)).map((row) => row.number),
      ddts: (await sql(scope, 'SELECT number FROM "Ddt" ORDER BY number')).map((row) => row.number),
      settings: (await sql(scope, 'SELECT id FROM "ShippingSettings"')).map((row) => row.id),
    })
    expect(await seen(floor(0))).toEqual({
      inspections: 3,
      releases: 5,
      reversals: 1,
      serials: ['SEED-SN-0001', 'SEED-SN-0002', 'SEED-SN-0003'],
      shipments: ['SEED-SH-0001', 'SEED-SH-0002'],
      ddts: ['143/2026', '144/2026'],
      settings: [A.siteA],
    })
    // Company B's plant (B1) sees nothing of A1's, only its own settings.
    expect(await seen(floor(1))).toEqual({ inspections: 0, releases: 0, reversals: 0, serials: [], shipments: [], ddts: [], settings: [a.sites[1]!.id] })
    // Tracking and the register are not the floor's.
    await expect(sql(floor(), 'SELECT id FROM "TrackingEvent"')).rejects.toThrow(DENIED)
    await expect(sql(floor(), 'SELECT id FROM "PpeRegisterEntry"')).rejects.toThrow(DENIED)
    // The floor never releases garments, takes them back nor issues a DDT.
    await expect(insert(floor(), 'QualityRelease', releaseRow({ workOrderSizeId: cell('RED-54'), inspectionId: seeded.quality.passedInspectionId }))).rejects.toThrow(DENIED)
    await expect(insert(floor(), 'QualityReleaseReversal', reversalRow(seeded.quality.releaseIds['BLK-52'], cell('BLK-52')))).rejects.toThrow(DENIED)
    await expect(insert(floor(), 'Ddt', ddtRow(seeded.shipmentId))).rejects.toThrow(DENIED)
  })
})

// --- the final inspection -------------------------------------------------------------------------------------------

describe('a final inspection', () => {
  it('starts OPEN, names one inspector, is decided once and never changes after (QHS-050)', async () => {
    await expect(insert(floor(), 'Inspection', inspectionRow({ status: 'PASSED', decidedAt: new Date().toISOString(), signatureSha256: SIGNED }))).rejects.toThrow(/starts OPEN/)
    await expect(insert(floor(), 'Inspection', inspectionRow({ lotSize: 8 }))).rejects.toThrow(/judges a lot of 8 garment\(s\); work order .* has 7/)
    await expect(insert(floor(), 'Inspection', inspectionRow({ sampleSize: 2 }))).rejects.toThrow(/a sample from 1 up to the lot/)
    await expect(insert(floor(), 'Inspection', inspectionRow({ inspectorUserId: a.actorId }))).rejects.toThrow(/exactly one inspector/)
    await expect(insert(floor(), 'Inspection', inspectionRow({ inspectorWorkerId: null }))).rejects.toThrow(/exactly one inspector/)
    await expect(insert(floor(), 'Inspection', inspectionRow({ inspectorWorkerId: null, inspectorUserId: a.actorId }))).rejects.toThrow(/the floor records the inspection of a worker/)
    expect(await insert(office(), 'Inspection', inspectionRow({ inspectorWorkerId: null, inspectorUserId: a.actorId }))).toBe(1)
    // A DRAFT work order has no garments to inspect.
    await expect(insert(office(), 'Inspection', inspectionRow({ workOrderId: production().draftWorkOrderId }))).rejects.toThrow(/is DRAFT; its garments are inspected while/)

    const open = inspectionRow()
    await insert(floor(), 'Inspection', open)
    await expect(run(floor(), `UPDATE "Inspection" SET status = 'PASSED', "decidedAt" = now(), checklist = '${CHECKLIST}'::jsonb WHERE id = $1::uuid`, open.id)).rejects.toThrow(/wrong decision/)
    await expect(run(floor(), `UPDATE "Inspection" SET status = 'PASSED', "decidedAt" = now(), "signatureSha256" = '${SIGNED}' WHERE id = $1::uuid`, open.id)).rejects.toThrow(/with its garment and label checklist/)
    expect(await decide(floor(), open.id as string)).toBe(1)

    const decided = seeded.quality.passedInspectionId
    await expect(run(office(), `UPDATE "Inspection" SET note = 'x' WHERE id = $1::uuid`, decided)).rejects.toThrow(/a decided or cancelled inspection never changes/)
    await expect(run(floor(), `UPDATE "Inspection" SET status = 'FAILED' WHERE id = $1::uuid`, decided)).rejects.toThrow(/never changes/)
    await expect(insert(floor(), 'InspectionDefect', defectRow(decided))).rejects.toThrow(/is PASSED; its defects change only while it is OPEN/)
    await expect(run(floor(), `UPDATE "InspectionDefect" SET quantity = 2 WHERE "inspectionId" = $1::uuid`, decided)).rejects.toThrow(/only while it is OPEN/)
    await expect(run(floor(), 'DELETE FROM "InspectionDefect" WHERE "inspectionId" = $1::uuid', decided)).rejects.toThrow(/only while it is OPEN/)
    await expect(admin('DELETE FROM "Inspection" WHERE id = $1', [decided])).rejects.toThrow(/never deleted/)
    // An OPEN inspection's defects change, and an abandoned one is cancelled.
    const defect = defectRow(seeded.quality.openInspectionId)
    expect(await insert(floor(), 'InspectionDefect', defect)).toBe(1)
    expect(await run(floor(), 'UPDATE "InspectionDefect" SET quantity = 2 WHERE id = $1::uuid', defect.id)).toBe(1)
    expect(await run(floor(), 'DELETE FROM "InspectionDefect" WHERE id = $1::uuid', defect.id)).toBe(1)
    const abandoned = inspectionRow()
    await insert(floor(), 'Inspection', abandoned)
    expect(await run(floor(), `UPDATE "Inspection" SET status = 'CANCELLED' WHERE id = $1::uuid`, abandoned.id)).toBe(1)
  })

  it('PASSES only within its sampling plan: no critical defect, majors and minors within the acceptance numbers, every checklist item ok', async () => {
    const critical = inspectionRow({ lotSize: 3, sampleSize: 3, acceptMinor: 1 })
    await insert(floor(), 'Inspection', critical)
    await insert(floor(), 'InspectionDefect', defectRow(critical.id as string, { defectClass: 'CRITICAL', code: 'ARMOUR-MISSING' }))
    await expect(decide(floor(), critical.id as string)).rejects.toThrow(/1 critical defect\(s\); a critical defect is never accepted/)
    expect(await decide(floor(), critical.id as string, 'FAILED')).toBe(1)

    const minors = inspectionRow({ lotSize: 3, sampleSize: 3, acceptMinor: 1 })
    await insert(floor(), 'Inspection', minors)
    await insert(floor(), 'InspectionDefect', defectRow(minors.id as string, { quantity: 2 }))
    await expect(decide(floor(), minors.id as string)).rejects.toThrow(/found 0 major and 2 minor defective garment\(s\); its plan accepts 0 and 1/)
    await insert(floor(), 'InspectionDefect', defectRow(minors.id as string, { quantity: 2 }))
    await expect(decide(floor(), minors.id as string, 'FAILED')).rejects.toThrow(/more defective garments in a class than its sample of 3/)

    const unchecked = inspectionRow()
    await insert(floor(), 'Inspection', { ...unchecked, checklist: [{ code: 'CE_MARK', ok: false }] })
    await expect(decide(floor(), unchecked.id as string)).rejects.toThrow(/checklist item that is not ok/)
    expect(await decide(floor(), unchecked.id as string, 'FAILED')).toBe(1)
  })

  it('is decided by an inspector who made none of the garments, or who signed so where the floor records the station (four-eyes)', async () => {
    // The operator cut and scanned WO-0001.
    const byMaker = inspectionRow({ inspectorWorkerId: A.operator })
    await insert(floor(), 'Inspection', byMaker)
    await expect(decide(floor(), byMaker.id as string)).rejects.toThrow(/worker .* made garments of work order .*; the inspection .* is by someone who made none of them/)
    await expect(decide(floor(), byMaker.id as string, 'FAILED')).rejects.toThrow(/made garments of work order/)
    // An office user who is that worker.
    expect(await run(office(), 'UPDATE "Worker" SET "userId" = $2::uuid WHERE id = $1::uuid', A.operator, A.member)).toBe(1)
    try {
      const byLinkedUser = inspectionRow({ inspectorWorkerId: null, inspectorUserId: A.member })
      await insert(office(), 'Inspection', byLinkedUser)
      await expect(decide(office(), byLinkedUser.id as string)).rejects.toThrow(/user .* is worker .*, who made garments of work order/)
      // Nor does that user sign a release of the work order's garments.
      const passed = await passedInspection(production().workOrderId)
      await expect(insert(office(), 'QualityRelease', releaseRow({ workOrderSizeId: cell('RED-54'), inspectionId: passed, releasedById: A.member }))).rejects.toThrow(
        /user .* is worker .*, who made garments of work order .*; the release .* is by someone who made none of them/,
      )
    } finally {
      expect(await run(office(), 'UPDATE "Worker" SET "userId" = NULL WHERE id = $1::uuid', A.operator)).toBe(1)
    }

    // A work order whose sewing was recorded by the station (A1 switched to STATION for it): the records name no maker.
    const wo = await releasedWorkOrder()
    const bundleId = randomUUID()
    await insert(floor(), 'Bundle', { id: bundleId, siteId: A.siteA, workOrderId: wo.workOrderId, workOrderSizeId: wo.cellId, code: `T-BN-${tag()}`, quantity: 1, deviceId: A.device })
    expect(await run(office(), `UPDATE "ProductionSettings" SET "scanSubject" = 'STATION' WHERE id = $1::uuid`, A.siteA)).toBe(1)
    try {
      await insert(floor(), 'OperationScan', {
        id: randomUUID(),
        siteId: A.siteA,
        workOrderId: wo.workOrderId,
        workOrderOperationId: wo.operations[20],
        bundleId,
        kind: 'REPORT',
        goodQuantity: 1,
        stationId: A.station('SEW-01'),
        deviceId: A.device,
        clientScanId: `t-${randomUUID()}`,
      })
    } finally {
      expect(await run(office(), `UPDATE "ProductionSettings" SET "scanSubject" = 'WORKER' WHERE id = $1::uuid`, A.siteA)).toBe(1)
    }
    const unsigned = inspectionRow({ workOrderId: wo.workOrderId })
    await insert(floor(), 'Inspection', unsigned)
    await expect(decide(floor(), unsigned.id as string)).rejects.toThrow(/do not name every maker .*; the inspection .* carries the inspector's signed statement/)
    expect(await run(floor(), 'UPDATE "Inspection" SET "notMakerStatement" = true WHERE id = $1::uuid', unsigned.id)).toBe(1)
    expect(await decide(floor(), unsigned.id as string)).toBe(1)
    // Its garment is released on that statement.
    expect(await insert(office(), 'QualityRelease', releaseRow({ workOrderId: wo.workOrderId, workOrderSizeId: wo.cellId, inspectionId: unsigned.id }))).toBe(1)
  })
})

// --- the release ----------------------------------------------------------------------------------------------------

describe('a quality release', () => {
  it('comes from a PASSED inspection and never passes the cell’s pieces nor the inspection’s lot (QHS-058)', async () => {
    const q = seeded.quality
    await expect(insert(office(), 'QualityRelease', releaseRow({ workOrderSizeId: cell('RED-54'), inspectionId: q.openInspectionId }))).rejects.toThrow(/is OPEN; garments are released only from a PASSED inspection/)
    // BLK 50: one piece, released already.
    await expect(insert(office(), 'QualityRelease', releaseRow({ workOrderSizeId: cell('BLK-50'), inspectionId: q.passedInspectionId }))).rejects.toThrow(/has 1 piece\(s\) and 1 released/)
    // The seeded PASSED inspection judged 5 garments and released 4: one more, then none.
    expect(await insert(office(), 'QualityRelease', releaseRow({ workOrderSizeId: cell('BLK-54'), inspectionId: q.passedInspectionId }))).toBe(1)
    await expect(insert(office(), 'QualityRelease', releaseRow({ workOrderSizeId: cell('RED-50'), inspectionId: q.passedInspectionId }))).rejects.toThrow(/judged a lot of 5 garment\(s\), 5 released already/)
    // An inspection of another work order: the reference refuses it.
    await expect(insert(office(), 'QualityRelease', releaseRow({ workOrderSizeId: cell('RED-50'), inspectionId: q.serialInspectionId }))).rejects.toThrow(/foreign key/)
    await expect(insert(office(), 'QualityRelease', releaseRow({ workOrderSizeId: cell('RED-50'), inspectionId: q.passedInspectionId, quantity: 0 }))).rejects.toThrow(/at least one garment, signed/)
  })

  it('names the certificates that cover the style, colourway and size on the day (the certificate gate)', async () => {
    const passed = await passedInspection(production().workOrderId)
    const red50 = (certificateIds: string[]) => releaseRow({ workOrderSizeId: cell('RED-50'), inspectionId: passed, certificateIds })
    await expect(insert(office(), 'QualityRelease', red50([]))).rejects.toThrow(/is PPE \(CATEGORY_II\); release .* names the certificates that cover it/)
    const certificate = (status: 'DRAFT' | 'VALID') => ({
      id: randomUUID(),
      holderPartyId: A.P1,
      standard: 'EN 17092-3:2020',
      number: `T-CERT-${tag()}`,
      notifiedBodyName: 'Test body',
      notifiedBodyNumber: '0000',
      validFrom: '2026-01-01',
      validTo: '2030-12-31',
      status,
      statusChangedAt: status === 'VALID' ? new Date().toISOString() : null,
    })
    // A VALID certificate of another style (the product seed's jacket).
    const another = certificate('VALID')
    await insert(office(), 'Certificate', another)
    await insert(office(), 'CertificateCoverage', { id: randomUUID(), certificateId: another.id, styleId: A.styleJkt01 })
    await expect(insert(office(), 'QualityRelease', red50([another.id]))).rejects.toThrow(/no certificate named by release .* covers style/)
    // A certificate typed in (DRAFT) covers nothing yet.
    const draft = certificate('DRAFT').id
    await insert(office(), 'Certificate', { ...certificate('DRAFT'), id: draft })
    await insert(office(), 'CertificateCoverage', { id: randomUUID(), certificateId: draft, styleId: production().styleId })
    await expect(insert(office(), 'QualityRelease', red50([draft]))).rejects.toThrow(/certificate .* is not VALID on/)
    await expect(insert(office(), 'QualityRelease', red50([seeded.quality.certificateId, draft]))).rejects.toThrow(/is not VALID on/)
    // A certificate whose coverage leaves out the colourway does not cover the cell.
    const narrow = randomUUID()
    await insert(office(), 'Certificate', { ...certificate('VALID'), id: narrow })
    await insert(office(), 'CertificateCoverage', { id: randomUUID(), certificateId: narrow, styleId: production().styleId, colourwayIds: [A.colourway.BLK] })
    await expect(insert(office(), 'QualityRelease', red50([narrow]))).rejects.toThrow(/covers style .* in colourway/)
    expect(await insert(office(), 'QualityRelease', red50([seeded.quality.certificateId]))).toBe(1)
  })

  it('is append-only, for every login', async () => {
    const release = seeded.quality.releaseIds['BLK-52']
    await expect(run(office(), 'UPDATE "QualityRelease" SET quantity = 1 WHERE id = $1::uuid', release)).rejects.toThrow(DENIED)
    await expect(run(office(), 'DELETE FROM "QualityRelease" WHERE id = $1::uuid', release)).rejects.toThrow(DENIED)
    await expect(admin('UPDATE "QualityRelease" SET quantity = 1 WHERE id = $1', [release])).rejects.toThrow(/append-only: UPDATE on "QualityRelease" is refused/)
    await expect(admin('DELETE FROM "QualityRelease" WHERE id = $1', [release])).rejects.toThrow(/append-only: DELETE on "QualityRelease" is refused/)
    await expect(admin('TRUNCATE "QualityRelease" CASCADE')).rejects.toThrow(/append-only: TRUNCATE on "QualityRelease" is refused/)
  })
})

// --- the serials ----------------------------------------------------------------------------------------------------

describe('garment serials (Q31)', () => {
  const serialRow = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: randomUUID(),
    siteId: A.siteA,
    workOrderId: seeded.quality.serialWorkOrderId,
    workOrderSizeId: seeded.quality.serialCellId,
    serial: `T-SN-${tag()}`,
    ...extra,
  })

  it('are given only for a SERIAL-tracked style, unique in the tenant, never more live ones than the cell’s pieces', async () => {
    await expect(insert(floor(), 'GarmentSerial', serialRow({ workOrderId: production().workOrderId, workOrderSizeId: cell('BLK-52') }))).rejects.toThrow(
      /traces its garments by batch \(BATCH: Q31\); serials are given only for a SERIAL style/,
    )
    await expect(insert(floor(), 'GarmentSerial', serialRow({ serial: 'SEED-SN-0001' }))).rejects.toThrow(/GarmentSerial_tenantId_serial_key/)
    // Each tenant has its own SEED-SN-0001.
    expect(await count(`SELECT count(*) AS n FROM "GarmentSerial" WHERE serial = 'SEED-SN-0001'`)).toBe(2)
    await expect(insert(floor(), 'GarmentSerial', serialRow({ status: 'RELEASED', releaseId: seeded.quality.serialReleaseIds[0] }))).rejects.toThrow(/starts MADE/)

    // WO-0003's cell has 4 pieces and 3 serials.
    const third = serialRow()
    expect(await insert(floor(), 'GarmentSerial', third)).toBe(1)
    await expect(insert(floor(), 'GarmentSerial', serialRow())).rejects.toThrow(/has 4 piece\(s\) and 4 live serial\(s\)/)
    await expect(run(floor(), `UPDATE "GarmentSerial" SET status = 'VOID' WHERE id = $1::uuid`, third.id)).rejects.toThrow(/wrong voiding/)
    expect(await run(floor(), `UPDATE "GarmentSerial" SET status = 'VOID', "voidedAt" = now(), "voidReason" = 'label spoilt' WHERE id = $1::uuid`, third.id)).toBe(1)
    await expect(run(floor(), `UPDATE "GarmentSerial" SET "voidReason" = 'x' WHERE id = $1::uuid`, third.id)).rejects.toThrow(/is VOID; it never changes/)
    await expect(run(floor(), `UPDATE "GarmentSerial" SET serial = 'T-OTHER' WHERE id = $1::uuid`, seeded.quality.serialIds[0])).rejects.toThrow(/never change/)
    // A void serial frees its piece, never its number.
    await expect(insert(floor(), 'GarmentSerial', serialRow({ serial: third.serial }))).rejects.toThrow(/GarmentSerial_tenantId_serial_key/)
    expect(await insert(floor(), 'GarmentSerial', serialRow())).toBe(1)
    await expect(admin('DELETE FROM "GarmentSerial" WHERE id = $1', [third.id])).rejects.toThrow(/is voided, never deleted/)
  })

  it('follow their style’s setting, which is fixed once its work orders have serials or releases', async () => {
    const q = seeded.quality
    await expect(run(office(), `UPDATE "Style" SET "garmentTracking" = 'BATCH' WHERE id = $1::uuid`, q.serialStyleId)).rejects.toThrow(/no longer changes \(Q31\)/)
    await expect(run(office(), `UPDATE "Style" SET "garmentTracking" = 'SERIAL' WHERE id = $1::uuid`, production().styleId)).rejects.toThrow(/no longer changes/)
    // The product seed's jacket has no work order yet: its setting moves.
    expect(await run(office(), `UPDATE "Style" SET "garmentTracking" = 'SERIAL' WHERE id = $1::uuid`, A.styleJkt01)).toBe(1)
    expect(await run(office(), `UPDATE "Style" SET "garmentTracking" = 'BATCH' WHERE id = $1::uuid`, A.styleJkt01)).toBe(1)
    expect(await sql(office(), 'SELECT "garmentTracking"::text AS t FROM "Style" WHERE id IN ($1::uuid, $2::uuid) ORDER BY code', production().styleId, q.serialStyleId)).toEqual([
      { t: 'BATCH' },
      { t: 'SERIAL' },
    ])
  })

  it('are released by a release of their cell (the office), packed only while released, and shipped with their shipment', async () => {
    const q = seeded.quality
    const [made, released] = q.serialIds
    await expect(run(floor(), `UPDATE "GarmentSerial" SET status = 'RELEASED', "releaseId" = $2::uuid WHERE id = $1::uuid`, made, q.serialReleaseIds[0])).rejects.toThrow(/releasing, taking back and shipping serial .* are the office's/)
    // The first seeded release of WO-0003 released one garment, the second serial.
    await expect(run(office(), `UPDATE "GarmentSerial" SET status = 'RELEASED', "releaseId" = $2::uuid WHERE id = $1::uuid`, made, q.serialReleaseIds[0])).rejects.toThrow(/holds 1 garment\(s\) \(less reversals\), and 1 serial\(s\) name it/)
    await expect(run(office(), `UPDATE "GarmentSerial" SET status = 'RELEASED' WHERE id = $1::uuid`, made)).rejects.toThrow(/wrong release or shipment line/)
    await expect(run(office(), `UPDATE "GarmentSerial" SET status = 'SHIPPED' WHERE id = $1::uuid`, made)).rejects.toThrow(/cannot move from MADE to SHIPPED/)
    // The third garment of WO-0003's PASSED inspection (a lot of 3).
    const second = releaseRow({ workOrderId: q.serialWorkOrderId, workOrderSizeId: q.serialCellId, inspectionId: q.serialInspectionId })
    expect(await insert(office(), 'QualityRelease', second)).toBe(1)
    expect(await run(office(), `UPDATE "GarmentSerial" SET status = 'RELEASED', "releaseId" = $2::uuid WHERE id = $1::uuid`, made, second.id)).toBe(1)
    await expect(run(office(), `UPDATE "GarmentSerial" SET "releaseId" = $2::uuid WHERE id = $1::uuid`, made, q.serialReleaseIds[0])).rejects.toThrow(/is named only when it is released/)

    // A shipment of SEED-SO-0003: one parcel, one line of two released garments (SEED-SH-0002, a DRAFT, holds a third).
    const shipment = shipmentRow({ salesOrderId: q.serialSalesOrderId })
    await insert(office(), 'Shipment', shipment)
    const parcel = parcelRow(shipment.id as string, 1)
    await insert(floor(), 'Parcel', parcel)
    const line = lineRow(shipment.id as string, { parcelId: parcel.id, workOrderId: q.serialWorkOrderId, workOrderSizeId: q.serialCellId, salesOrderLineId: q.serialSalesOrderLineId, size: '52', quantity: 2 })
    expect(await insert(floor(), 'ShipmentLine', line)).toBe(1)
    await expect(pack(floor(), shipment.id as string)).rejects.toThrow(/1 line\(s\) of a serial-tracked style without a serial for each garment/)
    const unreleased = (await sql(floor(), `SELECT id FROM "GarmentSerial" WHERE "workOrderSizeId" = $1::uuid AND status = 'MADE'`, q.serialCellId))[0]!.id
    await expect(run(floor(), 'UPDATE "GarmentSerial" SET "shipmentLineId" = $2::uuid WHERE id = $1::uuid', unreleased, line.id)).rejects.toThrow(/packed and unpacked only while RELEASED/)
    for (const serial of [made, released]) expect(await run(floor(), 'UPDATE "GarmentSerial" SET "shipmentLineId" = $2::uuid WHERE id = $1::uuid', serial, line.id)).toBe(1)
    await expect(run(floor(), 'UPDATE "ShipmentLine" SET quantity = 1 WHERE id = $1::uuid', line.id)).rejects.toThrow(/holds 2 serial\(s\)/)
    await expect(run(floor(), 'DELETE FROM "ShipmentLine" WHERE id = $1::uuid', line.id)).rejects.toThrow(/holds serials; unpack them first/)
    expect(await pack(floor(), shipment.id as string)).toBe(1)
    await expect(run(floor(), 'UPDATE "GarmentSerial" SET "shipmentLineId" = NULL WHERE id = $1::uuid', made)).rejects.toThrow(/unpacked only while the shipment is a DRAFT/)
    await expect(run(office(), `UPDATE "GarmentSerial" SET status = 'SHIPPED' WHERE id = $1::uuid`, made)).rejects.toThrow(/SHIPPED only with its shipment \(which is PACKED\)/)

    await insert(office(), 'Ddt', ddtRow(shipment.id as string))
    expect(await ship(shipment.id as string)).toBe(1)
    await expect(run(floor(), `UPDATE "GarmentSerial" SET status = 'SHIPPED' WHERE id = $1::uuid`, made)).rejects.toThrow(/the office's/)
    expect(await run(office(), `UPDATE "GarmentSerial" SET status = 'SHIPPED' WHERE id = ANY ($1::uuid[])`, [made, released])).toBe(2)
    await expect(run(office(), `UPDATE "GarmentSerial" SET status = 'VOID', "voidedAt" = now(), "voidReason" = 'x' WHERE id = $1::uuid`, made)).rejects.toThrow(/is SHIPPED; it never changes/)
  })
})

// --- the shipment ---------------------------------------------------------------------------------------------------

describe('a shipment', () => {
  it('ships only released garments (QHS-058, LOG-001): a cell’s lines over its shipments never pass its releases less reversals', async () => {
    // BLK 52: two released, one taken back (the seed's reversal), none on a shipment.
    const draftRow = shipmentRow()
    await insert(office(), 'Shipment', draftRow)
    const draft = draftRow.id as string
    const only = lineOf(draft, 'BLK-52')
    expect(await insert(floor(), 'ShipmentLine', only)).toBe(1)
    await expect(insert(floor(), 'ShipmentLine', lineOf(draft, 'BLK-52'))).rejects.toThrow(/only released garments ship \(QHS-058\): cell .* has 1 released \(less reversals\) and 1 on other shipments/)
    await expect(run(floor(), 'UPDATE "ShipmentLine" SET quantity = 2 WHERE id = $1::uuid', only.id)).rejects.toThrow(/only released garments ship/)
    // RED 54 is not released at all.
    await expect(insert(floor(), 'ShipmentLine', lineOf(draft, 'RED-54'))).rejects.toThrow(/has 0 released/)
    expect(await run(floor(), 'DELETE FROM "ShipmentLine" WHERE id = $1::uuid', only.id)).toBe(1)

    // A cancelled shipment's lines ship nothing: BLK 54 (released once, above) moves to another shipment.
    const first = shipmentRow()
    await insert(office(), 'Shipment', first)
    expect(await insert(office(), 'ShipmentLine', lineOf(first.id as string, 'BLK-54'))).toBe(1)
    const other = shipmentRow()
    await insert(office(), 'Shipment', other)
    await expect(insert(office(), 'ShipmentLine', lineOf(other.id as string, 'BLK-54'))).rejects.toThrow(/has 1 released \(less reversals\) and 1 on other shipments/)
    await expect(run(office(), `UPDATE "Shipment" SET status = 'CANCELLED' WHERE id = $1::uuid`, first.id)).rejects.toThrow(/wrong cancellation/)
    expect(await run(office(), `UPDATE "Shipment" SET status = 'CANCELLED', "cancelledAt" = now(), "cancelReason" = 'the customer collects' WHERE id = $1::uuid`, first.id)).toBe(1)
    expect(await insert(office(), 'ShipmentLine', lineOf(other.id as string, 'BLK-54'))).toBe(1)

    // A line ships its cell: that cell's sales order line and size, of the shipment's order.
    await expect(insert(floor(), 'ShipmentLine', lineOf(draft, 'BLK-52', { size: '54' }))).rejects.toThrow(/ships its work order cell .*: that cell's party, sales order line and size/)
    await expect(insert(floor(), 'ShipmentLine', lineOf(draft, 'BLK-52', { salesOrderLineId: A.orderLine.RED }))).rejects.toThrow(/that cell's party, sales order line and size/)
    const q = seeded.quality
    await expect(
      insert(office(), 'ShipmentLine', lineRow(draft, { workOrderId: q.serialWorkOrderId, workOrderSizeId: q.serialCellId, salesOrderLineId: q.serialSalesOrderLineId, size: '52' })),
    ).rejects.toThrow(/which is not of the shipment's order/)
  })

  it('serialise two packers taking the last released garment of a cell: the second is refused', async () => {
    const wo = await releasedWorkOrder('BLK')
    const passed = await passedInspection(wo.workOrderId)
    await insert(office(), 'QualityRelease', releaseRow({ workOrderId: wo.workOrderId, workOrderSizeId: wo.cellId, inspectionId: passed }))
    const [one, two] = [shipmentRow(), shipmentRow()]
    await insert(office(), 'Shipment', one)
    await insert(office(), 'Shipment', two)
    const line = (shipmentId: string) => lineRow(shipmentId, { workOrderId: wo.workOrderId, workOrderSizeId: wo.cellId, salesOrderLineId: A.orderLine.BLK, size: '50' })
    const results = await race(floor(), 'ShipmentLine', line(one.id as string), line(two.id as string))
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(String((results[1] as PromiseRejectedResult).reason)).toMatch(/has 1 released \(less reversals\) and 1 on other shipments/)
  })

  it('moves DRAFT → PACKED → SHIPPED → DELIVERED; the floor only packs; lines and parcels freeze; it leaves only with its DDT', async () => {
    // RED 50 (released once, above) is still at the factory.
    const empty = shipmentRow()
    await insert(office(), 'Shipment', empty)
    await expect(insert(office(), 'Shipment', shipmentRow({ status: 'PACKED', packedAt: new Date().toISOString() }))).rejects.toThrow(/starts as a DRAFT/)
    await expect(pack(floor(), empty.id as string)).rejects.toThrow(/PACKED with its lines, each in a parcel, and its parcels, each weighed \(0 line\(s\)/)
    const shipment = await packedDraft({ workOrderSizeId: cell('RED-50'), salesOrderLineId: A.orderLine.RED, size: '50' })
    const id = shipment.shipmentId
    const unweighed = parcelRow(id, 2, { grossWeightKg: null })
    await insert(floor(), 'Parcel', unweighed)
    await expect(pack(floor(), id)).rejects.toThrow(/2 parcel\(s\), 1 not weighed/)
    await expect(run(floor(), 'UPDATE "Parcel" SET "grossWeightKg" = 0 WHERE id = $1::uuid', unweighed.id)).rejects.toThrow(/a weight and sizes above 0/)
    expect(await run(floor(), 'DELETE FROM "Parcel" WHERE id = $1::uuid', unweighed.id)).toBe(1)
    await expect(run(floor(), 'DELETE FROM "Parcel" WHERE id = $1::uuid', shipment.parcelId)).rejects.toThrow(/holds shipment lines; move them first/)
    await expect(run(floor(), 'UPDATE "Shipment" SET "carrierName" = $2 WHERE id = $1::uuid', id, 'Other')).rejects.toThrow(/the floor packs and unpacks shipment .* nothing else/)
    expect(await pack(floor(), id)).toBe(1)
    // From PACKED on its lines are fixed; its parcels are labelled until it leaves.
    await expect(insert(floor(), 'ShipmentLine', lineOf(id, 'RED-50'))).rejects.toThrow(/is PACKED; its lines change only while it is a DRAFT/)
    await expect(insert(floor(), 'Parcel', parcelRow(id, 2))).rejects.toThrow(/added and removed while it is a DRAFT/)
    expect(await run(office(), `UPDATE "Parcel" SET "trackingNumber" = 'T-TRACK-1', "labelledAt" = now() WHERE id = $1::uuid`, shipment.parcelId)).toBe(1)
    await expect(run(floor(), `UPDATE "Shipment" SET status = 'SHIPPED', "shippedAt" = now() WHERE id = $1::uuid`, id)).rejects.toThrow(/the floor packs and unpacks/)

    // It leaves only with a DDT that is not cancelled (checked at commit).
    await expect(ship(id)).rejects.toThrow(/left without its DDT \(DPR 472\/1996\)/)
    const wrong = ddtRow(id)
    await insert(office(), 'Ddt', wrong)
    await insert(office(), 'DdtCancellation', { id: randomUUID(), siteId: A.siteA, partyId: A.P1, ddtId: wrong.id, reason: 'wrong weight', cancelledAt: new Date().toISOString() })
    await expect(ship(id)).rejects.toThrow(/left without its DDT/)
    await insert(office(), 'Ddt', ddtRow(id))
    expect(await ship(id)).toBe(1)

    await expect(run(office(), `UPDATE "Shipment" SET "shipTo" = '{"name":"x"}'::jsonb WHERE id = $1::uuid`, id)).rejects.toThrow(/left; only its delivery or return and its internal note change/)
    await expect(run(office(), `UPDATE "Parcel" SET "grossWeightKg" = 3 WHERE id = $1::uuid`, shipment.parcelId)).rejects.toThrow(/change until it leaves/)
    await expect(run(office(), `UPDATE "Shipment" SET status = 'CANCELLED', "cancelledAt" = now(), "cancelReason" = 'x' WHERE id = $1::uuid`, id)).rejects.toThrow(/cannot move from SHIPPED to CANCELLED/)
    await expect(run(office(), `UPDATE "Shipment" SET status = 'DELIVERED' WHERE id = $1::uuid`, id)).rejects.toThrow(/wrong packing, shipping, delivery or return time/)
    expect(await run(office(), `UPDATE "Shipment" SET status = 'DELIVERED', "deliveredAt" = now() WHERE id = $1::uuid`, id)).toBe(1)
    await expect(run(office(), `UPDATE "Shipment" SET "carrierName" = 'x' WHERE id = $1::uuid`, id)).rejects.toThrow(/is DELIVERED; only its internal note changes/)
    expect(await run(office(), `UPDATE "Shipment" SET "internalNote" = 'signed for by the workshop' WHERE id = $1::uuid`, id)).toBe(1)
    await expect(admin('DELETE FROM "Shipment" WHERE id = $1', [id])).rejects.toThrow(/is cancelled, never deleted/)

    // An immediate invoice travels with the goods instead of a DDT.
    const wo = await releasedWorkOrder('RED')
    const passed = await passedInspection(wo.workOrderId)
    await insert(office(), 'QualityRelease', releaseRow({ workOrderId: wo.workOrderId, workOrderSizeId: wo.cellId, inspectionId: passed }))
    const invoiced = await packedDraft({ workOrderId: wo.workOrderId, workOrderSizeId: wo.cellId, salesOrderLineId: A.orderLine.RED, size: '50' }, { ddtRequired: false })
    expect(await pack(floor(), invoiced.shipmentId)).toBe(1)
    expect(await ship(invoiced.shipmentId)).toBe(1)
  })
})

// --- the release reversal -------------------------------------------------------------------------------------------

describe('a release reversal', () => {
  /** A reversal written with the serial moves it names, in one office transaction. */
  const reverse = (row: Record<string, unknown>, moves: string[] = []) =>
    as(office(), (client) =>
      client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(...insertSql('QualityReleaseReversal', row))
        for (const move of moves) await tx.$executeRawUnsafe(move)
      }),
    )

  it('takes released garments back before they ship; never those a shipment holds; shipping is then limited to the remainder', async () => {
    // A work order cell of two garments, both released.
    const wo = await releasedWorkOrder('BLK', 2)
    const passed = await passedInspection(wo.workOrderId, 2)
    const release = releaseRow({ workOrderId: wo.workOrderId, workOrderSizeId: wo.cellId, inspectionId: passed, quantity: 2 })
    await insert(office(), 'QualityRelease', release)
    const of = (extra: Record<string, unknown> = {}) => reversalRow(release.id as string, wo.cellId, { workOrderId: wo.workOrderId, ...extra })
    const line = (shipmentId: string) => lineRow(shipmentId, { workOrderId: wo.workOrderId, workOrderSizeId: wo.cellId, salesOrderLineId: A.orderLine.BLK, size: '50' })

    await expect(insert(office(), 'QualityReleaseReversal', of({ quantity: 0 }))).rejects.toThrow(/at least one garment and says why/)
    await expect(insert(office(), 'QualityReleaseReversal', of({ reason: ' ' }))).rejects.toThrow(/says why/)
    await expect(insert(office(), 'QualityReleaseReversal', of({ quantity: 3 }))).rejects.toThrow(/released 2 garment\(s\), 0 reversed already/)
    await expect(insert(office(), 'QualityReleaseReversal', of({ serialIds: [seeded.quality.serialIds[0]] }))).rejects.toThrow(/batch-tracked release; it names no serial/)
    // Its cell and work order are the release's.
    await expect(insert(office(), 'QualityReleaseReversal', of({ workOrderSizeId: cell('BLK-52') }))).rejects.toThrow(/foreign key/)

    // One garment is packed into a DRAFT shipment: it is not taken back.
    const packing = shipmentRow()
    await insert(office(), 'Shipment', packing)
    const parcel = parcelRow(packing.id as string, 1)
    await insert(floor(), 'Parcel', parcel)
    expect(await insert(floor(), 'ShipmentLine', { ...line(packing.id as string), parcelId: parcel.id })).toBe(1)
    await expect(insert(office(), 'QualityReleaseReversal', of({ quantity: 2 }))).rejects.toThrow(/has 2 garment\(s\) released and 1 on shipments; reversal .* would take back garments a shipment holds/)
    // The other one is, before it ships.
    expect(await insert(office(), 'QualityReleaseReversal', of())).toBe(1)
    // Shipping is limited to what is left released: the one already on the DRAFT shipment.
    const another = shipmentRow()
    await insert(office(), 'Shipment', another)
    await expect(insert(floor(), 'ShipmentLine', line(another.id as string))).rejects.toThrow(/has 1 released \(less reversals\) and 1 on other shipments/)
    await expect(insert(office(), 'QualityReleaseReversal', of())).rejects.toThrow(/has 1 garment\(s\) released and 1 on shipments/)
    // Once it ships, it is never taken back either.
    expect(await pack(floor(), packing.id as string)).toBe(1)
    await insert(office(), 'Ddt', ddtRow(packing.id as string))
    expect(await ship(packing.id as string)).toBe(1)
    await expect(insert(office(), 'QualityReleaseReversal', of())).rejects.toThrow(/would take back garments a shipment holds/)
    // The seeded shipment SH-0001 left with BLK 50: its release is not reversed.
    await expect(insert(office(), 'QualityReleaseReversal', reversalRow(seeded.quality.releaseIds['BLK-50'], cell('BLK-50')))).rejects.toThrow(/has 1 garment\(s\) released and 1 on shipments/)
  })

  it('frees a garment held by a DRAFT line once the line goes, and the garment is released again only from a new inspection', async () => {
    const q = seeded.quality
    // BLK 52: the seed released two and took one back; the other goes onto a DRAFT shipment.
    const draft = shipmentRow()
    await insert(office(), 'Shipment', draft)
    const held = lineOf(draft.id as string, 'BLK-52')
    await insert(floor(), 'ShipmentLine', held)
    const blk52 = reversalRow(q.releaseIds['BLK-52'], cell('BLK-52'))
    await expect(insert(office(), 'QualityReleaseReversal', blk52)).rejects.toThrow(/would take back garments a shipment holds/)
    expect(await run(floor(), 'DELETE FROM "ShipmentLine" WHERE id = $1::uuid', held.id)).toBe(1)
    expect(await insert(office(), 'QualityReleaseReversal', blk52)).toBe(1)
    await expect(insert(office(), 'QualityReleaseReversal', reversalRow(q.releaseIds['BLK-52'], cell('BLK-52')))).rejects.toThrow(/released 2 garment\(s\), 2 reversed already/)
    await expect(insert(floor(), 'ShipmentLine', lineOf(draft.id as string, 'BLK-52'))).rejects.toThrow(/has 0 released/)
    // The seeded inspection's lot is used up (reversed garments count): a new inspection releases the reworked ones.
    await expect(insert(office(), 'QualityRelease', releaseRow({ workOrderSizeId: cell('BLK-52'), inspectionId: q.passedInspectionId }))).rejects.toThrow(/judged a lot of 5 garment\(s\), 5 released already/)
    const reinspected = await passedInspection(production().workOrderId, 2)
    expect(await insert(office(), 'QualityRelease', releaseRow({ workOrderSizeId: cell('BLK-52'), inspectionId: reinspected, quantity: 2 }))).toBe(1)
    await expect(insert(office(), 'QualityRelease', releaseRow({ workOrderSizeId: cell('BLK-52'), inspectionId: await passedInspection(production().workOrderId) }))).rejects.toThrow(
      /has 2 piece\(s\) and 2 released \(less reversals\)/,
    )
    expect(await insert(floor(), 'ShipmentLine', lineOf(draft.id as string, 'BLK-52', { quantity: 2 }))).toBe(1)
  })

  it('names the serials of a serial-tracked release, which go back to MADE or VOID in the same transaction, and only so', async () => {
    const q = seeded.quality
    const [, shipped, third] = q.serialIds
    const of = (releaseId: string, extra: Record<string, unknown> = {}) => reversalRow(releaseId, q.serialCellId, { workOrderId: q.serialWorkOrderId, ...extra })
    const toMade = (id: string) => `UPDATE "GarmentSerial" SET status = 'MADE' WHERE id = '${id}'::uuid`
    // WO-0003's DRAFT shipment SH-0002 holds a garment; its line goes, so a released garment is free.
    expect(await run(floor(), 'DELETE FROM "ShipmentLine" WHERE id = $1::uuid', seeded.draftLineId)).toBe(1)

    // The third serial, RELEASED by the second seeded release and not packed.
    await expect(run(office(), toMade(third))).rejects.toThrow(/goes back to MADE only through a reversal of that release that names it/)
    await expect(run(floor(), `UPDATE "GarmentSerial" SET status = 'VOID', "voidedAt" = now(), "voidReason" = 'x' WHERE id = $1::uuid`, third)).rejects.toThrow(/the office's/)
    const second = q.serialReleaseIds[1]
    await expect(reverse(of(second))).rejects.toThrow(/names exactly its 1 serial\(s\)/)
    await expect(reverse(of(second, { serialIds: [shipped] }))).rejects.toThrow(/names serial .*, which is not a RELEASED, unpacked serial of release/)
    // Named, but left RELEASED: refused at commit.
    await expect(reverse(of(second, { serialIds: [third] }))).rejects.toThrow(/is still RELEASED; reversal .* takes it back to MADE or VOID in the same transaction/)
    await expect(insert(floor(), 'QualityReleaseReversal', of(second, { serialIds: [third] }))).rejects.toThrow(DENIED)
    await reverse(of(second, { serialIds: [third] }), [toMade(third)])
    expect(await sql(office(), 'SELECT status::text AS status, "releaseId" FROM "GarmentSerial" WHERE id = $1::uuid', third)).toEqual([{ status: 'MADE', releaseId: second }])

    // Released again only by a new release, from a new inspection; then scrapped through a second reversal.
    await expect(run(office(), `UPDATE "GarmentSerial" SET status = 'RELEASED' WHERE id = $1::uuid`, third)).rejects.toThrow(/took serial .* back; it is released again only by a new release/)
    const reinspected = await passedInspection(q.serialWorkOrderId)
    const again = releaseRow({ workOrderId: q.serialWorkOrderId, workOrderSizeId: q.serialCellId, inspectionId: reinspected })
    await insert(office(), 'QualityRelease', again)
    expect(await run(office(), `UPDATE "GarmentSerial" SET status = 'RELEASED', "releaseId" = $2::uuid WHERE id = $1::uuid`, third, again.id)).toBe(1)
    await reverse(of(again.id as string, { serialIds: [third], reason: 'Armour pocket torn: scrapped' }), [
      `UPDATE "GarmentSerial" SET status = 'VOID', "voidedAt" = now(), "voidReason" = 'scrapped' WHERE id = '${third}'::uuid`,
    ])
    expect(await sql(office(), 'SELECT status::text AS status FROM "GarmentSerial" WHERE id = $1::uuid', third)).toEqual([{ status: 'VOID' }])
  })

  it('is append-only, for every login', async () => {
    const reversal = seeded.quality.reversalId
    await expect(run(office(), 'UPDATE "QualityReleaseReversal" SET quantity = 2 WHERE id = $1::uuid', reversal)).rejects.toThrow(DENIED)
    await expect(run(office(), 'DELETE FROM "QualityReleaseReversal" WHERE id = $1::uuid', reversal)).rejects.toThrow(DENIED)
    await expect(admin('UPDATE "QualityReleaseReversal" SET quantity = 2 WHERE id = $1', [reversal])).rejects.toThrow(/append-only: UPDATE on "QualityReleaseReversal" is refused/)
    await expect(admin('DELETE FROM "QualityReleaseReversal" WHERE id = $1', [reversal])).rejects.toThrow(/append-only: DELETE on "QualityReleaseReversal" is refused/)
    await expect(admin('TRUNCATE "QualityReleaseReversal"')).rejects.toThrow(/append-only: TRUNCATE on "QualityReleaseReversal" is refused/)
  })
})

// --- the DDT --------------------------------------------------------------------------------------------------------

describe('a DDT', () => {
  it('is issued for a PACKED or SHIPPED shipment with every DPR 472/1996 field, once per number of its series', async () => {
    const shipped = seeded.shipmentId
    const two = { packages: 2 }
    await expect(insert(office(), 'Ddt', ddtRow(seeded.draftShipmentId))).rejects.toThrow(/is DRAFT; a DDT is issued for a PACKED or SHIPPED shipment/)
    await expect(insert(office(), 'Ddt', ddtRow(shipped))).rejects.toThrow(/states 1 package\(s\); shipment .* has 2 parcel\(s\)/)
    await expect(insert(office(), 'Ddt', ddtRow(shipped, { ...two, carrier: null }))).rejects.toThrow(/names its carrier/)
    await expect(insert(office(), 'Ddt', ddtRow(shipped, { ...two, reason: 'OTHER' }))).rejects.toThrow(/reason for the transport in words/)
    await expect(insert(office(), 'Ddt', ddtRow(shipped, { ...two, netWeightKg: '9.0000' }))).rejects.toThrow(/net weight above 0 and at most the gross/)
    await expect(insert(office(), 'Ddt', ddtRow(shipped, { ...two, appearance: ' ' }))).rejects.toThrow(/goods' appearance/)
    await expect(insert(office(), 'Ddt', ddtRow(shipped, { ...two, lines: [] }))).rejects.toThrow(/its goods as a list of at least one line/)
    await expect(insert(office(), 'Ddt', ddtRow(shipped, { ...two, numberSeriesId: A.invoiceSeries }))).rejects.toThrow(/numbered from a DDT series, not a INVOICE series/)
    await expect(insert(office(), 'Ddt', ddtRow(shipped, { ...two, number: '144/2026' }))).rejects.toThrow(/Ddt_tenantId_numberSeriesId_number_key/)
    expect(await insert(office(), 'Ddt', ddtRow(shipped, { ...two, transportBy: 'SENDER', carrier: null, reason: 'OTHER', reasonText: 'Sostituzione' }))).toBe(1)
    // The seed's numbers: 143 and 144 of company A's 2026 series, without a gap; the series moved to 145.
    expect(await sql(office(), `SELECT value, formatted, "recordType" FROM "NumberAllocation" WHERE "seriesId" = $1::uuid ORDER BY value`, seeded.ddtSeriesId)).toEqual([
      { value: 143, formatted: '143/2026', recordType: 'Ddt' },
      { value: 144, formatted: '144/2026', recordType: 'Ddt' },
    ])
    expect(await sql(office(), 'SELECT "nextValue" FROM "NumberSeries" WHERE id = $1::uuid', seeded.ddtSeriesId)).toEqual([{ nextValue: 145 }])
  })

  it('never changes, for every login: a cancellation row keeps its number, and a cancellation never changes either', async () => {
    const ddt = seeded.ddtId
    await expect(run(office(), `UPDATE "Ddt" SET remarks = 'x' WHERE id = $1::uuid`, ddt)).rejects.toThrow(DENIED)
    await expect(run(office(), 'DELETE FROM "Ddt" WHERE id = $1::uuid', ddt)).rejects.toThrow(DENIED)
    await expect(admin(`UPDATE "Ddt" SET remarks = 'x' WHERE id = $1`, [ddt])).rejects.toThrow(/append-only: UPDATE on "Ddt" is refused/)
    await expect(admin('DELETE FROM "Ddt" WHERE id = $1', [ddt])).rejects.toThrow(/append-only: DELETE on "Ddt" is refused/)
    await expect(admin('TRUNCATE "Ddt" CASCADE')).rejects.toThrow(/append-only: TRUNCATE on "D/)
    const cancellation = seeded.cancellationId
    await expect(run(office(), `UPDATE "DdtCancellation" SET reason = 'x' WHERE id = $1::uuid`, cancellation)).rejects.toThrow(DENIED)
    await expect(admin(`UPDATE "DdtCancellation" SET reason = 'x' WHERE id = $1`, [cancellation])).rejects.toThrow(/append-only: UPDATE on "DdtCancellation" is refused/)
    await expect(admin('DELETE FROM "DdtCancellation" WHERE id = $1', [cancellation])).rejects.toThrow(/append-only: DELETE on "DdtCancellation" is refused/)
    await expect(admin('TRUNCATE "DdtCancellation"')).rejects.toThrow(/append-only: TRUNCATE on "DdtCancellation" is refused/)
    await expect(insert(office(), 'DdtCancellation', { id: randomUUID(), siteId: A.siteA, partyId: A.P1, ddtId: ddt, reason: ' ', cancelledAt: new Date().toISOString() })).rejects.toThrow(/says why/)
    // The cancelled DDT keeps its number.
    expect(await sql(office(), 'SELECT number FROM "Ddt" WHERE id = $1::uuid', seeded.cancelledDdtId)).toEqual([{ number: '143/2026' }])
  })
})

// --- tracking ---------------------------------------------------------------------------------------------------------

describe('tracking events', () => {
  it('belong to a shipment that has a label, are recorded once per carrier event, and are append-only for every login', async () => {
    const event = (shipmentId: string, extra: Record<string, unknown> = {}) => ({
      id: randomUUID(),
      siteId: A.siteA,
      partyId: A.P1,
      shipmentId,
      status: 'IN_TRANSIT',
      occurredAt: new Date().toISOString(),
      source: 'WEBHOOK',
      externalEventId: `t-${tag()}`,
      ...extra,
    })
    await expect(insert(office(), 'TrackingEvent', event(seeded.draftShipmentId))).rejects.toThrow(/is DRAFT; it has no tracking/)
    await expect(insert(office(), 'TrackingEvent', event(seeded.shipmentId, { externalEventId: 'seed-event-in-transit' }))).rejects.toThrow(/TrackingEvent_tenantId_shipmentId_externalEventId_key/)
    expect(await insert(office(), 'TrackingEvent', event(seeded.shipmentId, { status: 'OUT_FOR_DELIVERY', parcelId: seeded.parcelIds[0] }))).toBe(1)
    // Typed by the office (no carrier id): as many as happen.
    expect(await insert(office(), 'TrackingEvent', event(seeded.shipmentId, { source: 'MANUAL', externalEventId: null }))).toBe(1)
    expect(await insert(office(), 'TrackingEvent', event(seeded.shipmentId, { source: 'MANUAL', externalEventId: null }))).toBe(1)
    const [{ id }] = (await sql(office(), `SELECT id FROM "TrackingEvent" WHERE "externalEventId" = 'seed-event-in-transit'`)) as [{ id: string }]
    await expect(run(office(), `UPDATE "TrackingEvent" SET status = 'DELIVERED' WHERE id = $1::uuid`, id)).rejects.toThrow(DENIED)
    await expect(run(office(), 'DELETE FROM "TrackingEvent" WHERE id = $1::uuid', id)).rejects.toThrow(DENIED)
    await expect(admin(`UPDATE "TrackingEvent" SET status = 'DELIVERED' WHERE id = $1`, [id])).rejects.toThrow(/append-only: UPDATE on "TrackingEvent" is refused/)
    await expect(admin('DELETE FROM "TrackingEvent" WHERE id = $1', [id])).rejects.toThrow(/append-only: DELETE on "TrackingEvent" is refused/)
    await expect(admin('TRUNCATE "TrackingEvent"')).rejects.toThrow(/append-only: TRUNCATE on "TrackingEvent" is refused/)
  })
})

// --- the partner ----------------------------------------------------------------------------------------------------

describe('the partner wall', () => {
  it('a portal or link session reads only its own party’s shipments, parcels, DDTs and tracking, never an internal column', async () => {
    // A shipment of an order of another party (P3) of tenant A.
    const orderP3 = randomUUID()
    await insert(office(), 'SalesOrder', {
      id: orderP3,
      companyId: A.companyA,
      partyId: A.P3,
      number: `T-SO-${tag()}`,
      orderDate: '2026-11-20',
      taxMode: 'IT_B2B',
      billTo: { legalName: 'Other' },
      shipTo: { name: 'Other' },
    })
    const shipmentP3 = shipmentRow({ partyId: A.P3, salesOrderId: orderP3 })
    await insert(office(), 'Shipment', shipmentP3)
    // The order's party is the shipment's (the reference).
    await expect(insert(office(), 'Shipment', shipmentRow({ partyId: A.P3 }))).rejects.toThrow(/foreign key/)

    const shipments = (scope: FactoryScope) => as(scope, (client) => client.shipment.findMany({ select: { number: true }, where: { number: { startsWith: 'SEED-' } }, orderBy: { number: 'asc' } }))
    expect((await shipments(partner(A.P1))).map((row) => row.number)).toEqual(['SEED-SH-0001', 'SEED-SH-0002'])
    expect(await sql(partner(A.P3), 'SELECT number FROM "Shipment"')).toEqual([{ number: shipmentP3.number }])
    expect(await sql(partner(A.P3), 'SELECT id FROM "Ddt"')).toEqual([])
    expect((await sql(partner(B.P1, b), `SELECT number FROM "Shipment" WHERE number LIKE 'SEED-%' ORDER BY number`)).map((row) => row.number)).toEqual(['SEED-SH-0001', 'SEED-SH-0002'])

    // Its own DDTs (the cancelled one with its cancellation), parcels with their tracking numbers, and tracking.
    expect((await sql(partner(A.P1), `SELECT number FROM "Ddt" WHERE number IN ('143/2026', '144/2026') ORDER BY number`)).map((row) => row.number)).toEqual(['143/2026', '144/2026'])
    expect(await sql(partner(A.P1), 'SELECT "ddtId" FROM "DdtCancellation" WHERE "ddtId" = $1::uuid', seeded.cancelledDdtId)).toEqual([{ ddtId: seeded.cancelledDdtId }])
    expect((await sql(partner(A.P1), `SELECT "trackingNumber" FROM "Parcel" WHERE "shipmentId" = $1::uuid ORDER BY seq`, seeded.shipmentId)).map((row) => row.trackingNumber)).toEqual([
      'SEEDTRACK0001',
      'SEEDTRACK0002',
    ])
    expect(await count(`SELECT count(*) AS n FROM "TrackingEvent" WHERE "shipmentId" = $1 AND "externalEventId" LIKE 'seed-%'`, [seeded.shipmentId])).toBe(3)
    expect((await sql(partner(A.P1), `SELECT id FROM "TrackingEvent" WHERE "externalEventId" LIKE 'seed-%'`)).length).toBe(3)
    expect(await sql(partner(A.P3), 'SELECT id FROM "TrackingEvent"')).toEqual([])

    // Never an internal column, nor who in the office wrote a row; Prisma's default select fails loudly.
    for (const [table, column] of [
      ['Shipment', 'internalNote'],
      ['Shipment', 'integrationAccountId'],
      ['Shipment', 'createdById'],
      ['Ddt', 'internalNote'],
      ['Ddt', 'createdById'],
      ['ShipmentLine', 'createdById'],
      ['Parcel', 'createdById'],
      ['DdtCancellation', 'createdById'],
      ['TrackingEvent', 'createdById'],
    ] as const) {
      await expect(sql(partner(A.P1), `SELECT "${column}" FROM "${table}" LIMIT 1`), `${table}.${column}`).rejects.toThrow(DENIED)
    }
    await expect(as(partner(A.P1), (client) => client.ddt.findMany())).rejects.toThrow(DENIED)
    // It writes nothing here, and reads nothing of quality.
    await expect(run(partner(A.P1), `UPDATE "Shipment" SET status = 'DELIVERED' WHERE id = $1::uuid`, seeded.shipmentId)).rejects.toThrow(DENIED)
    await expect(insert(partner(A.P1), 'TrackingEvent', { id: randomUUID(), siteId: A.siteA, partyId: A.P1, shipmentId: seeded.shipmentId, status: 'DELIVERED', occurredAt: new Date().toISOString(), source: 'MANUAL' })).rejects.toThrow(
      DENIED,
    )
    for (const table of ['Inspection', 'InspectionDefect', 'QualityRelease', 'QualityReleaseReversal', 'GarmentSerial', 'PpeRegisterEntry', 'ShippingSettings']) {
      await expect(sql(partner(A.P1), `SELECT id FROM "${table}" LIMIT 1`), table).rejects.toThrow(DENIED)
    }
  })
})

// --- the PPE register -------------------------------------------------------------------------------------------------

describe('the PPE register', () => {
  it('keeps its entries: opened, closed once with who and when, never changed after nor deleted (Reg. 2016/425 art. 8(4))', async () => {
    const entry = {
      id: randomUUID(),
      companyId: A.companyA,
      reference: `T-REG-${tag()}`,
      kind: 'NON_CONFORMITY',
      styleId: production().styleId,
      batchNumbers: ['SEED-BT-0001'],
      reportedAt: new Date().toISOString(),
      description: 'A shoulder protector pocket sewn shut.',
    }
    await expect(insert(office(), 'PpeRegisterEntry', { ...entry, status: 'CLOSED', closedAt: new Date().toISOString(), closedById: a.actorId })).rejects.toThrow(/starts OPEN/)
    expect(await insert(office(), 'PpeRegisterEntry', entry)).toBe(1)
    await expect(run(office(), `UPDATE "PpeRegisterEntry" SET status = 'CLOSED' WHERE id = $1::uuid`, entry.id)).rejects.toThrow(/wrong closing/)
    await expect(run(office(), `UPDATE "PpeRegisterEntry" SET kind = 'RECALL' WHERE id = $1::uuid`, entry.id)).rejects.toThrow(/never change/)
    // Closing needs its duties met (202610285001_quality_ppe_register_guards): a reason, the risk decided, the corrective
    // action written and done, and here, since SEED-BT-0001's garments left on SEED-SH-0001, the distributors informed.
    const close = (reason: string) =>
      run(office(), `UPDATE "PpeRegisterEntry" SET status = 'CLOSED', "closedAt" = now(), "closedById" = $2::uuid, "closeReason" = $3 WHERE id = $1::uuid`, entry.id, a.actorId, reason)
    await expect(close('Fixed.')).rejects.toThrow(/closes once its risk is decided/)
    expect(await run(office(), `UPDATE "PpeRegisterEntry" SET risk = 'NO' WHERE id = $1::uuid`, entry.id)).toBe(1)
    await expect(close('Fixed.')).rejects.toThrow(/corrective action is written and done/)
    await expect(run(office(), `UPDATE "PpeRegisterEntry" SET "actionCompletedAt" = now() WHERE id = $1::uuid`, entry.id)).rejects.toThrow(/corrective action done without the action/)
    expect(await run(office(), `UPDATE "PpeRegisterEntry" SET "actionTaken" = 'Pocket re-opened on the batch', "actionCompletedAt" = now() WHERE id = $1::uuid`, entry.id)).toBe(1)
    await expect(close(' ')).rejects.toThrow(/closes with a reason/)
    await expect(close('Fixed.')).rejects.toThrow(/left for customers: it closes once the distributors were informed/)
    expect(await run(office(), `UPDATE "PpeRegisterEntry" SET "distributorsInformedAt" = now() WHERE id = $1::uuid`, entry.id)).toBe(1)
    expect(await close('Pocket re-opened on every garment of the batch; P1 informed.')).toBe(1)
    await expect(run(office(), `UPDATE "PpeRegisterEntry" SET "actionTaken" = 'x' WHERE id = $1::uuid`, entry.id)).rejects.toThrow(/is CLOSED; it never changes/)
    await expect(run(office(), 'DELETE FROM "PpeRegisterEntry" WHERE id = $1::uuid', entry.id)).rejects.toThrow(DENIED)
    await expect(admin('DELETE FROM "PpeRegisterEntry" WHERE id = $1', [entry.id])).rejects.toThrow(/never deleted/)
    await expect(insert(office(), 'PpeRegisterEntry', { ...entry, id: randomUUID() })).rejects.toThrow(/PpeRegisterEntry_tenantId_companyId_reference_key/)
  })
})

// --- the seeds --------------------------------------------------------------------------------------------------------

describe('the seeds', () => {
  it('are idempotent', async () => {
    const tables = ['Inspection', 'InspectionDefect', 'QualityRelease', 'QualityReleaseReversal', 'GarmentSerial', 'PpeRegisterEntry', 'ShippingSettings', 'Shipment', 'ShipmentLine', 'Parcel', 'Ddt', 'DdtCancellation', 'TrackingEvent', 'NumberAllocation']
    const counts = async () => {
      const out: number[] = []
      for (const table of tables) out.push(await count(`SELECT count(*) AS n FROM "${table}" WHERE "tenantId" = $1`, [b.tenantId]))
      return out
    }
    const before = await counts()
    // NumberAllocation: the numbering seed's two invoice numbers per company and the two DDT numbers.
    expect(before).toEqual([3, 2, 5, 1, 3, 1, 2, 2, 3, 3, 2, 1, 3, 6])
    await seedShipping({ db: factory, namespace: 'qs-b' })
    expect(await counts()).toEqual(before)
    expect(await admin(`SELECT number, status::text FROM "Shipment" WHERE "tenantId" = $1 ORDER BY number`, [b.tenantId])).toEqual([
      { number: 'SEED-SH-0001', status: 'SHIPPED' },
      { number: 'SEED-SH-0002', status: 'DRAFT' },
    ])
  })
})
