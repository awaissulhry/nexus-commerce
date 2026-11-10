import { describe, expect, it } from 'vitest'
import { certificateGate, type GateCover, type SizeGateRequest } from '../cert-gate/gate'
import { bodyProblems, certificateKindOf, cleanScopes, nandoLink, scopeCheck } from './bodies'
import { boughtInCheck, countsForSupplier, supplierProblems, type PartCoverage } from './bought-in'
import { cleanLevels, gloveMarking, levelFamilyOf, levelsProblems, orderedLevels, sameLevels } from './levels'
import { baseGateWords, baseStanding, outlivesBase, ownBrandProblems, sameStandard, type OwnBrandFacts } from './own-brand'
import { fiveYearCheck, fiveYearRefusal, spanBetween, spanWords, validitySpan } from './validity'

describe('the five-year check (PRD-282, Annex V 6.1)', () => {
  it('counts the last valid day in: 12 Mar 2024 to 11 Mar 2029 is five years', () => {
    expect(validitySpan('2024-03-12', '2029-03-11')).toEqual({ years: 5, months: 0, days: 0 })
    expect(fiveYearCheck('2024-03-12', '2029-03-11')).toMatchObject({ state: 'OK', latest: '2029-03-12', over: null })
  })

  it('allows the same day five years on (W1 and the database agree), refuses a day later', () => {
    expect(fiveYearCheck('2024-03-12', '2029-03-12').state).toBe('OK')
    expect(fiveYearCheck('2024-03-12', '2029-03-13')).toMatchObject({ state: 'TOO_LONG', over: { years: 0, months: 0, days: 1 } })
  })

  it('says by how much a validity is too long (the design: "5 years and 2 months")', () => {
    const check = fiveYearCheck('2024-01-01', '2029-02-28')
    expect(check.state).toBe('TOO_LONG')
    expect(check.span).toEqual({ years: 5, months: 2, days: 0 })
    expect(spanWords(check.span!)).toBe('5 years and 2 months')
    expect(fiveYearRefusal('2024-01-01', '2029-02-28')).toContain('Valid to is 5 years and 2 months after Valid from')
    expect(fiveYearRefusal('2024-01-01', '2028-12-31')).toBeNull()
  })

  it('keeps 29 February to 28 February five years on', () => {
    expect(fiveYearCheck('2024-02-29', '2029-02-28').state).toBe('OK')
    expect(fiveYearCheck('2024-02-29', '2029-03-01').state).toBe('TOO_LONG')
  })

  it('names dates out of order or missing apart', () => {
    expect(fiveYearCheck('2026-05-01', '2026-04-30').state).toBe('ORDER')
    expect(fiveYearCheck('2026-05-01', '').state).toBe('INCOMPLETE')
    expect(fiveYearCheck(null, '2026-05-01')).toMatchObject({ state: 'INCOMPLETE', latest: null })
  })

  it('counts months the calendar way', () => {
    expect(spanBetween('2026-01-31', '2026-03-01')).toEqual({ years: 0, months: 1, days: 1 })
    expect(spanBetween('2026-03-12', '2026-05-11')).toEqual({ years: 0, months: 1, days: 29 })
    expect(spanWords({ years: 1, months: 0, days: 3 })).toBe('1 year and 3 days')
  })
})

describe('the notified body directory (PRD-286)', () => {
  it('checks a body as the database does, field by field', () => {
    expect(bodyProblems({ number: '0498', name: 'Demo Lab', address: 'Via Demo 1\n00100 Roma', country: 'IT', nandoUrl: 'https://example.org/nando/0498', scopes: ['Regulation (EU) 2016/425 – protective clothing'], contactEmail: 'lab@example.org' })).toEqual([])
    const problems = bodyProblems({ number: '498', name: ' ', address: 'x', country: 'Italy', nandoUrl: 'http://example.org', scopes: ['a', 'A'], contactEmail: 'nope' })
    expect(problems.map((problem) => problem.path)).toEqual(['number', 'name', 'country', 'nandoUrl', 'scopes/1', 'contactEmail'])
  })

  it('leaves out fields an edit does not send', () => {
    expect(bodyProblems({ note: null })).toEqual([])
    expect(bodyProblems({ nandoUrl: '' })).toEqual([])
  })

  it('stores scopes trimmed and once', () => {
    expect(cleanScopes([' PPE gloves ', '', 'ppe gloves', 'PPE clothing'])).toEqual(['PPE gloves', 'PPE clothing'])
  })

  it('says whether the body is listed for the kind of product (a warning, never a refusal)', () => {
    expect(scopeCheck(['Regulation (EU) 2016/425 – protective clothing'], 'GARMENT')).toMatchObject({ state: 'LISTED', scope: 'Regulation (EU) 2016/425 – protective clothing' })
    expect(scopeCheck(['Regulation (EU) 2016/425 – equipment against mechanical impact'], 'PROTECTOR').state).toBe('LISTED')
    expect(scopeCheck(['Regulation (EU) 2016/425 – protective gloves'], 'GLOVE').state).toBe('LISTED')
    expect(scopeCheck(['Directive 2014/53/EU – radio equipment'], 'GARMENT').state).toBe('NOT_LISTED')
    expect(scopeCheck(['Protective clothing'], 'GARMENT').state).toBe('NOT_LISTED')
    expect(scopeCheck([], 'GARMENT').state).toBe('NO_SCOPES')
  })

  it('reads the kind from the standard and offers only an https NANDO link', () => {
    expect(certificateKindOf('EN 17092-4:2020')).toBe('GARMENT')
    expect(certificateKindOf('EN 1621-1:2012')).toBe('PROTECTOR')
    expect(certificateKindOf('EN 13594:2015')).toBe('GLOVE')
    expect(certificateKindOf('EN ISO 13688:2013')).toBe('OTHER')
    expect(nandoLink('https://example.org/x')).toBe('https://example.org/x')
    expect(nandoLink('javascript:alert(1)')).toBeNull()
    expect(nandoLink(null)).toBeNull()
  })
})

describe('performance levels (PRD-290 gloves, EN 1621 zones)', () => {
  it('knows which standards take levels', () => {
    expect(levelFamilyOf('EN 13594:2015')).toBe('EN13594')
    expect(levelFamilyOf('EN 1621-1:2012')).toBe('EN1621-1')
    expect(levelFamilyOf('EN 1621-2:2014')).toBe('EN1621-2')
    expect(levelFamilyOf('EN 1621-3:2018')).toBe('EN1621-3')
    expect(levelFamilyOf('EN 17092-4:2020')).toBeNull()
  })

  it('takes a glove level with knuckle protection, and words its marking', () => {
    expect(levelsProblems('EN 13594:2015', null, { level: '2', knuckle: 'KP' })).toEqual([])
    expect(gloveMarking({ level: '2', knuckle: 'KP' })).toBe('2KP')
    expect(gloveMarking({ level: '1' })).toBe('1')
    expect(gloveMarking(null)).toBeNull()
  })

  it('refuses unknown properties, values outside the vocabulary and a missing required level', () => {
    expect(levelsProblems('EN 13594:2015', null, { level: '3' }).map((problem) => problem.path)).toEqual(['levels/level'])
    expect(levelsProblems('EN 13594:2015', null, { knuckle: 'KP' }).map((problem) => problem.path)).toEqual(['levels/level'])
    expect(levelsProblems('EN 13594:2015', null, { level: '1', colour: 'red' }).map((problem) => problem.path)).toEqual(['levels/colour'])
    expect(levelsProblems('EN 17092-4:2020', 'A', { level: '1' }).map((problem) => problem.path)).toEqual(['levels'])
  })

  it('asks an EN 1621-1 protector for at least one zone', () => {
    expect(levelsProblems('EN 1621-1:2012', '2', { shoulder: '2', type: 'B' })).toEqual([])
    expect(levelsProblems('EN 1621-1:2012', '2', { type: 'B' }).map((problem) => problem.path)).toEqual(['levels'])
  })

  it('keeps the class and the level saying the same', () => {
    expect(levelsProblems('EN 1621-2:2014', '1', { back: '2', backArea: 'CB' }).map((problem) => problem.path)).toEqual(['levels'])
    expect(levelsProblems('EN 13594:2015', '2', { level: '2' })).toEqual([])
  })

  it('stores levels trimmed without empties, ordered as the vocabulary', () => {
    expect(cleanLevels({ level: ' 2 ', knuckle: '' })).toEqual({ level: '2' })
    expect(cleanLevels({ level: '' })).toBeNull()
    expect(orderedLevels('EN 1621-1:2012', { type: 'A', knee: '1', shoulder: '2' }).map((entry) => entry.key)).toEqual(['shoulder', 'knee', 'type'])
    expect(sameLevels({ knuckle: 'KP', level: '2' }, { level: '2', knuckle: 'KP' })).toBe(true)
    expect(sameLevels({ level: '2' }, { level: '2', knuckle: 'KP' })).toBe(false)
    expect(sameLevels(null, null)).toBe(true)
  })
})

describe('own-brand certificates (PRD-287)', () => {
  const base = { id: 'b', number: 'CERT-F', standard: 'EN 17092-4:2020', companyId: 'company', holderPartyId: null, baseCertificateId: null, status: 'VALID' as const, validFrom: '2025-01-01', validTo: '2029-12-31' }
  const facts = (over: Partial<OwnBrandFacts> = {}): OwnBrandFacts => ({ certificate: { id: 'c', number: 'CERT-B', standard: 'EN 17092-4:2020', holderPartyId: 'brand' }, holderIsBrand: true, restingOnThis: 0, base, ...over })

  it("lets a brand's certificate rest on the factory's own", () => {
    expect(ownBrandProblems(facts())).toEqual([])
  })

  it('refuses what the database refuses, in words first', () => {
    expect(ownBrandProblems(facts({ base: { ...base, id: 'c' } }))).toHaveLength(1)
    expect(ownBrandProblems(facts({ holderIsBrand: false }))).toHaveLength(1)
    expect(ownBrandProblems(facts({ base: { ...base, holderPartyId: 'brand', companyId: null } }))).toHaveLength(1)
    expect(ownBrandProblems(facts({ base: { ...base, baseCertificateId: 'x' } }))).toHaveLength(1)
    expect(ownBrandProblems(facts({ restingOnThis: 1 }))).toHaveLength(1)
    expect(ownBrandProblems(facts({ base: { ...base, status: 'WITHDRAWN' } }))[0]!.message).toContain('withdrawn')
  })

  it('says whether the base holds on a day', () => {
    expect(baseStanding(base, '2026-06-01').state).toBe('HOLDS')
    expect(baseStanding({ ...base, status: 'SUSPENDED' }, '2026-06-01').state).toBe('SUSPENDED')
    expect(baseStanding(base, '2030-01-01').state).toBe('EXPIRED')
    expect(baseStanding(base, '2024-12-31').state).toBe('NOT_YET')
    expect(baseStanding({ ...base, status: 'DRAFT' }, '2026-06-01').state).toBe('NOT_REGISTERED')
    expect(baseGateWords('Certificate CERT-B', baseStanding({ ...base, status: 'SUSPENDED' }, '2026-06-01'))).toContain('rests on the factory')
    expect(baseGateWords('Certificate CERT-B', baseStanding(base, '2026-06-01'))).toBeNull()
  })

  it('tells how long the brand certificate outlives its base, and whether the standards match', () => {
    expect(outlivesBase({ validTo: '2030-01-10' }, base)).toBe(10)
    expect(outlivesBase({ validTo: '2029-01-10' }, base)).toBe(0)
    expect(sameStandard('EN 17092-4:2020', ' en  17092-4:2020')).toBe(true)
  })

  it('makes the gate refuse a garment the brand certificate covers while its base is suspended', () => {
    const cover = (status: 'VALID' | 'SUSPENDED'): GateCover => ({
      coverageId: 'cov',
      colourwayIds: [],
      sizes: [],
      allowsMadeToMeasure: false,
      certificate: { id: 'c', number: 'CERT-B', standard: 'EN 17092-4:2020', ppeClass: 'A', notifiedBodyName: 'Demo', notifiedBodyNumber: '0000', validFrom: '2025-01-01', validTo: '2029-06-30', status: 'VALID', base: { number: 'CERT-F', status, validFrom: '2025-01-01', validTo: '2029-12-31' } },
    })
    const request = (status: 'VALID' | 'SUSPENDED'): SizeGateRequest => ({ style: { id: 's', code: 'JKT', ppeCategory: 'CATEGORY_II', sizes: ['50'], mtmAllowed: false }, colourwayId: 'cw', size: '50', date: '2026-06-01', covers: [cover(status)] })
    expect(certificateGate(request('VALID')).outcome).toBe('covered')
    const refused = certificateGate(request('SUSPENDED'))
    expect(refused.outcome).toBe('refused')
    expect(refused.outcome === 'refused' && refused.reasons[0]!.message).toContain('CERT-F, which is suspended')
  })
})

describe('bought-in parts (QHS-106)', () => {
  const certificate = { id: 'c1', number: 'CERT-P', standard: 'EN 1621-1:2012', ppeClass: '2', status: 'VALID' as const, validFrom: '2025-01-01', validTo: '2029-12-31' }
  const coverage = (over: Partial<PartCoverage> = {}): PartCoverage => ({ coverageId: 'k1', supplierPartyId: 'p2', supplierArticleCode: 'P2-SHD-L2', status: 'ACTIVE', certificate, ...over })

  it('covers a lot of the named supplier', () => {
    expect(boughtInCheck([coverage()], 'p2', '2026-06-01')).toMatchObject({ state: 'COVERED', coverage: { coverageId: 'k1' } })
  })

  it("never covers a lot from another supplier with this supplier's certificate", () => {
    expect(boughtInCheck([coverage()], 'p9', '2026-06-01')).toMatchObject({ state: 'OTHER_SUPPLIER', otherSuppliers: ['p2'] })
  })

  it('still covers the part from any supplier when the coverage names none (W1)', () => {
    expect(boughtInCheck([coverage({ supplierPartyId: null, supplierArticleCode: null })], 'p9', '2026-06-01').state).toBe('COVERED_ANY_SUPPLIER')
  })

  it('says why a named certificate does not hold, and when nothing covers the part', () => {
    expect(boughtInCheck([coverage({ certificate: { ...certificate, status: 'SUSPENDED' } })], 'p2', '2026-06-01')).toMatchObject({ state: 'NOT_VALID', why: 'SUSPENDED' })
    expect(boughtInCheck([coverage()], 'p2', '2030-06-01')).toMatchObject({ state: 'NOT_VALID', why: 'EXPIRED' })
    expect(boughtInCheck([coverage({ status: 'ARCHIVED' })], 'p2', '2026-06-01').state).toBe('NO_CERTIFICATE')
    expect(boughtInCheck([], 'p2', '2026-06-01').state).toBe('NO_CERTIFICATE')
  })

  it('names a supplier once, only on a part, only a supplier, its article code with it', () => {
    const draft = { isItem: true, current: null, supplierPartyId: 'p2', supplierArticleCode: 'P2-SHD-L2', isSupplier: true }
    expect(supplierProblems(draft)).toEqual([])
    expect(supplierProblems({ ...draft, isItem: false }).map((problem) => problem.path)).toEqual(['supplierPartyId'])
    expect(supplierProblems({ ...draft, current: 'p1' }).map((problem) => problem.path)).toEqual(['supplierPartyId'])
    expect(supplierProblems({ ...draft, isSupplier: false }).map((problem) => problem.path)).toEqual(['supplierPartyId'])
    expect(supplierProblems({ ...draft, supplierArticleCode: 'x'.repeat(101) }).map((problem) => problem.path)).toEqual(['supplierArticleCode'])
    expect(countsForSupplier({ supplierPartyId: null }, 'p9')).toBe(true)
    expect(countsForSupplier({ supplierPartyId: 'p2' }, 'p9')).toBe(false)
  })
})
