import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedCutting, type CuttingSeed } from '../seed/cutting'
import { seed as seedNumbering } from '../seed/numbering'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { classifiedModels, personalDataOf } from './ownership'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'
import { loadOwnership, loadSchema } from './tools'

/**
 * The cutting room schema (W2b schema wave 13/16, B-W2b-85, …_cutting_room_w2b_guards) on a database built from the migrations
 * and seeded, through the real login and the scoped client:
 *   - grants: the office plans and reconciles, the floor of the site reads, moves and spreads, the partner reads nothing;
 *   - cut orders: PLANNED first, a material of their kind, the marker, released with a line, the floor's two moves, CUT once
 *     the lays are, RECONCILED once every line is, final states frozen, never deleted;
 *   - lines: only while PLANNED, ratio × plies, the cell's material, a work order that is released;
 *   - tickets: OPEN first, one per lay and per leather cut order, the shape of a recut, the floor's moves, done once counted;
 *   - lays and their rolls: the ply check at both ends against the plies spread, one shade per lay, rolls only while spreading;
 *   - ply runs, the reconciliation (append-only), the consumption, secondary processes, trolleys, pattern pieces (frozen with
 *     their revision), second quality;
 *   - the cut log's cutting-table checks, the repair station's scans on a rework, a recut's ticket on its replacement;
 *   - CUT_ORDER and CUT_TICKET are office document kinds with a series.
 * The refusals are check_violation (SQLSTATE 23514); their messages are read through raw SQL.
 */

const NS = 'w2b-85-a'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let seeded: CuttingSeed

const key = (name: string): string => seedUuid(NS, name)
const A = { company: key('company:A'), site: key('site:A1') }
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: seeded.operatorId, siteId: A.site })
const partner = (): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: a.actorId, partyId: key('party:P1') })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
/** INSERT a copy of row `id` of `table` with `changes` (a jsonb object of columns). */
const copyRow = (scope: FactoryScope, table: string, id: string, changes: Record<string, unknown>) =>
  run(scope, `INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`, JSON.stringify(changes), id)
/** UPDATE row `id` of `table`: `set` is the SET list. */
const update = (scope: FactoryScope, table: string, id: string, set: string) => run(scope, `UPDATE "${table}" SET ${set} WHERE id = $1::uuid`, id)
const tag = (prefix: string): string => `${prefix}-${randomUUID().slice(0, 8)}`
const NOW = "'2026-11-21T08:00:00Z'"
const cell = (name: string): string => { const [colour, size] = name.split('-'); return key(`production:WO-0001:cell:${colour}:${size}`) }

/** A new PLANNED cut order copied from the seeded planned one, with `changes`. */
async function cutOrder(changes: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  await copyRow(office(), 'CutOrder', seeded.cutOrderIds.planned, { id, number: tag('T-CO'), ...changes })
  return id
}
/** A line of cut order `cutOrderId` copied from the seeded planned line, with `changes`. */
async function line(cutOrderId: string, changes: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  await copyRow(office(), 'CutOrderLine', seeded.lineIds.planned, { id, cutOrderId, seq: Math.floor(Math.random() * 1e6) + 100, ...changes })
  return id
}
/** A fabric cut order of the lining, RELEASED, with one line (ratio 1 × 1 ply) and one lay of 2 plies, PLANNED. */
async function fabricOrder(): Promise<{ order: string; lay: string }> {
  const order = randomUUID()
  await copyRow(office(), 'CutOrder', seeded.cutOrderIds.fabric, {
    id: order,
    number: tag('T-CO'),
    status: 'PLANNED',
    releasedAt: null,
    releasedById: null,
    cutAt: null,
    reconciledAt: null,
    reconciledById: null,
  })
  await copyRow(office(), 'CutOrderLine', seeded.lineIds.fabric[0]!, { id: randomUUID(), cutOrderId: order })
  const lay = randomUUID()
  await copyRow(office(), 'Lay', seeded.layIds.planned, { id: lay, cutOrderId: order, seq: 1, plies: 2 })
  await update(office(), 'CutOrder', order, `status = 'RELEASED', "releasedAt" = ${NOW}, "releasedById" = "createdById"`)
  return { order, lay }
}
/** A roll of the lay copied from the seeded spreading lay's roll (SEED-RL-0002, shade group 1). */
async function layRoll(lay: string, changes: Record<string, unknown> = {}, scope: FactoryScope = floor()): Promise<string> {
  const id = randomUUID()
  await copyRow(scope, 'LayRoll', seeded.layRollIds.spreading, { id, layId: lay, seq: Math.floor(Math.random() * 1e6) + 100, ...changes })
  return id
}

beforeAll(async () => {
  db = await migratedDatabase('cuttingroomw2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  await seedNumbering({ db: factory, namespace: NS })
  seeded = await seedCutting({ db: factory, namespace: NS })
}, 180_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('grants', () => {
  it('classifies the thirteen models of the file, none with a partner grant and none as personal data', () => {
    const ownership = loadOwnership()
    const models = classifiedModels(loadSchema(), ownership).filter(({ model }) => model.file === 'cutting.prisma')
    expect(models.map(({ model }) => model.name).sort()).toEqual([
      'CutConsumption',
      'CutIssue',
      'CutIssueLine',
      'CutOrder',
      'CutOrderLine',
      'CutReconciliation',
      'CutTicket',
      'GarmentDowngrade',
      'Lay',
      'LayRoll',
      'PatternPiece',
      'PlyRun',
      'SecondaryProcess',
    ])
    for (const { model, ownership: entry } of models) {
      expect(Object.keys(entry.access).sort(), model.name).toEqual(model.name === 'CutReconciliation' ? ['factory_runtime'] : ['factory_floor_runtime', 'factory_runtime'])
    }
    const names = new Set(models.map(({ model }) => model.name))
    expect(personalDataOf(loadSchema(), ownership).filter((entry) => names.has(entry.model))).toEqual([])
  })

  it('lets the floor read lines and pieces but write none, keeps it from the reconciliation, and the partner from everything', async () => {
    expect((await sql(floor(), 'SELECT id FROM "CutOrderLine"')).length).toBeGreaterThan(0)
    expect((await sql(floor(), 'SELECT id FROM "PatternPiece"')).length).toBeGreaterThan(0)
    await expect(run(floor(), 'UPDATE "CutOrderLine" SET quantity = quantity WHERE false')).rejects.toThrow(/permission denied/)
    await expect(run(floor(), 'DELETE FROM "PatternPiece" WHERE false')).rejects.toThrow(/permission denied/)
    await expect(run(floor(), 'INSERT INTO "CutOrder" (id) VALUES (NULL)')).rejects.toThrow(/permission denied/)
    await expect(run(floor(), 'UPDATE "GarmentDowngrade" SET note = note WHERE false')).rejects.toThrow(/permission denied/)
    await expect(sql(floor(), 'SELECT id FROM "CutReconciliation"')).rejects.toThrow(/permission denied/)
    for (const table of ['CutOrder', 'CutOrderLine', 'CutTicket', 'Lay', 'LayRoll', 'PlyRun', 'CutReconciliation', 'CutConsumption', 'SecondaryProcess', 'CutIssue', 'CutIssueLine', 'PatternPiece', 'GarmentDowngrade']) {
      await expect(sql(partner(), `SELECT id FROM "${table}"`)).rejects.toThrow(/permission denied/)
    }
  })

  it('shows the floor only its own site', async () => {
    const otherFloor: FactoryScope = { audience: 'floor', tenantId: a.tenantId, actorId: randomUUID(), siteId: randomUUID() }
    for (const table of ['CutOrder', 'CutTicket', 'Lay', 'LayRoll', 'PlyRun', 'CutConsumption', 'SecondaryProcess', 'CutIssue', 'CutIssueLine', 'GarmentDowngrade']) {
      expect((await sql(floor(), `SELECT id FROM "${table}"`)).length, table).toBeGreaterThan(0)
      expect(await sql(otherFloor, `SELECT id FROM "${table}"`), table).toEqual([])
    }
  })
})

describe('cut orders', () => {
  it('starts PLANNED, of a material tracked as its kind needs, with a marker only for fabric', async () => {
    await expect(cutOrder({ status: 'RELEASED', releasedAt: '2026-11-21T08:00:00Z', releasedById: a.actorId })).rejects.toThrow(/starts PLANNED/)
    await expect(cutOrder({ kind: 'FABRIC' })).rejects.toThrow(/tracked by LOT/)
    await expect(cutOrder({ itemId: key('product:item:lining'), itemColourId: null })).rejects.toThrow(/tracked by HIDE/)
    await expect(cutOrder({ markerName: 'MK-1' })).rejects.toThrow(/it has no marker/)
    await expect(copyRow(office(), 'CutOrder', seeded.cutOrderIds.planned, { id: randomUUID(), number: ' ' })).rejects.toThrow(/has its number/)
    const order = await cutOrder()
    await expect(update(office(), 'CutOrder', order, `number = 'X'`)).rejects.toThrow(/never change/)
    await expect(update(office(), 'CutOrder', order, `kind = 'FABRIC'`)).rejects.toThrow(/never change/)
    await expect(admin('DELETE FROM "CutOrder" WHERE id = $1', [order])).rejects.toThrow(/never deleted/)
    await expect(admin('TRUNCATE "CutOrder" CASCADE')).rejects.toThrow(/refused/)
  })

  it('is released with a line, and a fabric one with its marker; it goes back to PLANNED until a ticket was scanned', async () => {
    const order = await cutOrder()
    await expect(update(office(), 'CutOrder', order, `status = 'RELEASED', "releasedAt" = ${NOW}, "releasedById" = "createdById"`)).rejects.toThrow(/has no line/)
    await line(order)
    await expect(update(office(), 'CutOrder', order, `status = 'RELEASED'`)).rejects.toThrow(/wrong times/)
    expect(await update(office(), 'CutOrder', order, `status = 'RELEASED', "releasedAt" = ${NOW}, "releasedById" = "createdById"`)).toBe(1)
    expect(await update(office(), 'CutOrder', order, `status = 'PLANNED', "releasedAt" = NULL, "releasedById" = NULL`)).toBe(1)
    await expect(update(office(), 'CutOrder', order, `status = 'CUT', "cutAt" = ${NOW}`)).rejects.toThrow(/cannot move from PLANNED to CUT/)

    const fabric = randomUUID()
    await copyRow(office(), 'CutOrder', seeded.cutOrderIds.fabric, { id: fabric, number: tag('T-CO'), status: 'PLANNED', releasedAt: null, releasedById: null, cutAt: null, markerName: null, markerLength: null, markerUom: null })
    await copyRow(office(), 'CutOrderLine', seeded.lineIds.fabric[0]!, { id: randomUUID(), cutOrderId: fabric })
    await expect(update(office(), 'CutOrder', fabric, `status = 'RELEASED', "releasedAt" = ${NOW}, "releasedById" = "createdById"`)).rejects.toThrow(/with no marker/)
    await expect(update(office(), 'CutOrder', fabric, `"markerLength" = 2`)).rejects.toThrow(/both or neither/)
    expect(await update(office(), 'CutOrder', fabric, `"markerName" = 'MK-2', "markerLength" = 2, "markerUom" = 'M'`)).toBe(1)
    expect(await update(office(), 'CutOrder', fabric, `status = 'RELEASED', "releasedAt" = ${NOW}, "releasedById" = "createdById"`)).toBe(1)
    await expect(update(office(), 'CutOrder', fabric, `"markerLength" = 3`)).rejects.toThrow(/changes only while PLANNED/)
    // The seeded fabric order's tickets were scanned: it does not go back to PLANNED (it is IN_PROGRESS, so it cannot anyway).
    await expect(update(office(), 'CutOrder', seeded.cutOrderIds.fabric, `status = 'PLANNED', "releasedAt" = NULL, "releasedById" = NULL`)).rejects.toThrow(/cannot move from IN_PROGRESS to PLANNED/)
  })

  it('moves at the table only from RELEASED to IN_PROGRESS and on to CUT; a fabric one is CUT once its lays are', async () => {
    const { order, lay } = await fabricOrder()
    await expect(update(floor(), 'CutOrder', order, `note = 'x'`)).rejects.toThrow(/only starts/)
    await expect(update(floor(), 'CutOrder', order, `status = 'CANCELLED', "cancelledAt" = ${NOW}, "cancelReason" = 'x'`)).rejects.toThrow(/only starts/)
    expect(await update(floor(), 'CutOrder', order, `status = 'IN_PROGRESS'`)).toBe(1)
    await expect(update(floor(), 'CutOrder', order, `status = 'CUT', "cutAt" = ${NOW}`)).rejects.toThrow(/every lay of it is CUT or CANCELLED/)
    expect(await update(office(), 'Lay', lay, `status = 'CANCELLED', "cancelledAt" = ${NOW}, "cancelReason" = 'Marker changed.'`)).toBe(1)
    await expect(update(floor(), 'CutOrder', order, `status = 'CUT', "cutAt" = ${NOW}`)).rejects.toThrow(/one at least is CUT/)
  })
})

describe('lines', () => {
  it('change only while the cut order is PLANNED, with ratio × plies for fabric and neither for leather', async () => {
    await expect(line(seeded.cutOrderIds.fabric, { ratio: 1, plies: 1 })).rejects.toThrow(/only while it is PLANNED/)
    await expect(run(office(), 'DELETE FROM "CutOrderLine" WHERE id = $1::uuid', seeded.lineIds.fabric[0])).rejects.toThrow(/only while it is PLANNED/)
    const order = await cutOrder()
    await expect(line(order, { ratio: 1, plies: 1 })).rejects.toThrow(/a leather line neither/)
    await expect(line(order, { quantity: 0 })).rejects.toThrow(/at least one garment/)
    await expect(line(order, { quantity: 5 })).rejects.toThrow(/its cell makes 1/)
    await expect(line(order, { workOrderSizeId: cell('RED-54') })).rejects.toThrow(/does not take the material/)
    const id = await line(order)
    await expect(update(office(), 'CutOrderLine', id, `"cutOrderId" = '${seeded.cutOrderIds.planned}'`)).rejects.toThrow(/never moves/)
    expect(await run(office(), 'DELETE FROM "CutOrderLine" WHERE id = $1::uuid', id)).toBe(1)

    const fabric = randomUUID()
    await copyRow(office(), 'CutOrder', seeded.cutOrderIds.fabric, { id: fabric, number: tag('T-CO'), status: 'PLANNED', releasedAt: null, releasedById: null, cutAt: null })
    await expect(copyRow(office(), 'CutOrderLine', seeded.lineIds.fabric[1]!, { id: randomUUID(), cutOrderId: fabric, ratio: 1, plies: 1 })).rejects.toThrow(/ratio × plies/)
    expect(await copyRow(office(), 'CutOrderLine', seeded.lineIds.fabric[1]!, { id: randomUUID(), cutOrderId: fabric, ratio: 2, plies: 1 })).toBe(1)
  })

  it('takes a work order that is RELEASED or IN_PROGRESS', async () => {
    const [draft] = await admin(
      `SELECT s.id::text AS id, s."workOrderId"::text AS wo FROM "WorkOrderSize" s JOIN "WorkOrder" w ON w.id = s."workOrderId" WHERE w."tenantId" = $1 AND w.status = 'DRAFT' LIMIT 1`,
      [a.tenantId],
    )
    const order = await cutOrder()
    await expect(line(order, { workOrderId: draft!.wo, workOrderSizeId: draft!.id })).rejects.toThrow(/is DRAFT; a cut order takes RELEASED or IN_PROGRESS/)
  })
})

describe('tickets', () => {
  const ticket = (changes: Record<string, unknown>) =>
    copyRow(office(), 'CutTicket', seeded.ticketIds.layPlanned, { id: randomUUID(), number: tag('T-CT'), scanCode: tag('T-CT'), status: 'OPEN', startedAt: null, doneAt: null, voidedAt: null, voidReason: null, ...changes })

  it('starts OPEN, one per lay, a lay for fabric and none for leather, and a scan code without spaces', async () => {
    await expect(ticket({ status: 'STARTED', startedAt: '2026-11-21T08:00:00Z' })).rejects.toThrow(/starts OPEN/)
    await expect(ticket({})).rejects.toThrow(/CutTicket_one_per_lay|unique/)
    await expect(ticket({ layId: null })).rejects.toThrow(/a ticket per lay/)
    await expect(ticket({ scanCode: 'CT 1' })).rejects.toThrow(/scan code without spaces/)
    await expect(ticket({ cutOrderId: seeded.cutOrderIds.leather, layId: null })).rejects.toThrow(/takes no new ticket/)
    await expect(ticket({ workOrderId: seeded.workOrderId })).rejects.toThrow(/nothing of a recut/)
    expect(await update(office(), 'CutTicket', seeded.ticketIds.layPlanned, `status = 'VOID', "voidedAt" = ${NOW}, "voidReason" = 'Reprinted.'`)).toBe(1)
    expect(await ticket({})).toBe(1)
  })

  it('keeps the shape of a recut, of an ACTIVE bundle of its cell', async () => {
    const recut = (changes: Record<string, unknown>) => copyRow(office(), 'CutTicket', seeded.ticketIds.recut, { id: randomUUID(), number: tag('T-CT'), scanCode: tag('T-CT'), ...changes })
    await expect(recut({ quantity: 0 })).rejects.toThrow(/sets \(from 1\)/)
    await expect(recut({ lotId: null })).rejects.toThrow(/a lot with its item or none/)
    await expect(recut({ cutOrderId: seeded.cutOrderIds.fabric })).rejects.toThrow(/no cut order or lay/)
    await expect(recut({ workOrderSizeId: cell('BLK-50') })).rejects.toThrow(/ACTIVE bundle of its cell/)
    expect(await recut({ endBits: true, lotItemId: null, lotId: null })).toBe(1)
  })

  it('is started and finished at the table, done once its lay is counted, then never changes', async () => {
    const { order, lay } = await fabricOrder()
    const id = randomUUID()
    await ticket({ id, cutOrderId: order, layId: lay })
    await expect(update(floor(), 'CutTicket', id, `status = 'VOID', "voidedAt" = ${NOW}, "voidReason" = 'x'`)).rejects.toThrow(/the office voids it/)
    await expect(update(floor(), 'CutTicket', id, `part = 'x'`)).rejects.toThrow(/never changes but for its status/)
    await expect(update(floor(), 'CutTicket', id, `status = 'DONE', "startedAt" = ${NOW}, "doneAt" = ${NOW}`)).rejects.toThrow(/cannot move from OPEN to DONE/)
    expect(await update(floor(), 'CutTicket', id, `status = 'STARTED', "startedAt" = ${NOW}`)).toBe(1)
    await expect(update(floor(), 'CutTicket', id, `status = 'DONE', "doneAt" = ${NOW}`)).rejects.toThrow(/its ticket is done once its plies were counted/)
    await expect(update(office(), 'CutTicket', seeded.ticketIds.layCut, `"printedAt" = ${NOW}`)).rejects.toThrow(/is DONE; it never changes/)
    await expect(admin('DELETE FROM "CutTicket" WHERE id = $1', [id])).rejects.toThrow(/never deleted/)
  })
})

describe('lays and their rolls', () => {
  it('start PLANNED on a fabric cut order', async () => {
    const lay = (changes: Record<string, unknown>) => copyRow(office(), 'Lay', seeded.layIds.planned, { id: randomUUID(), seq: Math.floor(Math.random() * 1e6) + 100, ...changes })
    await expect(lay({ status: 'SPREADING' })).rejects.toThrow(/starts PLANNED/)
    await expect(lay({ cutOrderId: seeded.cutOrderIds.planned })).rejects.toThrow(/a lay is planned on a FABRIC cut order/)
    await expect(lay({ plies: 0 })).rejects.toThrow(/plies planned from 1/)
    await expect(lay({ layLength: 2 })).rejects.toThrow(/both or neither/)
  })

  it('are counted at both ends against the plies spread: a difference blocks the cut', async () => {
    const { order, lay } = await fabricOrder()
    await update(floor(), 'CutOrder', order, `status = 'IN_PROGRESS'`)
    expect(await update(floor(), 'Lay', lay, `status = 'SPREADING'`)).toBe(1)
    const roll = await layRoll(lay, { plies: 2 })
    await expect(update(floor(), 'Lay', lay, `status = 'CHECKED', "plyCountLeft" = 2, "plyCountRight" = 1, "checkedAt" = ${NOW}`)).rejects.toThrow(/left 2, right 1/)
    await expect(update(floor(), 'Lay', lay, `status = 'CHECKED', "plyCountLeft" = 3, "plyCountRight" = 3, "checkedAt" = ${NOW}`)).rejects.toThrow(/2 plies were spread/)
    await expect(update(floor(), 'Lay', lay, `status = 'CUT', "cutAt" = ${NOW}`)).rejects.toThrow(/cannot move from SPREADING to CUT/)
    expect(await update(floor(), 'Lay', lay, `status = 'CHECKED', "plyCountLeft" = 2, "plyCountRight" = 2, "checkedAt" = ${NOW}`)).toBe(1)
    await expect(run(floor(), 'DELETE FROM "LayRoll" WHERE id = $1::uuid', roll)).rejects.toThrow(/only while it is spread/)
    await expect(update(office(), 'Lay', lay, `plies = 3`)).rejects.toThrow(/plies planned change only while it is PLANNED or SPREADING/)
    // Back to spreading clears the counts; a roll is undone and added again; counted again.
    await expect(update(floor(), 'Lay', lay, `status = 'SPREADING'`)).rejects.toThrow(/wrong ply counts/)
    expect(await update(floor(), 'Lay', lay, `status = 'SPREADING', "plyCountLeft" = NULL, "plyCountRight" = NULL, "checkedAt" = NULL`)).toBe(1)
    expect(await run(floor(), 'DELETE FROM "LayRoll" WHERE id = $1::uuid', roll)).toBe(1)
    await layRoll(lay, { plies: 2 })
    await expect(update(floor(), 'Lay', lay, `plies = 3`)).rejects.toThrow(/plans its plies/)
    expect(await update(floor(), 'Lay', lay, `status = 'CHECKED', "plyCountLeft" = 2, "plyCountRight" = 2, "checkedAt" = ${NOW}`)).toBe(1)
    await expect(update(floor(), 'Lay', lay, `status = 'CANCELLED', "cancelledAt" = ${NOW}, "cancelReason" = 'x'`)).rejects.toThrow(/cancels it/)
    expect(await update(floor(), 'Lay', lay, `status = 'CUT', "cutAt" = ${NOW}`)).toBe(1)
    await expect(update(office(), 'Lay', lay, `"layLength" = 2, "lengthUom" = 'M'`)).rejects.toThrow(/only its note changes/)
    await expect(admin('DELETE FROM "Lay" WHERE id = $1', [lay])).rejects.toThrow(/never deleted/)
  })

  it('spreads rolls of the cut order\'s material and of one shade group', async () => {
    const lay = seeded.layIds.spreading
    const [{ id: fullRoll } = {}] = await admin(`SELECT id::text AS id FROM "FabricRoll" WHERE "tenantId" = $1 AND code = 'SEED-RL-0001'`, [a.tenantId])
    await expect(layRoll(lay, { rollId: fullRoll })).rejects.toThrow(/of another shade/)
    await expect(layRoll(lay, { plies: 0 })).rejects.toThrow(/plies from 1/)
    await expect(layRoll(lay, { endLoss: 61 })).rejects.toThrow(/at most roll SEED-RL-0002's length/)
    const roll = await layRoll(lay)
    await expect(update(floor(), 'LayRoll', roll, `"layId" = '${seeded.layIds.cut}'`)).rejects.toThrow(/never moves/)
    // A roll used up is spread no more.
    await update(office(), 'FabricRoll', seeded.rollId, `"lengthLeft" = 0, state = 'CONSUMED'`)
    try {
      await expect(layRoll(lay)).rejects.toThrow(/is CONSUMED; it is not spread/)
    } finally {
      await update(office(), 'FabricRoll', seeded.rollId, `"lengthLeft" = 44.5, state = 'PARTIAL'`)
    }
    // Another material: a roll of another item cannot be named (made by the admin, as a lining lot of another colour would be).
    expect(await run(floor(), 'DELETE FROM "LayRoll" WHERE id = $1::uuid', roll)).toBe(1)
  })
})

describe('ply runs, the reconciliation and the consumption', () => {
  it('numbers a counted lay, up to the plies counted, then only its print state changes', async () => {
    const run1 = (changes: Record<string, unknown>) => copyRow(floor(), 'PlyRun', seeded.plyRunId, { id: randomUUID(), seq: Math.floor(Math.random() * 1e6) + 100, ...changes })
    await expect(run1({ layId: seeded.layIds.spreading })).rejects.toThrow(/numbers a lay counted at both ends/)
    await expect(run1({ lastPly: 7 })).rejects.toThrow(/up to the plies counted \(6\)/)
    await expect(run1({ parts: ['body', 'body'] })).rejects.toThrow(/none blank or twice/)
    await expect(run1({ parts: [] })).rejects.toThrow(/at least one part/)
    await expect(run1({ status: 'VOID', voidedAt: '2026-11-21T08:00:00Z', voidReason: 'x' })).rejects.toThrow(/it is not voided/)
    await expect(run1({ status: 'PLANNED' })).rejects.toThrow(/wrong times/)
    await expect(update(floor(), 'PlyRun', seeded.plyRunId, `"lastPly" = 5`)).rejects.toThrow(/never changes but for its print state/)
    expect(await update(floor(), 'PlyRun', seeded.plyRunId, `status = 'VOID', "voidedAt" = ${NOW}, "voidReason" = 'Smudged.'`)).toBe(1)
    await expect(update(floor(), 'PlyRun', seeded.plyRunId, `status = 'PRINTED'`)).rejects.toThrow(/a VOID run never changes/)
    await expect(admin('DELETE FROM "PlyRun" WHERE id = $1', [seeded.plyRunId])).rejects.toThrow(/never deleted/)
  })

  it('keeps the reconciliation append-only: one per line, once the cut order is CUT, a reason when cut differs from ordered', async () => {
    const recon = (changes: Record<string, unknown>) => copyRow(office(), 'CutReconciliation', seeded.reconciliationId, { id: randomUUID(), ...changes })
    await expect(recon({})).rejects.toThrow(/unique/i)
    await expect(recon({ key: `reconciliation:${seeded.lineIds.leather[1]}` })).rejects.toThrow(/reconciliation:<its line>/)
    await expect(recon({ key: tag(`reconciliation:${seeded.reconciliationId}`) })).rejects.toThrow(/reconciliation:<its line>/)
    await expect(recon({ key: tag(`reconciliation:${seeded.lineIds.leather[0]}`), cutQuantity: 0 })).rejects.toThrow(/a reason code/)
    await expect(recon({ key: tag(`reconciliation:${seeded.lineIds.leather[0]}`), orderedQuantity: 3, cutQuantity: 3 })).rejects.toThrow(/the line ordered 1 garment/)
    await expect(recon({ key: tag(`reconciliation:${seeded.lineIds.leather[0]}`), recutQuantity: 2 })).rejects.toThrow(/recut from 0 up to the cut/)
    await expect(run(office(), `UPDATE "CutReconciliation" SET note = 'x' WHERE false`)).rejects.toThrow(/permission denied/)
    await expect(admin(`UPDATE "CutReconciliation" SET note = 'x' WHERE id = $1`, [seeded.reconciliationId])).rejects.toThrow(/never changed or removed/)
    await expect(admin('DELETE FROM "CutReconciliation" WHERE id = $1', [seeded.reconciliationId])).rejects.toThrow(/never changed or removed/)
    await expect(admin('TRUNCATE "CutReconciliation"')).rejects.toThrow(/never changed or removed/)
    const fabricLine = seeded.lineIds.fabric[0]!
    await expect(
      copyRow(office(), 'CutReconciliation', seeded.reconciliationId, { id: randomUUID(), cutOrderId: seeded.cutOrderIds.fabric, cutOrderLineId: fabricLine, key: `reconciliation:${fabricLine}` }),
    ).rejects.toThrow(/it is reconciled once it is CUT/)
  })

  it('closes a cut order RECONCILED once every line is, then only its note changes', async () => {
    const leather = seeded.cutOrderIds.leather
    await expect(update(office(), 'CutOrder', leather, `status = 'RECONCILED', "reconciledAt" = ${NOW}, "reconciledById" = "createdById"`)).rejects.toThrow(/every line of it has its reconciliation/)
    await run(
      office(),
      `INSERT INTO "CutReconciliation" (id, "siteId", "cutOrderId", "cutOrderLineId", key, "orderedQuantity", "cutQuantity", "varianceReasonCode", "reconciledAt")
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 2, 1, 'HIDE_SHORT', ${NOW})`,
      randomUUID(),
      A.site,
      leather,
      seeded.lineIds.leather[1],
      `reconciliation:${seeded.lineIds.leather[1]}`,
    )
    await expect(update(office(), 'CutOrder', leather, `status = 'RECONCILED'`)).rejects.toThrow(/wrong times/)
    expect(await update(office(), 'CutOrder', leather, `status = 'RECONCILED', "reconciledAt" = ${NOW}, "reconciledById" = "createdById"`)).toBe(1)
    await expect(update(office(), 'CutOrder', leather, `"stationId" = NULL`)).rejects.toThrow(/only its note changes/)
    expect(await update(office(), 'CutOrder', leather, `note = 'Reconciled with one short.'`)).toBe(1)
    // A reconciled order's consumption no longer changes.
    await expect(update(office(), 'CutConsumption', seeded.consumptionIds.leather, `confirmed = 145.5, "confirmedAt" = ${NOW}`)).rejects.toThrow(/no longer changes/)
  })

  it('keeps the consumption of a CUT lay or a leather cut order, in its unit, the confirmed figure with its time', async () => {
    const cons = (changes: Record<string, unknown>) => copyRow(floor(), 'CutConsumption', seeded.consumptionIds.lay, { id: randomUUID(), key: tag(`consumption:${seeded.layIds.cut}`), ...changes })
    await expect(cons({ layId: seeded.layIds.spreading, key: tag(`consumption:${seeded.layIds.spreading}`) })).rejects.toThrow(/a lay's once it is CUT/)
    await expect(cons({ key: tag(`consumption:${seeded.layIds.spreading}`) })).rejects.toThrow(/key consumption:<lay>/)
    await expect(cons({ uom: 'M2' })).rejects.toThrow(/in M, CM or MM/)
    await expect(cons({ confirmed: null })).rejects.toThrow(/the confirmed one with its time/)
    await expect(cons({ estimated: -1 })).rejects.toThrow(/from 0/)
    expect(await cons({})).toBe(1)
    await expect(update(floor(), 'CutConsumption', seeded.consumptionIds.lay, `uom = 'CM'`)).rejects.toThrow(/never change/)
    expect(await update(floor(), 'CutConsumption', seeded.consumptionIds.lay, `confirmed = 14.8, note = 'Recounted.'`)).toBe(1)
    await expect(admin('DELETE FROM "CutConsumption" WHERE id = $1', [seeded.consumptionIds.lay])).rejects.toThrow(/never deleted/)
  })
})

describe('after cutting', () => {
  it('moves a secondary process from WAITING, in house or outside, on a bundle with its garments', async () => {
    const proc = (changes: Record<string, unknown>) => copyRow(floor(), 'SecondaryProcess', seeded.processIds.fusing, { id: randomUUID(), seq: Math.floor(Math.random() * 1e6) + 100, ...changes })
    await expect(proc({ status: 'IN_PROGRESS', startedAt: '2026-11-21T08:00:00Z' })).rejects.toThrow(/starts WAITING/)
    await expect(proc({ quantity: 3 })).rejects.toThrow(/at least its 3 garment/)
    await expect(proc({ place: 'OUTSIDE' })).rejects.toThrow(/outside no work centre/)
    const id = randomUUID()
    await proc({ id })
    await expect(update(floor(), 'SecondaryProcess', id, `status = 'DONE', "startedAt" = ${NOW}, "doneAt" = ${NOW}`)).rejects.toThrow(/cannot move from WAITING to DONE/)
    expect(await update(floor(), 'SecondaryProcess', id, `status = 'IN_PROGRESS', "startedAt" = ${NOW}`)).toBe(1)
    await expect(update(floor(), 'SecondaryProcess', id, `kind = 'PRINT'`)).rejects.toThrow(/changes only while WAITING/)
    await expect(update(floor(), 'SecondaryProcess', id, `"bundleId" = '${seeded.workOrderId}'`)).rejects.toThrow(/never change/)
    await expect(update(floor(), 'SecondaryProcess', seeded.processIds.perforation, `"workCentreId" = NULL`)).rejects.toThrow(/only its note changes/)
    await expect(admin('DELETE FROM "SecondaryProcess" WHERE id = $1', [id])).rejects.toThrow(/never deleted/)
  })

  it('loads a trolley, sends it with a bundle, and receives each bundle once after it was sent', async () => {
    const issue = randomUUID()
    await copyRow(floor(), 'CutIssue', seeded.issueIds.loading, { id: issue })
    await expect(copyRow(floor(), 'CutIssue', seeded.issueIds.loading, { id: randomUUID(), trolleyCode: 'T 9' })).rejects.toThrow(/without spaces/)
    await expect(copyRow(floor(), 'CutIssue', seeded.issueIds.received, { id: randomUUID() })).rejects.toThrow(/starts LOADING/)
    await expect(update(floor(), 'CutIssue', issue, `status = 'SENT', "sentAt" = ${NOW}`)).rejects.toThrow(/carries no bundle/)
    const row = randomUUID()
    await copyRow(floor(), 'CutIssueLine', seeded.issueLineIds.loading, { id: row, cutIssueId: issue })
    await expect(copyRow(floor(), 'CutIssueLine', seeded.issueLineIds.loading, { id: randomUUID(), cutIssueId: issue, receivedAt: '2026-11-21T08:00:00Z' })).rejects.toThrow(/not yet received/)
    await expect(update(floor(), 'CutIssueLine', row, `"receivedAt" = ${NOW}`)).rejects.toThrow(/once it was sent/)
    expect(await update(floor(), 'CutIssue', issue, `status = 'SENT', "sentAt" = ${NOW}`)).toBe(1)
    await expect(copyRow(floor(), 'CutIssueLine', seeded.issueLineIds.loading, { id: randomUUID(), cutIssueId: issue })).rejects.toThrow(/only while it is LOADING/)
    await expect(run(floor(), 'DELETE FROM "CutIssueLine" WHERE id = $1::uuid', row)).rejects.toThrow(/only while it is LOADING/)
    await expect(update(floor(), 'CutIssue', issue, `"lineId" = "lineId", "trolleyCode" = 'T-9'`)).rejects.toThrow(/never change/)
    expect(await update(floor(), 'CutIssueLine', row, `"receivedAt" = ${NOW}`)).toBe(1)
    await expect(update(floor(), 'CutIssueLine', row, `"receivedAt" = NULL`)).rejects.toThrow(/was received; that stays/)
    expect(await update(floor(), 'CutIssue', issue, `status = 'RECEIVED', "receivedAt" = ${NOW}`)).toBe(1)
    await expect(update(floor(), 'CutIssue', issue, `status = 'CANCELLED', "cancelledAt" = ${NOW}, "cancelReason" = 'x'`)).rejects.toThrow(/only its note changes/)
    await expect(admin('DELETE FROM "CutIssue" WHERE id = $1', [issue])).rejects.toThrow(/never deleted/)
  })

  it('sends garments to second quality as exactly one of a FINISHED item and a SKU of the style, withdrawn once', async () => {
    const down = (changes: Record<string, unknown>, scope: FactoryScope = floor()) => copyRow(scope, 'GarmentDowngrade', seeded.downgradeIds.sku, { id: randomUUID(), ...changes })
    await expect(down({ secondQualityItemId: key('product:item:lining') })).rejects.toThrow(/exactly one of a second-quality item and a SKU/)
    await expect(down({ variantId: null, secondQualityItemId: key('product:item:lining') })).rejects.toThrow(/a second-quality item is FINISHED/)
    await expect(down({ variantId: key('product:variant:JKT-01:BLK:52') })).rejects.toThrow(/of another style/)
    await expect(down({ quantity: 3 })).rejects.toThrow(/its cell makes 2/)
    await expect(down({ reasonCode: 'A B' })).rejects.toThrow(/reason code without spaces/)
    await expect(down({ bundleId: key('production:bundle:WO-0001:1') })).rejects.toThrow(/bundle .* of another cell/)
    await expect(down({ voidedAt: '2026-11-21T08:00:00Z', voidedById: a.actorId, voidReason: 'x' })).rejects.toThrow(/it is not withdrawn/)
    await expect(update(office(), 'GarmentDowngrade', seeded.downgradeIds.sku, `quantity = 2`)).rejects.toThrow(/never changes/)
    await expect(update(office(), 'GarmentDowngrade', seeded.downgradeIds.withdrawn, `"voidReason" = 'Another reason.'`)).rejects.toThrow(/withdrawn already/)
    expect(await update(office(), 'GarmentDowngrade', seeded.downgradeIds.sku, `"voidedAt" = ${NOW}, "voidedById" = "createdById", "voidReason" = 'Repaired after all.'`)).toBe(1)
    await expect(admin('DELETE FROM "GarmentDowngrade" WHERE id = $1', [seeded.downgradeIds.sku])).rejects.toThrow(/never deleted/)
  })
})

describe('pattern pieces', () => {
  it('belong to a DRAFT revision, name sizes of the style, and a minimum grade only on a leather line', async () => {
    const piece = (changes: Record<string, unknown>) =>
      copyRow(office(), 'PatternPiece', seeded.patternPieceIds.front, { id: randomUUID(), seq: Math.floor(Math.random() * 1e6) + 100, name: tag('Piece'), ...changes })
    await expect(piece({ sizes: ['48'] })).rejects.toThrow(/outside its style's range/)
    await expect(piece({ sizes: ['50', '50'] })).rejects.toThrow(/none blank or twice/)
    await expect(piece({ quantity: 0 })).rejects.toThrow(/pieces from 1/)
    await expect(piece({ bomLineId: null })).rejects.toThrow(/names the leather line/)
    await expect(piece({ bomLineId: key('product:bom:JKT-01:1:20') })).rejects.toThrow(/a minimum grade is a leather \(hide\) rule/)
    await expect(piece({ name: 'Front left' })).rejects.toThrow(/unique/i)
    const id = randomUUID()
    expect(await piece({ id, minGradeId: null, bomLineId: null })).toBe(1)
    expect(await update(office(), 'PatternPiece', id, `grain = 'BIAS', sizes = ARRAY['54']`)).toBe(1)
    expect(await run(office(), 'DELETE FROM "PatternPiece" WHERE id = $1::uuid', id)).toBe(1)
    // A released revision's pieces are frozen: none is added to WO-0001's revision (SEED-JKT-02 rev 1, RELEASED).
    const [released] = await admin(`SELECT r.id::text AS id, r."styleId"::text AS style FROM "StyleRevision" r JOIN "WorkOrder" w ON w."styleRevisionId" = r.id WHERE w.id = $1`, [seeded.workOrderId])
    await expect(piece({ styleId: released!.style, revisionId: released!.id, minGradeId: null, bomLineId: null, sizes: [] })).rejects.toThrow(/is RELEASED; its "PatternPiece" rows never change/)
  })

  it('takes no retired grade', async () => {
    const [grade] = await admin(`SELECT id::text AS id FROM "LeatherGrade" WHERE "tenantId" = $1 AND code = 'D'`, [a.tenantId])
    await update(office(), 'LeatherGrade', grade!.id as string, 'active = false')
    await expect(update(office(), 'PatternPiece', seeded.patternPieceIds.sleeve, `"minGradeId" = '${grade!.id}'`)).rejects.toThrow(/grade D is retired/)
  })
})

describe('the cut log, the repair station and the recut ticket', () => {
  const entry = (changes: Record<string, unknown>, scope: FactoryScope = office()) =>
    copyRow(scope, 'CutLog', key('production:cut:H1:1'), { id: randomUUID(), clientEventId: tag('t-cut'), areaUsed: '1.0000', baseAreaUsed: '1.0000', note: null, ...changes })

  it('records the cutting table\'s checks with the entry, an override by one lead other than the cutter with the reason', async () => {
    const lead = key('worker:A1:lead')
    await expect(entry({ measuredThicknessMm: '0' })).rejects.toThrow(/above 0 and below 100/)
    await expect(entry({ overrides: ['SHADE'] })).rejects.toThrow(/exactly one lead allowed it/)
    await expect(entry({ overrides: ['SHADE', 'SHADE'], overrideLeadWorkerId: lead, overrideReason: 'x' })).rejects.toThrow(/twice/)
    await expect(entry({ overrideReason: 'Why not.' })).rejects.toThrow(/no lead and no reason/)
    await expect(entry({ overrides: ['WRONG_HIDE'], overrideLeadWorkerId: seeded.operatorId, overrideReason: 'Same article.' })).rejects.toThrow(/another person than the cutter/)
    await expect(entry({ overrides: ['THICKNESS'], overrideLeadWorkerId: lead, overrideReason: 'Within the customer\'s spec.' })).rejects.toThrow(/says the thickness measured/)
    await expect(entry({ overrides: ['GRADE'], overrideLeadUserId: a.actorId, overrideReason: 'Hidden panel.' }, floor())).rejects.toThrow(/takes a lead's PIN/)
    await expect(entry({ overrides: ['GRADE'], overrideLeadWorkerId: lead, overrideLeadUserId: a.actorId, overrideReason: 'x' })).rejects.toThrow(/exactly one lead/)
    expect(await entry({ overrides: ['THICKNESS', 'SHADE'], measuredThicknessMm: '1.45', overrideLeadWorkerId: lead, overrideReason: 'The customer accepts 1.45 mm.' }, floor())).toBe(1)
    expect(await entry({ measuredThicknessMm: '1.20' })).toBe(1)
    await expect(entry({ reversalOfId: key('production:cut:H1:1'), areaUsed: '20.0000', baseAreaUsed: '20.0000', measuredThicknessMm: '1.20' })).rejects.toThrow(/carries no photo, thickness or override/)
  })

  it('scans a rework in at a repair station from IN_PROGRESS on and out after it, each once', async () => {
    const [{ id: rework } = {}] = await admin(`SELECT id::text AS id FROM "ReworkOrder" WHERE "tenantId" = $1 AND status = 'OPEN' ORDER BY id LIMIT 1`, [a.tenantId])
    const station = key('site:A1:station:SEW-01')
    await expect(update(office(), 'ReworkOrder', rework as string, `"repairInAt" = ${NOW}, "repairStationId" = '${station}'`)).rejects.toThrow(/from IN_PROGRESS on/)
    expect(await update(office(), 'ReworkOrder', rework as string, `status = 'IN_PROGRESS', "startedAt" = ${NOW}`)).toBe(1)
    await expect(update(office(), 'ReworkOrder', rework as string, `"repairInAt" = ${NOW}`)).rejects.toThrow(/time and station together/)
    await expect(update(office(), 'ReworkOrder', rework as string, `"repairOutAt" = ${NOW}`)).rejects.toThrow(/scanned out after it/)
    expect(await update(floor(), 'ReworkOrder', rework as string, `"repairInAt" = ${NOW}, "repairStationId" = '${station}'`)).toBe(1)
    await expect(update(floor(), 'ReworkOrder', rework as string, `"repairOutAt" = '2026-11-21T07:00:00Z'`)).rejects.toThrow(/scanned out after it/)
    expect(await update(floor(), 'ReworkOrder', rework as string, `"repairOutAt" = '2026-11-21T08:40:00Z'`)).toBe(1)
    await expect(update(floor(), 'ReworkOrder', rework as string, `"repairOutAt" = '2026-11-21T08:50:00Z'`)).rejects.toThrow(/once; that stays/)
    await expect(update(floor(), 'ReworkOrder', rework as string, `"repairStationId" = '${key('site:A1:station:SEW-02')}'`)).rejects.toThrow(/once; that stays/)
  })

  it('gives a RECUT its recut ticket while OPEN: of its work order, cell and part, not VOID, and never changed', async () => {
    const replacement = seeded.replacementRequestId
    await expect(update(office(), 'ReplacementRequest', replacement, `"recutTicketId" = NULL`)).rejects.toThrow(/never changes/)
    const reduce = randomUUID()
    await copyRow(office(), 'ReplacementRequest', replacement, { id: reduce, kind: 'REDUCE', part: null, recutTicketId: null })
    await expect(update(office(), 'ReplacementRequest', reduce, `"recutTicketId" = '${seeded.ticketIds.recut}'`)).rejects.toThrow(/only a RECUT has a recut ticket/)
    const recut = randomUUID()
    await copyRow(office(), 'ReplacementRequest', replacement, { id: recut, recutTicketId: null, part: 'collar' })
    await expect(update(office(), 'ReplacementRequest', recut, `"recutTicketId" = '${seeded.ticketIds.recut}'`)).rejects.toThrow(/a RECUT ticket of its work order, cell and part/)
    await expect(update(office(), 'ReplacementRequest', recut, `"recutTicketId" = '${seeded.ticketIds.layCut}'`)).rejects.toThrow(/a RECUT ticket of its work order, cell and part/)
    const other = randomUUID()
    await copyRow(office(), 'CutTicket', seeded.ticketIds.recut, { id: other, number: tag('T-CT'), scanCode: tag('T-CT'), part: 'collar' })
    expect(await update(office(), 'ReplacementRequest', recut, `"recutTicketId" = '${other}'`)).toBe(1)
  })
})

describe('number kinds', () => {
  it('numbers cut orders and tickets from a company series, never from a block of scan ids', async () => {
    const series = await admin(`SELECT kind::text AS kind, pattern FROM "NumberSeries" WHERE "tenantId" = $1 AND kind IN ('CUT_ORDER', 'CUT_TICKET') ORDER BY kind, pattern`, [a.tenantId])
    expect(series).toEqual([
      { kind: 'CUT_ORDER', pattern: 'CO-{YYYY}-{N:4}' },
      { kind: 'CUT_ORDER', pattern: 'CO-{YYYY}-{N:4}' },
      { kind: 'CUT_TICKET', pattern: 'CTA-{YYYY}-{N:5}' },
      { kind: 'CUT_TICKET', pattern: 'CTB-{YYYY}-{N:5}' },
    ])
    await expect(
      run(office(), `INSERT INTO "NumberBlock" (id, kind, purpose, "fromRef", "toRef", "requestId") VALUES ($1::uuid, 'CUT_TICKET', 'ONLINE', 900000, 900001, $2)`, randomUUID(), tag('t-block')),
    ).rejects.toThrow(/is a document kind/)
  })
})
