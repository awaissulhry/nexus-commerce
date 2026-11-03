import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedAccounting } from '../seed/accounting'
import { seed as seedLeather, type LeatherSeed } from '../seed/leather'
import { seed as seedNumbering } from '../seed/numbering'
import { seed as seedNumberingBlocks } from '../seed/numbering-blocks'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { classifiedModels, personalDataOf } from './ownership'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'
import { loadOwnership, loadSchema } from './tools'

/**
 * The leather and roll stock schema (W2b schema wave 12/16, B-W2b-80, …_leather_stock_w2b_guards) on a database built from
 * the migrations and seeded, through the real login and the scoped client:
 *   - grants: the office keeps grades, rules and groups, the floor reads them and records on its site, the partner reads
 *     nothing;
 *   - grades and article rules: fixed codes, shares in range, one active rule, retired and never deleted;
 *   - shade groups: an article's or a lot's, one label, a lot's colour;
 *   - hides: the record and W1's text say the same, a W1 hide stays as it was, tag and area stay fixed;
 *   - marks: shape by kind, withdrawn once, nothing else changes;
 *   - measures: append-only for every login, by exactly one person;
 *   - REMNANT: RETURN's twin for the move, the work order's bound, what a work order holds of a hide, the cost entry;
 *   - remnants: their move, never more than it, the state machine, VOID only once the move is reversed;
 *   - rolls: parts of a lot, state by length left, fixed tag and length;
 *   - protector lots: a protector, a batch or a serial of that batch, withdrawn by the office;
 *   - packs: both columns or neither;
 *   - ROLL and REMNANT are scan-id kinds: blocks, never a series.
 * The refusals are check_violation (SQLSTATE 23514); their messages are read through raw SQL.
 */

const NS = 'w2b-80-a'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let seeded: LeatherSeed

const key = (name: string): string => seedUuid(NS, name)
const A = { company: key('company:A'), site: key('site:A1') }
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: randomUUID(), siteId: A.site })
const partner = (): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: a.actorId, partyId: key('party:P1') })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
/** INSERT a copy of row `id` of `table` with `changes` (a jsonb object of columns). */
const copyRow = (scope: FactoryScope, table: string, id: string, changes: Record<string, unknown>) =>
  run(scope, `INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`, JSON.stringify(changes), id)
const tag = (prefix: string): string => `${prefix}-${randomUUID().slice(0, 8)}`
const UNKNOWN = '00000000-0000-7000-8000-00000000dead'

/** A REMNANT move of the seeded offcut hide, of `quantity` ft², to the cutting rack. */
async function remnantMove(quantity = '6.0000', changes: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  await copyRow(office(), 'StockMove', seeded.offcut.moveId, { id, quantity, baseQuantity: quantity, idempotencyKey: tag('t-remnant'), ...changes })
  return id
}
/** A remnant of the seeded offcut hide, on `moveId`. */
async function remnant(moveId: string, changes: Record<string, unknown> = {}, scope: FactoryScope = office()): Promise<string> {
  const id = randomUUID()
  await copyRow(scope, 'Remnant', seeded.remnantIds[0], { id, code: tag('T-RM'), moveId, area: '1.0000', baseArea: '1.0000', ...changes })
  return id
}
const setRemnant = (id: string, state: string, extra = '') => run(office(), `UPDATE "Remnant" SET state = '${state}' ${extra} WHERE id = $1::uuid`, id)
/** The hide's reversal of `moveId`: the same move with its locations swapped. */
async function reverseMove(moveId: string): Promise<void> {
  const [{ to } = {}] = await admin(`SELECT "toLocationId"::text AS to FROM "StockMove" WHERE id = $1`, [moveId])
  await copyRow(office(), 'StockMove', moveId, { id: randomUUID(), fromLocationId: to, toLocationId: null, reversalOfId: moveId, idempotencyKey: tag('t-reversal') })
}

beforeAll(async () => {
  db = await migratedDatabase('leatherstockw2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  await seedNumbering({ db: factory, namespace: NS })
  seeded = await seedLeather({ db: factory, namespace: NS })
  await seedAccounting({ db: factory, namespace: NS })
  await seedNumberingBlocks({ db: factory, namespace: NS })
}, 180_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('grants', () => {
  it('classifies the eight models of the file, none with a partner grant and none as personal data', () => {
    const ownership = loadOwnership()
    const models = classifiedModels(loadSchema(), ownership).filter(({ model }) => model.file === 'leather.prisma')
    expect(models.map(({ model }) => model.name).sort()).toEqual(['FabricRoll', 'GarmentProtectorLot', 'HideMark', 'HideMeasure', 'ItemGradeRule', 'LeatherGrade', 'Remnant', 'ShadeGroup'])
    for (const { ownership: entry } of models) expect(Object.keys(entry.access).sort()).toEqual(['factory_floor_runtime', 'factory_runtime'])
    const names = new Set(models.map(({ model }) => model.name))
    expect(personalDataOf(loadSchema(), ownership).filter((entry) => names.has(entry.model))).toEqual([])
  })

  it('lets the floor read grades, rules and groups of the tenant and write none of them', async () => {
    for (const table of ['LeatherGrade', 'ItemGradeRule', 'ShadeGroup']) {
      expect((await sql(floor(), `SELECT id FROM "${table}"`)).length).toBeGreaterThan(0)
      await expect(run(floor(), `UPDATE "${table}" SET active = false WHERE false`)).rejects.toThrow(/permission denied/)
    }
  })

  it('keeps the partner out, the floor from withdrawing a protector row, and every login from a measure', async () => {
    for (const table of ['LeatherGrade', 'ItemGradeRule', 'HideMark', 'HideMeasure', 'ShadeGroup', 'Remnant', 'FabricRoll', 'GarmentProtectorLot']) {
      await expect(sql(partner(), `SELECT id FROM "${table}"`)).rejects.toThrow(/permission denied/)
    }
    await expect(run(floor(), `UPDATE "GarmentProtectorLot" SET "voidReason" = 'x' WHERE false`)).rejects.toThrow(/permission denied/)
    await expect(run(office(), `UPDATE "HideMeasure" SET note = 'x' WHERE false`)).rejects.toThrow(/permission denied/)
    await expect(run(floor(), `DELETE FROM "HideMeasure" WHERE false`)).rejects.toThrow(/permission denied/)
  })

  it('shows the floor only its own site', async () => {
    const other = randomUUID()
    const otherFloor: FactoryScope = { audience: 'floor', tenantId: a.tenantId, actorId: randomUUID(), siteId: other }
    for (const table of ['HideMark', 'HideMeasure', 'Remnant', 'FabricRoll', 'GarmentProtectorLot']) {
      expect((await sql(floor(), `SELECT id FROM "${table}"`)).length).toBeGreaterThan(0)
      expect(await sql(otherFloor, `SELECT id FROM "${table}"`)).toEqual([])
    }
  })
})

describe('grades and article rules', () => {
  it('keeps a grade: fixed code, words, a share from 0 to 100, retired and never deleted', async () => {
    const { A: grade } = seeded.gradeIds
    await expect(run(office(), `UPDATE "LeatherGrade" SET code = 'Z' WHERE id = $1::uuid`, grade)).rejects.toThrow(/never changes/)
    await expect(run(office(), `UPDATE "LeatherGrade" SET "usableShare" = 101 WHERE id = $1::uuid`, grade)).rejects.toThrow(/percent from 0 to 100/)
    await expect(copyRow(office(), 'LeatherGrade', grade, { id: randomUUID(), code: 'A B' })).rejects.toThrow(/code without spaces/)
    await expect(copyRow(office(), 'LeatherGrade', grade, { id: randomUUID(), code: tag('G'), labelEn: ' ' })).rejects.toThrow(/its words/)
    await expect(copyRow(office(), 'LeatherGrade', grade, { id: randomUUID() })).rejects.toThrow(/unique/i)
    await expect(admin(`DELETE FROM "LeatherGrade" WHERE id = $1`, [grade])).rejects.toThrow(/never deleted/)
    await expect(admin('TRUNCATE "LeatherGrade" CASCADE')).rejects.toThrow(/refused/)
    expect(await run(office(), `UPDATE "LeatherGrade" SET "labelEn" = 'First' WHERE id = $1::uuid`, grade)).toBe(1)
  })

  it('takes a rule of a hide article only, one active per article and grade, retired and never deleted', async () => {
    const copy = (changes: Record<string, unknown>) => copyRow(office(), 'ItemGradeRule', seeded.ruleIds.active, { id: randomUUID(), ...changes })
    await expect(copy({ itemId: seeded.rollItemId })).rejects.toThrow(/tracked by LOT/)
    await expect(copy({})).rejects.toThrow(/ItemGradeRule_one_active|unique/i)
    await expect(copy({ active: false, usableShare: '120.00' })).rejects.toThrow(/percent from 0 to 100/)
    await expect(copy({ active: false, panels: ['sleeve', ' '] })).rejects.toThrow(/panels in words/)
    const retired = randomUUID()
    await copyRow(office(), 'ItemGradeRule', seeded.ruleIds.active, { id: retired, active: false })
    await expect(run(office(), `UPDATE "ItemGradeRule" SET "gradeId" = $1::uuid WHERE id = $2::uuid`, seeded.gradeIds.C, retired)).rejects.toThrow(/never change/)
    await expect(run(office(), `UPDATE "ItemGradeRule" SET active = true WHERE id = $1::uuid`, retired)).rejects.toThrow(/ItemGradeRule_one_active|unique/i)
    await expect(admin(`DELETE FROM "ItemGradeRule" WHERE id = $1`, [retired])).rejects.toThrow(/never deleted/)
  })

  it('takes no rule for a retired grade', async () => {
    const grade = randomUUID()
    await copyRow(office(), 'LeatherGrade', seeded.gradeIds.D, { id: grade, code: tag('G'), active: false })
    await expect(copyRow(office(), 'ItemGradeRule', seeded.ruleIds.active, { id: randomUUID(), gradeId: grade })).rejects.toThrow(/is retired/)
  })
})

describe('shade groups', () => {
  const copy = (changes: Record<string, unknown>) => copyRow(office(), 'ShadeGroup', seeded.shadeGroupIds.one, { id: randomUUID(), label: tag('S'), ...changes })

  it('is an article\'s or a lot\'s, with the lot\'s site and colour', async () => {
    await expect(copy({ lotId: seeded.leatherLotId })).rejects.toThrow(/one lot's, with the lot's site/)
    await expect(copy({ lotSiteId: A.site })).rejects.toThrow(/one lot's, with the lot's site/)
    await expect(copy({ lotSiteId: A.site, lotId: seeded.leatherLotId, itemColourId: null })).rejects.toThrow(/of the lot's colour/)
    await expect(copy({ label: ' ' })).rejects.toThrow(/has a label/)
    await expect(copy({ itemId: seeded.threadItemId, itemColourId: null })).rejects.toThrow(/tracked by NONE/)
  })

  it('holds one label per article, colour and lot, where colour or lot is null too', async () => {
    await expect(copy({ label: '1' })).rejects.toThrow(/unique/i)
    await expect(copyRow(office(), 'ShadeGroup', seeded.shadeGroupIds.lining, { id: randomUUID() })).rejects.toThrow(/ShadeGroup_one_label|unique/i)
    await copy({ label: '1', lotSiteId: A.site, lotId: seeded.leatherLotId })
  })

  it('fixes its article, colour and lot, and is retired, never deleted', async () => {
    const { lot } = seeded.shadeGroupIds
    await expect(run(office(), `UPDATE "ShadeGroup" SET "lotId" = NULL, "lotSiteId" = NULL WHERE id = $1::uuid`, lot)).rejects.toThrow(/never change/)
    await expect(admin(`DELETE FROM "ShadeGroup" WHERE id = $1`, [lot])).rejects.toThrow(/never deleted/)
    expect(await run(office(), `UPDATE "ShadeGroup" SET "swatchRef" = 'Swatch L1' WHERE id = $1::uuid`, lot)).toBe(1)
  })
})

describe('hides', () => {
  const hide1 = () => seeded.hideIds[0]
  const hide2 = () => seeded.hideIds[1]

  it('keeps W1\'s text and leaves a hide with no record as it was', async () => {
    const [row] = await admin(`SELECT grade, shade, "gradeId", "shadeGroupId" FROM "Hide" WHERE id = $1`, [hide1()])
    expect(row).toEqual({ grade: 'A', shade: 'Black 01', gradeId: null, shadeGroupId: null })
    expect(await run(office(), `UPDATE "Hide" SET grade = 'A+', shade = 'dark' WHERE id = $1::uuid`, hide1())).toBe(1)
    expect(await run(floor(), `UPDATE "Hide" SET grade = 'A', shade = 'Black 01' WHERE id = $1::uuid`, hide1())).toBe(1)
  })

  it('takes a grade and a shade group from the floor too, with the text saying the same', async () => {
    expect(await run(floor(), `UPDATE "Hide" SET "gradeId" = $1::uuid, "shadeGroupId" = $2::uuid, shade = '1' WHERE id = $3::uuid`, seeded.gradeIds.A, seeded.shadeGroupIds.one, hide1())).toBe(1)
    await expect(run(office(), `UPDATE "Hide" SET grade = 'B' WHERE id = $1::uuid`, hide1())).rejects.toThrow(/names grade "A"/)
    await expect(run(office(), `UPDATE "Hide" SET shade = '9' WHERE id = $1::uuid`, hide1())).rejects.toThrow(/names shade group "1"/)
    expect(await run(office(), `UPDATE "Hide" SET "gradeId" = NULL, "shadeGroupId" = NULL WHERE id = $1::uuid`, hide1())).toBe(1)
    expect(await run(office(), `UPDATE "Hide" SET shade = 'Black 01' WHERE id = $1::uuid`, hide1())).toBe(1)
  })

  it('takes a group of its own article, lot and colour', async () => {
    await expect(run(office(), `UPDATE "Hide" SET "shadeGroupId" = $1::uuid, shade = '1' WHERE id = $2::uuid`, seeded.shadeGroupIds.lining, hide2())).rejects.toThrow(/own article and lot/)
    const otherLot = randomUUID()
    await copyRow(office(), 'Lot', seeded.leatherLotId, { id: otherLot, code: tag('T-LOT'), receiptLineId: null })
    const group = randomUUID()
    await copyRow(office(), 'ShadeGroup', seeded.shadeGroupIds.lot, { id: group, lotId: otherLot, label: tag('S') })
    await expect(run(office(), `UPDATE "Hide" SET "shadeGroupId" = $1::uuid, shade = 'x' WHERE id = $2::uuid`, group, hide2())).rejects.toThrow(/own article and lot/)
    const red = randomUUID()
    await copyRow(office(), 'ShadeGroup', seeded.shadeGroupIds.one, { id: red, itemColourId: key('product:item-colour:leather:RED'), label: tag('S') })
    await expect(run(office(), `UPDATE "Hide" SET "shadeGroupId" = $1::uuid, shade = 'x' WHERE id = $2::uuid`, red, hide2())).rejects.toThrow(/another colour/)
  })

  it('takes no retired grade or group, and keeps one it had', async () => {
    const grade = randomUUID()
    await copyRow(office(), 'LeatherGrade', seeded.gradeIds.D, { id: grade, code: 'RETIRED', active: false })
    await expect(run(office(), `UPDATE "Hide" SET "gradeId" = $1::uuid, grade = 'RETIRED' WHERE id = $2::uuid`, grade, hide2())).rejects.toThrow(/is retired/)
    const group = randomUUID()
    await copyRow(office(), 'ShadeGroup', seeded.shadeGroupIds.three, { id: group, label: 'old', active: false })
    await expect(run(office(), `UPDATE "Hide" SET "shadeGroupId" = $1::uuid, shade = 'old' WHERE id = $2::uuid`, group, hide2())).rejects.toThrow(/is retired/)
    await run(office(), `UPDATE "LeatherGrade" SET active = false WHERE id = $1::uuid`, seeded.gradeIds.B)
    expect(await run(office(), `UPDATE "Hide" SET defects = 'Still a B.' WHERE id = $1::uuid`, hide2())).toBe(1)
    await run(office(), `UPDATE "LeatherGrade" SET active = true WHERE id = $1::uuid`, seeded.gradeIds.B)
  })

  it('still never changes its tag or measured area, and freezes the record on a used-up hide', async () => {
    await expect(run(office(), `UPDATE "Hide" SET area = 1 WHERE id = $1::uuid`, hide2())).rejects.toThrow(/never change/)
    await expect(run(office(), `UPDATE "Hide" SET code = 'X' WHERE id = $1::uuid`, hide2())).rejects.toThrow(/never change/)
  })
})

describe('hide marks', () => {
  const copy = (changes: Record<string, unknown>, scope: FactoryScope = floor()) => copyRow(scope, 'HideMark', seeded.markIds.defect, { id: randomUUID(), ...changes })

  it('has a shape by kind, on the hide', async () => {
    await expect(copy({ x: 1.5 })).rejects.toThrow(/numeric field overflow|lies on the hide/)
    await expect(copy({ y: -0.1 })).rejects.toThrow(/lies on the hide/)
    await expect(copy({ defectCodeId: null })).rejects.toThrow(/a DEFECT has its code/)
    await expect(copy({ outline: [{ x: 0.1, y: 0.1 }] })).rejects.toThrow(/a DEFECT has its code and no outline/)
    await expect(copy({ kind: 'ZONE', zoneGradeId: null, defectCodeId: null })).rejects.toThrow(/a ZONE its grade/)
    await expect(copy({ kind: 'ZONE' })).rejects.toThrow(/a ZONE its grade and no defect code/)
    await expect(copy({ kind: 'ZONE', defectCodeId: null, outline: [{ x: 2, y: 0 }] })).rejects.toThrow(/lies on the hide/)
    await copy({ kind: 'ZONE', defectCodeId: null, outline: [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.2 }, { x: 0.2, y: 0.4 }] })
  })

  it('names a defect of the library in use and a grade in use', async () => {
    const [{ id: category } = {}] = await admin(`SELECT id::text AS id FROM "DefectCode" WHERE "tenantId" = $1 AND "parentId" IS NULL LIMIT 1`, [a.tenantId])
    await expect(copy({ defectCodeId: category })).rejects.toThrow(/not a category/)
    const grade = randomUUID()
    await copyRow(office(), 'LeatherGrade', seeded.gradeIds.D, { id: grade, code: tag('G'), active: false })
    await expect(copy({ zoneGradeId: grade })).rejects.toThrow(/retired grade/)
  })

  it('names an inspection of the hide\'s own lot', async () => {
    await expect(copy({ incomingInspectionId: UNKNOWN })).rejects.toThrow(/foreign key/i)
  })

  it('is withdrawn once, with who and why, from the floor too, and nothing else changes', async () => {
    const id = randomUUID()
    await copy({ id })
    await expect(run(floor(), `UPDATE "HideMark" SET x = 0.5 WHERE id = $1::uuid`, id)).rejects.toThrow(/never changes/)
    await expect(run(floor(), `UPDATE "HideMark" SET "voidedAt" = now() WHERE id = $1::uuid`, id)).rejects.toThrow(/when, by whom and why/)
    await expect(copy({ voidedAt: '2026-11-20T10:00:00.000Z', voidedById: UNKNOWN, voidReason: 'x' })).rejects.toThrow(/new; it is not withdrawn/)
    expect(await run(floor(), `UPDATE "HideMark" SET "voidedAt" = now(), "voidedById" = $1::uuid, "voidReason" = 'A fold' WHERE id = $2::uuid`, UNKNOWN, id)).toBe(1)
    await expect(run(floor(), `UPDATE "HideMark" SET "voidReason" = 'Another' WHERE id = $1::uuid`, id)).rejects.toThrow(/withdrawn already/)
    await expect(admin(`DELETE FROM "HideMark" WHERE id = $1`, [id])).rejects.toThrow(/never deleted/)
    await expect(admin('TRUNCATE "HideMark" CASCADE')).rejects.toThrow(/refused/)
  })
})

describe('hide measures', () => {
  const copy = (changes: Record<string, unknown>, scope: FactoryScope = office()) => copyRow(scope, 'HideMeasure', seeded.measureIds[2], { id: randomUUID(), ...changes })

  it('says who measured, exactly one person, in an area unit above 0', async () => {
    await expect(copy({ measuredById: null })).rejects.toThrow(/exactly one/)
    await expect(copy({ measuredByWorkerId: seeded.workerId })).rejects.toThrow(/exactly one/)
    await expect(copy({ measuredArea: 0 })).rejects.toThrow(/areas above 0/)
    await expect(copy({ declaredArea: 0 })).rejects.toThrow(/areas above 0/)
    await expect(copy({ areaUom: 'M' })).rejects.toThrow(/areas above 0/)
    await copy({ declaredArea: null })
    await copyRow(floor(), 'HideMeasure', seeded.measureIds[0], { id: randomUUID() })
  })

  it('is append-only for every login, and leaves the hide\'s area alone', async () => {
    const before = await admin(`SELECT area FROM "Hide" WHERE id = $1`, [seeded.hideIds[0]])
    await expect(admin(`UPDATE "HideMeasure" SET note = 'x' WHERE id = $1`, [seeded.measureIds[0]])).rejects.toThrow(/append-only/)
    await expect(admin(`DELETE FROM "HideMeasure" WHERE id = $1`, [seeded.measureIds[0]])).rejects.toThrow(/append-only/)
    await expect(admin('TRUNCATE "HideMeasure" CASCADE')).rejects.toThrow(/append-only/)
    expect(await admin(`SELECT area FROM "Hide" WHERE id = $1`, [seeded.hideIds[0]])).toEqual(before)
  })
})

describe('REMNANT moves', () => {
  it('enters one location, names its work order and is of a hide', async () => {
    const { cutting, bin } = seeded.locations
    await expect(remnantMove('1.0000', { fromLocationId: cutting, toLocationId: null })).rejects.toThrow(/only enter one/)
    await expect(remnantMove('1.0000', { fromLocationId: bin, toLocationId: cutting })).rejects.toThrow(/only enter one/)
    await expect(remnantMove('1.0000', { workOrderId: null })).rejects.toThrow(/without its work order/)
    await expect(copyRow(office(), 'StockMove', seeded.offcut.moveId, { id: randomUUID(), itemId: seeded.rollItemId, lotId: seeded.rollLotId, hideId: null, idempotencyKey: tag('t') })).rejects.toThrow(/without its hide/)
  })

  it('is bound to its work order as a RETURN is: never a DRAFT one, and one of its site', async () => {
    await expect(remnantMove('1.0000', { workOrderId: seeded.draftWorkOrderId })).rejects.toThrow(/is DRAFT/)
    await expect(remnantMove('1.0000', { workOrderId: UNKNOWN })).rejects.toThrow(/not a work order of its site/)
  })

  it('is reversed by its mirror and comes off what the work order holds of a hide', async () => {
    // A hide of the offcut article: 10 ft² issued to WO-0001, then cuts against what the work order holds.
    const hideId = randomUUID()
    await copyRow(office(), 'Hide', seeded.offcut.hideId, { id: hideId, code: tag('T-HIDE'), state: 'FULL', gradeId: null, grade: null })
    const opening = randomUUID()
    await copyRow(office(), 'StockMove', seeded.offcut.moveId, { id: opening, hideId, reason: 'OPENING', workOrderId: null, quantity: '10.0000', baseQuantity: '10.0000', toLocationId: seeded.locations.store, idempotencyKey: tag('t') })
    await copyRow(office(), 'StockMove', seeded.offcut.moveId, { id: randomUUID(), hideId, reason: 'ISSUE', quantity: '10.0000', baseQuantity: '10.0000', fromLocationId: seeded.locations.store, toLocationId: null, idempotencyKey: tag('t') })
    const cut = (area: string) =>
      copyRow(office(), 'CutLog', key('production:cut:H1:1'), { id: randomUUID(), lotId: seeded.offcut.lotId, hideId, areaUsed: area, baseAreaUsed: area, clientEventId: tag('t') })
    const back = await remnantMove('4.0000', { hideId })
    await expect(cut('7.0000')).rejects.toThrow(/a cut of 7\.0000 does not fit/)
    await cut('6.0000')
    await reverseMove(back)
    await expect(reverseMove(back)).rejects.toThrow(/never goes below zero/)
    await cut('4.0000')
  })

  it('takes its material off the work order in the cost ledger, as a RETURN does', async () => {
    const [entry] = await admin(`SELECT id::text AS id FROM "WorkOrderCostEntry" WHERE "tenantId" = $1 AND kind = 'MATERIAL' AND "reversalOfId" IS NULL ORDER BY id LIMIT 1`, [a.tenantId])
    const moveId = await remnantMove('2.0000')
    const changes = { id: randomUUID(), itemId: seeded.offcut.itemId, stockMoveId: moveId, workOrderId: seeded.workOrderId, idempotencyKey: tag('t') }
    await expect(copyRow(office(), 'WorkOrderCostEntry', String(entry!.id), { ...changes, quantity: '2.0000', amount: 100 })).rejects.toThrow(/a RETURN or REMNANT from it takes them off/)
    await copyRow(office(), 'WorkOrderCostEntry', String(entry!.id), { ...changes, quantity: '-2.0000', amount: -100 })
  })
})

describe('remnants', () => {
  it('names the live move that put it into stock, of its hide, at its place', async () => {
    const moveId = await remnantMove()
    const { store } = seeded.locations
    await expect(remnant(seeded.offcut.moveId.replace(/.$/, '0'))).rejects.toThrow(/foreign key/i)
    await expect(remnant(moveId, { locationId: store })).rejects.toThrow(/entering its place/)
    const [{ id: issue } = {}] = await admin(`SELECT id::text AS id FROM "StockMove" WHERE "tenantId" = $1 AND reason = 'ISSUE' LIMIT 1`, [a.tenantId])
    await expect(remnant(String(issue))).rejects.toThrow(/a REMNANT or RETURN of its hide/)
    const reversed = await remnantMove()
    await reverseMove(reversed)
    await expect(remnant(reversed)).rejects.toThrow(/was reversed/)
  })

  it('takes W1\'s RETURN for a remnant made before the REMNANT move', async () => {
    const hideId = randomUUID()
    await copyRow(office(), 'Hide', seeded.offcut.hideId, { id: hideId, code: tag('T-HIDE'), state: 'FULL', gradeId: null, grade: null })
    const moveId = await remnantMove('2.0000', { hideId, reason: 'RETURN' })
    await remnant(moveId, { hideId })
  })

  it('never tags more than the move brought back, floor or office', async () => {
    const moveId = await remnantMove('2.0000')
    await remnant(moveId, { area: '1.2000', baseArea: '1.2000' }, floor())
    await expect(remnant(moveId, { area: '1.0000', baseArea: '1.0000' })).rejects.toThrow(/does not fit/)
    await remnant(moveId, { area: '0.8000', baseArea: '0.8000' }, floor())
  })

  it('has a tag, an area and, in stock, a place; it starts IN_STOCK', async () => {
    const moveId = await remnantMove()
    await expect(remnant(moveId, { area: 0 })).rejects.toThrow(/area above 0/)
    await expect(remnant(moveId, { areaUom: 'M' })).rejects.toThrow(/area above 0/)
    await expect(remnant(moveId, { code: 'a b' })).rejects.toThrow(/tag without spaces/)
    await expect(remnant(moveId, { area: '2.0000' })).rejects.toThrow(/its area is its base area/)
    await expect(remnant(moveId, { state: 'USED' })).rejects.toThrow(/starts IN_STOCK/)
    const id = await remnant(moveId)
    await expect(run(office(), `UPDATE "Remnant" SET "locationId" = NULL WHERE id = $1::uuid`, id)).rejects.toThrow(/says where it lies/)
    await expect(remnant(moveId, { locationId: null })).rejects.toThrow(/says where it lies/)
  })

  it('takes no archived place', async () => {
    const id = await remnant(await remnantMove())
    const place = randomUUID()
    await copyRow(office(), 'Location', seeded.locations.store, { id: place, code: tag('T-LOC'), status: 'ARCHIVED', parentId: null })
    await expect(run(office(), `UPDATE "Remnant" SET "locationId" = $1::uuid WHERE id = $2::uuid`, place, id)).rejects.toThrow(/is archived/)
  })

  it('walks its states and no others', async () => {
    const id = await remnant(await remnantMove())
    await expect(setRemnant(id, 'USED')).rejects.toThrow(/does not go from IN_STOCK to USED/)
    await setRemnant(id, 'ISSUED', ', "locationId" = NULL')
    await expect(setRemnant(id, 'SCRAPPED')).rejects.toThrow(/does not go from ISSUED to SCRAPPED/)
    await setRemnant(id, 'USED')
    await expect(setRemnant(id, 'IN_STOCK')).rejects.toThrow(/does not go from USED to IN_STOCK/)
    await setRemnant(id, 'ISSUED')
    await setRemnant(id, 'IN_STOCK', `, "locationId" = '${seeded.locations.bin}'`)
    await setRemnant(id, 'SCRAPPED')
    await setRemnant(id, 'IN_STOCK')
  })

  it('is VOID only once its move is reversed, and then frees the move and never changes', async () => {
    const moveId = await remnantMove('1.0000')
    const id = await remnant(moveId)
    await expect(setRemnant(id, 'VOID')).rejects.toThrow(/only once the move/)
    await reverseMove(moveId)
    await setRemnant(id, 'VOID')
    await expect(run(office(), `UPDATE "Remnant" SET note = 'x' WHERE id = $1::uuid`, id)).rejects.toThrow(/VOID; it never changes/)
  })

  it('fixes its tag, hide, area and move, and is never deleted', async () => {
    const id = seeded.remnantIds[1]
    await expect(run(office(), `UPDATE "Remnant" SET code = 'X' WHERE id = $1::uuid`, id)).rejects.toThrow(/never change/)
    await expect(run(office(), `UPDATE "Remnant" SET area = 1 WHERE id = $1::uuid`, id)).rejects.toThrow(/never change/)
    await expect(admin(`DELETE FROM "Remnant" WHERE id = $1`, [id])).rejects.toThrow(/never deleted/)
    await expect(admin('TRUNCATE "Remnant" CASCADE')).rejects.toThrow(/refused/)
    expect(await run(floor(), `UPDATE "Remnant" SET "gradeId" = $1::uuid, note = 'Graded again' WHERE id = $2::uuid`, seeded.gradeIds.A, id)).toBe(1)
  })
})

describe('fabric rolls', () => {
  const copy = (changes: Record<string, unknown>, scope: FactoryScope = floor()) => copyRow(scope, 'FabricRoll', seeded.rollIds.full, { id: randomUUID(), code: tag('T-RL'), ...changes })
  const set = (id: string, columns: string, ...values: unknown[]) => run(office(), `UPDATE "FabricRoll" SET ${columns} WHERE id = $${values.length + 1}::uuid`, ...values, id)

  it('is a part of a lot of an item tracked by LOT, with a length in a length unit', async () => {
    await expect(copy({ itemId: seeded.offcut.itemId, lotId: seeded.offcut.lotId })).rejects.toThrow(/tracked by HIDE/)
    await expect(copy({ length: 0, lengthLeft: 0, state: 'CONSUMED' })).rejects.toThrow(/length above 0/)
    await expect(copy({ uom: 'FT2' })).rejects.toThrow(/length above 0/)
    await expect(copy({ lengthLeft: '61.0000' })).rejects.toThrow(/from 0 to it/)
    await expect(copy({ code: 'a b' })).rejects.toThrow(/tag without spaces/)
    await expect(copy({ widthCm: 0 })).rejects.toThrow(/width above 0/)
    await expect(copy({ shrinkageLengthPercent: '101.00' })).rejects.toThrow(/shrinkage from 0 to 100/)
  })

  it('says with its state what its length left says', async () => {
    const id = randomUUID()
    await copy({ id })
    await expect(set(id, `"lengthLeft" = 10`)).rejects.toThrow(/is FULL with/)
    await expect(set(id, `state = 'PARTIAL'`)).rejects.toThrow(/is PARTIAL with/)
    expect(await set(id, `state = 'PARTIAL', "lengthLeft" = 10`)).toBe(1)
    expect(await set(id, `state = 'END', "lengthLeft" = 2`)).toBe(1)
    await expect(set(id, `state = 'CONSUMED'`)).rejects.toThrow(/is CONSUMED with/)
    expect(await set(id, `state = 'CONSUMED', "lengthLeft" = 0`)).toBe(1)
    expect(await set(id, `state = 'PARTIAL', "lengthLeft" = 2`)).toBe(1)
    expect(await set(id, `state = 'SCRAPPED'`)).toBe(1)
  })

  it('takes a shade group of its article, with the text saying the same', async () => {
    const { lining, one } = seeded.shadeGroupIds
    await expect(copy({ shadeGroupId: one, shade: '1' })).rejects.toThrow(/own article and lot/)
    await expect(copy({ shadeGroupId: lining, shade: '2' })).rejects.toThrow(/names shade group "1"/)
    await copy({ shadeGroupId: lining, shade: '1' })
  })

  it('fixes its tag, lot and length, takes no archived place, and is never deleted', async () => {
    const id = seeded.rollIds.partial
    await expect(set(id, `code = 'X'`)).rejects.toThrow(/never change/)
    await expect(set(id, `length = 70`)).rejects.toThrow(/never change/)
    const place = randomUUID()
    await copyRow(office(), 'Location', seeded.locations.store, { id: place, code: tag('T-LOC'), status: 'ARCHIVED', parentId: null })
    await expect(set(id, `"locationId" = $1::uuid`, place)).rejects.toThrow(/is archived/)
    await expect(admin(`DELETE FROM "FabricRoll" WHERE id = $1`, [id])).rejects.toThrow(/never deleted/)
    await expect(admin('TRUNCATE "FabricRoll" CASCADE')).rejects.toThrow(/refused/)
    expect(await set(id, `"widthCm" = 143`)).toBe(1)
  })
})

describe('protector lots', () => {
  const copy = (changes: Record<string, unknown>, scope: FactoryScope = floor()) => copyRow(scope, 'GarmentProtectorLot', seeded.protector.batchRowId, { id: randomUUID(), ...changes })

  it('is a protector, in a batch or one of its serials', async () => {
    await expect(copy({ itemId: seeded.rollItemId, lotId: seeded.rollLotId })).rejects.toThrow(/no protector/)
    await expect(copy({ workOrderId: seeded.draftWorkOrderId })).rejects.toThrow(/is DRAFT; nothing was built/)
    await expect(copy({ garmentSerialId: seeded.serialId })).rejects.toThrow(/foreign key/i)
    await expect(copy({ placement: ' ' })).rejects.toThrow(/placement in words/)
    await copy({ workOrderId: seeded.serialWorkOrderId, garmentSerialId: seeded.serialId })
  })

  it('records a lot held after the fact: its status is no condition', async () => {
    await run(office(), `UPDATE "Lot" SET "qualityStatus" = 'BLOCKED', version = version + 1 WHERE id = $1::uuid`, seeded.protector.lotId)
    await copy({})
    await run(office(), `UPDATE "Lot" SET "qualityStatus" = 'RELEASED', version = version + 1 WHERE id = $1::uuid`, seeded.protector.lotId)
  })

  it('finds the garments of a protector lot, batches and serials, live rows only', async () => {
    const rows = await sql(office(), `SELECT "workOrderId"::text AS "workOrderId", "garmentSerialId"::text AS serial FROM "GarmentProtectorLot" WHERE "lotId" = $1::uuid AND "voidedAt" IS NULL`, seeded.protector.lotId)
    expect(rows).toContainEqual({ workOrderId: seeded.workOrderId, serial: null })
    expect(rows).toContainEqual({ workOrderId: seeded.serialWorkOrderId, serial: seeded.serialId })
  })

  it('is withdrawn by the office, once, and nothing else changes', async () => {
    const id = randomUUID()
    await copy({ id })
    await expect(run(office(), `UPDATE "GarmentProtectorLot" SET placement = 'elbow' WHERE id = $1::uuid`, id)).rejects.toThrow(/never changes/)
    await expect(run(office(), `UPDATE "GarmentProtectorLot" SET "voidReason" = 'x' WHERE id = $1::uuid`, id)).rejects.toThrow(/when, by whom and why/)
    expect(await run(office(), `UPDATE "GarmentProtectorLot" SET "voidedAt" = now(), "voidedById" = $1::uuid, "voidReason" = 'Wrong lot' WHERE id = $2::uuid`, UNKNOWN, id)).toBe(1)
    await expect(run(office(), `UPDATE "GarmentProtectorLot" SET "voidReason" = 'Other' WHERE id = $1::uuid`, id)).rejects.toThrow(/withdrawn already/)
    await expect(admin(`DELETE FROM "GarmentProtectorLot" WHERE id = $1`, [id])).rejects.toThrow(/never deleted/)
    await expect(admin('TRUNCATE "GarmentProtectorLot" CASCADE')).rejects.toThrow(/refused/)
  })
})

describe('consumables by pack', () => {
  it('has a pack size above 0 and its unit, both or neither', async () => {
    const id = seeded.threadItemId
    await expect(run(office(), `UPDATE "Item" SET "packUom" = NULL WHERE id = $1::uuid`, id)).rejects.toThrow(/both or neither/)
    await expect(run(office(), `UPDATE "Item" SET "packSize" = 0 WHERE id = $1::uuid`, id)).rejects.toThrow(/both or neither/)
    expect(await run(office(), `UPDATE "Item" SET "packSize" = NULL, "packUom" = NULL WHERE id = $1::uuid`, id)).toBe(1)
    expect(await run(office(), `UPDATE "Item" SET "packSize" = 2500, "packUom" = 'CONE' WHERE id = $1::uuid`, id)).toBe(1)
  })
})

describe('numbering', () => {
  it.each(['ROLL', 'REMNANT'])('makes %s a scan-id kind: a block, never a series', async (kind) => {
    const [series] = await admin(`SELECT id::text AS id FROM "NumberSeries" WHERE "tenantId" = $1 ORDER BY id LIMIT 1`, [a.tenantId])
    await expect(copyRow(office(), 'NumberSeries', String(series!.id), { id: randomUUID(), kind, code: 'SCAN', scopeKey: 'ALL', reset: 'NEVER', fiscal: false })).rejects.toThrow(/is a scan-id kind/)
    const [{ n }] = (await admin(`SELECT count(*)::int AS n FROM "NumberBlock" WHERE "tenantId" = $1 AND kind = $2::"NumberKind"`, [a.tenantId, kind])) as [{ n: number }]
    expect(n).toBeGreaterThan(0)
  })
})
