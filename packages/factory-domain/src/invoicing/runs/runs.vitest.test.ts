import { describe, expect, it } from 'vitest'
import { monthOfDay, monthStartOf, pickProblems, runIssuePlan, runMonthProblem, runWords, RUN_PICK_MAX } from './runs'

// B-W2b-396 (FIN-068): the monthly invoice run; every id here is made up.
const problem = { code: 'BUYER', path: 'party/taxIdentity', message: 'The customer has no VAT number.' }

describe('the monthly invoice run (FIN-068)', () => {
  it('names its month by the first day, never a month that has not started', () => {
    expect(monthStartOf('2026-10')).toBe('2026-10-01')
    expect(monthOfDay('2026-10-31')).toBe('2026-10')
    expect(runMonthProblem('2026-10', '2026-11-14')).toBeNull()
    expect(runMonthProblem('2026-11', '2026-11-14')).toBeNull()
    expect(runMonthProblem('2026-12', '2026-11-14')?.message).toBe('2026-12 has not started: a run invoices the DDTs of this month or an earlier one.')
    expect(runMonthProblem('2026-13', '2026-11-14')?.path).toBe('body/month')
  })

  it('picks each customer once, at least one, at most a request', () => {
    expect(pickProblems(['a', 'b'])).toEqual([])
    expect(pickProblems([]).map((issue) => issue.message)).toEqual(['Pick at least one customer.'])
    expect(pickProblems(['a', 'a']).map((issue) => issue.message)).toEqual(['Each customer once.'])
    expect(pickProblems(Array.from({ length: RUN_PICK_MAX + 1 }, (_, index) => `p${index}`))).toHaveLength(1)
  })

  it('issues the drafts whose checks pass and lets go the others; issued ones are counted apart', () => {
    const plan = runIssuePlan([
      { invoiceId: 'i1', partyId: 'p1', status: 'DRAFT', problems: [] },
      { invoiceId: 'i2', partyId: 'p2', status: 'DRAFT', problems: [problem] },
      { invoiceId: 'i3', partyId: 'p3', status: 'ISSUED', problems: [] },
    ])
    expect(plan.ready.map((entry) => entry.invoiceId)).toEqual(['i1'])
    expect(plan.held.map((entry) => entry.invoiceId)).toEqual(['i2'])
    expect(plan.issued.map((entry) => entry.invoiceId)).toEqual(['i3'])
  })

  it('says the run in words', () => {
    expect(runWords('PREVIEW', '2026-10', { drafts: 3, ready: 2, issued: 0 })).toBe('The run of 2026-10 previews 3 deferred invoices: 2 ready to issue, 1 with something to fix (left out when the run is issued).')
    expect(runWords('PREVIEW', '2026-10', { drafts: 0, ready: 0, issued: 0 })).toBe('The run of 2026-10 holds no draft: pick customers with DDTs to invoice.')
    expect(runWords('ISSUED', '2026-10', { drafts: 0, ready: 0, issued: 1 })).toBe('The run of 2026-10 is issued: 1 invoice.')
  })
})
