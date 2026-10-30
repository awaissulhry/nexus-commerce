import { describe, expect, it } from 'vitest'
import { REASON_COLOURS, REASON_ICONS } from '../../reasons/rules'
import {
  appliesAt,
  approvalNeeded,
  DEFECT_CODE,
  defectDraftProblems,
  dispositionDraftProblems,
  GARMENT_ZONES,
  isGarmentZone,
  mergedLabels,
  OUTCOME_RULES,
  outcomeOptions,
  retireWords,
  sortedStages,
  stockActionWords,
  useAsIsProblem,
} from './rules'
import { missingDispositions, missingStarter, STANDARD_DISPOSITIONS, STARTER_LIBRARY } from './standard'

const paths = (issues: readonly { path: string }[]) => issues.map((issue) => issue.path)

describe('the defect library (QHS-001)', () => {
  it('codes are upper-case, without spaces, and the zones are ids of the garment map', () => {
    expect(DEFECT_CODE.test('SEAM-OPEN')).toBe(true)
    expect(DEFECT_CODE.test('ARMOUR_POCKET')).toBe(true)
    expect(DEFECT_CODE.test('seam open')).toBe(false)
    expect(DEFECT_CODE.test('S')).toBe(false)
    expect(GARMENT_ZONES.every((zone) => /^[A-Z_]+$/.test(zone.id) && zone.it && zone.en)).toBe(true)
    expect(isGarmentZone('SHOULDER')).toBe(true)
    expect(isGarmentZone('shoulder')).toBe(false)
  })

  it('a category has no class or zone; a new defect has a category and its class', () => {
    expect(paths(defectDraftProblems({ code: 'SEAM', labelIt: 'Cuciture', labelEn: 'Seams', severity: 'MAJOR', zone: 'BACK' }, { isCategory: true, creating: true }))).toEqual(['severity', 'zone'])
    expect(paths(defectDraftProblems({ code: 'SEAM-OPEN', labelIt: 'Aperta', labelEn: 'Open seam', parentId: 'x' }, { isCategory: false, creating: true, parent: { isCategory: true } }))).toEqual(['severity'])
    expect(paths(defectDraftProblems({ code: 'SEAM-OPEN', labelIt: 'Aperta', labelEn: 'Open seam', severity: 'MAJOR' }, { isCategory: false, creating: true, parent: null }))).toEqual(['parentId'])
    expect(defectDraftProblems({ code: 'X-1', labelIt: 'a', labelEn: 'b', severity: 'MINOR' }, { isCategory: false, creating: true, parent: { isCategory: false } })[0]!.message).toMatch(/two levels/)
    expect(defectDraftProblems({ code: 'SEAM-OPEN', labelIt: 'Aperta', labelEn: 'Open seam', severity: 'MAJOR', zone: 'SLEEVE_L', stages: ['FINAL', 'IN_LINE'] }, { isCategory: false, creating: true, parent: { isCategory: true } })).toEqual([])
  })

  it('a change keeps a defect\'s class, checks words, icons, colours, zones and stages', () => {
    expect(paths(defectDraftProblems({ severity: null }, { isCategory: false, creating: false }))).toEqual(['severity'])
    expect(paths(defectDraftProblems({ labelIt: ' ', icon: 'unicorn', colour: '#123456', zone: 'ELSEWHERE', stages: ['FINAL', 'FINAL'] }, { isCategory: false, creating: false }))).toEqual(['labelIt', 'icon', 'colour', 'zone', 'stages'])
    expect(defectDraftProblems({ icon: REASON_ICONS[0], colour: REASON_COLOURS[0].toUpperCase(), labelI18n: { ro: 'Cusătură', it: 'no' } }, { isCategory: false, creating: false }).map((issue) => issue.path)).toEqual(['labelI18n/it'])
    expect(paths(defectDraftProblems({ stages: ['NOWHERE'] }, { isCategory: true, creating: false }))).toEqual(['stages'])
  })

  it('stages: none means every stage; kept in the factory\'s order', () => {
    expect(appliesAt([], 'CUTTING')).toBe(true)
    expect(appliesAt(['FINAL'], 'CUTTING')).toBe(false)
    expect(sortedStages(['FINAL', 'INCOMING', 'IN_LINE'])).toEqual(['INCOMING', 'IN_LINE', 'FINAL'])
  })

  it('says what retiring a code does', () => {
    expect(retireWords('STAIN', 214)).toBe('STAIN is used on 214 records; it stays on them and leaves the pickers.')
    expect(retireWords('STAIN', 0)).toMatch(/can also be deleted/)
  })

  it('merges the other languages: null takes one out', () => {
    expect(mergedLabels({ ro: 'a', ur: 'b' }, { ro: null, zh: ' c ' })).toEqual({ ur: 'b', zh: 'c' })
  })

  it('ships the leather-apparel starter set with the design\'s defects, from the design system\'s icons and colours', () => {
    const codes = STARTER_LIBRARY.flatMap((category) => category.defects.map((defect) => defect.code))
    for (const code of ['SEAM-OPEN', 'STITCH-SKIP', 'PUCKERING', 'SHADE-DIFF', 'HIDE-SCAR', 'GRAIN-CRACK', 'LOOSE-GRAIN', 'COLOUR-RUB', 'ZIP-MISALIGNED', 'ARMOUR-POCKET-MISSING', 'LABEL-WRONG', 'STAIN', 'NEEDLE-HOLES']) expect(codes).toContain(code)
    for (const category of STARTER_LIBRARY) {
      expect((REASON_ICONS as readonly string[]).includes(category.icon)).toBe(true)
      expect((REASON_COLOURS as readonly string[]).includes(category.colour)).toBe(true)
      expect(DEFECT_CODE.test(category.code)).toBe(true)
      for (const defect of category.defects) expect(defectDraftProblems({ ...defect, parentId: 'x' }, { isCategory: false, creating: true, parent: { isCategory: true } })).toEqual([])
    }
    expect(STARTER_LIBRARY.flatMap((category) => category.defects).filter((defect) => defect.severity === 'CRITICAL').map((defect) => defect.code)).toEqual(['ARMOUR-POCKET-MISSING', 'LABEL-WRONG'])
    const missing = missingStarter(new Set(['SEAM', 'SEAM-OPEN', 'LEATHER']))
    expect(missing.categories.map((category) => category.code)).toEqual(['FITTING', 'PROTECTION', 'LABEL', 'FINISH'])
    expect(missing.defects[0]).toMatchObject({ category: 'SEAM', defect: { code: 'STITCH-SKIP' } })
    expect(missingStarter(new Set(codes.concat(STARTER_LIBRARY.map((category) => category.code))))).toEqual({ categories: [], defects: [] })
  })
})

describe('the disposition codes (QHS-005)', () => {
  it('each outcome says which moves and follow-ups it may make; use as is none, scrap a SCRAP move', () => {
    expect(OUTCOME_RULES.USE_AS_IS).toMatchObject({ moves: [null], followUps: [null] })
    expect(OUTCOME_RULES.SCRAP.moves).toEqual(['SCRAP'])
    expect(OUTCOME_RULES.QUARANTINE.moves).toEqual(['TRANSFER'])
    expect(outcomeOptions().map((option) => option.outcome)).toEqual(['USE_AS_IS', 'REWORK', 'REPAIR', 'REGRADE', 'RETURN_TO_SUPPLIER', 'QUARANTINE', 'SCRAP'])
  })

  it('a new code takes its outcome\'s defaults and refuses a move or follow-up the outcome does not make', () => {
    expect(dispositionDraftProblems({ code: 'SCRAP_IT', labelIt: 'Scarto', labelEn: 'Scrap', outcome: 'SCRAP' }, true)).toEqual([])
    expect(paths(dispositionDraftProblems({ code: 'SCRAP_IT', labelIt: 'Scarto', labelEn: 'Scrap', outcome: 'SCRAP', stockMoveReason: 'TRANSFER' }, true))).toEqual(['stockMoveReason'])
    expect(paths(dispositionDraftProblems({ code: 'OK', labelIt: 'Va bene', labelEn: 'Fine', outcome: 'USE_AS_IS', followUp: 'REWORK_ORDER', reinspection: true }, true))).toEqual(['followUp', 'reinspection'])
    expect(dispositionDraftProblems({ code: 'BACK', labelIt: 'Reso', labelEn: 'Back', outcome: 'RETURN_TO_SUPPLIER', stockMoveReason: 'SCRAP' }, true)[0]!.message).toMatch(/Return to the supplier posts no move/)
    expect(paths(dispositionDraftProblems({ code: 'bad code', labelIt: 'x', labelEn: 'y' }, true))).toEqual(['code', 'outcome'])
  })

  it('a change never names the code, outcome, move or follow-up; amounts are cents from 0', () => {
    expect(paths(dispositionDraftProblems({ outcome: 'SCRAP', stockMoveReason: 'SCRAP', approvalAmount: -1 }, false))).toEqual(['outcome', 'stockMoveReason', 'approvalAmount'])
    expect(dispositionDraftProblems({ approvalAmount: 50_000, approvalSeverity: 'CRITICAL', labelEn: 'Scrap it' }, false)).toEqual([])
  })

  it('says the stock action in words', () => {
    expect(stockActionWords({ outcome: 'SCRAP', stockMoveReason: 'SCRAP', followUp: null, reinspection: false })).toBe('Posts a SCRAP move out of stock.')
    expect(stockActionWords({ outcome: 'REWORK', stockMoveReason: null, followUp: 'REWORK_ORDER', reinspection: true })).toBe('Moves no stock; opens a rework order; the goods are inspected again before they are released.')
  })

  it('asks a second person by class (this class or worse) or by value (unknown value asks too)', () => {
    const scrap = { approvalSeverity: 'MAJOR' as const, approvalAmount: 50_000 }
    expect(approvalNeeded(scrap, { severity: 'CRITICAL', value: 10 }).needed).toBe(true)
    expect(approvalNeeded(scrap, { severity: 'MAJOR', value: 10 }).needed).toBe(true)
    expect(approvalNeeded(scrap, { severity: 'MINOR', value: 10 })).toEqual({ needed: false, why: null })
    expect(approvalNeeded(scrap, { severity: 'MINOR', value: 50_000 }).needed).toBe(true)
    expect(approvalNeeded(scrap, { severity: 'MINOR', value: null }).why).toMatch(/not known/)
    expect(approvalNeeded({ approvalSeverity: null, approvalAmount: null }, { severity: 'CRITICAL', value: null }).needed).toBe(false)
  })

  it('use as is only on a minor nonconformance (QHS-002)', () => {
    expect(useAsIsProblem('USE_AS_IS', 'MINOR')).toBeNull()
    expect(useAsIsProblem('USE_AS_IS', 'MAJOR')).toMatch(/refused on a major/)
    expect(useAsIsProblem('SCRAP', 'CRITICAL')).toBeNull()
  })

  it('the standard codes are the design\'s seven, each valid for its outcome', () => {
    expect(STANDARD_DISPOSITIONS.map((code) => code.code)).toEqual(['SCRAP', 'USE_AS_IS', 'REWORK', 'REPAIR', 'REGRADE', 'RETURN_TO_SUPPLIER', 'QUARANTINE'])
    for (const code of STANDARD_DISPOSITIONS) {
      expect(dispositionDraftProblems({ ...code }, true)).toEqual([])
      expect((REASON_ICONS as readonly string[]).includes(code.icon)).toBe(true)
    }
    expect(missingDispositions(new Set(['SCRAP', 'REWORK'])).map((code) => code.code)).toEqual(['USE_AS_IS', 'REPAIR', 'REGRADE', 'RETURN_TO_SUPPLIER', 'QUARANTINE'])
  })
})
