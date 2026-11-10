import { describe, expect, it } from 'vitest'
import { applicability, evaluateMaterial, judgeRule, styleRollUp, svhcAnswer, type DeclarationFact, type EvaluationInput, type RuleFacts, type StyleUse } from './evaluate'
import { planRuleRow, planSubstanceRow, readValues, substanceRecordValues, substanceRulesImporter, substancesImporter } from './importer'
import { SUBSTANCES_ADDS, SUBSTANCES_MANAGE } from './permissions'
import { casOk, ecOk, limitWords, ruleProblems, SUBSTANCE_LISTS, substanceProblems, switchRefusal } from './rules'
import { STARTER_RULES, STARTER_SUBSTANCES } from './starter'

/** B-W2b-250: the substance list's rules, the evaluator and the imports (pure). Every id, code and answer is made up. */

const rule = (over: Partial<RuleFacts> = {}): RuleFacts => ({
  id: '00000000-0000-7000-8000-000000000001',
  key: 'REACH-XVII-43',
  code: 'AZO',
  name: 'Azo colourants',
  companyId: null,
  substanceId: null,
  substanceGroup: 'AZO_AMINES',
  materialKinds: ['LEATHER', 'TEXTILE', 'LINING'],
  productTypes: [],
  marketCodes: [],
  limitValue: '30',
  limitUnit: 'MG_KG',
  limitBound: 'AT_MOST',
  testMethod: 'EN ISO 17234-1',
  evidence: 'EITHER',
  exemptPpe: false,
  exemptNaturalLeather: false,
  source: 'LAW',
  customerPartyId: null,
  legalReference: 'REACH Annex XVII entry 43',
  switchedOn: true,
  offReason: null,
  status: 'ACTIVE',
  substanceIds: ['00000000-0000-7000-8000-0000000000a1'],
  ...over,
})
const jacket: StyleUse = { styleId: '00000000-0000-7000-8000-0000000000s1', code: 'JKT-01', productType: 'JACKET', ppeCategory: 'CATEGORY_II', brandPartyId: null, companyId: 'c-a' }
const fashion: StyleUse = { styleId: '00000000-0000-7000-8000-0000000000s2', code: 'TEE-01', productType: 'OTHER', ppeCategory: 'NOT_PPE', brandPartyId: 'brand-1', companyId: 'c-a' }
const v1 = { id: 'v-1', publishedOn: '2026-01-15', entryCount: 250 }
const v2 = { id: 'v-2', publishedOn: '2026-07-01', entryCount: 253 }
const declaration = (over: Partial<DeclarationFact> = {}): DeclarationFact => ({
  requestId: '00000000-0000-7000-8000-0000000000d1',
  number: 'SD-2026-0001',
  kind: 'RSL',
  status: 'ACCEPTED',
  dueOn: '2026-10-19',
  validTo: null,
  decidedAt: '2026-10-13T09:30:00.000Z',
  svhcListVersionId: null,
  answeredListVersionId: null,
  lines: [{ contains: false, aboveThreshold: null, substanceId: null, substanceName: null }],
  ...over,
})
const input = (over: Partial<EvaluationInput> = {}): EvaluationInput => ({
  material: { id: 'm-1', code: 'LEA-100', name: 'Bovine leather', kind: 'TEXTILE', companyId: 'c-a' },
  uses: [jacket],
  markets: ['IT', 'DE'],
  rules: [rule()],
  tests: [],
  declarations: [],
  listVersions: [v1, v2],
  svhcSubstanceIds: new Set(['dehp']),
  saved: null,
  today: '2026-11-10',
  ...over,
})

describe('the substance list (PRD-318)', () => {
  it('checks CAS and EC check digits as the database does', () => {
    expect(casOk('50-32-8')).toBe(true)
    expect(casOk('50-32-7')).toBe(false)
    expect(casOk('18540-29-9')).toBe(true)
    expect(ecOk('200-028-5')).toBe(true)
    expect(ecOk('200-028-4')).toBe(false)
    expect(substanceProblems({ casNumber: '50-32-7', lists: ['REACH_ANNEX_XVII'], annexXviiEntries: ['50'] }).map((issue) => issue.path)).toEqual(['body/casNumber'])
    expect(substanceProblems({ lists: ['SVHC'], annexXviiEntries: ['43'] }).map((issue) => issue.path)).toEqual(['body/annexXviiEntries'])
    expect(substanceProblems({ lists: ['REACH_ANNEX_XVII'], annexXviiEntries: [] }).map((issue) => issue.path)).toEqual(['body/annexXviiEntries'])
    expect(substanceProblems({ lists: ['POPS'], svhcListVersionId: 'v-1' }).map((issue) => issue.path)).toEqual(['body/svhcListVersionId'])
  })

  it('has a starter list of public law that the database takes: check digits right, keys once, each rule valid', () => {
    for (const substance of STARTER_SUBSTANCES) {
      expect(substanceProblems({ ...substance, lists: [...substance.lists], annexXviiEntries: [...substance.annexXviiEntries] }), substance.name).toEqual([])
    }
    const cas = STARTER_SUBSTANCES.flatMap((substance) => (substance.casNumber ? [substance.casNumber] : []))
    expect(new Set(cas).size).toBe(cas.length)
    expect(STARTER_SUBSTANCES.filter((substance) => substance.groupCode === 'AZO_AMINES')).toHaveLength(22)
    expect(STARTER_SUBSTANCES.filter((substance) => substance.groupCode === 'PAH_8')).toHaveLength(8)
    expect(new Set(STARTER_RULES.map((starter) => starter.key)).size).toBe(STARTER_RULES.length)
    for (const starter of STARTER_RULES) {
      expect(ruleProblems({ ...starter, substanceId: starter.substance ? 'named' : null, materialKinds: [...starter.materialKinds], source: 'LAW', customerPartyId: null }), starter.key).toEqual([])
    }
    expect(STARTER_RULES.filter((starter) => starter.offReason !== null).map((starter) => starter.code)).toEqual(['CMR', 'PFAS'])
  })

  it('says what is wrong with a rule, and when a switch is refused', () => {
    expect(ruleProblems({ substanceId: 'x', substanceGroup: 'AZO' }).map((issue) => issue.path)).toEqual(['body/substanceId'])
    expect(ruleProblems({ limitValue: '3', limitUnit: 'MG_KG', limitBound: null }).map((issue) => issue.path)).toEqual(['body/limitValue'])
    expect(ruleProblems({ limitValue: '0', limitUnit: 'MG_KG', limitBound: 'BELOW' }).map((issue) => issue.path)).toEqual(['body/limitValue'])
    expect(ruleProblems({ source: 'CUSTOMER', customerPartyId: null }).map((issue) => issue.path)).toEqual(['body/customerPartyId'])
    expect(ruleProblems({ materialKinds: ['FINISHED'], marketCodes: ['fr'] }).map((issue) => issue.path)).toEqual(['body/materialKinds', 'body/marketCodes'])
    expect(switchRefusal({ key: 'K', switchedOn: true, status: 'ACTIVE' }, true, null)).toBe('Rule K is already on.')
    expect(switchRefusal({ key: 'K', switchedOn: true, status: 'ACTIVE' }, false, ' ')).toMatch(/Say why rule K is switched off/)
    expect(switchRefusal({ key: 'K', switchedOn: false, status: 'ACTIVE' }, true, null)).toBeNull()
    expect(switchRefusal({ key: 'K', switchedOn: false, status: 'ARCHIVED' }, true, null)).toMatch(/archived/)
    expect(limitWords('3', 'MG_KG', 'BELOW')).toBe('below 3 mg/kg')
    expect(limitWords('0.5', 'UG_CM2_WEEK', 'AT_MOST')).toBe('at most 0.5 µg/cm²/week')
  })

  it('gives the right to keep the list to the quality inspector', () => {
    expect(SUBSTANCES_MANAGE).toBe('compliance.substances.manage')
    expect(SUBSTANCES_ADDS).toEqual({ quality_inspector: ['compliance.substances.manage'] })
  })
})

describe('which rule applies (PRD-320 … PRD-325, PRD-329)', () => {
  it('by kind, switch, status, market, company, product type, brand and the two exemptions of entry 72', () => {
    const base = input()
    expect(applicability(rule(), base)).toEqual({ why: null, styleIds: [jacket.styleId] })
    expect(applicability(rule({ materialKinds: ['TRIM'] }), base).why).toBe('MATERIAL_KIND')
    expect(applicability(rule({ switchedOn: false }), base).why).toBe('SWITCHED_OFF')
    expect(applicability(rule({ status: 'ARCHIVED' }), base).why).toBe('ARCHIVED')
    expect(applicability(rule({ marketCodes: ['FR'] }), base).why).toBe('MARKET')
    expect(applicability(rule({ marketCodes: ['US'] }), { ...base, markets: ['US-CA'] }).why).toBeNull()
    expect(applicability(rule({ companyId: 'c-b' }), base).why).toBe('OTHER_COMPANY')
    expect(applicability(rule({ productTypes: ['GLOVES'] }), base).why).toBe('PRODUCT_TYPE')
    expect(applicability(rule({ source: 'CUSTOMER', customerPartyId: 'brand-1' }), base).why).toBe('BRAND')
    expect(applicability(rule({ source: 'CUSTOMER', customerPartyId: 'brand-1' }), { ...base, uses: [jacket, fashion] })).toEqual({ why: null, styleIds: [fashion.styleId] })
    expect(applicability(rule({ exemptPpe: true }), base).why).toBe('EXEMPT_PPE')
    expect(applicability(rule({ exemptPpe: true }), { ...base, uses: [jacket, fashion] }).styleIds).toEqual([fashion.styleId])
    expect(applicability(rule({ exemptNaturalLeather: true }), { ...base, material: { ...base.material, kind: 'LEATHER' } }).why).toBe('EXEMPT_NATURAL_LEATHER')
    // Not used in a style yet: judged alone; a product-type rule waits for a style.
    expect(applicability(rule(), { ...base, uses: [] })).toEqual({ why: null, styleIds: [] })
    expect(applicability(rule({ productTypes: ['JACKET'] }), { ...base, uses: [] }).why).toBe('PRODUCT_TYPE')
  })
})

describe('whether the evidence is there and passes', () => {
  const test = (verdict: 'PASS' | 'FAIL', testedOn = '2026-11-02') => ({ resultId: '00000000-0000-7000-8000-0000000000r1', lotId: '00000000-0000-7000-8000-0000000000l1', test: 'AZO' as const, verdict, testedOn, recordedAt: `${testedOn}T10:00:00.000Z` })

  it('a passing newest test or an accepted declaration in force meets it; a failing test or a declaration above the limit fails it', () => {
    expect(judgeRule(rule(), input({ tests: [test('PASS')] }))).toMatchObject({ status: 'MET', metBy: 'TEST', words: 'Met by a passing AZO test of 2026-11-02.' })
    expect(judgeRule(rule(), input({ tests: [test('PASS', '2026-10-01'), test('FAIL', '2026-11-02')] }))).toMatchObject({ status: 'FAILED', metBy: 'TEST' })
    expect(judgeRule(rule(), input({ declarations: [declaration()] }))).toMatchObject({ status: 'MET', metBy: 'DECLARATION', proof: { kind: 'DECLARATION', number: 'SD-2026-0001' } })
    const above = declaration({ lines: [{ contains: true, aboveThreshold: true, substanceId: '00000000-0000-7000-8000-0000000000a1', substanceName: 'Benzidine' }] })
    expect(judgeRule(rule(), input({ declarations: [above] }))).toMatchObject({ status: 'FAILED', words: expect.stringContaining('Benzidine above the limit') })
    // An RSL line above the limit of another rule's substance does not fail this one.
    const other = declaration({ lines: [{ contains: true, aboveThreshold: true, substanceId: 'another', substanceName: 'DMF' }] })
    expect(judgeRule(rule(), input({ declarations: [other] })).status).toBe('MET')
  })

  it('a TEST rule takes no declaration; expired, refused and open declarations say so in the words', () => {
    expect(judgeRule(rule({ evidence: 'TEST' }), input({ declarations: [declaration()] }))).toMatchObject({ status: 'MISSING', needs: { test: 'AZO', declaration: null }, words: 'Missing: a passing AZO test.' })
    expect(judgeRule(rule(), input({ declarations: [declaration({ validTo: '2026-11-09' })] })).words).toBe("Missing: a supplier's RSL declaration or a passing AZO test. SD-2026-0001 expired on 2026-11-09.")
    expect(judgeRule(rule(), input({ declarations: [declaration({ status: 'REFUSED' })] })).words).toMatch(/SD-2026-0001 was refused\.$/)
    expect(judgeRule(rule(), input({ declarations: [declaration({ status: 'OVERDUE', decidedAt: null })] }))).toMatchObject({ status: 'MISSING', asked: { number: 'SD-2026-0001', status: 'OVERDUE' }, words: expect.stringMatching(/Asked in SD-2026-0001, due 2026-10-19 \(overdue\)\.$/) })
    // CMR has no lab test of its own: a declaration proves it.
    expect(judgeRule(rule({ code: 'CMR', evidence: 'TEST' }), input()).needs).toEqual({ test: null, declaration: 'RSL' })
    // Nickel has its own declaration kind.
    expect(judgeRule(rule({ code: 'NICKEL', materialKinds: [] }), input({ declarations: [declaration({ kind: 'NICKEL', lines: [{ contains: true, aboveThreshold: true, substanceId: null, substanceName: null }] })] })).status).toBe('FAILED')
  })
})

describe('the SVHC answer per material and per style (PRD-326, REACH art. 33)', () => {
  const svhc = (over: Partial<DeclarationFact>) => declaration({ kind: 'REACH_SVHC', svhcListVersionId: 'v-1', answeredListVersionId: 'v-1', ...over })

  it('takes the newest accepted SVHC declaration: above 0.1 % with its SVHCs, or none; older lists are stale', () => {
    const none = svhcAnswer(input({ declarations: [svhc({})] }))
    expect(none).toMatchObject({ aboveThreshold: false, source: 'DECLARATION', current: false, grewBy: 3, listVersion: v1, newestVersion: v2 })
    const above = svhcAnswer(input({ declarations: [svhc({}), svhc({ requestId: '00000000-0000-7000-8000-0000000000d2', number: 'SD-2026-0002', answeredListVersionId: 'v-2', lines: [{ contains: true, aboveThreshold: true, substanceId: 'dehp', substanceName: 'DEHP' }] })] }))
    expect(above).toMatchObject({ aboveThreshold: true, substanceIds: ['dehp'], current: true, grewBy: null, request: { number: 'SD-2026-0002' } })
    const unnamed = svhcAnswer(input({ declarations: [svhc({ lines: [{ contains: true, aboveThreshold: true, substanceId: null, substanceName: 'Something new' }] })] }))
    expect(unnamed).toMatchObject({ aboveThreshold: null, unnamed: ['Something new'] })
    expect(svhcAnswer(input({ saved: { aboveThreshold: true, listVersionId: 'v-2', substanceIds: ['dehp'] } }))).toMatchObject({ source: 'PROFILE', aboveThreshold: true, current: true })
    expect(svhcAnswer(input())).toMatchObject({ source: 'NONE', aboveThreshold: null })
  })

  it('rolls the components up: YES when one is above, NO only when all answered none on the newest list', () => {
    const answer = (aboveThreshold: boolean | null, current = true, substanceIds: string[] = []) => ({ ...svhcAnswer(input()), aboveThreshold, current, substanceIds })
    expect(styleRollUp([{ materialId: 'a', svhc: answer(true, true, ['dehp']) }, { materialId: 'b', svhc: answer(false) }])).toMatchObject({ article33: 'YES', substanceIds: ['dehp'], above: 1, none: 1 })
    expect(styleRollUp([{ materialId: 'a', svhc: answer(false) }, { materialId: 'a', svhc: answer(false) }])).toMatchObject({ article33: 'NO', none: 1 })
    expect(styleRollUp([{ materialId: 'a', svhc: answer(false, false) }])).toMatchObject({ article33: 'UNKNOWN', stale: 1 })
    expect(styleRollUp([{ materialId: 'a', svhc: answer(null) }])).toMatchObject({ article33: 'UNKNOWN', unknown: 1 })
    expect(styleRollUp([]).article33).toBe('UNKNOWN')
  })
})

describe('the material evaluation', () => {
  const current = declaration({ kind: 'REACH_SVHC', number: 'SD-2026-0009', svhcListVersionId: 'v-2', answeredListVersionId: 'v-2' })

  it('is COMPLETE with every rule met and a current SVHC answer, INCOMPLETE otherwise, BLOCKED on a failure', () => {
    const complete = evaluateMaterial(input({ declarations: [declaration(), current] }))
    expect(complete).toMatchObject({ state: 'COMPLETE', stateReason: null, applicableRuleIds: [rule().id], testsNeeded: [], declarationsNeeded: ['REACH_SVHC', 'RSL'] })
    const incomplete = evaluateMaterial(input({ declarations: [current] }))
    expect(incomplete.state).toBe('INCOMPLETE')
    expect(incomplete.stateReason).toBe("REACH Annex XVII entry 43: Missing: a supplier's RSL declaration or a passing AZO test.")
    const stale = evaluateMaterial(input({ declarations: [declaration(), { ...current, answeredListVersionId: 'v-1', svhcListVersionId: 'v-1' }] }))
    expect(stale.stateReason).toMatch(/answered against the list of 2026-01-15; the Candidate List of 2026-07-01 is longer by 3: ask again/)
    const blocked = evaluateMaterial(input({ rules: [rule(), rule({ id: '00000000-0000-7000-8000-000000000002', key: 'REACH-XVII-46a', code: 'NPE', evidence: 'TEST', legalReference: 'REACH Annex XVII entry 46a' })], declarations: [current], tests: [{ resultId: '00000000-0000-7000-8000-0000000000r9', lotId: '00000000-0000-7000-8000-0000000000l9', test: 'NPE', verdict: 'FAIL', testedOn: '2026-11-03', recordedAt: '2026-11-03T08:00:00.000Z' }] }))
    expect(blocked).toMatchObject({ state: 'BLOCKED', testsNeeded: ['NPE'] })
    expect(blocked.stateReason).toMatch(/^REACH Annex XVII entry 46a: Failed: the NPE test of 2026-11-03/)
    expect(blocked.rules.map((verdict) => verdict.status)).toEqual(['FAILED', 'MISSING'])
  })
})

describe('the imports (PRD-318)', () => {
  it('reads lists by their names and aliases', () => {
    expect(readValues('svhc; Annex XVII, afirm', SUBSTANCE_LISTS, { 'annex xvii': 'REACH_ANNEX_XVII', afirm: 'AFIRM_RSL' })).toEqual({ values: ['REACH_ANNEX_XVII', 'SVHC', 'AFIRM_RSL'], unknown: [] })
    expect(readValues('SVHC, nope', SUBSTANCE_LISTS).unknown).toEqual(['nope'])
  })

  it('a substance row: new by CAS needs a name and lists; a known one gains lists and entries, never loses one', () => {
    expect(planSubstanceRow({ identifier: '117-81-7', lists: 'SVHC' }, null)).toEqual({ action: 'ERROR', errors: [{ column: 'name', message: 'Name is needed for a new substance.' }] })
    expect(planSubstanceRow({ identifier: '117-81-6', name: 'DEHP', lists: 'SVHC' }, null)).toMatchObject({ action: 'ERROR', errors: [{ column: 'identifier' }] })
    expect(planSubstanceRow({ identifier: 'Nonylphenol ethoxylates', lists: 'REACH_ANNEX_XVII', annexXviiEntries: '46a' }, null)).toMatchObject({ action: 'CREATE' })
    const existing = {
      id: 's-1',
      values: substanceRecordValues({ casNumber: '50-32-8', ecNumber: '200-028-5', name: 'Benzo[a]pyrene', nameI18n: null, groupCode: 'PAH_8', lists: ['REACH_ANNEX_XVII'], annexXviiEntries: ['50'], svhcAddedOn: null, note: null, status: 'ACTIVE', foreign: false }),
    }
    expect(planSubstanceRow({ identifier: '50-32-8', lists: 'SVHC', svhcAddedOn: '2026-01-15' }, existing)).toEqual({ action: 'UPDATE', before: { lists: 'REACH_ANNEX_XVII', svhcAddedOn: null }, after: { lists: 'REACH_ANNEX_XVII, SVHC', svhcAddedOn: '2026-01-15' } })
    expect(planSubstanceRow({ identifier: '50-32-8', lists: 'REACH_ANNEX_XVII', annexXviiEntries: '50' }, existing)).toEqual({ action: 'UNCHANGED' })
    expect(planSubstanceRow({ identifier: '50-32-8', ecNumber: '200-028-6' }, existing)).toMatchObject({ action: 'ERROR' })
    expect(substancesImporter.keyColumns).toEqual(['identifier'])
  })

  it('a rule row: new needs its kind, name, evidence, reference and what it restricts', () => {
    expect(planRuleRow({ key: 'BRAND-1', code: 'OTHER', name: 'DMF', evidence: 'EITHER', legalReference: 'Brand RSL' }, null)).toMatchObject({ action: 'ERROR', errors: [{ column: 'substance' }] })
    expect(planRuleRow({ key: 'BRAND-1', code: 'OTHER', name: 'DMF', evidence: 'EITHER', legalReference: 'Brand RSL', substance: '68-12-2', limit: '10', unit: 'MG_KG', bound: 'AT_MOST', source: 'CUSTOMER', customer: 'CLI-001' }, null)).toMatchObject({ action: 'CREATE' })
    expect(planRuleRow({ key: 'BRAND-1', code: 'OTHER', name: 'DMF', evidence: 'EITHER', legalReference: 'Brand RSL', substance: '68-12-2', limit: '10' }, null)).toMatchObject({ action: 'ERROR', errors: [{ column: 'limit' }] })
    expect(substanceRulesImporter.keyColumns).toEqual(['key'])
  })
})
