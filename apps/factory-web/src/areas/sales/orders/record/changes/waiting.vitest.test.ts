import { describe, expect, it } from 'vitest'
import { countsOf, holdsPointerOf, lastRevisionOf, waitingAnswerOf } from './waiting'

// F-OC-101 … 104 (order CHANGES tab, W1): section 1, Waiting — the ONE waiting list's rows, said once with their turn, who and door.

const card = (onUs: number, onCustomer: number, still: number) => ({ onUs: Array.from({ length: onUs }), onCustomer: Array.from({ length: onCustomer }), still: Array.from({ length: still }) }) as never

describe('F-OC-101: Waiting\'s one answer', () => {
  it('"5 things wait: 4 on us, 1 on {customer}" · only steps: "4 steps are still to do" · nothing: "Nothing waits"', () => {
    expect(waitingAnswerOf(countsOf(card(4, 1, 0)))).toEqual({
      kind: 'total',
      count: 5,
      parts: [
        { key: 'changesTab.waiting.partUs', params: { count: 4 } },
        { key: 'changesTab.waiting.partCustomer', params: { count: 1 } },
      ],
    })
    expect(waitingAnswerOf(countsOf(card(0, 0, 4)))).toEqual({ kind: 'steps', count: 4 })
    expect(waitingAnswerOf(countsOf(card(0, 0, 0)))).toEqual({ kind: 'nothing' })
    // The steps are counted with the rest when something else waits too (the badge adds the same rows).
    expect(waitingAnswerOf(countsOf(card(1, 0, 2)))).toMatchObject({ kind: 'total', count: 3, parts: [{ key: 'changesTab.waiting.partUs' }, { key: 'changesTab.waiting.partSteps', params: { count: 2 } }] })
  })

  it('the last change is the latest revision (by its number, not the list\'s order); none: no line', () => {
    expect(lastRevisionOf([{ revision: 1, createdAt: '2026-11-10T09:00:00Z' }, { revision: 2, createdAt: '2026-11-12T09:00:00Z' }])).toEqual({ revision: 2, at: '2026-11-12T09:00:00Z' })
    expect(lastRevisionOf([{ revision: 3, createdAt: '2026-11-19T09:00:00Z' }, { revision: 1, createdAt: '2026-11-10T09:00:00Z' }])).toEqual({ revision: 3, at: '2026-11-19T09:00:00Z' })
    expect(lastRevisionOf([])).toBeNull()
    expect(lastRevisionOf(null)).toBeNull()
  })

  it('L4: "Holds and dates are on Production ›" only while a hold or a date waits — holds first — and never on a cancelled order', () => {
    const ready = (holds: number, dates: number) => ({ status: 'ready', rows: [], card: card(0, 0, 0), holds: Array.from({ length: holds }), dates: Array.from({ length: dates }) }) as never
    expect(holdsPointerOf(ready(1, 1), 'IN_PRODUCTION')).toBe('holds')
    expect(holdsPointerOf(ready(0, 2), 'CONFIRMED')).toBe('dates')
    expect(holdsPointerOf(ready(0, 0), 'IN_PRODUCTION')).toBeNull()
    expect(holdsPointerOf(ready(2, 0), 'CANCELLED')).toBeNull()
    expect(holdsPointerOf({ status: 'loading' }, 'IN_PRODUCTION')).toBeNull()
  })
})
