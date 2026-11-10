import { describe, expect, it } from 'vitest'
import { contactEmail, operatorProblems, overlapOf, overlapWords, resolveOperators, type OperatorRow } from './rules'

// Every name, address and id here is made up.
let next = 0
const row = (over: Partial<OperatorRow>): OperatorRow => ({
  id: `row-${++next}`,
  companyId: null,
  styleId: null,
  brandPartyId: null,
  marketCode: null,
  role: 'MANUFACTURER',
  partyId: null,
  printedName: 'Test S.r.l.',
  printedAddress: 'Via Test 1, 00000 Testville',
  contact: null,
  validFrom: '2026-01-01',
  validTo: null,
  ...over,
})

const company = row({ companyId: 'A', printedName: 'Test Company A' })
const tenant = row({ printedName: 'Test Tenant default' })
const brand = row({ brandPartyId: 'P1', partyId: 'P1', printedName: 'Test Brand One', contact: 'compliance@brand.example' })
const styleCh = row({ styleId: 'S1', marketCode: 'CH', role: 'DISTRIBUTOR', partyId: 'P3', printedName: 'Test Distributor CH', validFrom: '2026-06-01', validTo: '2027-05-31' })
const importerUk = row({ companyId: 'A', marketCode: 'UK', role: 'IMPORTER', partyId: 'P9', printedName: 'Test Importer UK' })
const rows = [company, tenant, brand, styleCh, importerUk]
const target = { styleId: 'S1', companyId: 'A', brandPartyId: null, soldUnderOurName: false, marketCode: null, day: '2026-11-10' }
const names = (resolved: ReturnType<typeof resolveOperators>) => Object.fromEntries(resolved.map((entry) => [entry.role, `${entry.row.printedName}/${entry.level}`]))

describe('economic operators per style and market (B-W2b-249; PRD-298)', () => {
  it('takes the most specific row: style, brand, company, tenant; a market row only for its market', () => {
    expect(names(resolveOperators(rows, target))).toEqual({ MANUFACTURER: 'Test Company A/COMPANY' })
    expect(names(resolveOperators(rows, { ...target, marketCode: 'CH' }))).toEqual({ MANUFACTURER: 'Test Company A/COMPANY', DISTRIBUTOR: 'Test Distributor CH/STYLE' })
    expect(names(resolveOperators(rows, { ...target, marketCode: 'UK' }))).toEqual({ MANUFACTURER: 'Test Company A/COMPANY', IMPORTER: 'Test Importer UK/COMPANY' })
    expect(names(resolveOperators(rows, { ...target, companyId: 'B' }))).toEqual({ MANUFACTURER: 'Test Tenant default/TENANT' })
    // Out of its days, the CH distributor no longer applies.
    expect(names(resolveOperators(rows, { ...target, marketCode: 'CH', day: '2027-06-01' }))).toEqual({ MANUFACTURER: 'Test Company A/COMPANY' })
  })

  it('Owner question 3: a brand style sold under the brand\'s name has the brand as manufacturer; under our name, our company', () => {
    expect(names(resolveOperators(rows, { ...target, brandPartyId: 'P1' }))).toEqual({ MANUFACTURER: 'Test Brand One/BRAND' })
    expect(names(resolveOperators(rows, { ...target, brandPartyId: 'P1', soldUnderOurName: true }))).toEqual({ MANUFACTURER: 'Test Company A/COMPANY' })
  })

  it('refuses a second row of the same scope, market and role on overlapping days, in words', () => {
    const later = row({ styleId: 'S1', marketCode: 'CH', role: 'DISTRIBUTOR', partyId: 'P4', validFrom: '2027-01-01' })
    expect(overlapOf(later, rows)).toBe(styleCh)
    expect(overlapOf({ ...later, validFrom: '2027-06-01' }, rows)).toBeNull()
    expect(overlapOf({ ...later, marketCode: 'DE' }, rows)).toBeNull()
    expect(overlapOf(styleCh, rows)).toBeNull()
    expect(overlapWords(styleCh, 'Style TEST-JKT-01')).toBe(
      'Style TEST-JKT-01 already has a distributor for market CH from 2026-06-01 to 2027-05-31 (Test Distributor CH): give that one a last day before this one starts, or change the days.',
    )
  })

  it('checks a row in words: a party for every role but the manufacturer, a style or a brand, days in order', () => {
    expect(operatorProblems({ role: 'IMPORTER', printedName: 'x', printedAddress: 'y', validFrom: '2026-01-01' }, true).map((issue) => issue.path)).toEqual(['body/partyId'])
    expect(operatorProblems({ role: 'MANUFACTURER', styleId: 's', brandPartyId: 'b' }, true).map((issue) => issue.path)).toEqual(['body/brandPartyId'])
    expect(operatorProblems({ validFrom: '2026-02-01', validTo: '2026-01-31' }, true).map((issue) => issue.path)).toEqual(['body/validTo'])
    expect(operatorProblems({ marketCode: 'uk' }, true).map((issue) => issue.path)).toEqual(['body/marketCode'])
  })

  it('reads an e-mail contact for the public page, nothing else', () => {
    expect(contactEmail(' compliance@brand.example ')).toBe('compliance@brand.example')
    expect(contactEmail('https://brand.example/contact')).toBeNull()
    expect(contactEmail(null)).toBeNull()
  })
})
