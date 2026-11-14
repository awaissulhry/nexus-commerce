import { describe, expect, it } from 'vitest'
import { dualThresholdMinor, needsSecondApproval, secondApprovalWords, thresholdText } from './approvals'
import { approvalProblems, byDueAndDiscount, dueBucket, isMonday, isoWeekNumber, lineAmounts, lineProblems, proposalTitle, weekOf } from './rules'

/** B-W2b-403 (FIN-140, FIN-142): the weekly payment proposal, its four eyes and the second approval above the amount. */
describe('the weekly payment proposal', () => {
  it('a week is named by its Monday; the ISO week number', () => {
    expect(weekOf('2026-11-18')).toEqual({ weekStart: '2026-11-16', weekEnd: '2026-11-22' })
    expect(weekOf('2026-11-16')).toEqual({ weekStart: '2026-11-16', weekEnd: '2026-11-22' })
    expect(weekOf('2026-11-22')).toEqual({ weekStart: '2026-11-16', weekEnd: '2026-11-22' })
    expect(isMonday('2026-11-16')).toBe(true)
    expect(isMonday('2026-11-17')).toBe(false)
    expect(isoWeekNumber('2026-11-09')).toBe(46)
    expect(isoWeekNumber('2026-12-28')).toBe(53)
    expect(isoWeekNumber('2027-01-04')).toBe(1)
    expect(proposalTitle('2026-11-09').en).toBe('Payment proposal — week 46')
  })

  it('due buckets and the order: earliest due first, undated last, the bigger discount first', () => {
    const week = { weekStart: '2026-11-16', weekEnd: '2026-11-22' }
    expect([dueBucket('2026-11-10', week), dueBucket('2026-11-22', week), dueBucket('2026-11-23', week), dueBucket(null, week)]).toEqual(['OVERDUE', 'THIS_WEEK', 'LATER', 'NO_DUE_DATE'])
    const sorted = byDueAndDiscount([
      { id: 'a', number: 'A', dueDate: null },
      { id: 'b', number: 'B', dueDate: '2026-11-20', discountAmount: 0 },
      { id: 'c', number: 'C', dueDate: '2026-11-20', discountAmount: 500 },
      { id: 'd', number: 'D', dueDate: '2026-11-12' },
    ])
    expect(sorted.map((row) => row.id)).toEqual(['d', 'c', 'b', 'a'])
  })

  it('a line pays the total less the withholding less the discount; never more', () => {
    expect(lineAmounts({ grossTotal: 12_200, withholdingAmount: 2_000 })).toEqual({ amount: 10_200, discountAmount: 0 })
    expect(lineAmounts({ grossTotal: 12_200, withholdingAmount: null }, 200)).toEqual({ amount: 12_000, discountAmount: 200 })
    expect(lineAmounts({ grossTotal: 12_200, withholdingAmount: null }, 12_200)).toBeNull()
    expect(lineAmounts({ grossTotal: 12_200, withholdingAmount: null }, -1)).toBeNull()
  })

  it('what keeps an invoice out, and what keeps a proposal from its yes', () => {
    const proposal = { companyId: 'c1', currency: 'EUR' }
    expect(lineProblems({ companyId: 'c1', kind: 'INVOICE', status: 'RECEIVED', currency: 'EUR', inOtherProposal: false }, proposal, { forApproval: false })).toEqual([])
    expect(lineProblems({ companyId: 'c1', kind: 'INVOICE', status: 'RECEIVED', currency: 'EUR', inOtherProposal: false }, proposal, { forApproval: true })).toEqual(['INVOICE_NOT_APPROVED'])
    expect(lineProblems({ companyId: 'c2', kind: 'CREDIT_NOTE', status: 'PAID', currency: 'USD', inOtherProposal: true }, proposal, { forApproval: true })).toEqual(['OTHER_COMPANY', 'NOT_A_SUPPLIER_INVOICE', 'INVOICE_PAID', 'CURRENCY', 'IN_ANOTHER_PROPOSAL'])
    expect(approvalProblems({ status: 'DRAFT', createdById: 'maker', lines: [{ held: false, problems: [] }] }, 'other')).toEqual([])
    expect(approvalProblems({ status: 'DRAFT', createdById: 'maker', lines: [{ held: true, problems: [] }] }, 'maker')).toEqual(['OWN_PROPOSAL', 'HELD'])
    expect(approvalProblems({ status: 'APPROVED', createdById: 'maker', lines: [] }, 'other')).toEqual(['NOT_DRAFT', 'EMPTY'])
  })

  it('above 10,000 of its currency a second person approves too (the design\'s amount, not decided)', () => {
    expect(dualThresholdMinor('EUR')).toBe(1_000_000)
    expect(dualThresholdMinor('JPY')).toBe(10_000)
    expect(needsSecondApproval(1_000_000, 'EUR')).toBe(false)
    expect(needsSecondApproval(1_000_001, 'EUR')).toBe(true)
    expect(thresholdText('EUR')).toBe('10000.00 EUR')
    expect(secondApprovalWords('Made-up Finance', null).en).toBe('Approved once by Made-up Finance: a second person approves totals above the amount.')
    expect(secondApprovalWords(null, '10000.00 EUR').it).toBe('Approvata una volta: i totali sopra 10000.00 EUR li approva una seconda persona.')
  })
})
