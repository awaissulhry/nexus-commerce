import { describe, expect, it } from 'vitest'
import { chooseRules, conditionProblems, type RuleCondition } from '../../approvals/rules'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { templateOf } from '../../auth/roles/templates'
import { EVENT_CATALOGUE } from '../../events/catalogue'
import {
  availableOf,
  checkWords,
  creditFacts,
  CREDIT_OVERRIDE_FIELDS,
  creditResult,
  exposureOf,
  findingsOf,
  heldWords,
  limitProblems,
  overLimitBy,
  overrideResult,
  usedOf,
  usedPercent,
  type CreditReading,
} from './credit'
import { SALES_CREDIT_CHECKS, SALES_CREDIT_LIMITS, SALES_CREDIT_PERMISSIONS, SALES_CREDIT_VIEW } from './permissions'

// Made-up readings (minor units of EUR).
const within: CreditReading = { currency: 'EUR', openOrders: 300_000, openInvoices: 200_000, overdue: 0, subject: 100_000, limit: 1_000_000, onHold: false }
const over: CreditReading = { ...within, subject: 600_000 }
const late: CreditReading = { ...within, overdue: 50_000 }

describe('credit limits (B-W2b-304)', () => {
  it('adds up exposure, used, available, over by and the share used', () => {
    expect(exposureOf(within)).toBe(600_000)
    expect(usedOf(within)).toBe(500_000)
    expect(availableOf(within)).toBe(500_000)
    expect(overLimitBy(within)).toBe(0)
    expect(overLimitBy(over)).toBe(100_000)
    expect(usedPercent(within)).toBe(50)
    expect(usedPercent({ ...within, limit: 0 })).toBe(100)
    expect(usedPercent({ ...within, limit: null })).toBeNull()
    expect(availableOf({ ...within, limit: null })).toBeNull()
  })

  it('finds what is wrong, in order, and answers PASS, WARN or HOLD', () => {
    expect(findingsOf(within)).toEqual([])
    expect(findingsOf({ ...over, overdue: 1, onHold: true })).toEqual(['OVER_LIMIT', 'OVERDUE', 'ON_HOLD'])
    expect(creditResult(within, 'ORDER', true)).toBe('PASS')
    // No rule switched on (every tenant until the Owner sets one): shown and let through.
    expect(creditResult(over, 'ORDER', false)).toBe('WARN')
    expect(creditResult(over, 'ORDER', true)).toBe('HOLD')
    // The quote never holds; overdue alone warns.
    expect(creditResult(over, 'QUOTE', true)).toBe('WARN')
    expect(creditResult(late, 'SHIPMENT', false)).toBe('WARN')
    // An override's own check: PASS when nothing is found any more, else WARN.
    expect(overrideResult(within)).toBe('PASS')
    expect(overrideResult(over)).toBe('WARN')
  })

  it('words a check without an amount', () => {
    expect(checkWords(['OVER_LIMIT', 'OVERDUE'], 'HOLD')).toBe('Over the credit limit · invoices overdue: held until a yes.')
    expect(checkWords([], 'PASS')).toBe('Within the credit limit.')
    expect(checkWords(['OVER_LIMIT'], 'WARN', 'en', true)).toBe('Let through with a yes: over the credit limit.')
    expect(checkWords(['OVERDUE'], 'WARN', 'it')).toBe('Fatture scadute: segnalato e lasciato passare.')
    expect(heldWords('Work order WO-0007', ['OVER_LIMIT'], 'ASKED')).toBe('Work order WO-0007 is held for credit (over the credit limit): it waits for the yes that was asked.')
    for (const words of [checkWords(['OVER_LIMIT', 'OVERDUE', 'ON_HOLD'], 'HOLD'), heldWords('X', ['OVERDUE'], 'TO_ASK')]) expect(words).not.toMatch(/\d/)
  })

  it("gives the seeded rule's facts and holds by it", () => {
    const facts = creditFacts(over, 'ORDER', 'SEED-C1')
    expect(facts).toMatchObject({ step: 'ORDER', overLimit: true, overLimitBy: '1000', exposure: '11000', limit: '10000', hasOverdue: false, onHold: false, currency: 'EUR', customerCode: 'SEED-C1' })
    const seeded: RuleCondition = { combinator: 'and', rows: [{ field: 'overLimit', operator: 'isTrue', value: null }] }
    expect(conditionProblems(seeded, CREDIT_OVERRIDE_FIELDS)).toEqual([])
    const rule = { id: 'r1', companyId: null, sequence: 10, createdAt: new Date('2026-11-01T00:00:00Z'), active: true, effectiveFrom: null, condition: seeded, approverRoleId: 'finance', approverUserId: null }
    const now = new Date('2026-11-12T10:00:00Z')
    expect(chooseRules([rule], { companyId: 'a', facts, askers: ['u1'] }, CREDIT_OVERRIDE_FIELDS, now).matched).toHaveLength(1)
    expect(chooseRules([rule], { companyId: 'a', facts: creditFacts(late, 'ORDER', 'SEED-C1'), askers: ['u1'] }, CREDIT_OVERRIDE_FIELDS, now).matched).toHaveLength(0)
    // A rule naming the person asking never decides (nobody approves their own request).
    const named = { ...rule, approverRoleId: null, approverUserId: 'u1' }
    expect(chooseRules([named], { companyId: 'a', facts, askers: ['u1'] }, CREDIT_OVERRIDE_FIELDS, now).deciding).toBeNull()
  })

  it('refuses a limit that is not one', () => {
    expect(limitProblems({ amount: 5_000_000, currency: 'EUR' })).toEqual([])
    expect(limitProblems({ amount: null, currency: null })).toEqual([])
    expect(limitProblems({ amount: -1, currency: 'EUR' }).map((issue) => issue.path)).toEqual(['amount'])
    expect(limitProblems({ amount: 10, currency: 'eur' }).map((issue) => issue.path)).toEqual(['currency'])
  })

  it('declares its permissions, gives them to finance and sales, and declares its events', () => {
    for (const name of SALES_CREDIT_PERMISSIONS) expect(FACTORY_PERMISSIONS.isDeclared(name)).toBe(true)
    expect(templateOf('finance')!.permissions).toEqual(expect.arrayContaining([SALES_CREDIT_VIEW, SALES_CREDIT_LIMITS, SALES_CREDIT_CHECKS]))
    expect(templateOf('sales')!.permissions).toEqual(expect.arrayContaining([SALES_CREDIT_VIEW, SALES_CREDIT_CHECKS]))
    expect(templateOf('sales')!.permissions).not.toContain(SALES_CREDIT_LIMITS)
    expect(templateOf('warehouse')!.permissions).not.toContain(SALES_CREDIT_VIEW)
    expect(EVENT_CATALOGUE.find('credit_check.recorded', 1)).toBeTruthy()
    expect(EVENT_CATALOGUE.find('credit_limit.changed', 1)).toBeTruthy()
  })
})
