import { describe, expect, it } from 'vitest'
import { mapHeaders } from '../../imports/headers'
import { parseRow } from '../../imports/plan'
import type { SpecValue } from '../measures/rules'
import { gradeRulesImporter, parseStep, planStepRow, importRecordValues } from './importer'
import { fitChains, fitProblems, gradeSpec, gradeWords, normaliseStep, pointOffsets, ruleProblems, stepProblems, writtenCells, type ScaleSize, type StepData, type StepPoint } from './rules'

const CHEST = 'b0000000-0000-4000-8000-000000000001'
const SLEEVE = 'b0000000-0000-4000-8000-000000000002'
const INSEAM = 'b0000000-0000-4000-8000-000000000003'
const BODY = 'b0000000-0000-4000-8000-000000000004'

const EU: ScaleSize[] = ['48', '50', '52', '54', '56'].map((code, index) => ({ code, seq: index + 1, fitCode: null }))
const FIT: ScaleSize[] = [
  { code: '50R', seq: 1, fitCode: 'R' },
  { code: '50L', seq: 2, fitCode: 'L' },
  { code: '52R', seq: 3, fitCode: 'R' },
  { code: '52L', seq: 4, fitCode: 'L' },
]
const offsets = (map: Map<string, { toFixed(places: number): string }>) => Object.fromEntries([...map].map(([size, value]) => [size, value.toFixed(2)]))

describe('two-dimension scales (PRD-049)', () => {
  it('asks a fit of every size on a scale of size and fit, and none on a scale of one', () => {
    expect(fitProblems(2, [{ code: '52R', fitCode: 'R' }, { code: '52L', fitCode: 'L' }])).toEqual([])
    expect(fitProblems(2, [{ code: '52', fitCode: null }], 'sizes', 'Size scale X')[0]).toEqual({ path: 'sizes/0/fitCode', message: expect.stringContaining('Size scale X has two dimensions') })
    expect(fitProblems(1, [{ code: '52', fitCode: 'R' }])[0]!.message).toMatch(/one dimension/)
    expect(fitProblems(2, [{ code: '52R', fitCode: 'r-1' }])[0]!.message).toMatch(/1 to 10 capital/)
    expect(fitProblems(3, [])[0]!.path).toBe('dimensions')
  })

  it('makes one chain per fit, in the scale order', () => {
    expect([...fitChains(FIT)]).toEqual([
      ['R', ['50R', '52R']],
      ['L', ['50L', '52L']],
    ])
    expect([...fitChains(EU)]).toEqual([['', ['48', '50', '52', '54', '56']]])
  })
})

describe('grade rules (PRD-051)', () => {
  const points = new Map<string, StepPoint>([
    [CHEST, { id: CHEST, code: 'CHEST_W', kind: 'GARMENT', status: 'ACTIVE' }],
    [SLEEVE, { id: SLEEVE, code: 'SLEEVE', kind: 'GARMENT', status: 'ARCHIVED' }],
    [BODY, { id: BODY, code: 'chest', kind: 'BODY', status: 'ACTIVE' }],
  ])
  const context = { scaleSizes: EU.map((size) => size.code), baseSize: '52', format: 'RELATIVE' as const, points }

  it('checks the rule against its scale', () => {
    expect(ruleProblems({ code: 'GR-EU', name: 'EU jacket', baseSize: '52', format: 'RELATIVE' }, ['50', '52'])).toEqual([])
    expect(ruleProblems({ code: 'gr eu', name: '', baseSize: '58', format: 'RELATIVE' }, ['50', '52']).map((issue) => issue.path)).toEqual(['code', 'name', 'baseSize'])
  })

  it('refuses every wrong step at once: body point, archived point, one size, foreign size, both ways, two standards', () => {
    const steps: StepData[] = [
      { pointOfMeasureId: BODY, fromSize: null, toSize: null, increment: '1' },
      { pointOfMeasureId: SLEEVE, fromSize: null, toSize: null, increment: '1' },
      { pointOfMeasureId: CHEST, fromSize: '50', toSize: null, increment: '1' },
      { pointOfMeasureId: CHEST, fromSize: '52', toSize: '58', increment: '1' },
      { pointOfMeasureId: CHEST, fromSize: '50', toSize: '52', increment: '2' },
      { pointOfMeasureId: CHEST, fromSize: '52', toSize: '50', increment: '-2' },
      { pointOfMeasureId: CHEST, fromSize: null, toSize: null, increment: '2' },
      { pointOfMeasureId: CHEST, fromSize: null, toSize: null, increment: '2.005' },
    ]
    expect(stepProblems(steps, context).map((issue) => issue.path)).toEqual([
      'steps/0/pointOfMeasureId',
      'steps/1/pointOfMeasureId',
      'steps/2/toSize',
      'steps/3/toSize',
      'steps/5/pointOfMeasureId',
      'steps/7/increment',
      'steps/7/pointOfMeasureId',
    ])
    // A point the rule had stays even when archived since.
    expect(stepProblems([steps[1]!], { ...context, kept: new Set([SLEEVE]) })).toEqual([])
  })

  it('counts an absolute rule from its base size', () => {
    const problems = stepProblems([{ pointOfMeasureId: CHEST, fromSize: '50', toSize: '54', increment: '4' }], { ...context, format: 'ABSOLUTE' })
    expect(problems[0]!.message).toMatch(/counts every increment from its base size 52/)
  })

  it('writes a step plainly', () => {
    expect(normaliseStep({ pointOfMeasureId: CHEST, fromSize: ' 50r ', toSize: '52r', increment: '-0.50' })).toEqual({ pointOfMeasureId: CHEST, fromSize: '50R', toSize: '52R', increment: '-0.5' })
  })
})

describe('grading (PRD-052)', () => {
  it('RELATIVE: the standard increment along the chain, a given step instead of it, back the other way', () => {
    const steps: StepData[] = [
      { pointOfMeasureId: CHEST, fromSize: null, toSize: null, increment: '2' },
      { pointOfMeasureId: CHEST, fromSize: '52', toSize: '54', increment: '2.5' },
    ]
    expect(offsets(pointOffsets({ baseSize: '52', format: 'RELATIVE' }, steps, EU))).toEqual({ '52': '0.00', '50': '-2.00', '54': '2.50', '48': '-4.00', '56': '4.50' })
  })

  it('RELATIVE over two dimensions: the size along each fit, the fit only where a step says', () => {
    const steps: StepData[] = [
      { pointOfMeasureId: INSEAM, fromSize: null, toSize: null, increment: '0' },
      { pointOfMeasureId: INSEAM, fromSize: '52R', toSize: '52L', increment: '4' },
    ]
    expect(offsets(pointOffsets({ baseSize: '52R', format: 'RELATIVE' }, steps, FIT))).toEqual({ '52R': '0.00', '50R': '0.00', '52L': '4.00', '50L': '4.00' })
    // No step between the fits: the long fit is not reached (never a silent 0).
    expect(offsets(pointOffsets({ baseSize: '52R', format: 'RELATIVE' }, [steps[0]!], FIT))).toEqual({ '52R': '0.00', '50R': '0.00' })
  })

  it('ABSOLUTE: from the base, a given step, else the standard increment times the places along its chain', () => {
    const steps: StepData[] = [
      { pointOfMeasureId: CHEST, fromSize: null, toSize: null, increment: '2' },
      { pointOfMeasureId: CHEST, fromSize: '52', toSize: '56', increment: '5' },
    ]
    expect(offsets(pointOffsets({ baseSize: '52', format: 'ABSOLUTE' }, steps, EU))).toEqual({ '52': '0.00', '48': '-4.00', '50': '-2.00', '54': '2.00', '56': '5.00' })
    expect(offsets(pointOffsets({ baseSize: '52R', format: 'ABSOLUTE' }, [{ pointOfMeasureId: INSEAM, fromSize: '52R', toSize: '52L', increment: '4' }], FIT))).toEqual({ '52R': '0.00', '52L': '4.00' })
  })

  const value = (point: string, size: string, nominal: string, source: SpecValue['source'] = 'TYPED', seq = 1): SpecValue => ({ id: `${point}-${size}`, pointOfMeasureId: point, size, seq, nominal, toleranceMinus: '1', tolerancePlus: '1', source })

  it('grades a spec from its base value: adds, changes, keeps a typed value unless asked, and says what it cannot reach', () => {
    const steps: StepData[] = [{ pointOfMeasureId: CHEST, fromSize: null, toSize: null, increment: '2' }]
    const values = [value(CHEST, '52', '58'), value(CHEST, '50', '55', 'GRADED'), value(CHEST, '54', '61'), value(SLEEVE, '52', '64', 'TYPED', 2)]
    const input = { rule: { baseSize: '50', format: 'RELATIVE' as const }, steps, scaleSizes: EU, baseSize: '52', range: ['50', '52', '54', '56'], values, codeOf: (id: string) => (id === CHEST ? 'CHEST_W' : 'SLEEVE'), unitOf: () => 'CM', keepOverrides: true }
    const kept = gradeSpec(input)
    expect(kept.cells.map((cell) => [cell.size, cell.action, cell.after?.nominal ?? null])).toEqual([
      ['50', 'CHANGE', '56'],
      ['54', 'KEEP_OVERRIDE', '60'],
      ['56', 'ADD', '62'],
    ])
    expect(kept.notInRule).toEqual([SLEEVE])
    expect(gradeWords(kept)).toBe('1 cell(s) added, 1 changed, 1 typed value(s) kept, 1 point(s) the rule does not grade.')
    expect(writtenCells(kept).map((cell) => cell.size)).toEqual(['50', '56'])
    const overwritten = gradeSpec({ ...input, keepOverrides: false })
    expect(overwritten.cells.find((cell) => cell.size === '54')).toMatchObject({ action: 'OVERWRITE', words: 'CHEST_W 54: the typed 61 cm becomes 60 cm.' })
    const twice = gradeSpec({ ...input, values: [value(CHEST, '52', '58'), value(CHEST, '50', '56', 'GRADED')] })
    expect(twice.cells[0]).toMatchObject({ size: '50', action: 'SAME' })
  })

  it('never grades to 0 or below, and never past what the steps reach', () => {
    const steps: StepData[] = [{ pointOfMeasureId: CHEST, fromSize: '52', toSize: '54', increment: '-60' }]
    const plan = gradeSpec({ rule: { baseSize: '52', format: 'RELATIVE' }, steps, scaleSizes: EU, baseSize: '52', range: ['50', '52', '54'], values: [value(CHEST, '52', '58')], codeOf: () => 'CHEST_W', unitOf: () => 'CM', keepOverrides: true })
    expect(plan.cells.map((cell) => [cell.size, cell.action])).toEqual([
      ['50', 'NOT_REACHED'],
      ['54', 'OUT_OF_RANGE'],
    ])
    expect(plan.cells[1]!.words).toBe('CHEST_W 54: grading gives -2 cm, not a measure above 0.')
  })
})

describe('the grade rules import', () => {
  it('reads a step as from-to or the standard increment', () => {
    expect(parseStep('50-52')).toEqual({ fromSize: '50', toSize: '52' })
    expect(parseStep('52r > 52l')).toEqual({ fromSize: '52R', toSize: '52L' })
    expect(parseStep('*')).toEqual({ fromSize: null, toSize: null })
    expect(parseStep('tutte')).toEqual({ fromSize: null, toSize: null })
    expect(parseStep('50')).toBeNull()
  })

  it('plans a new step with its increment, a changed increment, and nothing for the same one', () => {
    const mapping = mapHeaders(gradeRulesImporter.columns, ['Regola', 'Punto', 'Passo', 'Incremento'])
    expect(mapping.issues).toEqual([])
    const parsed = parseRow(gradeRulesImporter, mapping.columns, { rowNumber: 2, cells: ['gr-eu', 'CHEST_W', '50-52', '1,5'] }, { numberFormat: 'it' })
    expect(parsed.errors).toEqual([])
    expect(parsed.values).toMatchObject({ rule: 'GR-EU', increment: '1.5' })
    expect(planStepRow(parsed.values, null)).toEqual({ action: 'CREATE', after: parsed.values })
    const record = { id: CHEST, values: importRecordValues({ ruleCode: 'GR-EU', pointCode: 'CHEST_W', fromSize: '50', toSize: '52', increment: '1.00' }) }
    expect(planStepRow(parsed.values, record)).toEqual({ action: 'UPDATE', before: { increment: '1' }, after: { increment: '1.5' } })
    expect(planStepRow({ ...parsed.values, increment: '1.0' }, record)).toEqual({ action: 'UNCHANGED' })
    expect(gradeRulesImporter.validateRow({ rule: 'GR EU', point: 'X', step: '50' }).map((issue) => issue.column)).toEqual(['rule', 'step'])
  })
})
