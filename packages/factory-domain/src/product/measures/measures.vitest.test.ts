import { describe, expect, it } from 'vitest'
import { mapHeaders } from '../../imports/headers'
import { parseRow } from '../../imports/plan'
import { pointsOfMeasureImporter, planPomRow, importRecordValues } from './importer'
import {
  approvalProblems,
  bandOf,
  kindChangeRefusal,
  missingCells,
  normalisePom,
  orderProblems,
  patchedPom,
  planCells,
  pomChanges,
  pomProblems,
  specEditRefusal,
  toleranceWords,
  type PomFields,
  type SpecPoint,
  type SpecValue,
} from './rules'

const POINT = 'a0000000-0000-4000-8000-000000000001'
const OTHER = 'a0000000-0000-4000-8000-000000000002'
const BODY = 'a0000000-0000-4000-8000-000000000003'

const garment: PomFields = { code: 'CHEST_W', name: 'Chest width', nameI18n: null, description: null, howTo: null, howToI18n: null, kind: 'GARMENT', bodyZone: 'UPPER', uom: 'CM', defaultTolerance: '1', bodyPointId: null }

describe('points of measure (PRD-062, PRD-069)', () => {
  it('keeps a code the inspection can record, a length unit, a tolerance from 0 and words per language', () => {
    expect(pomProblems(garment)).toEqual([])
    expect(pomProblems({ ...garment, code: 'CHEST W' }).map((issue) => issue.path)).toEqual(['code'])
    expect(pomProblems({ ...garment, code: 'X'.repeat(41) }).map((issue) => issue.path)).toEqual(['code'])
    expect(pomProblems({ ...garment, uom: 'KG' as PomFields['uom'] })[0]).toMatchObject({ path: 'uom', message: expect.stringContaining('length') })
    expect(pomProblems({ ...garment, defaultTolerance: '-1' }).map((issue) => issue.path)).toEqual(['defaultTolerance'])
    expect(pomProblems({ ...garment, nameI18n: { it: ' ', EN: 'x' } }).map((issue) => issue.path)).toEqual(['nameI18n/it', 'nameI18n/EN'])
  })

  it('links a garment point to an active body point only (PRD-069)', () => {
    const body = { id: BODY, code: 'chest', kind: 'BODY' as const, uom: 'CM' as const, status: 'ACTIVE' as const }
    expect(pomProblems({ ...garment, bodyPointId: BODY }, { id: POINT, bodyPoint: body })).toEqual([])
    expect(pomProblems({ ...garment, kind: 'BODY', bodyPointId: BODY }, { id: POINT, bodyPoint: body })[0]!.message).toMatch(/Only a garment point/)
    expect(pomProblems({ ...garment, bodyPointId: POINT }, { id: POINT, bodyPoint: body })[0]!.message).toMatch(/itself/)
    expect(pomProblems({ ...garment, bodyPointId: BODY }, { id: POINT, bodyPoint: { ...body, kind: 'GARMENT' } })[0]!.message).toMatch(/is a garment point/)
    expect(pomProblems({ ...garment, bodyPointId: BODY }, { id: POINT, bodyPoint: { ...body, status: 'ARCHIVED' } })[0]!.message).toMatch(/archived/)
    expect(pomProblems({ ...garment, bodyPointId: BODY }, { id: POINT, bodyPoint: null })[0]!.message).toMatch(/No such/)
  })

  it('patches only what is named, says what changed, and keeps kind and unit while in use', () => {
    const next = patchedPom(garment, { name: ' Chest width ', defaultTolerance: '1.50', howTo: '' })
    expect(next).toMatchObject({ name: 'Chest width', defaultTolerance: '1.5', howTo: null })
    expect(pomChanges(garment, next)).toEqual(['defaultTolerance'])
    expect(normalisePom({ ...garment, nameI18n: { en: ' Chest ', it: 'Torace' } }).nameI18n).toEqual({ en: 'Chest', it: 'Torace' })
    const used = { templatePoints: 0, specValues: 3, gradeSteps: 1, garmentPoints: 0 }
    expect(kindChangeRefusal('CHEST_W', ['uom'], used)).toMatch(/in use \(3 measurement spec value\(s\), 1 grade rule step\(s\)\): its unit stay/)
    expect(kindChangeRefusal('CHEST_W', ['name'], used)).toBeNull()
    expect(kindChangeRefusal('CHEST_W', ['kind'], { templatePoints: 0, specValues: 0, gradeSteps: 0, garmentPoints: 0 })).toBeNull()
  })
})

describe('the measurement spec (PRD-063)', () => {
  const points = new Map<string, SpecPoint>([
    [POINT, { id: POINT, code: 'CHEST_W', kind: 'GARMENT', status: 'ACTIVE', defaultTolerance: '1' }],
    [OTHER, { id: OTHER, code: 'SLEEVE', kind: 'GARMENT', status: 'ARCHIVED', defaultTolerance: null }],
    [BODY, { id: BODY, code: 'chest', kind: 'BODY', status: 'ACTIVE', defaultTolerance: null }],
  ])
  const base: SpecValue = { id: 'v1', pointOfMeasureId: POINT, size: '52', seq: 1, nominal: '58', toleranceMinus: '1', tolerancePlus: '1.5', source: 'TYPED' }
  const context = { values: [base], points, sizes: ['50', '52', '54'], baseSize: '52' }

  it('types cells: tolerances from the cell, the point in this spec, then the library; an override on another size', () => {
    const plan = planCells(
      [
        { pointOfMeasureId: POINT, size: '54', nominal: '60.50' },
        { pointOfMeasureId: POINT, size: '52', nominal: '58', toleranceMinus: '0.5' },
      ],
      context,
    )
    expect(plan.problems).toEqual([])
    expect(plan.write).toMatchObject([
      { size: '54', nominal: '60.5', toleranceMinus: '1', tolerancePlus: '1.5', source: 'TYPED', before: null },
      { size: '52', nominal: '58', toleranceMinus: '0.5', tolerancePlus: '1.5', before: { id: 'v1' } },
    ])
  })

  it('refuses every wrong cell at once, and takes a cell out with a null nominal', () => {
    const plan = planCells(
      [
        { pointOfMeasureId: BODY, size: '52', nominal: '100' },
        { pointOfMeasureId: OTHER, size: '52', nominal: '60' },
        { pointOfMeasureId: POINT, size: '56', nominal: '60' },
        { pointOfMeasureId: POINT, size: '50', nominal: '0' },
        { pointOfMeasureId: POINT, size: '52', nominal: null },
        { pointOfMeasureId: POINT, size: '52', nominal: '1' },
      ],
      context,
    )
    expect(plan.problems.map((issue) => issue.path)).toEqual(['cells/0/pointOfMeasureId', 'cells/1/pointOfMeasureId', 'cells/2/size', 'cells/3/nominal', 'cells/5/size'])
    expect(plan.problems[0]!.message).toMatch(/body point/)
    expect(plan.problems[1]!.message).toMatch(/archived/)
    expect(plan.remove).toEqual([base])
  })

  it('asks the tolerance of a point that has none anywhere', () => {
    const plan = planCells([{ pointOfMeasureId: OTHER, size: '52', nominal: '60' }], { ...context, points: new Map([[OTHER, { ...points.get(OTHER)!, status: 'ACTIVE' as const }]]) })
    expect(plan.problems).toEqual([{ path: 'cells/0/toleranceMinus', message: expect.stringContaining('no default tolerance') }])
  })

  it('names the missing cells and refuses an approval with a gap, in words', () => {
    expect(missingCells([base], ['50', '52', '54'])).toEqual([{ pointOfMeasureId: POINT, sizes: ['50', '54'] }])
    expect(approvalProblems([], { sizes: ['52'], baseSize: '52', codeOf: () => 'X' })[0]!.message).toMatch(/at least one point/)
    expect(approvalProblems([base, { ...base, size: '50' }], { sizes: ['50', '52', '54'], baseSize: '52', codeOf: () => 'CHEST_W' })[0]!.message).toBe('CHEST_W has no value for 54.')
    expect(approvalProblems([{ ...base, size: '50' }], { sizes: ['50', '52'], baseSize: '52', codeOf: () => 'CHEST_W' })[0]!.message).toMatch(/the base size among them/)
    expect(approvalProblems([base, { ...base, size: '48' }], { sizes: ['52'], baseSize: '52', codeOf: () => 'CHEST_W' })[0]!.message).toMatch(/48 left the style's range/)
  })

  it('keeps the order of the points and asks every point once to reorder', () => {
    expect(orderProblems([POINT, OTHER], [OTHER, POINT])).toEqual([])
    expect(orderProblems([POINT, OTHER], [OTHER])).toHaveLength(1)
    expect(orderProblems([POINT], [POINT, POINT])).toEqual([{ path: 'pointOfMeasureIds', message: 'Each point once.' }])
  })

  it('says why a spec does not change: the revision released, the spec approved or archived', () => {
    expect(specEditRefusal({ revision: 2, status: 'RELEASED' }, null, 'ACTIVE')).toMatch(/Revision 2 is released and frozen/)
    expect(specEditRefusal({ revision: 2, status: 'DRAFT' }, { status: 'APPROVED' }, 'ACTIVE')).toMatch(/reopen it/)
    expect(specEditRefusal({ revision: 2, status: 'DRAFT' }, { status: 'DRAFT' }, 'ACTIVE')).toBeNull()
  })

  it('keeps an asymmetric band as its centre ± half its width (the same band for the inspection)', () => {
    expect(bandOf('58', '1', '1')).toEqual({ nominal: '58.000', tolerance: '1.000' })
    expect(bandOf('58', '1', '1.5')).toEqual({ nominal: '58.250', tolerance: '1.250' })
    expect(toleranceWords('58.00', '1.00', '1.50', 'CM')).toBe('58 −1/+1.5 cm')
    expect(toleranceWords('58', '1', '1', 'MM')).toBe('58 ± 1 mm')
  })
})

describe('the points of measure import', () => {
  const sheet = (headers: string[], row: (string | null)[]) => {
    const mapping = mapHeaders(pointsOfMeasureImporter.columns, headers)
    return parseRow(pointsOfMeasureImporter, mapping.columns, { rowNumber: 2, cells: row }, { numberFormat: 'it' })
  }

  it('makes a new point from a row in Italian words, and refuses one without its kind', () => {
    const parsed = sheet(['Codice', 'Nome', 'Tipo', 'Zona', 'Tolleranza'], ['CHEST_W', 'Mezzo torace', 'capo', 'busto', '1,5'])
    expect(parsed.errors).toEqual([])
    expect(planPomRow(parsed.values, null)).toEqual({ action: 'CREATE', after: expect.objectContaining({ kind: 'GARMENT', bodyZone: 'UPPER', defaultTolerance: '1.5' }) })
    const missing = sheet(['Codice', 'Nome', 'Zona'], ['CHEST_W', 'Mezzo torace', 'busto'])
    expect(planPomRow(missing.values, null)).toMatchObject({ action: 'ERROR', errors: [{ column: 'kind' }] })
  })

  it('changes only the cells given, and keeps the unit of a point in use', () => {
    const record = { id: POINT, values: importRecordValues({ fields: garment, bodyPointCode: null, status: 'ACTIVE', foreign: false, use: { templatePoints: 0, specValues: 2, gradeSteps: 0, garmentPoints: 0 } }) }
    const tolerance = sheet(['Code', 'Default tolerance'], ['CHEST_W', '2'])
    expect(planPomRow(tolerance.values, record)).toEqual({ action: 'UPDATE', before: { defaultTolerance: '1' }, after: { defaultTolerance: '2' } })
    const same = sheet(['Code', 'Name'], ['CHEST_W', 'Chest width'])
    expect(planPomRow(same.values, record)).toEqual({ action: 'UNCHANGED' })
    const unit = sheet(['Code', 'Unit'], ['CHEST_W', 'mm'])
    expect(planPomRow(unit.values, record)).toMatchObject({ action: 'ERROR', errors: [{ column: 'uom', message: expect.stringContaining('in use') }] })
  })
})
