import { describe, expect, it } from 'vitest'
import { depositOutcomeOf, madeToMeasureOf, pickRule, ruleProblems, type RuleFacts, type RuleInput } from './cancellation'

// B-W2b-396 (FIN-080): every rule and amount here is made up.
const rule = (values: Partial<RuleFacts> = {}): RuleFacts => ({ id: 'r1', depositKind: 'ACCONTO', cancelledBy: 'CUSTOMER', madeToMeasure: null, refundRule: 'REFUND_ALL', keepPct: '0', documentKind: 'CREDIT_NOTE', note: null, ...values })
const input = (values: Partial<RuleInput> = {}): RuleInput => ({ depositKind: 'CAPARRA', cancelledBy: 'CUSTOMER', madeToMeasure: null, refundRule: 'KEEP_PERCENT', keepPct: '30', documentKind: 'CREDIT_NOTE', note: null, ...values })

describe('the rules for the deposit of a cancelled order (FIN-080)', () => {
  it('are checked as the database checks them, in words', () => {
    expect(ruleProblems(input())).toEqual([])
    expect(ruleProblems(input({ keepPct: '0' })).map((issue) => issue.path)).toEqual(['body/keepPct'])
    expect(ruleProblems(input({ refundRule: 'REFUND_ALL', keepPct: '10' })).map((issue) => issue.path)).toEqual(['body/keepPct'])
    expect(ruleProblems(input({ keepPct: '100' })).map((issue) => issue.path)).toEqual(['body/documentKind'])
    expect(ruleProblems(input({ keepPct: '100', documentKind: 'NONE' }))).toEqual([])
    expect(ruleProblems(input({ refundRule: 'REFUND_DOUBLE', keepPct: '0' })).map((issue) => issue.message)).toEqual(['Twice the deposit is paid back only for a caparra, when we cancel (c.c. artt. 1385, 1386).'])
    expect(ruleProblems(input({ refundRule: 'REFUND_DOUBLE', keepPct: '0', cancelledBy: 'COMPANY' }))).toEqual([])
    expect(ruleProblems(input({ refundRule: 'REFUND_DOUBLE', keepPct: '0', cancelledBy: 'COMPANY', depositKind: 'ACCONTO' }))).toHaveLength(1)
    expect(ruleProblems(input({ keepPct: '101' })).map((issue) => issue.path)).toEqual(['body/keepPct'])
    expect(ruleProblems(input({ note: ' ' })).map((issue) => issue.path)).toEqual(['body/note'])
  })

  it("pick the exact order type's rule before the 'any' one", () => {
    const any = rule({ id: 'any', depositKind: 'CAPARRA' })
    const mtm = rule({ id: 'mtm', depositKind: 'CAPARRA', madeToMeasure: true })
    expect(pickRule([any, mtm], { depositKind: 'CAPARRA', cancelledBy: 'CUSTOMER', madeToMeasure: true })?.id).toBe('mtm')
    expect(pickRule([any, mtm], { depositKind: 'CAPARRA', cancelledBy: 'CUSTOMER', madeToMeasure: false })?.id).toBe('any')
    expect(pickRule([any, mtm], { depositKind: 'CAPARRA', cancelledBy: 'COMPANY', madeToMeasure: false })).toBeNull()
    expect(pickRule([any], { depositKind: 'ACCONTO', cancelledBy: 'CUSTOMER', madeToMeasure: false })).toBeNull()
  })

  it('decide what is kept, paid back and documented; without a rule everything is paid back', () => {
    const deposit = { depositKind: 'CAPARRA', currency: 'EUR', paid: 30_000, invoiced: 30_000 }
    expect(depositOutcomeOf(deposit, null, 'CUSTOMER')).toMatchObject({ source: 'NO_RULE', kept: 0, refund: 30_000, extra: 0, document: 'CREDIT_NOTE', creditAmount: 30_000 })
    const keep30 = depositOutcomeOf(deposit, rule({ depositKind: 'CAPARRA', refundRule: 'KEEP_PERCENT', keepPct: '30' }), 'CUSTOMER')
    expect(keep30).toMatchObject({ source: 'RULE', kept: 9_000, refund: 21_000, creditAmount: 21_000 })
    expect(keep30.words).toBe("Confirmatory deposit (caparra confirmatoria, c.c. art. 1385), the customer cancels: the company's rule: keep €90.00 (30%) and pay back €210.00. A credit note of €210.00 follows for the deposit invoice.")
    expect(depositOutcomeOf(deposit, rule({ depositKind: 'CAPARRA', refundRule: 'KEEP_PERCENT', keepPct: '100', documentKind: 'NONE' }), 'CUSTOMER')).toMatchObject({ kept: 30_000, refund: 0, creditAmount: 0, document: 'NONE' })
    expect(depositOutcomeOf(deposit, rule({ depositKind: 'CAPARRA', cancelledBy: 'COMPANY', refundRule: 'REFUND_DOUBLE' }), 'COMPANY')).toMatchObject({ kept: 0, refund: 30_000, extra: 30_000, creditAmount: 30_000 })
    // Paid more than invoiced: the credit note covers only what a deposit invoice billed.
    expect(depositOutcomeOf({ ...deposit, invoiced: 10_000 }, null, 'CUSTOMER')).toMatchObject({ refund: 30_000, creditAmount: 10_000 })
    expect(depositOutcomeOf({ ...deposit, paid: 0 }, null, 'CUSTOMER').words).toMatch(/nothing was paid on it\.$/)
  })

  it('call an order made to measure when a line of goods names a measurement profile, or the order says so', () => {
    expect(madeToMeasureOf({ noWithdrawal: false, lines: [{ kind: 'SIZE_GRID', measurementProfileId: null }] })).toBe(false)
    expect(madeToMeasureOf({ noWithdrawal: false, lines: [{ kind: 'MTM', measurementProfileId: 'p1' }] })).toBe(true)
    expect(madeToMeasureOf({ noWithdrawal: true, lines: [] })).toBe(true)
    expect(madeToMeasureOf({ noWithdrawal: false, lines: [{ kind: 'FEE', measurementProfileId: 'p1' }] })).toBe(false)
  })
})
