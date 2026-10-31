import { describe, expect, it } from 'vitest'
import { matchLine, MATCH_SETTINGS, type GoodsFacts } from './match'
import { effectivePayablesSettings, matchSettingsOf, payablesSettingsProblems, sdiApprovalProblem, type PayablesSettingsRow } from './settings'

/** B-W2b-21 (Z8:03): the payables settings — the company's row wins, the tenant's fills in, the W2a rule last. Made-up figures. */

const empty: PayablesSettingsRow = { quantityTolerancePct: null, priceTolerancePct: null, differenceToleranceAmount: null, billingBasis: null, sdiApproval: null, sdiApproverIds: [], accepterMayNotApprove: null }
const PERSON = '00000000-0000-4000-8000-000000000001'
const OTHER = '00000000-0000-4000-8000-000000000002'
const leather: GoodsFacts = { kind: 'GOODS', orderedQuantity: '420.0000', orderedUnitPrice: '4.200000', orderUom: 'FT2', received: '105.0000', billedElsewhere: '0', ended: false, lineTolerancePct: null }

describe('what applies to a company', () => {
  it('nothing set anywhere: the W2a rule, not decided, in its own words', () => {
    const settings = effectivePayablesSettings(null, null)
    expect(settings).toMatchObject({ quantityTolerancePct: '0.0000', priceTolerancePct: '0.0000', differenceToleranceAmount: 0, billingBasis: 'RECEIVED', sdiApproval: 'ANY_APPROVER', accepterMayNotApprove: true, decided: false })
    expect(matchSettingsOf(settings).words).toEqual(MATCH_SETTINGS.words)
  })
  it('the company row wins value by value; a null follows the tenant row; decided once every match figure is set', () => {
    const tenant = { ...empty, quantityTolerancePct: '2', priceTolerancePct: '1.5', differenceToleranceAmount: 100, billingBasis: 'RECEIVED' as const }
    const company = { ...empty, priceTolerancePct: '0', billingBasis: 'ORDERED' as const }
    const settings = effectivePayablesSettings(company, tenant)
    expect(settings).toMatchObject({ quantityTolerancePct: '2.0000', priceTolerancePct: '0.0000', differenceToleranceAmount: 100, billingBasis: 'ORDERED', decided: true })
    expect(settings.source).toMatchObject({ quantityTolerancePct: 'TENANT', priceTolerancePct: 'COMPANY', billingBasis: 'COMPANY', sdiApproval: 'DEFAULT' })
    const words = matchSettingsOf(settings).words
    expect(words.en).toContain('what was ordered')
    expect(words.it).toContain('quanto ordinato')
    expect(effectivePayablesSettings({ ...empty, quantityTolerancePct: '1' }, null).decided).toBe(false)
  })
  it('the listed approvers travel with the row whose LISTED rule applies', () => {
    const tenant = { ...empty, sdiApproval: 'LISTED' as const, sdiApproverIds: [PERSON] }
    expect(effectivePayablesSettings(null, tenant)).toMatchObject({ sdiApproval: 'LISTED', sdiApproverIds: [PERSON] })
    expect(effectivePayablesSettings({ ...empty, sdiApproval: 'NOT_THE_BUYER' }, tenant)).toMatchObject({ sdiApproval: 'NOT_THE_BUYER', sdiApproverIds: [] })
  })
})

describe('the match with the settings', () => {
  it('a price tolerance lets a small rise pass; the amount tolerance lets a rounding difference pass', () => {
    // 105 ft² at 4.24 instead of 4.20: 0.95 % above the order's price.
    expect(matchLine({ quantity: '105.0000', uom: 'FT2', netAmount: 44_520 }, leather, 'EUR')).toMatchObject({ withinTolerance: false, differenceAmount: 420 })
    const settings = matchSettingsOf(effectivePayablesSettings({ ...empty, quantityTolerancePct: '0', priceTolerancePct: '1', differenceToleranceAmount: 0, billingBasis: 'RECEIVED' }, null))
    expect(matchLine({ quantity: '105.0000', uom: 'FT2', netAmount: 44_520 }, leather, 'EUR', settings)).toMatchObject({ withinTolerance: true, priceTolerancePct: '1.0000' })
    const rounding = matchSettingsOf(effectivePayablesSettings({ ...empty, quantityTolerancePct: '0', priceTolerancePct: '0', differenceToleranceAmount: 500, billingBasis: 'RECEIVED' }, null))
    expect(matchLine({ quantity: '105.0000', uom: 'FT2', netAmount: 44_520 }, leather, 'EUR', rounding)).toMatchObject({ withinTolerance: true, verdict: 'WITHIN' })
    expect(matchLine({ quantity: '105.0000', uom: 'FT2', netAmount: 44_701 }, leather, 'EUR', rounding)).toMatchObject({ withinTolerance: false, differenceAmount: 601 })
  })
  it('billed on what was ordered: an invoice ahead of the goods is within', () => {
    const ordered = matchSettingsOf(effectivePayablesSettings({ ...empty, quantityTolerancePct: '0', priceTolerancePct: '0', differenceToleranceAmount: 0, billingBasis: 'ORDERED' }, null))
    expect(matchLine({ quantity: '210.0000', uom: 'FT2', netAmount: 88_200 }, leather, 'EUR')).toMatchObject({ verdict: 'WAITING' })
    expect(matchLine({ quantity: '210.0000', uom: 'FT2', netAmount: 88_200 }, leather, 'EUR', ordered)).toMatchObject({ withinTolerance: true, receivedQuantity: '420.0000' })
  })
})

describe('a change of the settings, checked', () => {
  it('percentages 0 to 100, an amount of 0 or more, people listed only for LISTED, each once; the four eyes cannot be lifted', () => {
    expect(payablesSettingsProblems({ ...empty, quantityTolerancePct: '2.5', priceTolerancePct: '100', differenceToleranceAmount: 0 })).toEqual([])
    expect(payablesSettingsProblems({ ...empty, quantityTolerancePct: '100.5' }).map((issue) => issue.path)).toEqual(['body/quantityTolerancePct'])
    expect(payablesSettingsProblems({ ...empty, priceTolerancePct: '1.23456' }).map((issue) => issue.path)).toEqual(['body/priceTolerancePct'])
    expect(payablesSettingsProblems({ ...empty, differenceToleranceAmount: -1 }).map((issue) => issue.path)).toEqual(['body/differenceToleranceAmount'])
    expect(payablesSettingsProblems({ ...empty, sdiApproval: 'LISTED' }).map((issue) => issue.path)).toEqual(['body/sdiApproverIds'])
    expect(payablesSettingsProblems({ ...empty, sdiApproval: 'ANY_APPROVER', sdiApproverIds: [PERSON] }).map((issue) => issue.path)).toEqual(['body/sdiApproverIds'])
    expect(payablesSettingsProblems({ ...empty, sdiApproval: 'LISTED', sdiApproverIds: [PERSON, PERSON] }).map((issue) => issue.path)).toEqual(['body/sdiApproverIds'])
    expect(payablesSettingsProblems({ ...empty, accepterMayNotApprove: false })[0]!.message).toContain('B-W2a-F7')
  })
})

describe('who approves what SDI delivered', () => {
  it('LISTED: only the people listed; NOT_THE_BUYER: never who sent an order it bills; a typed invoice is not concerned', () => {
    const listed = { sdiApproval: 'LISTED' as const, sdiApproverIds: [PERSON] }
    expect(sdiApprovalProblem(listed, { source: 'SDI' }, PERSON, [])).toBeNull()
    expect(sdiApprovalProblem(listed, { source: 'SDI' }, OTHER, [])).toMatchObject({ code: 'NOT_A_LISTED_APPROVER' })
    expect(sdiApprovalProblem(listed, { source: 'MANUAL' }, OTHER, [])).toBeNull()
    const notBuyer = { sdiApproval: 'NOT_THE_BUYER' as const, sdiApproverIds: [] }
    expect(sdiApprovalProblem(notBuyer, { source: 'SDI' }, PERSON, [PERSON])).toMatchObject({ code: 'OWN_ORDER' })
    expect(sdiApprovalProblem(notBuyer, { source: 'SDI' }, OTHER, [PERSON])).toBeNull()
  })
})
