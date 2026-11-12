import { describe, expect, it } from 'vitest'
import { holdStopWords, holdsInForceFor, holdWordsProblem } from './holds'

/** An account on hold (B-W2b-290; SAL-023): what is in force for a company, and the words where it stops. */

const A = '0190d3a1-0000-7000-8000-0000000000a1'
const B = '0190d3a1-0000-7000-8000-0000000000b1'

describe('account holds', () => {
  it('asks for words to place and to release', () => {
    expect(holdWordsProblem(' ', 'place')?.message).toBe('Say why the account goes on hold.')
    expect(holdWordsProblem('', 'release')?.message).toBe('Say why the hold is lifted.')
    expect(holdWordsProblem('x'.repeat(2001), 'place')?.path).toBe('words')
    expect(holdWordsProblem('Two invoices overdue.', 'place')).toBeNull()
  })

  it('is in force for its company, or for every company, until released', () => {
    const holds = [
      { id: 1, companyId: A, reason: 'CREDIT' as const, words: 'Overdue.', releasedAt: null },
      { id: 2, companyId: null, reason: 'LEGAL' as const, words: 'Dispute.', releasedAt: null },
      { id: 3, companyId: B, reason: 'OTHER' as const, words: 'Old.', releasedAt: null },
      { id: 4, companyId: A, reason: 'DATA_MISSING' as const, words: 'Done.', releasedAt: new Date() },
    ]
    expect(holdsInForceFor(holds, A).map((hold) => hold.id)).toEqual([1, 2])
    expect(holdsInForceFor(holds, B).map((hold) => hold.id)).toEqual([2, 3])
  })

  it('says what waits, in words', () => {
    const holds = [{ reason: 'CREDIT' as const, words: 'Two invoices overdue.' }]
    expect(holdStopWords('SEED-C1', holds, 'SHIPMENT')).toBe('SEED-C1 is on hold (credit: Two invoices overdue.). Shipments wait until it is released.')
    expect(holdStopWords('SEED-C1', holds, 'ORDER')).toContain('New orders wait until it is released')
    expect(holdStopWords('SEED-C1', holds, 'QUOTE')).toContain('The quote may go on')
  })
})
