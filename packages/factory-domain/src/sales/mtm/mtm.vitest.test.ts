import { describe, expect, it } from 'vitest'
import { SEND_CHECK_CODES } from '../quotes/send'
import { MTM_LINE_CODES } from './codes'
import { addMonths, isOld, measuredValuesOf, monthsBetween, notStartedProblem, outsidePoints, reviewNoteProblems, reviewRefusal, unitFindings, type MeasuredPoint, type ReviewFacts, type UnitFacts } from './rules'
import { worksheetFingerprint, worksheetNumber, worksheetReport, type WorksheetInput } from './worksheet'

/** The made-to-measure office's pure rules (B-W2b-358). Made-up riders and values; no test reads today's date. */

const POINTS: MeasuredPoint[] = [
  { code: 'chest', name: 'Chest', uom: 'CM', required: true, minValue: '70', maxValue: '150', status: 'ACTIVE' },
  { code: 'waist', name: 'Waist', uom: 'CM', required: true, minValue: '60', maxValue: '140', status: 'ACTIVE' },
  { code: 'wrist', name: 'Wrist', uom: 'MM', required: false, minValue: null, maxValue: null, status: 'ACTIVE' },
  { code: 'neck', name: 'Neck', uom: 'CM', required: true, minValue: null, maxValue: null, status: 'ARCHIVED' },
]

describe('the values of a revision', () => {
  it('keeps each point in its unit, with height and weight as basics', () => {
    const result = measuredValuesOf({ chest: '102.50', waist: '88', wrist: '175', height: '178', weight: '74,5' }, POINTS)
    expect(result.problems).toEqual([])
    expect(result.measurements).toEqual({ chest: { value: '102.5', unit: 'cm' }, waist: { value: '88', unit: 'cm' }, wrist: { value: '175', unit: 'mm' }, height: { value: '178', unit: 'cm' }, weight: { value: '74.5', unit: 'kg' } })
  })

  it('asks a required point, refuses a non-number, an unknown and an archived point', () => {
    const result = measuredValuesOf({ chest: 'abc', neck: '40', shoe: '44' }, POINTS)
    expect(result.problems.map((problem) => problem.path).sort()).toEqual(['body/measurements/chest', 'body/measurements/neck', 'body/measurements/shoe', 'body/measurements/waist'])
    expect(result.problems.find((problem) => problem.path.endsWith('/neck'))!.message).toContain('archived')
    expect(result.problems.find((problem) => problem.path.endsWith('/waist'))!.message).toBe('Waist is measured on every revision.')
  })

  it('asks a value outside its plausible range again until the person confirms it', () => {
    const asked = measuredValuesOf({ chest: '160', waist: '88' }, POINTS)
    expect(asked.problems).toEqual([{ path: 'body/measurements/chest', message: 'Chest 160 cm is outside 70–150 cm: check it, then confirm it (confirmedOutside).' }])
    const kept = measuredValuesOf({ chest: '160', waist: '88' }, POINTS, ['chest'])
    expect(kept.problems).toEqual([])
    expect(kept.outside).toEqual(['chest'])
    expect(outsidePoints(kept.measurements, POINTS)).toEqual(['chest'])
  })
})

describe('old measures (SAL-300)', () => {
  it('counts months on business dates, the last day of a shorter month', () => {
    expect(addMonths('2025-01-31', 1)).toBe('2025-02-28')
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29')
    expect(addMonths('2025-11-13', 12)).toBe('2026-11-13')
    expect(monthsBetween('2025-03-10', '2026-05-09')).toBe(13)
    expect(monthsBetween('2026-05-09', '2025-03-10')).toBe(0)
  })

  it('is old from 12 months on', () => {
    expect(isOld('2025-06-01', '2026-05-31')).toBe(false)
    expect(isOld('2025-06-01', '2026-06-01')).toBe(true)
  })
})

describe('the factory review (SAL-292)', () => {
  const at = (iso: string) => new Date(iso)
  const facts: ReviewFacts = { status: 'WAITING', revision: 2, latestRevision: 2, measuredByUserId: 'measurer', takenAt: at('2026-03-01T10:00:00Z'), submittedAt: null, reviewedAt: null }
  const now = at('2026-03-02T10:00:00Z')

  it('lets someone else confirm, and the measurer ask for more of their own measures', () => {
    expect(reviewRefusal(facts, 'CONFIRM', 'reviewer', now)).toBeNull()
    expect(reviewRefusal(facts, 'CONFIRM', 'measurer', now)).toBe('You measured this revision: someone else confirms it (nobody confirms their own measures).')
    expect(reviewRefusal(facts, 'NEED_MORE', 'measurer', now)).toBeNull()
  })

  it('refuses a confirmed review, an older revision, a review before the measures or the send', () => {
    expect(reviewRefusal({ ...facts, status: 'CONFIRMED' }, 'NEED_MORE', 'reviewer', now)).toContain('is confirmed')
    expect(reviewRefusal({ ...facts, revision: 1 }, 'CONFIRM', 'reviewer', now)).toBe('Revision 1 is not the newest (revision 2 is): review the newest.')
    expect(reviewRefusal(facts, 'CONFIRM', 'reviewer', at('2026-03-01T09:00:00Z'))).toContain('reviewed after that')
    expect(reviewRefusal({ ...facts, measuredByUserId: null, submittedAt: at('2026-03-05T08:00:00Z') }, 'CONFIRM', 'reviewer', now)).toContain('once it has been sent')
    expect(reviewRefusal({ ...facts, status: 'NEED_MORE', reviewedAt: at('2026-03-03T08:00:00Z') }, 'NEED_MORE', 'reviewer', now)).toContain('no earlier than its last review')
  })

  it('needs the words to ask for more', () => {
    expect(reviewNoteProblems('NEED_MORE', '  ')).toEqual([{ path: 'body/note', message: 'Say what more is needed: the rider or dealer reads it.' }])
    expect(reviewNoteProblems('CONFIRM', null)).toEqual([])
    expect(reviewNoteProblems('CONFIRM', 'x'.repeat(2001))).toHaveLength(1)
  })
})

describe('made-to-measure started (GATE-MTM, PRD-017) and a unit’s findings', () => {
  const style = { code: 'MADE-JKT', mtmAllowed: true }
  const on = { code: 'JACKET', rulesOn: true }

  it('says why a unit cannot be quoted', () => {
    expect(notStartedProblem({ style: { ...style, mtmAllowed: false }, template: on })).toContain('is not made to measure')
    expect(notStartedProblem({ style, template: null })).toContain('has no measurement template')
    expect(notStartedProblem({ style, template: { ...on, rulesOn: false } })).toContain('has not started for measurement template JACKET')
    expect(notStartedProblem({ style, template: on, garmentType: 'TROUSERS' })).toContain('measured for TROUSERS')
    expect(notStartedProblem({ style, template: on, garmentType: 'JACKET' })).toBeNull()
  })

  it('blocks what is not started or outside the range, warns of waiting, older and old measures', () => {
    const unit: UnitFacts = {
      kind: 'ORDER',
      seq: 20,
      label: 'Line 20 (MADE-JKT BLK)',
      style,
      template: on,
      profile: { riderName: 'Made-up rider', garmentType: 'JACKET', revision: 1, latestRevision: 2, reviewStatus: 'WAITING', takenOn: '2025-01-10' },
      blocks: ['chest is 9 cm over the base size.'],
      today: '2026-02-10',
    }
    const findings = unitFindings(unit)
    expect(findings.map((finding) => [finding.code, finding.severity])).toEqual([
      ['MTM_OUTSIDE_RANGE', 'BLOCKS'],
      ['MTM_NOT_CONFIRMED', 'WARNING'],
      ['MTM_NOT_LATEST', 'WARNING'],
      ['MTM_OLD_MEASURES', 'WARNING'],
    ])
    expect(findings[1]!.message).toBe('Line 20 (MADE-JKT BLK): revision 1 waits for the factory review; the order waits for the review.')
    expect(findings[3]!.message).toBe('Line 20 (MADE-JKT BLK): measured on 2025-01-10, 13 months ago: ask for a new measure.')
    const clean = unitFindings({ ...unit, blocks: [], template: { ...on, rulesOn: false }, profile: { ...unit.profile, revision: 2, reviewStatus: 'CONFIRMED', takenOn: '2026-01-10' } })
    expect(clean.map((finding) => finding.code)).toEqual(['MTM_NOT_STARTED'])
  })

  it('its codes are send checks of a quote', () => {
    for (const code of MTM_LINE_CODES) expect(SEND_CHECK_CODES).toContain(code)
  })
})

describe('the worksheet and order form (SAL-303)', () => {
  const input: WorksheetInput = {
    language: 'en',
    date: '2026-03-02',
    version: 1,
    company: { name: 'Made-up Atelier Srl', lines: ['Via Finta 1, 00000 Nowhere'], legal: 'Made-up legal line' },
    customer: 'Made-up Team (MT-1)',
    rider: 'Made-up rider',
    garment: { code: 'JACKET', name: 'Jacket' },
    revision: 2,
    takenOn: '2026-03-01',
    takenBy: 'Made-up fitter',
    measuredBy: 'Made-up fitter',
    measuredPlace: 'Showroom',
    baseSize: '52',
    review: { status: 'CONFIRMED', by: 'Made-up reviewer', on: '2026-03-02', note: 'Room for a back protector.' },
    points: [{ code: 'chest', name: 'Chest', value: '102.5', unit: 'cm', range: '70–150 cm' }, { code: 'height', name: 'Height', value: '178', unit: 'cm', range: null }],
    fitNotes: 'Long arms.',
    units: [{ document: 'Q-0001', style: 'MADE-JKT', colourway: 'BLK', baseSize: '52', status: 'Draft' }],
  }

  it('prints the facts, the measures with a column for the fitting, the order form and the signatures; never a price', () => {
    const report = worksheetReport(input)
    expect(report.title).toBe('Made-to-measure worksheet and order form')
    expect(report.facts.map((fact) => fact.label)).toEqual(['Customer', 'Rider', 'Garment', 'Revision', 'Measured on', 'Measured by', 'Our fitter', 'Where', 'Base size', 'Factory review', 'Version', 'Printed on'])
    expect(report.sections.map((section) => section.heading)).toEqual(['Measures', 'Fit notes', 'Order form: made-to-measure units on this revision', 'Signatures'])
    expect(report.sections[0]!.table!.rows).toEqual([
      ['Chest (chest)', '102.5 cm', '70–150 cm', ''],
      ['Height (height)', '178 cm', '-', ''],
    ])
    expect(report.sections[2]!.table!.rows).toEqual([['Q-0001', 'MADE-JKT', 'BLK', '52', 'Draft']])
    expect(report.fileName).toBe('mtm-worksheet-jacket-r2-v1-en.pdf')
    expect(worksheetNumber('JACKET', 2, 3)).toBe('JACKET r2 v3')
    expect(worksheetReport({ ...input, language: 'it' }).title).toBe('Scheda su misura e modulo d’ordine')
  })

  it('fingerprints what it prints but the day and the version', () => {
    expect(worksheetFingerprint({ ...input, date: '2026-04-01', version: 7 })).toBe(worksheetFingerprint(input))
    expect(worksheetFingerprint({ ...input, baseSize: '54' })).not.toBe(worksheetFingerprint(input))
  })
})
