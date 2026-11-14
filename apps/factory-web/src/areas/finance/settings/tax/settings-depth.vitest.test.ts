import { describe, expect, it } from 'vitest'
import { REFUND_RULES as DOMAIN_REFUND_RULES } from '@nexus/factory-domain/invoicing/cancellation/cancellation'
import { designScreen as rulesScreen } from '../deposit-cancel/fixtures'
import { REFUND_RULES } from '../deposit-cancel/api'
import { emptyRule, madeToMeasureOf, orderKindOf, ruleBodyOf, ruleDraftProblems, ruleWords } from '../deposit-cancel/model'
import { designScreen as sdiScreen } from '../sdi-test/fixtures'
import { designScreen as skipScreen } from '../terms-skip/fixtures'
import { conventionsText, skipProblem, toggleMonth } from '../terms-skip/model'
import { TERMS } from '../terms/demo/fixtures'
import { draftOf, emptyTerms, fieldsOf, patchOf, previewOf, rulesChanged, termsProblems } from '../terms/model'
import { designScreen as taxScreen } from './fixtures'
import { codeDraftOf, codeFieldsOf, codeProblems, codesShown, codeVerbs, rowSelectable, switchOn } from './model'

/** B-W2b-417 — Finance settings in depth (tax set-up, test mode, skipped months, refund rules): the rules, made-up data only. */

const FULL = { view: true, manage: true, switch: true }
const READ = { view: true, manage: false, switch: false }

describe('the tax set-up', () => {
  const codes = taxScreen.cases[0]!.model.card.codes.value!.codes
  const today = '2026-11-14'

  it('shows in force and planned by default, every version on ask, and the verbs each allows today', () => {
    expect(codesShown(codes, 'current').map((code) => code.state)).toEqual(['IN_FORCE', 'IN_FORCE', 'PLANNED'])
    expect(codesShown(codes, 'all')).toHaveLength(4)
    expect(codeVerbs(codes[0]!, FULL).map((verb) => verb.id)).toEqual(['relabel', 'end', 'version', 'archive'])
    expect(codeVerbs(codes[2]!, FULL).map((verb) => verb.id)).toEqual(['edit', 'version', 'confirm', 'archive', 'delete'])
    expect(codeVerbs(codes[1]!, READ).find((verb) => verb.id === 'confirm')!.held).toEqual({ key: 'held.noTaxSwitch' })
    expect(rowSelectable(codes[3]!, FULL)).toBeNull()
    expect(rowSelectable(codes[0]!, READ)).toEqual({ key: 'tax.notSelectable' })
    expect(switchOn({ switches: { taxCodesOn: false, stampDutyOn: true, declarationsOfIntentOn: false }, selfInvoicesOn: true }, 'selfInvoicesOn')).toBe(true)
  })

  it('checks a code as factory-domain does, and sends only what the form may change', () => {
    const fresh = { ...codeDraftOf('new', null, today), code: 'n3.1', label: 'Esportazione', ratePct: '0', natura: 'N3.1', legalRef: 'Art. 8 c.1 lett. a) DPR 633/1972' }
    expect(codeProblems('new', fresh, null, today)).toEqual({})
    expect(codeFieldsOf('new', fresh)).toMatchObject({ country: 'IT', code: 'N3.1', ratePct: '0', natura: 'N3.1', validFrom: today, validTo: null })
    expect(codeProblems('new', { ...fresh, natura: '', legalRef: '' }, null, today)).toEqual({ natura: 'tax.problem.natura' })
    expect(codeProblems('new', { ...fresh, ratePct: '21', natura: '', legalRef: '' }, null, today)).toEqual({ ratePct: 'tax.problem.ratePct' })
    const version = codeDraftOf('version', codes[0]!, today)
    expect(version).toMatchObject({ ratePct: '22', validFrom: '2026-11-15', validTo: '' })
    expect(codeProblems('version', { ...version, validFrom: today }, codes[0]!, today)).toEqual({ validFrom: 'tax.problem.versionFrom' })
    expect(codeFieldsOf('relabel', { ...version, label: ' Ordinaria ' })).toEqual({ label: 'Ordinaria' })
    expect(codeProblems('end', { ...codeDraftOf('end', codes[1]!, today), validTo: '' }, codes[1]!, today)).toEqual({ validTo: 'tax.problem.endDay' })
  })
})

describe('skipped months in payment terms', () => {
  it('keeps the months in calendar order, each once, at most 11', () => {
    expect(toggleMonth([12], 8, true)).toEqual([8, 12])
    expect(toggleMonth([8, 12], 8, false)).toEqual([12])
    expect(skipProblem([8])).toBeNull()
    expect(skipProblem([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])).toBe('skip.problem')
    expect(conventionsText({ fromEndOfMonth: true, skipMonths: [8] }, 'en')).toBe('days counted from the end of the month · August skipped (the due day moves to the next month)')
    expect(conventionsText({ fromEndOfMonth: false, skipMonths: [] }, 'it')).toBeNull()
  })

  it('makes them rules of the terms: sent, compared, printed', () => {
    const draft = { ...emptyTerms(), code: 'RIBA60FM', name: 'Ri.Ba. 60 fm', method: 'MP12', fromEndOfMonth: true, skipMonths: [8] }
    expect(fieldsOf(draft)).toMatchObject({ fromEndOfMonth: true, skipMonths: [8] })
    expect(previewOf(draft, 'it')).toContain('escluso agosto')
    expect(termsProblems({ ...draft, skipMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] }).skip).toBe('skip.problem')
    const stored = TERMS[1]!
    expect(rulesChanged(stored, draftOf(stored, 'it'))).toBe(false)
    expect(rulesChanged(stored, { ...draftOf(stored, 'it'), skipMonths: [8] })).toBe(true)
    expect(patchOf(stored, { ...draftOf(stored, 'it'), fromEndOfMonth: true })).toMatchObject({ fromEndOfMonth: true, skipMonths: [] })
  })
})

describe('the refund rule on cancellation', () => {
  it('checks a rule as factory-domain does and says it in words', () => {
    expect([...REFUND_RULES]).toEqual([...DOMAIN_REFUND_RULES])
    expect(ruleDraftProblems(emptyRule())).toEqual({})
    expect(ruleDraftProblems({ ...emptyRule(), refundRule: 'REFUND_DOUBLE' })).toEqual({ refundRule: 'rule.problem.refundRule' })
    expect(ruleDraftProblems({ ...emptyRule(), refundRule: 'KEEP_PERCENT', keepPct: '0' })).toEqual({ keepPct: 'rule.problem.keepPct' })
    expect(ruleDraftProblems({ ...emptyRule(), refundRule: 'KEEP_PERCENT', keepPct: '100' })).toEqual({ documentKind: 'rule.problem.documentKind' })
    expect(ruleBodyOf({ ...emptyRule(), refundRule: 'KEEP_PERCENT', keepPct: '12,5', orderKind: 'made', note: ' ' })).toEqual({ depositKind: 'ACCONTO', cancelledBy: 'CUSTOMER', madeToMeasure: true, refundRule: 'KEEP_PERCENT', keepPct: '12.5', documentKind: 'CREDIT_NOTE', note: null })
    expect([null, true, false].map((value) => orderKindOf(value))).toEqual(['any', 'made', 'stock'])
    expect(madeToMeasureOf('stock')).toBe(false)
    expect(ruleWords({ refundRule: 'KEEP_PERCENT', keepPct: '20.0000', documentKind: 'NONE' })).toEqual({ key: 'rule.words.KEEP_PERCENT.NONE', params: { pct: '20' } })
  })
})

describe('the design cases', () => {
  it('give each settings part its own screen with the states and roles the design names', () => {
    const screens = [taxScreen, sdiScreen, skipScreen, rulesScreen]
    expect(screens.map((screen) => screen.screen)).toEqual(['SCR-446', 'SCR-447', 'SCR-448', 'SCR-449'])
    for (const screen of screens) expect(screen.cases.map((item) => item.id), screen.screen).toContain('sales')
    for (const screen of [taxScreen, sdiScreen, rulesScreen]) expect(screen.cases.map((item) => item.id), screen.screen).toEqual(expect.arrayContaining(['loading', 'error', 'in-page']))
  })
})
