import { describe, expect, it } from 'vitest'
import { PRODUCTION_READ } from './fixtures'
import { nextDatesOf } from './dates'

/** F-OO-100 (order overview lane: one file per section) — Next dates' rules, moved with dates.ts out of overview.vitest.test.ts unchanged. */

describe('Overview’s facts (F-SA-233): Next dates', () => {
  const milestone = (id: string, kind: string, target: string | null, late: number | null, state = 'TO_COME') => ({ id, kind, gateId: null, gateKind: kind === 'GATE' ? 'PP_SAMPLE' : null, label: null, target, actual: null, state, late, owner: null })

  it('next dates: three to come, late first (most late first), then by target; the ex-factory day fills a free place', () => {
    const dates = { ...PRODUCTION_READ.dates!, milestones: [milestone('a', 'START', '2026-11-22', null), milestone('b', 'GATE', '2026-11-15', 3), milestone('c', 'GATE', '2026-11-10', 1), milestone('d', 'START', '2026-11-01', null, 'DONE')] }
    expect(nextDatesOf(dates, '2026-12-15').map((row) => row.id)).toEqual(['b', 'c', 'a'])
    expect(nextDatesOf({ ...dates, milestones: [milestone('a', 'START', '2026-11-22', null)] }, '2026-12-15').map((row) => row.id)).toEqual(['a', 'ex-factory'])
    expect(nextDatesOf(null, null)).toEqual([])
  })
})
