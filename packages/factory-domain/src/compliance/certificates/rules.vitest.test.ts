import { describe, expect, it } from 'vitest'
import { canTransition } from '../../state/machine'
import { coverageProblems } from './coverage'
import {
  acceptsCoverage,
  addDays,
  addYears,
  certificateMachine,
  certificateNextStatuses,
  certificateProblems,
  daysBetween,
  daysToExpiry,
  en17092ClassOf,
  expiryWarningDue,
  isCertificateEditable,
  isExpiredOn,
  type CertificateFacts,
  type CertificateFields,
} from './rules'

// Made-up certificates: the notified body "0000" and every number are invented.
const COMPANY = '0195f5d0-0000-7000-8000-00000000000a'
const fields = (overrides: Partial<CertificateFields> = {}): CertificateFields => ({
  companyId: COMPANY,
  holderPartyId: null,
  standard: 'EN 17092-4:2020',
  ppeClass: 'A',
  number: 'TEST-CERT-0001',
  notifiedBodyName: 'Test Notified Body',
  notifiedBodyNumber: '0000',
  modelReference: 'TEST-JKT-01',
  validFrom: '2026-01-15',
  validTo: '2031-01-14',
  ...overrides,
})
const paths = (overrides: Partial<CertificateFields>) => certificateProblems(fields(overrides)).map((problem) => problem.path)
const facts = (overrides: Partial<CertificateFacts> = {}): CertificateFacts => ({ certificate: fields(), today: '2026-10-28', pdfAvailable: true, reason: null, ...overrides })

describe('calendar days', () => {
  it('adds days and years, and counts the days between two days', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(addYears('2026-01-15', 5)).toBe('2031-01-15')
    // 29 February plus five years is 28 February, as PostgreSQL adds an interval (the database's five-year rule).
    expect(addYears('2028-02-29', 5)).toBe('2033-02-28')
    expect(daysBetween('2026-10-28', '2026-11-27')).toBe(30)
    expect(daysBetween('2026-11-27', '2026-10-28')).toBe(-30)
    // Across the change to winter time in Europe/Rome: still whole days.
    expect(daysBetween('2026-10-24', '2026-10-26')).toBe(2)
    expect(() => addDays('2026-02-30', 1)).toThrow(RangeError)
  })
})

describe('certificate data (QHS-103; Reg. (EU) 2016/425 Annex V; EN 17092)', () => {
  it('accepts a complete EN 17092 certificate, a protector certificate and a brand-held one', () => {
    expect(certificateProblems(fields())).toEqual([])
    expect(certificateProblems(fields({ standard: 'EN 1621-1:2012', ppeClass: '2' }))).toEqual([])
    expect(certificateProblems(fields({ companyId: null, holderPartyId: '0195f5d0-0000-7000-8000-0000000000b1' }))).toEqual([])
    expect(certificateProblems(fields({ standard: 'EN ISO 13688:2013+A1:2021', ppeClass: null }))).toEqual([])
  })

  it('knows which EN 17092 part grants which class, and refuses a class the part does not grant', () => {
    expect(['2', '3', '4', '5', '6'].map((part) => en17092ClassOf(`EN 17092-${part}:2020`))).toEqual(['AAA', 'AA', 'A', 'B', 'C'])
    expect(en17092ClassOf('EN 17092-1:2020')).toBeNull()
    expect(paths({ ppeClass: 'AA' })).toEqual(['ppeClass'])
    expect(certificateProblems(fields({ ppeClass: 'AA' }))[0]!.message).toBe('EN 17092-4 grants class A, not AA (EN 17092 classes: AAA, AA, A, B, C).')
    expect(paths({ ppeClass: null })).toEqual(['ppeClass'])
    expect(paths({ standard: 'EN 17092-1:2020' })).toEqual(['standard'])
    expect(paths({ standard: 'EN 1621-2:2014', ppeClass: '3' })).toEqual(['ppeClass'])
  })

  it('needs the standard with its edition, a four-digit notified body number, a number and a holder', () => {
    expect(paths({ standard: 'EN 17092-4' })).toEqual(['standard'])
    expect(paths({ standard: 'en 17092-4:2020' })).toEqual(['standard'])
    expect(paths({ notifiedBodyNumber: '123' })).toEqual(['notifiedBodyNumber'])
    expect(paths({ notifiedBodyNumber: 'NB 0000' })).toEqual(['notifiedBodyNumber'])
    expect(paths({ number: '  ' })).toEqual(['number'])
    expect(paths({ notifiedBodyName: '' })).toEqual(['notifiedBodyName'])
    expect(paths({ companyId: null, holderPartyId: null })).toEqual(['holderPartyId'])
  })

  it('PPE Regulation 2016/425 Annex V: the validity ends after it starts and spans at most five years', () => {
    expect(paths({ validTo: '2026-01-15' })).toEqual(['validTo'])
    expect(paths({ validTo: '2025-12-31' })).toEqual(['validTo'])
    expect(paths({ validTo: '2031-01-15' })).toEqual([])
    expect(paths({ validTo: '2031-01-16' })).toEqual(['validTo'])
    expect(certificateProblems(fields({ validTo: '2031-01-16' }))[0]!.message).toContain('at most 5 years')
    expect(paths({ validFrom: '2028-02-29', validTo: '2033-02-28' })).toEqual([])
    expect(paths({ validFrom: '2028-02-29', validTo: '2033-03-01' })).toEqual(['validTo'])
    expect(paths({ validFrom: '2026-13-01' })).toEqual(['validFrom'])
  })
})

describe('expiry by business date', () => {
  it('expires the day after its last valid day', () => {
    expect(isExpiredOn('2026-10-28', '2026-10-28')).toBe(false)
    expect(isExpiredOn('2026-10-28', '2026-10-29')).toBe(true)
    expect(daysToExpiry('2026-11-27', '2026-10-28')).toBe(30)
    expect(daysToExpiry('2026-10-27', '2026-10-28')).toBe(-1)
  })

  it('warns at 90, 30 and 7 days, with the smallest threshold reached', () => {
    expect(expiryWarningDue('2027-03-01', '2026-10-28')).toBeNull()
    expect(expiryWarningDue('2027-01-26', '2026-10-28')).toBe(90)
    expect(expiryWarningDue('2026-12-15', '2026-10-28')).toBe(90)
    expect(expiryWarningDue('2026-11-27', '2026-10-28')).toBe(30)
    // Registered with 20 days left: warned at once at 30, later at 7.
    expect(expiryWarningDue('2026-11-17', '2026-10-28')).toBe(30)
    expect(expiryWarningDue('2026-11-04', '2026-10-28')).toBe(7)
    expect(expiryWarningDue('2026-10-28', '2026-10-28')).toBe(7)
    expect(expiryWarningDue('2026-10-27', '2026-10-28')).toBeNull()
  })
})

describe('the certificate machine', () => {
  it('moves like the database trigger: DRAFT → VALID | WITHDRAWN, VALID ⇄ SUSPENDED, WITHDRAWN and EXPIRED final', () => {
    expect(certificateMachine.finals).toEqual(['WITHDRAWN', 'EXPIRED'])
    expect(certificateNextStatuses('DRAFT')).toEqual(['VALID', 'WITHDRAWN'])
    expect(certificateNextStatuses('SUSPENDED')).toEqual(['VALID', 'WITHDRAWN', 'EXPIRED'])
    expect(canTransition(certificateMachine, 'DRAFT', 'SUSPENDED', facts())).toMatchObject({ ok: false, reason: 'not_allowed' })
    expect(canTransition(certificateMachine, 'EXPIRED', 'VALID', facts())).toMatchObject({ ok: false, reason: 'not_allowed' })
    expect(isCertificateEditable('DRAFT')).toBe(true)
    expect(isCertificateEditable('VALID')).toBe(false)
    expect([acceptsCoverage('DRAFT'), acceptsCoverage('VALID'), acceptsCoverage('SUSPENDED'), acceptsCoverage('WITHDRAWN'), acceptsCoverage('EXPIRED')]).toEqual([true, true, true, false, false])
  })

  it('PPE Regulation 2016/425: registers a certificate only with its PDF, complete and not past its last valid day', () => {
    expect(canTransition(certificateMachine, 'DRAFT', 'VALID', facts())).toEqual({ ok: true, from: 'DRAFT', to: 'VALID' })
    const noPdf = canTransition(certificateMachine, 'DRAFT', 'VALID', facts({ pdfAvailable: false }))
    expect(noPdf).toMatchObject({ ok: false, reason: 'guard', missing: ["the certificate's PDF from the notified body, uploaded on the certificate"] })
    expect(canTransition(certificateMachine, 'DRAFT', 'VALID', facts({ certificate: fields({ ppeClass: 'C' }) }))).toMatchObject({ ok: false, reason: 'guard' })
    const late = canTransition(certificateMachine, 'DRAFT', 'VALID', facts({ certificate: fields({ validFrom: '2021-10-01', validTo: '2026-09-30' }) }))
    expect(late).toMatchObject({ ok: false, missing: ['a validity that has not ended (its last valid day was 2026-09-30)'] })
    // Reinstating a suspended one checks the same.
    expect(canTransition(certificateMachine, 'SUSPENDED', 'VALID', facts()).ok).toBe(true)
  })

  it('suspends and withdraws only with a reason, and expires only after the last valid day', () => {
    expect(canTransition(certificateMachine, 'VALID', 'SUSPENDED', facts())).toMatchObject({ ok: false, missing: ['a reason (as the notified body wrote it)'] })
    expect(canTransition(certificateMachine, 'VALID', 'SUSPENDED', facts({ reason: 'Production audit pending' })).ok).toBe(true)
    expect(canTransition(certificateMachine, 'DRAFT', 'WITHDRAWN', facts({ reason: 'Typed by mistake' })).ok).toBe(true)
    expect(canTransition(certificateMachine, 'VALID', 'EXPIRED', facts())).toMatchObject({ ok: false, reason: 'guard' })
    expect(canTransition(certificateMachine, 'VALID', 'EXPIRED', facts({ today: '2031-01-15' })).ok).toBe(true)
  })
})

describe('coverage (PRD-281: by style, colourway and size, or an item)', () => {
  const style = { sizes: ['48', '50', '52'], colourwayIds: ['0195f5d0-0000-7000-8000-0000000000c1', '0195f5d0-0000-7000-8000-0000000000c2'] }
  const styleId = '0195f5d0-0000-7000-8000-0000000000d1'
  it('covers exactly one style or one item; an item names no colourways, sizes or made-to-measure', () => {
    expect(coverageProblems({ styleId, sizes: ['50'], colourwayIds: [style.colourwayIds[0]!] }, style)).toEqual([])
    expect(coverageProblems({ styleId, itemId: styleId }, style).map((problem) => problem.path)).toEqual(['styleId'])
    expect(coverageProblems({}, null).map((problem) => problem.path)).toEqual(['styleId'])
    expect(coverageProblems({ itemId: styleId, sizes: ['50'], allowsMadeToMeasure: true }, null).map((problem) => problem.path)).toEqual(['sizes', 'allowsMadeToMeasure'])
  })

  it("refuses a size outside the style's range, a colourway of another style, and a value listed twice", () => {
    const problems = coverageProblems({ styleId, sizes: ['50', '50', '58'], colourwayIds: ['0195f5d0-0000-7000-8000-0000000000ff'] }, style)
    expect(problems.map((problem) => problem.path)).toEqual(['sizes', 'colourwayIds/0', 'sizes/2'])
  })
})
