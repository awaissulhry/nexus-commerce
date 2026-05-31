import { describe, it, expect } from 'vitest'
import { settledCutoffDay, RESTATEMENT_WINDOW_HOURS } from './ads-reconcile.service.js'

// A.3 — the restatement-window boundary. A daily-perf date is "settled"
// (authoritative) iff date < settledCutoffDay(now). Everything from the cutoff
// day forward is still inside the ~72h window and may restate.
describe('settledCutoffDay', () => {
  it('floors now − 72h to the UTC day', () => {
    // now = 2026-05-31 02:00Z; −72h = 2026-05-28 02:00Z; floor → 2026-05-28.
    const cut = settledCutoffDay(new Date('2026-05-31T02:00:00.000Z'), 72)
    expect(cut.toISOString().slice(0, 10)).toBe('2026-05-28')
    expect(cut.getUTCHours()).toBe(0)
  })

  it('a date 4 days old is settled; a 2-day-old date is still provisional', () => {
    const now = new Date('2026-05-31T02:00:00.000Z')
    const cut = settledCutoffDay(now, 72)
    const fourDaysOld = new Date('2026-05-27T00:00:00.000Z')
    const twoDaysOld = new Date('2026-05-29T00:00:00.000Z')
    expect(fourDaysOld < cut).toBe(true) // settled
    expect(twoDaysOld < cut).toBe(false) // provisional (inside 72h window)
  })

  it('boundary: the cutoff day itself is provisional (strict <)', () => {
    const now = new Date('2026-05-31T23:59:59.000Z')
    const cut = settledCutoffDay(now, 72) // → 2026-05-28
    const cutoffDay = new Date('2026-05-28T00:00:00.000Z')
    expect(cutoffDay < cut).toBe(false)
  })

  it('respects a custom window (24h)', () => {
    const cut = settledCutoffDay(new Date('2026-05-31T12:00:00.000Z'), 24)
    expect(cut.toISOString().slice(0, 10)).toBe('2026-05-30')
  })

  it('defaults to the configured restatement window', () => {
    const now = new Date('2026-05-31T02:00:00.000Z')
    expect(settledCutoffDay(now).getTime()).toBe(settledCutoffDay(now, RESTATEMENT_WINDOW_HOURS).getTime())
  })
})
