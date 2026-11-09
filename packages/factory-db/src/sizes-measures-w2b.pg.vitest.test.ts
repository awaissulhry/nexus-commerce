import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedSizesDepth, type SizesDepthSeed } from '../seed/sizes-depth'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { classifiedModels } from './ownership'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'
import { loadOwnership, loadSchema } from './tools'

/**
 * Sizes, measurements and made-to-measure rules (W2b-4 schema wave 27/33, B-W2b-210, …_sizes_measures_w2b_guards) on a
 * database built from the migrations and seeded, through the real login and the scoped client:
 *   - grants: the office keeps it all; the floor reads the points of measure, specs and values, prepacks and protector
 *     placement, never a grade rule or a made-to-measure rule; the partner reads nothing;
 *   - a scale of one or two dimensions and the size's fit;
 *   - points of measure: a length, a garment point's body point, kind and unit fixed once named, the picture;
 *   - the measurement spec as a part of the revision: frozen once released, one live spec per revision, approved with its
 *     values and frozen until reopened, garment points only;
 *   - grade rules, prepacks, protector placement;
 *   - made-to-measure: template points of a body point with their limits, the plausibility rules, the base size rule, a BOM
 *     line's made-to-measure point, the rules built off.
 * The refusals are check_violation (SQLSTATE 23514); their messages are read through raw SQL.
 */

const NS = 'w2b-210-a'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let seed: SizesDepthSeed

const key = (name: string): string => seedUuid(NS, name)
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: a.actorId, siteId: key('site:A1') })
const partner = (): FactoryScope => ({ audience: 'partner', tenantId: a.tenantId, actorId: a.actorId, partyId: key('party:P1') })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
/** INSERT a copy of row `id` of `table` with `changes` (a jsonb object of columns), as the office. */
const copyRow = (table: string, id: string, changes: Record<string, unknown>) =>
  run(office(), `INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`, JSON.stringify(changes), id)
/** UPDATE row `id` of `table` with `changes`, as the office. */
const change = (table: string, id: string, changes: Record<string, unknown>) =>
  run(office(), `UPDATE "${table}" t SET (${Object.keys(changes).map((column) => `"${column}"`).join(', ')}) = (SELECT ${Object.keys(changes).map((column) => `r."${column}"`).join(', ')} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb) r) WHERE t.id = $2::uuid`, JSON.stringify(changes), id)
const ids = (rows: Record<string, unknown>[]): string[] => rows.map((row) => String(row.id)).sort()
const tag = (): string => randomUUID().slice(0, 8)
const UNIQUE = /Unique constraint|duplicate key/

/** A fresh DRAFT revision of SEED-JKT-01 (sizes 50, 52, 54; scale SEED-EU-JKT), with a fresh DRAFT spec (base 52). */
async function draftRevision(): Promise<{ revisionId: string; specId: string }> {
  const revisionId = randomUUID()
  await copyRow('StyleRevision', seed.jacket.revisionId, { id: revisionId, revision: Math.floor(Math.random() * 1_000_000) + 100, effectiveFrom: null })
  const specId = randomUUID()
  await copyRow('MeasurementSpec', seed.jacket.specId, { id: specId, revisionId })
  return { revisionId, specId }
}
/** A value of the spec (a copy of the seeded back length of 52). */
async function value(revisionId: string, specId: string, changes: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  await copyRow('MeasurementSpecValue', seed.specValueIds.back52, { id, revisionId, specId, ...changes })
  return id
}
const approve = (specId: string) => change('MeasurementSpec', specId, { status: 'APPROVED', approvedAt: new Date().toISOString(), approvedById: a.actorId })

beforeAll(async () => {
  db = await migratedDatabase('sizesmeasures')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  seed = await seedSizesDepth({ db: factory, namespace: NS })
}, 180_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('grants', () => {
  it('classifies the nine models of the file, none for the partner', () => {
    const models = classifiedModels(loadSchema(), loadOwnership()).filter(({ model }) => model.file === 'sizes-depth.prisma')
    expect(models.map(({ model }) => model.name).sort()).toEqual([
      'GradeRule',
      'GradeRuleStep',
      'MeasurementRule',
      'MeasurementSpec',
      'MeasurementSpecValue',
      'PointOfMeasure',
      'Prepack',
      'PrepackLine',
      'ProtectorPlacement',
    ])
    for (const { ownership } of models) expect(Object.keys(ownership.access)).not.toContain('factory_partner_runtime')
  })

  it('the floor reads points, specs, values, prepacks and protectors, never a grade rule or a made-to-measure rule', async () => {
    expect((await sql(floor(), 'SELECT id FROM "PointOfMeasure"')).length).toBe(10)
    expect(ids(await sql(floor(), 'SELECT id FROM "MeasurementSpec"'))).toEqual([seed.jacket.archivedSpecId, seed.jacket.specId, seed.trousers.specId].sort())
    expect((await sql(floor(), 'SELECT id FROM "MeasurementSpecValue"')).length).toBe(17)
    expect((await sql(floor(), 'SELECT id FROM "Prepack"')).length).toBe(4)
    expect((await sql(floor(), 'SELECT id FROM "PrepackLine"')).length).toBe(12)
    expect((await sql(floor(), 'SELECT id FROM "ProtectorPlacement"')).length).toBe(4)
    for (const table of ['GradeRule', 'GradeRuleStep', 'MeasurementRule']) await expect(sql(floor(), `SELECT id FROM "${table}"`)).rejects.toThrow(/permission denied/)
    await expect(run(floor(), `UPDATE "MeasurementSpecValue" SET nominal = 1 WHERE id = $1::uuid`, seed.specValueIds.back52)).rejects.toThrow(/permission denied/)
  })

  it('portal and link sessions read nothing here', async () => {
    for (const table of ['PointOfMeasure', 'MeasurementSpec', 'MeasurementSpecValue', 'GradeRule', 'GradeRuleStep', 'Prepack', 'PrepackLine', 'ProtectorPlacement', 'MeasurementRule']) {
      await expect(sql(partner(), `SELECT id FROM "${table}"`)).rejects.toThrow(/permission denied/)
    }
  })
})

describe('sizes and fits (PRD-049)', () => {
  it('a size has a fit exactly when its scale has two dimensions', async () => {
    expect(await admin(`SELECT code, "fitCode" AS fit FROM "Size" WHERE "scaleId" = $1 ORDER BY seq`, [seed.fitScaleId])).toEqual([
      { code: '50R', fit: 'R' },
      { code: '50L', fit: 'L' },
      { code: '52R', fit: 'R' },
      { code: '52L', fit: 'L' },
    ])
    const size = (scaleId: string, fitCode: string | null) => copyRow('Size', seed.fitSizeIds['52L'], { id: randomUUID(), scaleId, code: `T${tag()}`, fitCode })
    await expect(size(seed.fitScaleId, null)).rejects.toThrow(/has a fit exactly when its scale has two dimensions/)
    await expect(size(seed.jacketScaleId, 'L')).rejects.toThrow(/has a fit exactly when its scale has two dimensions/)
    await expect(size(seed.fitScaleId, 'X L')).rejects.toThrow(/1 to 10 letters or digits/)
    expect(await size(seed.fitScaleId, 'XL')).toBe(1)
    expect(await size(seed.jacketScaleId, null)).toBe(1)
  })

  it('a scale has one or two dimensions, changed only while it has no size', async () => {
    await expect(change('SizeScale', seed.fitScaleId, { dimensions: 1 })).rejects.toThrow(/change only while it has no size/)
    const scaleId = randomUUID()
    await expect(copyRow('SizeScale', seed.fitScaleId, { id: scaleId, code: `T-SC-${tag()}`, dimensions: 3 })).rejects.toThrow(/has 1 dimension, or 2/)
    expect(await copyRow('SizeScale', seed.fitScaleId, { id: scaleId, code: `T-SC-${tag()}`, dimensions: 1 })).toBe(1)
    expect(await change('SizeScale', scaleId, { dimensions: 2 })).toBe(1)
  })
})

describe('points of measure (PRD-062, PRD-069)', () => {
  const fresh = (changes: Record<string, unknown>) => copyRow('PointOfMeasure', seed.pointIds.backLen, { id: randomUUID(), code: `T-POM-${tag()}`, pictureFileId: null, ...changes })

  it('is a length with a code, words per language and a tolerance of 0 or more', async () => {
    await expect(fresh({ uom: 'M' })).rejects.toThrow(/is a length, in CM or MM/)
    await expect(fresh({ code: 'BACK LEN' })).rejects.toThrow(/has no spaces/)
    await expect(fresh({ nameI18n: { it: ' ' } })).rejects.toThrow(/per language/)
    await expect(fresh({ defaultTolerance: '-0.50' })).rejects.toThrow(/default tolerance .* is 0 or more/)
    expect(await fresh({ uom: 'MM', defaultTolerance: '3.00' })).toBe(1)
  })

  it('only a garment point names its body point: a BODY one, never itself', async () => {
    await expect(fresh({ kind: 'BODY', bodyPointId: seed.pointIds.chest })).rejects.toThrow(/only a GARMENT point of measure names its body point/)
    await expect(fresh({ bodyPointId: seed.pointIds.chestW })).rejects.toThrow(/the body point of point of measure .* is a BODY point/)
    const id = randomUUID()
    await expect(copyRow('PointOfMeasure', seed.pointIds.backLen, { id, code: `T-POM-${tag()}`, pictureFileId: null, bodyPointId: id })).rejects.toThrow(/never itself/)
    expect(await fresh({ bodyPointId: seed.pointIds.chest })).toBe(1)
  })

  it('its kind and unit change only while nothing names it; its company never', async () => {
    // The garment chest width: spec values name it; the body chest: a template point and a garment point name it.
    await expect(change('PointOfMeasure', seed.pointIds.chestW, { uom: 'MM' })).rejects.toThrow(/is in use .* its kind and unit never change/)
    await expect(change('PointOfMeasure', seed.pointIds.chest, { kind: 'GARMENT' })).rejects.toThrow(/is in use/)
    await expect(change('PointOfMeasure', seed.pointIds.chest, { companyId: key('company:A') })).rejects.toThrow(/company and creation of point of measure .* never change/)
    const id = randomUUID()
    await copyRow('PointOfMeasure', seed.pointIds.backLen, { id, code: `T-POM-${tag()}`, pictureFileId: null })
    expect(await change('PointOfMeasure', id, { kind: 'BODY', uom: 'MM' })).toBe(1)
    // Words and status change freely.
    expect(await change('PointOfMeasure', seed.pointIds.chestW, { name: 'Chest width (flat)', status: 'ARCHIVED' })).toBe(1)
    expect(await change('PointOfMeasure', seed.pointIds.chestW, { name: 'Chest width', status: 'ACTIVE' })).toBe(1)
  })

  it('its picture is an available photo of the point', async () => {
    expect(await admin(`SELECT "pictureFileId" AS file FROM "PointOfMeasure" WHERE id = $1`, [seed.pointIds.backLen])).toEqual([{ file: seed.pictureFileId }])
    await expect(change('PointOfMeasure', seed.pointIds.sleeveLen, { pictureFileId: seed.pictureFileId })).rejects.toThrow(/is an AVAILABLE photo of the point/)
  })
})

describe('the measurement spec (PRD-063, PRD-052)', () => {
  it('is a part of its revision: frozen once released, with its values and the protector placement', async () => {
    const { revisionId, styleId, specId } = seed.trousers
    await expect(copyRow('MeasurementSpec', specId, { id: randomUUID(), status: 'ARCHIVED' })).rejects.toThrow(/its "MeasurementSpec" rows never change/)
    await expect(change('MeasurementSpec', specId, { status: 'DRAFT', approvedAt: null, approvedById: null })).rejects.toThrow(/its "MeasurementSpec" rows never change/)
    await expect(change('MeasurementSpecValue', seed.specValueIds.released, { nominal: '82.00' })).rejects.toThrow(/its "MeasurementSpecValue" rows never change/)
    await expect(run(office(), `DELETE FROM "ProtectorPlacement" WHERE id = $1::uuid`, seed.placementIds.knee)).rejects.toThrow(/its "ProtectorPlacement" rows never change/)
    expect(await admin(`SELECT status::text FROM "StyleRevision" WHERE id = $1 AND "styleId" = $2`, [revisionId, styleId])).toEqual([{ status: 'RELEASED' }])
  })

  it("one live spec per revision; its base size is one of the style's sizes; its grade rule of the style's scale", async () => {
    await expect(copyRow('MeasurementSpec', seed.jacket.specId, { id: randomUUID() })).rejects.toThrow(/MeasurementSpec_one_live_per_revision|Unique constraint|duplicate key/)
    const { revisionId } = await draftRevision()
    await expect(copyRow('MeasurementSpec', seed.jacket.archivedSpecId, { id: randomUUID(), revisionId, baseSize: '56' })).rejects.toThrow(/base size 56 of measurement spec .* is one of the style's sizes \(50, 52, 54\)/)
    await expect(copyRow('MeasurementSpec', seed.jacket.archivedSpecId, { id: randomUUID(), revisionId, gradeRuleId: seed.gradeRuleIds.trousers })).rejects.toThrow(/grade rule of measurement spec .* of the style's size scale/)
    // An archived spec is kept beside the live one.
    expect(await copyRow('MeasurementSpec', seed.jacket.archivedSpecId, { id: randomUUID(), revisionId })).toBe(1)
  })

  it('a value: a garment point, a size code, a nominal above 0, tolerances of 0 or more; its cell fixed', async () => {
    const { revisionId, specId } = await draftRevision()
    await expect(value(revisionId, specId, { pointOfMeasureId: seed.pointIds.chest })).rejects.toThrow(/measures the garment: point of measure .* is a BODY point/)
    await expect(value(revisionId, specId, { size: '5 2' })).rejects.toThrow(/size code without spaces/)
    await expect(value(revisionId, specId, { nominal: '0' })).rejects.toThrow(/nominal above 0 and tolerances of 0 or more/)
    await expect(value(revisionId, specId, { tolerancePlus: '-1' })).rejects.toThrow(/nominal above 0 and tolerances of 0 or more/)
    await expect(value(revisionId, specId, { seq: 0 })).rejects.toThrow(/counts from 1/)
    const id = await value(revisionId, specId)
    await expect(value(revisionId, specId)).rejects.toThrow(UNIQUE)
    await expect(change('MeasurementSpecValue', id, { size: '54' })).rejects.toThrow(/keeps its spec, point of measure, size and creation/)
    expect(await change('MeasurementSpecValue', id, { nominal: '73.50', source: 'TYPED' })).toBe(1)
  })

  it("is approved with its values (of the style's sizes, every point at the base size), frozen until reopened, archived for good", async () => {
    const { revisionId, specId } = await draftRevision()
    await expect(approve(specId)).rejects.toThrow(/approved with at least one value/)
    const odd = await value(revisionId, specId, { size: '58' })
    await expect(approve(specId)).rejects.toThrow(/every value is of one of the style's sizes \(50, 52, 54\): 58 is not/)
    await run(office(), `DELETE FROM "MeasurementSpecValue" WHERE id = $1::uuid`, odd)
    await value(revisionId, specId, { pointOfMeasureId: seed.pointIds.sleeveLen, size: '54', seq: 3 })
    await expect(approve(specId)).rejects.toThrow(/every point has a value for its base size 52/)
    const base = await value(revisionId, specId, { pointOfMeasureId: seed.pointIds.sleeveLen, size: '52', seq: 3 })
    await expect(change('MeasurementSpec', specId, { status: 'APPROVED' })).rejects.toThrow(/names who approved it and when while APPROVED/)
    expect(await approve(specId)).toBe(1)
    // Approved: its values and columns are frozen.
    await expect(change('MeasurementSpecValue', base, { nominal: '64.50' })).rejects.toThrow(/is APPROVED: its values change only while it is DRAFT/)
    await expect(value(revisionId, specId)).rejects.toThrow(/is APPROVED: its values change only while it is DRAFT/)
    await expect(run(office(), `DELETE FROM "MeasurementSpecValue" WHERE id = $1::uuid`, base)).rejects.toThrow(/is approved: its values change only while it is DRAFT/)
    await expect(change('MeasurementSpec', specId, { baseSize: '50' })).rejects.toThrow(/is approved; reopen it/)
    // Reopened (the approval cleared), changed, archived: an archived spec never changes or comes back.
    await expect(change('MeasurementSpec', specId, { status: 'DRAFT' })).rejects.toThrow(/nobody while DRAFT/)
    expect(await change('MeasurementSpec', specId, { status: 'DRAFT', approvedAt: null, approvedById: null })).toBe(1)
    expect(await change('MeasurementSpecValue', base, { nominal: '64.50' })).toBe(1)
    expect(await change('MeasurementSpec', specId, { status: 'ARCHIVED' })).toBe(1)
    await expect(change('MeasurementSpec', specId, { status: 'DRAFT' })).rejects.toThrow(/is archived; it never changes/)
    await expect(change('MeasurementSpecValue', base, { nominal: '65.00' })).rejects.toThrow(/is ARCHIVED: its values change only while it is DRAFT/)
    // A new live spec of the revision, now that the old one is archived.
    expect(await copyRow('MeasurementSpec', seed.jacket.specId, { id: randomUUID(), revisionId })).toBe(1)
  })

  it("a draft revision is abandoned with its specs: their values go first, an archived spec's too", async () => {
    const { revisionId, specId } = await draftRevision()
    const id = await value(revisionId, specId)
    expect(await change('MeasurementSpec', specId, { status: 'ARCHIVED' })).toBe(1)
    expect(await run(office(), `DELETE FROM "MeasurementSpecValue" WHERE id = $1::uuid`, id)).toBe(1)
    expect(await run(office(), `DELETE FROM "MeasurementSpec" WHERE id = $1::uuid`, specId)).toBe(1)
    // The office never deletes a revision; the owner may remove the unused draft now.
    expect((await db.admin.query(`DELETE FROM "StyleRevision" WHERE id = $1::uuid`, [revisionId])).rowCount).toBe(1)
  })
})

describe('grade rules (PRD-051)', () => {
  it('a rule starts from a size of its scale, and keeps its scale and company', async () => {
    const copy = (changes: Record<string, unknown>) => copyRow('GradeRule', seed.gradeRuleIds.jacket, { id: randomUUID(), code: `T-GR-${tag()}`, ...changes })
    await expect(copy({ baseSize: '58' })).rejects.toThrow(/base size 58 of grade rule .* is a size of its scale/)
    await expect(copy({ code: 'T GR' })).rejects.toThrow(/code without spaces/)
    expect(await copy({ baseSize: '48', format: 'ABSOLUTE' })).toBe(1)
    await expect(change('GradeRule', seed.gradeRuleIds.jacket, { sizeScaleId: seed.fitScaleId, baseSize: '52R' })).rejects.toThrow(/company, size scale and creation of grade rule .* never change/)
    await expect(change('GradeRule', seed.gradeRuleIds.jacket, { baseSize: '57' })).rejects.toThrow(/is a size of its scale/)
  })

  it('a step names both sizes or neither; one standard increment per point', async () => {
    const step = (changes: Record<string, unknown>) => copyRow('GradeRuleStep', seed.gradeStepIds.back52to54, { id: randomUUID(), ...changes })
    await expect(step({ fromSize: null })).rejects.toThrow(/names both sizes \(from, to\), or neither/)
    await expect(step({ fromSize: '54', toSize: '54' })).rejects.toThrow(/from one size code to another/)
    await expect(step({ fromSize: null, toSize: null, pointOfMeasureId: seed.pointIds.chestW })).rejects.toThrow(/GradeRuleStep_one_standard_per_point|Unique constraint|duplicate key/)
    expect(await step({ fromSize: null, toSize: null, increment: '-0.25' })).toBe(1)
    await expect(change('GradeRuleStep', seed.gradeStepIds.back50to52, { pointOfMeasureId: seed.pointIds.chestW })).rejects.toThrow(/keeps its rule, point of measure and creation/)
    expect(await change('GradeRuleStep', seed.gradeStepIds.back50to52, { increment: '1.50' })).toBe(1)
  })
})

describe('prepacks (PRD-055)', () => {
  it("a style's prepack is of its scale; a line names a colourway of the prepack's style; one line per size", async () => {
    await expect(copyRow('Prepack', seed.prepackIds.jacket, { id: randomUUID(), code: `T-PP-${tag()}`, sizeScaleId: seed.fitScaleId })).rejects.toThrow(/of a style is of the style's size scale/)
    const line = (changes: Record<string, unknown>) => copyRow('PrepackLine', seed.prepackLineIds.colourBlk, { id: randomUUID(), ...changes })
    await expect(line({ prepackId: seed.prepackIds.scale, size: '48' })).rejects.toThrow(/one of its prepack's style \(a size scale's prepack names none\)/)
    await expect(line({ styleId: null, size: '50' })).rejects.toThrow(/names a colourway with its style, or neither/)
    await expect(line({ quantity: 0, size: '50' })).rejects.toThrow(/has 1 to 10 000 pieces/)
    await expect(line({})).rejects.toThrow(UNIQUE)
    await expect(copyRow('PrepackLine', seed.prepackLineIds.jacket50, { id: randomUUID() })).rejects.toThrow(/PrepackLine_one_per_size|Unique constraint|duplicate key/)
    expect(await line({ size: '54' })).toBe(1)
    expect(await change('PrepackLine', seed.prepackLineIds.jacket50, { quantity: 3 })).toBe(1)
    await expect(change('PrepackLine', seed.prepackLineIds.jacket50, { size: '48' })).rejects.toThrow(/keeps its prepack, size, colourway and creation/)
  })

  it("an archived prepack's lines never change", async () => {
    await expect(change('PrepackLine', seed.prepackLineIds.archived50, { quantity: 2 })).rejects.toThrow(/is ARCHIVED: its lines never change/)
    await expect(run(office(), `DELETE FROM "PrepackLine" WHERE id = $1::uuid`, seed.prepackLineIds.archived50)).rejects.toThrow(/is ARCHIVED: its lines never change/)
    await expect(copyRow('PrepackLine', seed.prepackLineIds.archived50, { id: randomUUID(), size: '54' })).rejects.toThrow(/is ARCHIVED: its lines never change/)
    await expect(change('Prepack', seed.prepackIds.archived, { styleId: null })).rejects.toThrow(/size scale, style and creation of prepack .* never change/)
  })
})

describe('protector placement (PRD-074)', () => {
  it("a protector in a pocket, for some of the style's sizes, frozen with its revision", async () => {
    const { revisionId } = await draftRevision()
    const place = (changes: Record<string, unknown>) => copyRow('ProtectorPlacement', seed.placementIds.shoulder, { id: randomUUID(), revisionId, ...changes })
    await expect(place({ protectorItemId: key('product:item:leather') })).rejects.toThrow(/names a PROTECTOR material, not a LEATHER one/)
    await expect(place({ level: '3' })).rejects.toThrow(/the level "1" or "2"/)
    await expect(place({ sizes: ['52', '52'] })).rejects.toThrow(/names each size once/)
    await expect(place({ sizes: ['56'] })).rejects.toThrow(/for the style's sizes \(50, 52, 54\): 56 is not one/)
    await expect(place({ seq: 0 })).rejects.toThrow(/counts from 1/)
    const id = randomUUID()
    expect(await copyRow('ProtectorPlacement', seed.placementIds.shoulder, { id, revisionId, sizes: ['54'] })).toBe(1)
    expect(await change('ProtectorPlacement', id, { level: '1', positionNote: 'Lower by 1 cm.' })).toBe(1)
    // Released: frozen with the revision.
    expect(await run(office(), `UPDATE "StyleRevision" SET status = 'RELEASED', "releasedAt" = now(), "releasedById" = $1::uuid WHERE id = $2::uuid`, a.actorId, revisionId)).toBe(1)
    await expect(change('ProtectorPlacement', id, { level: '2' })).rejects.toThrow(/its "ProtectorPlacement" rows never change/)
    await expect(place({ seq: 9 })).rejects.toThrow(/its "ProtectorPlacement" rows never change/)
  })
})

describe('made-to-measure (PRD-201, PRD-202, PRD-203, PRD-204)', () => {
  it('the rules are built off', async () => {
    expect(await admin(`SELECT code, "rulesOn" FROM "MeasurementTemplate" WHERE "tenantId" = $1 ORDER BY code`, [a.tenantId])).toEqual([
      { code: 'JACKET', rulesOn: false },
      { code: 'TROUSERS', rulesOn: false },
    ])
  })

  it('a template point takes a BODY point of measure in its unit; its limits are 0 or more', async () => {
    const point = seed.templatePointIds.trousersWaist
    await expect(change('MeasurementPoint', point, { pointOfMeasureId: seed.pointIds.waistW })).rejects.toThrow(/takes a BODY point of measure in its own unit/)
    await expect(change('MeasurementPoint', point, { uom: 'MM' })).rejects.toThrow(/takes a BODY point of measure in its own unit \(MM\)/)
    await expect(change('MeasurementPoint', point, { alterationPlus: '-1.00' })).rejects.toThrow(/tolerance and alteration limits .* are 0 or more/)
    expect(await change('MeasurementPoint', point, { alterationMinus: '3.00', alterationPlus: '5.00' })).toBe(1)
    // W1's columns, as B-W2b-171 reads them, still change.
    expect(await change('MeasurementPoint', point, { howTo: 'Around the natural waist, relaxed.', required: false })).toBe(1)
  })

  it('a plausibility rule: ORDER of two points of one unit, RATIO between factors, RANGE of one point, words per language', async () => {
    const rule = (changes: Record<string, unknown>) => copyRow('MeasurementRule', seed.ruleIds.inseam, { id: randomUUID(), code: `T-R-${tag()}`, ...changes })
    await expect(rule({ minFactor: '1.0000' })).rejects.toThrow(/ORDER rule .* no factor or value/)
    await expect(rule({ otherPointId: seed.templatePointIds.inseam })).rejects.toThrow(/compares two different points/)
    await expect(rule({ kind: 'RATIO' })).rejects.toThrow(/RATIO rule .* at least one factor above 0/)
    await expect(rule({ kind: 'RATIO', minFactor: '0.9000', maxFactor: '0.8000' })).rejects.toThrow(/RATIO rule .*\(the smallest first\)/)
    await expect(rule({ kind: 'RANGE', minValue: '60.00' })).rejects.toThrow(/RANGE rule .* names one point/)
    await expect(rule({ kind: 'RANGE', otherPointId: null })).rejects.toThrow(/RANGE rule .* at least one value/)
    await expect(rule({ messageI18n: { it: '' } })).rejects.toThrow(/says what is wrong per language/)
    await expect(rule({ code: 'A B' })).rejects.toThrow(/has no spaces/)
    await expect(rule({ otherPointId: seed.templatePointIds.chest })).rejects.toThrow(/violates foreign key|Foreign key/)
    expect(await rule({ kind: 'RATIO', maxFactor: '0.9000', severity: 'WARN' })).toBe(1)
    expect(await rule({ kind: 'RANGE', otherPointId: null, maxValue: '100.00' })).toBe(1)
    // An ORDER rule between a centimetre and a millimetre point is refused.
    const mm = randomUUID()
    await copyRow('MeasurementPoint', seed.templatePointIds.inseam, { id: mm, code: `t-${tag()}`, uom: 'MM', pointOfMeasureId: null })
    await expect(rule({ otherPointId: mm })).rejects.toThrow(/compares two points of one unit \(CM and MM\)/)
  })

  it("the base size rule names 1 to 10 of the template's points and breaks a tie LARGER or SMALLER", async () => {
    const template = seed.templateIds.jacket
    const setRule = (rule: unknown) => change('MeasurementTemplate', template, { baseSizeRule: rule })
    expect(await admin(`SELECT "baseSizeRule" AS rule FROM "MeasurementTemplate" WHERE id = $1`, [template])).toEqual([{ rule: { points: ['chest'], tie: 'LARGER' } }])
    await expect(setRule({ points: ['height'] })).rejects.toThrow(/names height, which is not a point of the template/)
    await expect(setRule({ points: [] })).rejects.toThrow(/names 1 to 10 point codes/)
    await expect(setRule({ points: ['chest', 'chest'] })).rejects.toThrow(/names each point once/)
    await expect(setRule({ points: ['chest'], tie: 'MIDDLE' })).rejects.toThrow(/breaks a tie with "LARGER" or "SMALLER"/)
    await expect(setRule({ points: ['chest'], weight: 2 })).rejects.toThrow(/has only "points" and "tie"/)
    await expect(setRule(['chest'])).rejects.toThrow(/is an object/)
    expect(await setRule({ points: ['chest', 'waist'], tie: 'SMALLER' })).toBe(1)
    expect(await setRule({ points: ['chest'], tie: 'LARGER' })).toBe(1)
  })

  it("a BOM line's quantity follows a point of its style's template, with a factor above 0 and at most 10", async () => {
    const line = seed.bomLineIds.lining
    expect(await admin(`SELECT "mtmScaleFactor"::text AS factor FROM "BomLine" WHERE id = $1`, [seed.bomLineIds.leather])).toEqual([{ factor: '1.0000' }])
    await expect(change('BomLine', line, { mtmScalePointId: null })).rejects.toThrow(/names its made-to-measure point with its factor, or neither/)
    await expect(change('BomLine', line, { mtmScaleFactor: '0' })).rejects.toThrow(/above 0 and at most 10/)
    await expect(change('BomLine', line, { mtmScaleFactor: '10.5' })).rejects.toThrow(/above 0 and at most 10/)
    await expect(change('BomLine', line, { mtmScalePointId: seed.templatePointIds.inseam })).rejects.toThrow(/is a point of its style's measurement template/)
    expect(await change('BomLine', line, { mtmScalePointId: seed.templatePointIds.waist, mtmScaleFactor: '0.5000' })).toBe(1)
    expect(await change('BomLine', line, { mtmScalePointId: null, mtmScaleFactor: null })).toBe(1)
  })
})

describe('every new table', () => {
  it('refuses TRUNCATE, for the owner too', async () => {
    for (const table of ['MeasurementSpecValue', 'GradeRuleStep', 'PrepackLine', 'ProtectorPlacement', 'MeasurementRule']) {
      await expect(admin(`TRUNCATE "${table}"`)).rejects.toThrow(new RegExp(`TRUNCATE on "${table}" is refused`))
    }
    // A table others reference refuses it anyway (their keys); its own statement trigger refuses it with CASCADE too.
    const triggers = await admin(`SELECT tgrelid::regclass::text AS "table" FROM pg_trigger WHERE tgname LIKE '%\\_no\\_truncate' AND tgrelid::regclass::text = ANY ($1) ORDER BY 1`, [
      ['"PointOfMeasure"', '"MeasurementSpec"', '"GradeRule"', '"Prepack"'],
    ])
    expect(triggers.map((row) => row.table)).toEqual(['"GradeRule"', '"MeasurementSpec"', '"PointOfMeasure"', '"Prepack"'])
  })
})
