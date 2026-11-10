import { describe, expect, it } from 'vitest'
import { REGISTER_KINDS as DOMAIN_REGISTER_KINDS } from '@nexus/factory-domain/compliance/register/rules'
import { GAP_TYPES as DOMAIN_GAP_TYPES, KPI_KEYS as DOMAIN_KPI_KEYS, KPI_SIGHTS } from '@nexus/factory-domain/compliance/reports/rules'
import { COMPLIANCE_GATES } from '@nexus/factory-domain/compliance/requirements/rules'
import { GAP_TYPES, GATES, KPI_KEYS, REGISTER_KINDS } from './api'
import { CR6, EXPIRIES, GAPS, KPIS, REGISTER } from './fixtures'
import {
  cr6CsvRows,
  defaultRange,
  expiryCsvRows,
  expiryHref,
  failedLotsHref,
  gapCsvRows,
  gapHref,
  KPI_SIGHT,
  kpiCsvRows,
  kpiValueText,
  mgText,
  monthLabel,
  pctText,
  rangeShown,
  registerCsvRows,
  registerHref,
  reportsAddressOf,
  reportsAddressText,
  reportsCan,
  reviewAddress,
  reviewAddressOf,
  reviewYears,
  reviewYearsAll,
  romeToday,
  supplierHref,
  tileHeld,
  tileHref,
  yearRange,
} from './model'

const params = (text: string) => new URLSearchParams(text)
const ALL = reportsCan(['compliance.reports.view', 'compliance.certificates.view', 'compliance.register.view', 'quality.lots.view', 'shipping.view', 'parties.view'])
const BUILT = new Set(['/compliance/certificates', '/compliance/register', '/compliance/tests', '/compliance/labels', '/warehouse/shipments', '/purchasing/suppliers/[partyId]', '/compliance/certificates/[id]'])
const BRAND = '0190f0e2-7202-7000-8000-000000000001'

describe('compliance reports: the lists match the domain', () => {
  it('headline numbers, their sights, gap types, gates and register kinds are the API\'s', () => {
    expect(KPI_KEYS).toEqual(DOMAIN_KPI_KEYS)
    expect(GAP_TYPES).toEqual(DOMAIN_GAP_TYPES)
    expect(GATES).toEqual(COMPLIANCE_GATES)
    expect(REGISTER_KINDS).toEqual(DOMAIN_REGISTER_KINDS)
    expect(KPI_SIGHT).toEqual(KPI_SIGHTS)
  })
})

describe('compliance reports: the address', () => {
  it('reads and writes the period and the brand; anything else is dropped', () => {
    const address = reportsAddressOf(params(`from=2026-01-01&to=2026-06-30&brand=${BRAND}&worker=x`))
    expect(address).toEqual({ from: '2026-01-01', to: '2026-06-30', brandId: BRAND })
    expect(reportsAddressText(address)).toBe(`?from=2026-01-01&to=2026-06-30&brand=${BRAND}`)
    expect(reportsAddressOf(params('from=bad&brand=nope'))).toEqual({ from: null, to: null, brandId: null })
    expect(reportsAddressText(reportsAddressOf(params('')))).toBe('')
  })

  it('the period shown: the address, else the answer, else the 365 days up to today', () => {
    const now = new Date(2026, 10, 10, 12)
    expect(defaultRange(now)).toEqual({ from: '2025-11-11', to: '2026-11-10' })
    expect(rangeShown({ from: null, to: null }, { from: '2026-01-01', to: '2026-11-10' }, now)).toEqual({ from: '2026-01-01', to: '2026-11-10' })
    expect(rangeShown({ from: '2026-03-01', to: null }, null, now)).toEqual({ from: '2026-03-01', to: '2026-11-10' })
  })

  it('the annual review: its address, its year (this year when none), its days, the years offered', () => {
    expect(reviewAddress('/w/DEMO', 2026, BRAND)).toBe(`/w/DEMO/compliance/reports/print?year=2026&brand=${BRAND}`)
    expect(reviewAddressOf(params('year=2025'), '2026-11-10')).toEqual({ year: 2025, brandId: null })
    expect(reviewAddressOf(params('year=2031'), '2026-11-10').year).toBe(2026)
    expect(reviewAddressOf(params(''), '2026-11-10').year).toBe(2026)
    expect(yearRange(2026, '2026-11-10')).toEqual({ from: '2026-01-01', to: '2026-11-10' })
    expect(yearRange(2025, '2026-11-10')).toEqual({ from: '2025-01-01', to: '2025-12-31' })
    expect(reviewYears('2026-11-10')).toEqual([2026, 2025])
    expect(reviewYearsAll('2026-11-10')).toEqual([2026, 2025, 2024, 2023, 2022, 2021, 2020])
    expect(romeToday(new Date('2026-11-10T23:30:00Z'))).toBe('2026-11-11')
  })
})

describe('compliance reports: figures in words', () => {
  it('percent, counts and mg/kg; nothing is "—", never 0', () => {
    expect(pctText('91.7', 'en')).toBe('91.7 %')
    expect(pctText('91.7', 'it')).toBe('91,7 %')
    expect(pctText(null, 'en')).toBe('—')
    expect(mgText('1.2', 'it')).toBe('1,2')
    expect(mgText(null, 'en')).toBe('—')
    expect(kpiValueText('coverage', KPIS.kpis, 'en')).toBe('91.7 %')
    expect(kpiValueText('gaps', KPIS.kpis, 'en')).toBe('23')
    expect(kpiValueText('refusals', { ...KPIS.kpis, refusals: null }, 'en')).toBe('—')
    expect(monthLabel('2027-02', 'en')).toMatch(/Feb.*2027/)
  })
})

describe('compliance reports: where each number leads', () => {
  it('each tile opens its list once built and in the role; the refusals wait for the status board', () => {
    expect(tileHref('coverage', '/w/DEMO', ALL, BUILT)).toBe('/w/DEMO/compliance/certificates?view=valid')
    expect(tileHref('coverage', '/w/DEMO', ALL, new Set([...BUILT, '/compliance/status']))).toBe('/w/DEMO/compliance/status')
    expect(tileHref('gaps', '/w/DEMO', ALL, BUILT)).toBe('#fw-cr-gaps')
    expect(tileHref('registerOpen', '/w/DEMO', ALL, BUILT)).toBe('/w/DEMO/compliance/register?view=open')
    expect(tileHref('crViLots', '/w/DEMO', ALL, BUILT)).toBe('/w/DEMO/compliance/tests?view=released')
    expect(tileHref('shipped', '/w/DEMO', ALL, BUILT)).toBe('/w/DEMO/warehouse/shipments')
    expect(tileHref('refusals', '/w/DEMO', ALL, BUILT)).toBeNull()
    expect(tileHeld('refusals', ALL, BUILT)).toBe('tile.held.board')
    expect(tileHref('registerOpen', '/w/DEMO', { ...ALL, register: false }, BUILT)).toBeNull()
    expect(tileHeld('registerOpen', { ...ALL, register: false }, BUILT)).toBe('tile.held.noList')
    expect(tileHeld('coverage', ALL, BUILT)).toBeNull()
  })

  it('a gap opens where it is fixed (the board once built); a page not built opens nothing', () => {
    expect(gapHref('certificate', '/w/DEMO', ALL, BUILT)).toBe('/w/DEMO/compliance/certificates')
    expect(gapHref('crVi', '/w/DEMO', ALL, BUILT)).toBe('/w/DEMO/compliance/tests?view=waiting')
    expect(gapHref('docLanguage', '/w/DEMO', ALL, BUILT)).toBeNull()
    expect(gapHref('other', '/w/DEMO', ALL, BUILT)).toBeNull()
    expect(gapHref('label', '/w/DEMO', ALL, new Set([...BUILT, '/compliance/status']))).toBe('/w/DEMO/compliance/status?gap=label')
  })

  it('a chip opens its record (its page, else its panels); a supplier, the failed lots, a register kind', () => {
    const certificate = EXPIRIES.months.flatMap((month) => month.items).find((item) => item.recordType === 'Certificate')!
    expect(expiryHref(certificate, '/w/DEMO', BUILT)).toBe(`/w/DEMO/compliance/certificates/${certificate.recordId}`)
    const declaration = EXPIRIES.months.flatMap((month) => month.items).find((item) => item.recordType === 'SupplierDeclarationRequest')!
    expect(expiryHref(declaration, '/w/DEMO', BUILT)).toMatch(new RegExp(`^/w/DEMO/records/SupplierDeclarationRequest/${declaration.recordId}\\?label=`))
    expect(supplierHref(CR6.suppliers[0]!.party, '/w/DEMO', ALL, BUILT)).toBe(`/w/DEMO/purchasing/suppliers/${CR6.suppliers[0]!.party!.id}`)
    expect(supplierHref(CR6.suppliers[0]!.party, '/w/DEMO', { ...ALL, suppliers: false }, BUILT)).toBeNull()
    expect(failedLotsHref('/w/DEMO', ALL, BUILT)).toBe('/w/DEMO/compliance/tests?view=failed')
    expect(registerHref('COMPLAINT', '/w/DEMO', ALL, true, BUILT)).toBe('/w/DEMO/compliance/register?view=open&kind=COMPLAINT')
    expect(registerHref('WITHDRAWAL', '/w/DEMO', ALL, false, BUILT)).toBe('/w/DEMO/compliance/register')
    expect(registerHref('RECALL', '/w/DEMO', { ...ALL, register: false }, false, BUILT)).toBeNull()
  })
})

describe('compliance reports: the files', () => {
  it('each panel\'s rows as a file', () => {
    expect(kpiCsvRows(KPIS, { coverage: 'Coverage' }, 'en')[0]).toEqual(['Coverage', '91.7 %', 44, 48])
    expect(gapCsvRows(GAPS.rows, { docLanguage: 'DoC' })[1]).toEqual(['DoC', 12, 5, 3, 2, 'DOC-LANGUAGE USER-INFO-LANGUAGE USER-INFO-DE'])
    expect(expiryCsvRows(EXPIRIES)).toHaveLength(EXPIRIES.count)
    expect(cr6CsvRows(CR6, { none: 'none' }, 'en')[2]).toEqual(['none', 1, '—', '—', '3', 0, 1, 1, 0])
    expect(registerCsvRows(REGISTER, { COMPLAINT: 'Complaints' }, 'en')[0]!.slice(0, 5)).toEqual(['Complaints', 14, 12, 3, '9.5'])
  })
})
