import { describe, expect, it } from 'vitest'
import { businessDate } from '../../core/time'
import type { RequirementKind } from '../requirements/rules'
import {
  answeredOnTime,
  certificateCoverage,
  coverageCellOf,
  crViBySupplier,
  gapsByType,
  gapTypeOf,
  median,
  monthsOf,
  openGaps,
  pct,
  periodOf,
  periodProblems,
  registerSummary,
  shippedCoverage,
  spanOf,
  yearPeriod,
  yearProblems,
  type MissingLine,
  type ReportLine,
} from './rules'

const line = (check: string, state: ReportLine['state'], kind: RequirementKind, code = check, blocks: string[] = ['SHIPMENT']): ReportLine => ({ check, state, blocks: blocks.length > 0, requirement: { code, kind, blocks } })
const missing = (styleId: string, marketCode: string, check: string, kind: RequirementKind, code = check, blocks: string[] = ['SHIPMENT']): MissingLine => ({ ...line(check, 'MISSING', kind, code, blocks), styleId, marketCode })

describe('compliance reports: the period', () => {
  it('defaults to the 365 days up to today; refuses a period that ends after today, backwards or longer than 366 days', () => {
    expect(periodOf({}, '2026-11-10')).toEqual({ from: '2025-11-11', to: '2026-11-10' })
    expect(periodOf({ from: '2026-01-01' }, '2026-11-10')).toEqual({ from: '2026-01-01', to: '2026-11-10' })
    expect(periodOf({ to: '2026-06-30' }, '2026-11-10')).toEqual({ from: '2025-07-01', to: '2026-06-30' })
    expect(periodProblems({ from: '2026-01-01', to: '2026-11-10' }, '2026-11-10')).toEqual([])
    expect(periodProblems({ from: '2026-11-01', to: '2026-11-11' }, '2026-11-10')[0]!.message).toMatch(/cannot end after today/)
    expect(periodProblems({ from: '2026-11-05', to: '2026-11-01' }, '2026-11-10')[0]!.message).toBe('The period ends before it starts.')
    expect(periodProblems({ from: '2025-01-01', to: '2026-11-01' }, '2026-11-10')[0]!.message).toBe('A report covers at most 366 days.')
    expect(periodProblems({ from: '2026-02-30', to: '2026-11-01' }, '2026-11-10')[0]!.path).toBe('querystring/from')
  })

  it('the annual review takes a calendar year, up to today while it runs', () => {
    expect(yearPeriod(2025, '2026-11-10')).toEqual({ from: '2025-01-01', to: '2025-12-31' })
    expect(yearPeriod(2026, '2026-11-10')).toEqual({ from: '2026-01-01', to: '2026-11-10' })
    expect(yearProblems(2026, '2026-11-10')).toEqual([])
    expect(yearProblems(2027, '2026-11-10')[0]!.message).toBe('Give a year from 2020 to 2026.')
    expect(yearProblems(2019, '2026-11-10')).toHaveLength(1)
  })

  it('the months a period touches and its instants in Rome', () => {
    expect(monthsOf({ from: '2025-11-11', to: '2026-02-03' })).toEqual(['2025-11', '2025-12', '2026-01', '2026-02'])
    expect(monthsOf({ from: '2026-03-01', to: '2026-03-31' })).toEqual(['2026-03'])
    expect(spanOf({ from: '2026-11-01', to: '2026-11-30' })).toEqual({ start: new Date('2026-10-31T23:00:00.000Z'), end: new Date('2026-11-30T23:00:00.000Z') })
  })

  it('percent with one decimal, null for nothing; the median', () => {
    expect(pct(2, 3)).toBe('66.7')
    expect(pct(3, 3)).toBe('100.0')
    expect(pct(0, 0)).toBeNull()
    expect(median([])).toBeNull()
    expect(median([3, 1, 2])).toBe(2)
    expect(median([1, 2, 3, 4])).toBe(2.5)
  })
})

describe('compliance reports: ANA-025 certificate coverage', () => {
  it('a cell takes the certificate line\'s state (the worst of several) and whether a DoC language is missing', () => {
    expect(coverageCellOf('S1', 'IT', [line('certificate.coverage', 'OK', 'CERTIFICATE'), line('doc.languages', 'MISSING', 'DOC_LANGUAGE')])).toEqual({ styleId: 'S1', marketCode: 'IT', certificate: 'OK', docMissing: true })
    expect(coverageCellOf('S1', 'DE', [line('certificate.coverage', 'OK', 'CERTIFICATE', 'A'), line('certificate.coverage', 'MISSING', 'CERTIFICATE', 'B')]).certificate).toBe('MISSING')
    expect(coverageCellOf('S2', 'IT', [line('label.languages', 'OK', 'LABEL')])).toMatchObject({ certificate: null, docMissing: false })
  })

  it('covered over the cells that need a certificate; a cell without one is not counted; expiring still covers', () => {
    const cells = [{ certificate: 'OK' as const }, { certificate: 'EXPIRING' as const }, { certificate: 'MISSING' as const }, { certificate: 'NOT_NEEDED' as const }, { certificate: null }]
    expect(certificateCoverage(cells)).toEqual({ covered: 2, needing: 3, expiring: 1, pct: '66.7' })
    expect(certificateCoverage([{ certificate: null }])).toEqual({ covered: 0, needing: 0, expiring: 0, pct: null })
  })

  it('shipped pairs: covered by a valid certificate AND the DoC languages; a destination without a market or cell is unknown; a non-PPE pair is not counted', () => {
    const cells = [
      { styleId: 'S1', marketCode: 'IT', certificate: 'OK' as const, docMissing: false },
      { styleId: 'S1', marketCode: 'DE', certificate: 'OK' as const, docMissing: true },
      { styleId: 'S2', marketCode: 'IT', certificate: 'MISSING' as const, docMissing: false },
      { styleId: 'S3', marketCode: 'IT', certificate: null, docMissing: false },
    ]
    const shipped = [
      { styleId: 'S1', marketCode: 'IT' },
      { styleId: 'S1', marketCode: 'IT' },
      { styleId: 'S1', marketCode: 'DE' },
      { styleId: 'S2', marketCode: 'IT' },
      { styleId: 'S3', marketCode: 'IT' },
      { styleId: 'S1', marketCode: null },
      { styleId: 'S9', marketCode: 'IT' },
    ]
    expect(shippedCoverage(shipped, cells)).toEqual({ pairs: 6, needing: 3, covered: 1, unknown: 2, pct: '33.3' })
    expect(shippedCoverage([], cells).pct).toBeNull()
  })
})

describe('compliance reports: gaps by type', () => {
  it('each missing line by its requirement\'s kind; the operator\'s GPSR contact is an operator gap', () => {
    expect(gapTypeOf(line('certificate.gloveLevels', 'MISSING', 'CERTIFICATE'))).toBe('certificate')
    expect(gapTypeOf(line('userInfo.languages', 'MISSING', 'USER_INFO_LANGUAGE'))).toBe('docLanguage')
    expect(gapTypeOf(line('label.ceMarking', 'MISSING', 'LABEL'))).toBe('label')
    expect(gapTypeOf(line('gpsr.contact', 'MISSING', 'LABEL'))).toBe('operator')
    expect(gapTypeOf(line('textile.fibres', 'MISSING', 'DECLARATION'))).toBe('other')
  })

  it('counts, styles, markets, blocking and the requirements behind; Cr VI lots in their place; the total', () => {
    const rows = gapsByType(
      [
        missing('S1', 'IT', 'certificate.coverage', 'CERTIFICATE', 'CERT-COVERAGE'),
        missing('S1', 'DE', 'certificate.coverage', 'CERTIFICATE', 'CERT-COVERAGE'),
        missing('S2', 'DE', 'doc.languages', 'DOC_LANGUAGE', 'DOC-LANGUAGE', []),
        missing('S2', 'FR', 'userInfo.languages', 'USER_INFO_LANGUAGE', 'USER-INFO-LANGUAGE', []),
        missing('S2', 'FR', 'doc.languages', 'DOC_LANGUAGE', 'DOC-LANGUAGE', []),
        { ...missing('S3', 'IT', 'label.languages', 'LABEL'), state: 'OK' },
      ],
      2,
    )
    expect(rows.map((row) => row.type)).toEqual(['certificate', 'docLanguage', 'label', 'crVi', 'operator', 'other'])
    expect(rows[0]).toEqual({ type: 'certificate', count: 2, styles: 1, markets: 2, blocking: 2, requirements: ['CERT-COVERAGE'] })
    expect(rows[1]).toEqual({ type: 'docLanguage', count: 3, styles: 1, markets: 2, blocking: 0, requirements: ['DOC-LANGUAGE', 'USER-INFO-LANGUAGE'] })
    expect(rows[2]).toMatchObject({ type: 'label', count: 0 })
    expect(rows[3]).toEqual({ type: 'crVi', count: 2, styles: null, markets: null, blocking: null, requirements: [] })
    expect(openGaps(rows)).toBe(7)
    expect(gapsByType([], null).map((row) => row.type)).not.toContain('crVi')
  })
})

describe('compliance reports: chromium VI per supplier', () => {
  it('lots, median and highest of the measured values, fails, below detection, the limit; fails first', () => {
    const rows = crViBySupplier([
      { lotId: 'L1', supplierId: 'P1', value: 1.2, belowDetection: false, limit: 3, verdict: 'PASS', evidence: 'LOT_REPORT' },
      { lotId: 'L2', supplierId: 'P1', value: 2.4, belowDetection: false, limit: 3, verdict: 'PASS', evidence: 'SUPPLIER_REPORT' },
      { lotId: 'L3', supplierId: 'P1', value: null, belowDetection: true, limit: 3, verdict: 'PASS', evidence: 'LOT_REPORT' },
      { lotId: 'L4', supplierId: 'P2', value: 3.6, belowDetection: false, limit: 3, verdict: 'FAIL', evidence: 'LOT_REPORT' },
      { lotId: 'L5', supplierId: null, value: 0.8, belowDetection: false, limit: 3, verdict: 'PASS', evidence: 'LOT_REPORT' },
    ])
    expect(rows.map((row) => row.supplierId)).toEqual(['P2', 'P1', null])
    expect(rows[1]).toEqual({ supplierId: 'P1', lots: 3, results: 3, measured: 2, belowDetection: 1, median: 1.8, highest: 2.4, fails: 0, limit: 3, lotReports: 2, supplierReports: 1 })
    expect(rows[0]).toMatchObject({ fails: 1, highest: 3.6 })
  })
})

describe('compliance reports: the register', () => {
  const span = spanOf({ from: '2026-01-01', to: '2026-06-30' })
  const toDay = (instant: Date) => businessDate(instant)
  it('per kind: opened and closed in the period, open at its end, the median days to close, the months', () => {
    const facts = [
      { kind: 'COMPLAINT' as const, reportedAt: new Date('2026-01-10T09:00:00Z'), closedAt: new Date('2026-01-20T09:00:00Z') },
      { kind: 'COMPLAINT' as const, reportedAt: new Date('2026-02-01T09:00:00Z'), closedAt: new Date('2026-02-05T09:00:00Z') },
      { kind: 'COMPLAINT' as const, reportedAt: new Date('2026-03-01T09:00:00Z'), closedAt: null },
      { kind: 'COMPLAINT' as const, reportedAt: new Date('2025-12-15T09:00:00Z'), closedAt: new Date('2026-07-15T09:00:00Z') },
      { kind: 'RECALL' as const, reportedAt: new Date('2026-07-01T09:00:00Z'), closedAt: null },
    ]
    const { rows, total } = registerSummary(facts, span, monthsOf({ from: '2026-01-01', to: '2026-06-30' }), toDay)
    expect(rows.map((row) => row.kind)).toEqual(['COMPLAINT', 'NON_CONFORMITY', 'RECALL', 'WITHDRAWAL', 'AUTHORITY_REQUEST'])
    expect(rows[0]).toEqual({ kind: 'COMPLAINT', opened: 3, closed: 2, openAtEnd: 2, medianDaysToClose: '7.0', months: [1, 1, 1, 0, 0, 0] })
    expect(rows[2]).toMatchObject({ opened: 0, openAtEnd: 0, medianDaysToClose: null })
    expect(total).toMatchObject({ opened: 3, closed: 2, openAtEnd: 2 })
  })

  it('an authority request is answered on time by the end of its due day in Rome', () => {
    expect(answeredOnTime({ answeredAt: new Date('2026-11-13T22:30:00Z'), dueOn: '2026-11-13' })).toBe(true)
    expect(answeredOnTime({ answeredAt: new Date('2026-11-13T23:30:00Z'), dueOn: '2026-11-13' })).toBe(false)
    expect(answeredOnTime({ answeredAt: null, dueOn: '2026-11-13' })).toBe(false)
  })
})
