import { describe, expect, it } from 'vitest'
import { bankReferenceProblem, normaliseBankReference, openOnDeposit, openOnInvoice, planAllocations, voidProblems } from './payments'

describe('a payment received (FIN-121, FIN-122)', () => {
  it('the bank reference is kept in one form, so the same transfer typed twice is found', () => {
    expect(normaliseBankReference(' cro 0012 3456 ')).toBe('CRO00123456')
    expect(normaliseBankReference('   ')).toBeNull()
    expect(bankReferenceProblem('')).toContain('required')
    expect(bankReferenceProblem('TRN#1')).toContain('letters, digits')
    expect(bankReferenceProblem('TRN-2026/0001')).toBeNull()
  })

  it('without an amount an allocation takes what fits: the target\'s open amount, the payment\'s rest; the rest stays unallocated', () => {
    const plan = planAllocations(250000, [{ target: 'DEPOSIT_REQUEST', targetId: 'r1', open: openOnDeposit(183000, 0), path: 'body/allocations/0', label: 'deposit request' }], 'EUR')
    expect(plan).toEqual({ allocations: [{ target: 'DEPOSIT_REQUEST', targetId: 'r1', amount: 183000 }], left: 67000, issues: [] })
  })

  it('an amount above what is open or left is refused, in words', () => {
    const plan = planAllocations(10000, [
      { target: 'INVOICE', targetId: 'i1', open: openOnInvoice(61000, 0, 60000), amount: 2000, path: 'body/allocations/0', label: 'invoice FT-1' },
      { target: 'INVOICE', targetId: 'i2', open: 50000, amount: 20000, path: 'body/allocations/1', label: 'invoice FT-2' },
    ], 'EUR')
    expect(plan.allocations).toEqual([])
    expect(plan.issues.map((issue) => issue.message)).toEqual(['The invoice FT-1 is open for 10.00 EUR only; allocate at most that.', 'The payment has 100.00 EUR left to allocate; allocate at most that.'])
  })

  it('a payment is voided only once its allocations add up to 0', () => {
    expect(voidProblems({ status: 'RECEIVED', allocated: 0 })).toEqual([])
    expect(voidProblems({ status: 'RECEIVED', allocated: 100 })).toHaveLength(1)
    expect(voidProblems({ status: 'VOIDED', allocated: 0 })).toHaveLength(1)
  })
})
