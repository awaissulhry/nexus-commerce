import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../../../lib/api/errors'
import type { GradePreviewView } from './api'
import { demoSpec } from './fixtures'
import { addPlan, approveHeld, cellProblemOf, fillCells, gradeHeld, gradeLines, isOverride, missingCount, movedPoints, pasteCells, specCellProblem, specHeld, specProblem, specRowsOf, startHeld, toleranceCells, toleranceOf, toleranceText } from './spec-model'

const CAN = { manage: true, release: true, library: true }

describe('may the spec change now (revision-bound)', () => {
  it('a draft spec of a draft revision changes; else it says why', () => {
    expect(specHeld(demoSpec(), CAN)).toBeNull()
    expect(specHeld(demoSpec({ revision: 'released' }), CAN)).toBe('spec.held.frozen')
    expect(specHeld(demoSpec({ status: 'APPROVED' }), CAN)).toBe('spec.held.approved')
    expect(specHeld(demoSpec(), { manage: false })).toBe('spec.held.noManage')
    expect(specHeld(demoSpec({ rule: true }), CAN)).toBe('spec.held.rule')
    expect(startHeld(demoSpec({ none: true }), CAN)).toBeNull()
    expect(startHeld(demoSpec({ none: true, revision: 'released' }), CAN)).toBe('spec.held.frozen')
  })

  it('approve needs the release right and nothing missing; reopen needs the right', () => {
    expect(missingCount(demoSpec())).toBe(2)
    expect(approveHeld(demoSpec(), CAN, false)).toBe('spec.held.missing')
    expect(approveHeld(demoSpec({ complete: true }), CAN, false)).toBeNull()
    expect(approveHeld(demoSpec({ complete: true }), { release: false }, false)).toBe('spec.held.noRelease')
    expect(approveHeld(demoSpec({ empty: true }), CAN, false)).toBe('spec.held.noPoints')
  })
})

describe('rows and cells', () => {
  const rows = specRowsOf(demoSpec())
  it('a value typed among graded ones is a manual override; the base size never is', () => {
    const back = rows.find((row) => row.point.code === 'DEMO-BACK_LEN')!
    expect(isOverride(back, '56', '52')).toBe(true)
    expect(isOverride(back, '52', '52')).toBe(false)
    expect(isOverride(back, '54', '52')).toBe(false)
  })

  it('the tolerance as people read it; "varies" when the sizes differ', () => {
    const sleeve = rows.find((row) => row.point.code === 'DEMO-SLEEVE_LEN')!
    expect(toleranceText(toleranceOf(sleeve, '52'), 'CM', 'it')).toBe('−1 / +1,5 cm')
    expect(toleranceText(toleranceOf(rows[0]!, '52'), 'CM', 'en')).toBe('± 1 cm')
    expect(toleranceOf(rows[0]!, '52')!.varies).toBe(false)
  })

  it('a value is above 0; the order moves one place', () => {
    expect(cellProblemOf('0')).toBe('spec.problem.nominal')
    expect(cellProblemOf('58.5')).toBeNull()
    expect(cellProblemOf(null)).toBeNull()
    expect(movedPoints(rows, rows[1]!.id, -1)).toEqual([rows[1]!.id, rows[0]!.id, rows[2]!.id, rows[3]!.id])
    expect(movedPoints(rows, rows[0]!.id, -1)).toBeNull()
  })

  it('a row filled from its base, a row\'s tolerance for every size it has', () => {
    expect(fillCells('p', [{ size: '54', from: '60', to: '61' }])).toEqual([{ pointOfMeasureId: 'p', size: '54', nominal: '61' }])
    const sleeve = rows.find((row) => row.point.code === 'DEMO-SLEEVE_LEN')!
    const cells = toleranceCells(sleeve, '0.5', '1')
    expect(cells).toHaveLength(5)
    expect(cells[0]).toEqual({ pointOfMeasureId: sleeve.id, size: '50', nominal: '63.5', toleranceMinus: '0.5', tolerancePlus: '1' })
  })
})

describe('paste from a spreadsheet', () => {
  const view = demoSpec()
  it('one line per point in the range\'s order; an empty cell is left as it is; words and unknown points are said', () => {
    const result = pasteCells('demo-chest_w\t52\t\t56\nDEMO-WAIST_W;44;abc\nDEMO-HEM_W\t40', view)
    expect(result.cells).toEqual([
      { pointOfMeasureId: view.points[0]!.pointOfMeasureId, size: '46', nominal: '52' },
      { pointOfMeasureId: view.points[0]!.pointOfMeasureId, size: '50', nominal: '56' },
      { pointOfMeasureId: view.points[3]!.pointOfMeasureId, size: '46', nominal: '44' },
    ])
    expect(result.points).toBe(2)
    expect(result.problems.map((problem) => problem.key)).toEqual(['spec.pasteProblem.notNumber', 'spec.pasteProblem.unknown'])
  })

  it('a first line of sizes is a header the values follow; a comma decimal is read', () => {
    const result = pasteCells('Punto\t56\t58\nDEMO-BACK_LEN\t74,5\t75', view)
    expect(result.cells).toEqual([
      { pointOfMeasureId: view.points[1]!.pointOfMeasureId, size: '56', nominal: '74.5' },
      { pointOfMeasureId: view.points[1]!.pointOfMeasureId, size: '58', nominal: '75' },
    ])
  })

  it('0 is no value: said, not sent; more values than sizes are said', () => {
    const result = pasteCells('DEMO-CHEST_W\t0\t1\t2\t3\t4\t5\t6\t7', view)
    expect(result.cells).toHaveLength(6)
    expect(result.problems.map((problem) => problem.key)).toEqual(['spec.pasteProblem.notNumber', 'spec.pasteProblem.over'])
  })
})

describe('Add points and Apply grade rule', () => {
  it('Add sends each ticked point with its base value, or says why it is held', () => {
    expect(addPlan([])).toEqual({ held: 'spec.addDialog.held.none' })
    expect(addPlan([{ id: 'a', picked: true, value: '' }])).toEqual({ held: 'spec.addDialog.held.value' })
    expect(addPlan([{ id: 'a', picked: true, value: '61,5' }, { id: 'b', picked: false, value: '' }])).toEqual({ points: [{ pointOfMeasureId: 'a', nominal: '61.5' }] })
  })

  it('the preview: what Apply writes, what stays and why', () => {
    const preview: GradePreviewView = {
      rule: { id: 'r', code: 'R', name: 'R', format: 'RELATIVE', baseSize: '52' },
      baseSize: '52',
      keepOverrides: true,
      cells: (['ADD', 'CHANGE', 'OVERWRITE', 'KEEP_OVERRIDE', 'SAME', 'NOT_REACHED', 'OUT_OF_RANGE'] as const).map((action, index) => ({ pointOfMeasureId: 'p', code: 'P', size: String(46 + index * 2), action, before: null, after: null, words: 'x' })),
      notInRule: [],
      noBase: [],
      counts: { ADD: 1, CHANGE: 1, OVERWRITE: 1, KEEP_OVERRIDE: 1, SAME: 1, NOT_REACHED: 1, OUT_OF_RANGE: 1 },
      words: 'x',
    }
    const lines = gradeLines(preview)
    expect(lines.written.map((cell) => cell.action)).toEqual(['ADD', 'CHANGE', 'OVERWRITE'])
    expect(lines.kept).toBe(1)
    expect(lines.notReached).toHaveLength(1)
    expect(lines.outOfRange).toHaveLength(1)
    expect(gradeHeld({ ruleId: '', keepOverrides: true, preview: { status: 'idle' } }, false, null)).toBe('spec.grade.held.rule')
    expect(gradeHeld({ ruleId: 'r', keepOverrides: true, preview: { status: 'loading' } }, false, null)).toBe('spec.grade.held.preview')
    expect(gradeHeld({ ruleId: 'r', keepOverrides: true, preview: { status: 'ready', value: preview } }, false, null)).toBeNull()
    expect(gradeHeld({ ruleId: 'r', keepOverrides: true, preview: { status: 'ready', value: { ...preview, cells: [] } } }, false, null)).toBe('spec.grade.held.nothing')
    expect(gradeHeld({ ruleId: 'r', keepOverrides: true, preview: { status: 'ready', value: preview } }, false, 'spec.held.frozen')).toBe('spec.held.frozen')
  })
})

describe('refusals in our words', () => {
  it('someone else, the edit rule, the state', () => {
    expect(specProblem(new ApiError('conflict', 409, 'version_conflict', 'x', null, [])).key).toBe('problem.write.moved')
    expect(specProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/EDIT_BLOCKED', message: 'x' }])).key).toBe('spec.held.rule')
    expect(specProblem(new ApiError('conflict', 409, 'invalid_state', 'The measurement spec is approved: reopen it to change it.', null, [])).messages).toEqual(['The measurement spec is approved: reopen it to change it.'])
    expect(specCellProblem(new ApiError('invalid', 400, 'invalid', 'x', null, [])).toString()).toBe('spec.problem.nominal')
  })
})
