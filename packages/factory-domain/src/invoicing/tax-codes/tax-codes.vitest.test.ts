import { describe, expect, it } from 'vitest'
import { ruleStatusFromCodes } from '../../tax/rules'
import { nonTaxable, taxable } from '../../tax/vat-treatment'
import { codeActions, codeForTreatment, codesInForce, codeStateOf, dayBefore, lineCodeProblems, nextVersionProblem, overlappingVersion, taxCodeProblems, treatmentOfCode, type TaxCodeFacts, type TaxCodeInput } from './tax-codes'
import { ALL_OFF, switchWords } from './switches'

// B-W2b-392 (FIN-107): every code, law and key here is made up.
const input = (values: Partial<TaxCodeInput> = {}): TaxCodeInput => ({ country: 'IT', code: '22', label: 'Ordinary rate 22%', ratePct: '22', natura: null, legalRef: null, accountCodeKey: 'VAT_SALES_22', ruleId: 'IT_DOMESTIC_SUPPLY', validFrom: '2026-01-01', validTo: null, ...values })
const code = (values: Partial<TaxCodeFacts> = {}): TaxCodeFacts => ({
  id: values.id ?? '00000000-0000-7000-8000-000000000001',
  companyId: 'c',
  country: 'IT',
  code: '22',
  label: 'Ordinary rate',
  ratePct: '22.00',
  natura: null,
  legalRef: null,
  accountCodeKey: null,
  ruleId: null,
  verification: 'UNVERIFIED',
  confirmedAt: null,
  validFrom: '2026-01-01',
  validTo: null,
  status: 'ACTIVE',
  ...values,
})
const paths = (issues: { path: string }[]) => issues.map((issue) => issue.path)

describe('a tax code version (the guards said again in words)', () => {
  it('takes an Italian rate, or 0 with its Natura and law', () => {
    expect(taxCodeProblems(input())).toEqual([])
    expect(taxCodeProblems(input({ code: 'N3.2', ratePct: '0', natura: 'N3.2', legalRef: 'Art. 41 DL 331/1993', ruleId: 'INTRA_EU_SUPPLY_OF_GOODS' }))).toEqual([])
    expect(paths(taxCodeProblems(input({ ratePct: '21' })))).toEqual(['body/ratePct'])
    expect(paths(taxCodeProblems(input({ country: 'DE', ratePct: '19', ruleId: null })))).toEqual([])
    expect(paths(taxCodeProblems(input({ ratePct: '0' })))).toEqual(['body/natura'])
    expect(paths(taxCodeProblems(input({ natura: 'N3.2', legalRef: 'x' })))).toEqual(['body/natura'])
    expect(paths(taxCodeProblems(input({ ratePct: '0', natura: 'N3', legalRef: 'Art. 8' })))).toEqual(['body/natura'])
    expect(paths(taxCodeProblems(input({ ratePct: '0', natura: 'N3.1', legalRef: null })))).toEqual(['body/legalRef'])
    expect(paths(taxCodeProblems(input({ legalRef: 'Art. 1' })))).toEqual(['body/legalRef'])
  })

  it('refuses a bad country, code, label, key, rule or period', () => {
    expect(paths(taxCodeProblems(input({ country: 'it', code: 'n3 2', label: '  ', accountCodeKey: 'has space', ruleId: 'NOT_A_RULE', validTo: '2025-12-31' })))).toEqual([
      'body/country',
      'body/code',
      'body/label',
      'body/accountCodeKey',
      'body/ruleId',
      'body/validTo',
    ])
    expect(paths(taxCodeProblems(input({ label: 'two\nlines' })))).toEqual(['body/label'])
  })
})

describe('the state of a version on a day, and what may be done', () => {
  it('is planned, in force, ended or archived', () => {
    expect(codeStateOf(code({ validFrom: '2026-12-01' }), '2026-11-14')).toBe('PLANNED')
    expect(codeStateOf(code(), '2026-11-14')).toBe('IN_FORCE')
    expect(codeStateOf(code({ validTo: '2026-11-13' }), '2026-11-14')).toBe('ENDED')
    expect(codeStateOf(code({ validTo: '2026-11-14' }), '2026-11-14')).toBe('IN_FORCE')
    expect(codeStateOf(code({ status: 'ARCHIVED' }), '2026-11-14')).toBe('ARCHIVED')
  })

  it('edits and deletes only a version not yet in force; a version in force ends and gets a next version', () => {
    expect(codeActions(code({ validFrom: '2026-12-01' }), '2026-11-14')).toMatchObject({ edit: true, delete: true, end: false, newVersion: true, archive: true, confirm: true })
    expect(codeActions(code(), '2026-11-14')).toMatchObject({ edit: false, delete: false, relabel: true, end: true, newVersion: true })
    expect(codeActions(code({ validTo: '2026-10-31' }), '2026-11-14')).toMatchObject({ edit: false, relabel: false, end: false, newVersion: false, delete: false })
    expect(codeActions(code({ verification: 'VERIFIED' }), '2026-11-14').confirm).toBe(false)
  })

  it('a next version starts after the current one, from today at the earliest while it is in force', () => {
    expect(nextVersionProblem(code(), '2026-11-14', '2026-11-14')).toBeNull()
    expect(nextVersionProblem(code(), '2026-11-13', '2026-11-14')).toContain('from today at the earliest')
    expect(nextVersionProblem(code({ validFrom: '2026-12-01' }), '2026-12-01', '2026-11-14')).toContain('starts after this one')
    expect(nextVersionProblem(code({ validTo: '2026-10-31' }), '2026-12-01', '2026-11-14')).toContain('has ended')
    expect(nextVersionProblem(code({ status: 'ARCHIVED' }), '2026-12-01', '2026-11-14')).toContain('archived')
    expect(dayBefore('2026-01-01')).toBe('2025-12-31')
  })

  it('finds the ACTIVE version of the same code whose days meet', () => {
    const others = [code({ id: 'a', validTo: '2026-06-30' }), code({ id: 'b', validFrom: '2026-07-01', status: 'ARCHIVED' }), code({ id: 'c', code: '10', ratePct: '10.00' })]
    expect(overlappingVersion({ country: 'IT', code: '22', validFrom: '2026-07-01', validTo: null }, others)).toBeNull()
    expect(overlappingVersion({ country: 'IT', code: '22', validFrom: '2026-06-30', validTo: null }, others)?.id).toBe('a')
    expect(overlappingVersion({ id: 'a', country: 'IT', code: '22', validFrom: '2026-06-30', validTo: null }, others)).toBeNull()
  })
})

describe('the code in force for an invoice line', () => {
  const codes = [
    code({ id: 'r22', code: '22', ruleId: 'IT_DOMESTIC_SUPPLY' }),
    code({ id: 'n32', code: 'N3.2', ratePct: '0.00', natura: 'N3.2', legalRef: 'Art. 41 DL 331/1993', ruleId: 'INTRA_EU_SUPPLY_OF_GOODS' }),
    code({ id: 'n35a', code: 'N3.5', ratePct: '0.00', natura: 'N3.5', legalRef: 'Art. 8 c.1 lett. c) DPR 633/1972' }),
    code({ id: 'n35b', code: 'N3.5-B', ratePct: '0.00', natura: 'N3.5', legalRef: 'Art. 8 c.1 lett. c) DPR 633/1972 (bis)' }),
    code({ id: 'old10', code: '10', ratePct: '10.00', validTo: '2025-12-31', validFrom: '2025-01-01' }),
    code({ id: 'arch', code: '4', ratePct: '4.00', status: 'ARCHIVED' }),
    code({ id: 'de', country: 'DE', code: '19', ratePct: '19.00' }),
  ]
  const inForce = codesInForce(codes, '2026-11-14')

  it('keeps only the ACTIVE Italian versions of the day', () => {
    expect(inForce.map((one) => one.id)).toEqual(['r22', 'n32', 'n35a', 'n35b'])
  })

  it('a rate by its rate; a Natura by its law first, then the rule, then the first by code', () => {
    expect(codeForTreatment(inForce, taxable(22))?.id).toBe('r22')
    expect(codeForTreatment(inForce, taxable(10))).toBeNull()
    expect(codeForTreatment(inForce, nonTaxable('N3.5', 'Art. 8 c.1 lett. c) DPR 633/1972 (bis)'))?.id).toBe('n35b')
    expect(codeForTreatment(inForce, nonTaxable('N3.5', 'something else'))?.id).toBe('n35a')
    expect(codeForTreatment(inForce, nonTaxable('N3.1', 'Art. 8'))).toBeNull()
    expect(treatmentOfCode({ ratePct: '19.00', natura: null, legalRef: null })).toBeNull()
  })

  it('a line without a code in force is a TAX_CODE problem in words; a deposit deducted keeps its VAT', () => {
    const problems = lineCodeProblems(
      [
        { seq: 1, kind: 'GOODS', vat: taxable(22) },
        { seq: 2, kind: 'GOODS', vat: taxable(10) },
        { seq: 3, kind: 'DEPOSIT_DEDUCTION', vat: taxable(5) },
        { seq: 4, kind: 'CHARGE', vat: nonTaxable('N3.1', 'Art. 8') },
      ],
      inForce,
      '2026-11-14',
    )
    expect(problems).toEqual([
      { code: 'TAX_CODE', path: 'lines/1/vat', message: 'Line 2 carries VAT 10 %, which is not a tax code of the company in force on 2026-11-14: finance adds it in the tax set-up, or the line takes another VAT.' },
      { code: 'TAX_CODE', path: 'lines/3/vat', message: expect.stringContaining('Line 4 carries VAT N3.1 (non imponibili - esportazioni)') },
    ])
  })
})

describe('the rules read from the table (tax/rules.ts)', () => {
  it('a rule the catalogue leaves UNVERIFIED is settled once every code in force that applies it is confirmed', () => {
    expect(ruleStatusFromCodes('IT_DOMESTIC_SUPPLY', [])).toBe('VERIFIED')
    expect(ruleStatusFromCodes('STAMP_DUTY', [])).toBe('UNVERIFIED')
    expect(ruleStatusFromCodes('STAMP_DUTY', [{ ruleId: 'STAMP_DUTY', verification: 'VERIFIED' }, { ruleId: 'STAMP_DUTY', verification: 'UNVERIFIED' }])).toBe('UNVERIFIED')
    expect(ruleStatusFromCodes('STAMP_DUTY', [{ ruleId: 'STAMP_DUTY', verification: 'VERIFIED' }, { ruleId: 'EXPORT_OF_GOODS', verification: 'UNVERIFIED' }])).toBe('VERIFIED')
  })

  it('every switch says what waits for the accountant while off', () => {
    const words = switchWords(ALL_OFF)
    expect(Object.values(words).every((text) => text.startsWith('Waits for the accountant'))).toBe(true)
    expect(switchWords({ ...ALL_OFF, stampDutyOn: true }).stampDutyOn).toContain('charged to the customer as an invoice line')
  })
})
