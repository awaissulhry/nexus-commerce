import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { templateOf } from '../../auth/roles/templates'
import { EVENT_CATALOGUE } from '../../events/catalogue'
import { addArea, areaIn, noArea, otherAreaUnit, twoNumbersWords, withOtherUnit } from './area'
import { gradeChoiceProblem, gradeRuleDraftProblems, gradingDraftProblems, gradingRefusal, panelsOf, reasonRequired, shadeChoiceProblem, shadeGroupsFor } from './grading'
import { AREA_TOLERANCE_PERCENT, areaCheck, claimNote, lotCheck, measureDraftProblems, measureRefusal, stockCorrection } from './measure'
import { activeRules, gradeMix, gradeOfHide, gradesForArticle, shareFor, usableArea, type GradeFacts, type RuleFacts } from './usable'

/**
 * Hides as stock (B-W2b-94; PRD-031, SCM-249, SCM-250, SCM-258), pure: area units and the two numbers, grades and usable
 * area with the grade mix, the area check against the tannery with the claim it opens, the grading rules. Made-up figures.
 */

const grade = (code: string, share: string, sortOrder: number, active = true): GradeFacts => ({ id: `g-${code}`, code, labelIt: `Scelta ${code}`, labelEn: `Grade ${code}`, usableShare: share, sortOrder, active })
const A = grade('A', '85.00', 1)
const B = grade('B', '72.00', 2)
const C = grade('C', '60.00', 3)
const D = grade('D', '45.00', 4, false)
const GRADES = [D, C, B, A]
const rule = (gradeId: string, share: string, active = true, panels: string[] = []): RuleFacts => ({ id: `r-${gradeId}-${share}`, gradeId, usableShare: share, panels, active })

describe('area and the two numbers (SCM-258)', () => {
  it('converts between m², dm² and ft² and shows the other unit beside', () => {
    expect(areaIn('10', 'M2', 'FT2').toFixed(4)).toBe('107.6391')
    expect(areaIn('53.2', 'FT2', 'M2').toFixed(4)).toBe('4.9424')
    expect(areaIn('482', 'DM2', 'M2').toFixed(4)).toBe('4.8200')
    expect(otherAreaUnit('M2')).toBe('FT2')
    expect(otherAreaUnit('FT2')).toBe('M2')
    expect(otherAreaUnit('DM2')).toBe('FT2')
    expect(withOtherUnit('51.8', 'FT2')).toEqual({ uom: 'FT2', quantity: '51.8000', other: { uom: 'M2', quantity: '4.8124' } })
  })

  it('adds areas in one unit and writes hides beside area in both languages', () => {
    let total = noArea('M2')
    total = addArea(total, 36, '400', 'M2')
    total = addArea(total, 1, '134.5486', 'FT2')
    expect(total.hides).toBe(37)
    expect(total.area.toFixed(2)).toBe('412.50')
    expect(twoNumbersWords(total, 'en')).toBe('37 hides · 412.50 m² (4,440.1 ft²)')
    expect(twoNumbersWords(total, 'it')).toBe('37 pelli · 412,50 m² (4.440,1 ft²)')
    expect(twoNumbersWords({ hides: 1200, area: areaIn('1234567.891', 'M2', 'M2'), uom: 'M2' }, 'en')).toBe('1200 hides · 1,234,567.89 m² (13,288,778.2 ft²)')
    expect(twoNumbersWords({ hides: 1, area: areaIn('0', 'M2', 'M2'), uom: 'FT2' }, 'en')).toBe('1 hide · 0.00 ft² (0.0 m²)')
    expect(twoNumbersWords({ hides: 2, area: areaIn('8', 'FT2', 'FT2'), uom: 'FT2' }, 'en', 'pieces')).toBe('2 pieces · 8.00 ft² (0.7 m²)')
  })
})

describe('grades and usable area (PRD-031, SCM-250)', () => {
  const rules = activeRules([rule(A.id, '88.00'), rule(B.id, '74.00'), rule(C.id, '58.00', true, ['under collar']), rule(D.id, '40.00', false)])

  it("takes the article's active rule, else the grade's default", () => {
    expect(shareFor(A, rules)).toEqual({ share: '88.00', source: 'RULE', panels: [] })
    expect(shareFor(C, rules)).toEqual({ share: '58.00', source: 'RULE', panels: ['under collar'] })
    // D's rule is retired: the grade's default applies.
    expect(shareFor(D, rules)).toEqual({ share: '45.00', source: 'GRADE', panels: [] })
    expect(shareFor(B, new Map())).toEqual({ share: '72.00', source: 'GRADE', panels: [] })
  })

  it('estimates the usable area rounded down, never more leather than there is', () => {
    expect(usableArea('51.8', '74').toFixed(4)).toBe('38.3320')
    expect(usableArea('1.00003', '33.33').toFixed(4)).toBe('0.3333')
    expect(usableArea('10', '0').toFixed(4)).toBe('0.0000')
    expect(usableArea('10', '100').toFixed(4)).toBe('10.0000')
  })

  it("finds a hide's grade by its record, else by its W1 text, else none", () => {
    expect(gradeOfHide({ gradeId: B.id, grade: 'B' }, GRADES)).toEqual({ grade: B, byText: false })
    expect(gradeOfHide({ gradeId: null, grade: ' a ' }, GRADES)).toEqual({ grade: A, byText: true })
    expect(gradeOfHide({ gradeId: null, grade: 'Extra' }, GRADES)).toEqual({ grade: null, byText: false })
    expect(gradeOfHide({ gradeId: null, grade: null }, GRADES)).toEqual({ grade: null, byText: false })
    // A retired grade a hide names stays its grade.
    expect(gradeOfHide({ gradeId: D.id, grade: 'D' }, GRADES).grade).toBe(D)
  })

  it("offers the article's grades, else every active grade, in tile order", () => {
    expect(gradesForArticle(GRADES, rules).map((entry) => entry.code)).toEqual(['A', 'B', 'C'])
    expect(gradesForArticle(GRADES, new Map()).map((entry) => entry.code)).toEqual(['A', 'B', 'C'])
    expect(gradesForArticle(GRADES, activeRules([rule(B.id, '70')])).map((entry) => entry.code)).toEqual(['B'])
  })

  it('makes the grade mix: per grade in tile order, the ungraded apart, usable of what is left', () => {
    const mix = gradeMix(
      [
        { gradeId: A.id, grade: 'A', measured: '53.2', left: '53.2' },
        { gradeId: null, grade: 'B', measured: '51.8', left: '20' },
        { gradeId: B.id, grade: 'B', measured: '50', left: '50' },
        { gradeId: null, grade: 'Seconda', measured: '45', left: '45' },
        { gradeId: null, grade: null, measured: '0', left: '0' },
      ],
      GRADES,
      rules,
    )
    expect(mix.rows.map((row) => [row.grade?.code ?? null, row.hides, row.byText, row.measured.toFixed(2), row.left.toFixed(2), row.share?.share ?? null, row.usable?.toFixed(4) ?? null, row.percentOfArea])).toEqual([
      ['A', 1, 0, '53.20', '53.20', '88.00', '46.8160', '26.60'],
      ['B', 2, 1, '101.80', '70.00', '74.00', '51.8000', '50.90'],
      [null, 2, 0, '45.00', '45.00', null, null, '22.50'],
    ])
    expect(mix.rows[2]!.texts).toEqual(['Seconda'])
    expect(mix.hides).toBe(5)
    expect(mix.measured.toFixed(2)).toBe('200.00')
    expect(mix.left.toFixed(2)).toBe('168.20')
    expect(mix.usable.toFixed(4)).toBe('98.6160')
    expect(mix.ungradedLeft.toFixed(2)).toBe('45.00')
    expect(gradeMix([], GRADES, rules)).toMatchObject({ rows: [], hides: 0 })
  })
})

describe('re-measure and area check (SCM-249, QHS-025)', () => {
  it('sets the measure against the tannery with the tolerance either way', () => {
    expect(AREA_TOLERANCE_PERCENT).toBe('2.00')
    expect(areaCheck('53.2', '52.6')).toMatchObject({ differencePercent: '-1.13', outcome: 'WITHIN' })
    expect(areaCheck('53.2', '52.6').difference.toFixed(2)).toBe('-0.60')
    expect(areaCheck('50', '48.9')).toMatchObject({ differencePercent: '-2.20', outcome: 'SHORT' })
    expect(areaCheck('50', '51')).toMatchObject({ differencePercent: '2.00', outcome: 'WITHIN' })
    expect(areaCheck('50', '51.5')).toMatchObject({ differencePercent: '3.00', outcome: 'OVER' })
    expect(areaCheck('50', '49', '1')).toMatchObject({ outcome: 'SHORT' })
  })

  it('checks a measure before it is written', () => {
    const now = new Date('2026-11-03T10:00:00.000Z')
    expect(measureDraftProblems({ measuredArea: '51.3', areaUom: 'FT2' }, now)).toEqual([])
    expect(measureDraftProblems({ measuredArea: '0', declaredArea: '-1', areaUom: 'HIDE', measuredAt: new Date('2026-11-03T11:00:00.000Z'), note: 'x'.repeat(501) }, now).map((problem) => problem.path)).toEqual([
      'measuredArea',
      'declaredArea',
      'areaUom',
      'measuredAt',
      'note',
    ])
  })

  it('measures only a whole hide', () => {
    expect(measureRefusal({ code: 'HD-1', state: 'FULL' })).toBeNull()
    for (const state of ['PARTLY_CUT', 'REMNANT', 'CONSUMED', 'SCRAPPED', 'RETURNED']) expect(measureRefusal({ code: 'HD-1', state })).toMatch(/^Hide HD-1 /)
  })

  it('corrects the stock by the difference, or not at all', () => {
    expect(stockCorrection('51.8', '51.3')).toEqual({ direction: 'OUT', quantity: expect.anything() })
    expect(stockCorrection('51.8', '51.3')!.quantity.toFixed(4)).toBe('0.5000')
    expect(stockCorrection('50', '50.25')!.direction).toBe('IN')
    expect(stockCorrection('50.0000', '50')).toBeNull()
  })

  it('checks a lot on its measured hides together and gives the claim lines of the short ones', () => {
    const within = lotCheck([{ hideId: 'h1', code: 'HD-1', declared: '53.2', measured: '52.6' }, { hideId: 'h2', code: 'HD-2', declared: '51.8', measured: '51.3' }], 'ft²')
    expect(within).toMatchObject({ hides: 2, opensClaim: false, claimLines: [] })
    expect(within.check!.differencePercent).toBe('-1.05')
    const short = lotCheck([{ hideId: 'h1', code: 'HD-1', declared: '53.2', measured: '50' }, { hideId: 'h2', code: 'HD-2', declared: '51.8', measured: '52' }], 'ft²')
    expect(short.opensClaim).toBe(true)
    expect(short.check!.outcome).toBe('SHORT')
    expect(short.claimLines).toEqual([{ hideId: 'h1', quantity: '3.2000', reason: "Hide HD-1: 3.20 ft² short of the tannery's area." }])
    expect(claimNote('LOT-7', short.check!, 2, 'ft²')).toBe("Lot LOT-7: 2 hides measured 102.00 ft² against the 105.00 ft² invoiced, 3.00 ft² (2.86 %) short, beyond the 2.00 % tolerance.")
    expect(lotCheck([], 'ft²')).toEqual({ hides: 0, check: null, opensClaim: false, claimLines: [] })
  })
})

describe('grading by record (SCM-250)', () => {
  it('keeps a used, scrapped or returned hide read-only and asks a reason once it is cut', () => {
    expect(gradingRefusal({ code: 'HD-1', state: 'FULL' })).toBeNull()
    expect(gradingRefusal({ code: 'HD-1', state: 'PARTLY_CUT' })).toBeNull()
    expect(gradingRefusal({ code: 'HD-1', state: 'CONSUMED' })).toMatch(/used up/)
    expect(gradingRefusal({ code: 'HD-1', state: 'SCRAPPED' })).toMatch(/scrapped/)
    expect(gradingRefusal({ code: 'HD-1', state: 'RETURNED' })).toMatch(/supplier/)
    expect(reasonRequired({ state: 'FULL', cutEntries: 0 })).toBe(false)
    expect(reasonRequired({ state: 'FULL', cutEntries: 2 })).toBe(true)
    expect(reasonRequired({ state: 'PARTLY_CUT', cutEntries: 0 })).toBe(true)
  })

  it('checks the body: a change, a thickness above 0, the reason when it is needed', () => {
    expect(gradingDraftProblems({ gradeId: 'g' }, false)).toEqual([])
    expect(gradingDraftProblems({}, false).map((problem) => problem.path)).toEqual(['gradeId'])
    expect(gradingDraftProblems({ thicknessMm: '0' }, false).map((problem) => problem.path)).toEqual(['thicknessMm'])
    expect(gradingDraftProblems({ thicknessMm: '1.234' }, false).map((problem) => problem.path)).toEqual(['thicknessMm'])
    expect(gradingDraftProblems({ thicknessMm: null }, false)).toEqual([])
    expect(gradingDraftProblems({ defects: 'hole' }, true).map((problem) => problem.path)).toEqual(['reason'])
    expect(gradingDraftProblems({ defects: 'hole', reason: 'Found at the table.' }, true)).toEqual([])
  })

  it("gives a hide only its article's active grades; one it has may stay", () => {
    const allowed = [A, B, C]
    expect(gradeChoiceProblem(B, null, allowed, 'LEA-100')).toBeNull()
    expect(gradeChoiceProblem(D, null, allowed, 'LEA-100')).toMatch(/retired/)
    expect(gradeChoiceProblem(D, D.id, allowed, 'LEA-100')).toBeNull()
    expect(gradeChoiceProblem(grade('E', '30', 5), null, allowed, 'LEA-100')).toBe("Grade E is not one of LEA-100's grades (A, B, C): add it on the material's Grades and usable area first.")
  })

  it("sorts a hide only into a group of its article, colour and lot", () => {
    const hide = { itemId: 'i1', lotId: 'l1', itemColourId: 'c1', shadeGroupId: null, code: 'HD-1' }
    const group = { id: 's1', itemId: 'i1', itemColourId: 'c1', lotId: null, label: '1', active: true }
    expect(shadeChoiceProblem(group, hide)).toBeNull()
    expect(shadeChoiceProblem({ ...group, itemId: 'i2' }, hide)).toMatch(/another article/)
    expect(shadeChoiceProblem({ ...group, lotId: 'l2' }, hide)).toMatch(/another lot/)
    expect(shadeChoiceProblem({ ...group, itemColourId: 'c2' }, hide)).toMatch(/another colour/)
    expect(shadeChoiceProblem({ ...group, active: false }, hide)).toMatch(/retired/)
    expect(shadeChoiceProblem({ ...group, active: false }, { ...hide, shadeGroupId: 's1' })).toBeNull()
    expect(shadeGroupsFor([group, { ...group, id: 's2', itemColourId: null }, { ...group, id: 's3', lotId: 'l2' }, { ...group, id: 's4', active: false }], hide).map((entry) => entry.id)).toEqual(['s1', 's2'])
  })

  it("keeps an article's rule: a share 0-100, its panels trimmed and each once", () => {
    expect(gradeRuleDraftProblems({ usableShare: '74.5', panels: ['sleeve'] }, true)).toEqual([])
    expect(gradeRuleDraftProblems({}, true).map((problem) => problem.path)).toEqual(['usableShare'])
    expect(gradeRuleDraftProblems({ usableShare: '100.01' }, false).map((problem) => problem.path)).toEqual(['usableShare'])
    expect(gradeRuleDraftProblems({ panels: ['x'.repeat(61)] }, false).map((problem) => problem.path)).toEqual(['panels'])
    expect(gradeRuleDraftProblems({ panels: Array.from({ length: 21 }, (_, index) => `panel ${index}`) }, false).map((problem) => problem.path)).toEqual(['panels'])
    expect(panelsOf([' Under  collar ', 'under collar', '', 'Pocket bag'])).toEqual(['Under collar', 'Pocket bag'])
  })
})

describe('the catalogues', () => {
  it('declares inventory.hides.manage and gives it to the warehouse and the quality inspector', () => {
    expect(FACTORY_PERMISSIONS.get('inventory.hides.manage')).toMatchObject({ area: 'inventory', risk: 'write' })
    expect(templateOf('warehouse')!.permissions).toContain('inventory.hides.manage')
    expect(templateOf('quality_inspector')!.permissions).toContain('inventory.hides.manage')
    expect(templateOf('sales')!.permissions).not.toContain('inventory.hides.manage')
    expect(templateOf('owner')!.permissions).toContain('inventory.hides.manage')
  })

  it('declares the three events', () => {
    for (const type of ['inventory.grade_rule_changed', 'inventory.hide_graded', 'inventory.hide_measured']) expect(EVENT_CATALOGUE.types()).toContain(type)
  })
})
