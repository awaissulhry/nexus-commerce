/**
 * ACR.1.5 — the cron evaluator, against the expressions this fleet actually runs.
 *
 * Every case below is a real default from `src/jobs/*.ts`. A preview that miscounts these
 * would tell an operator the bid optimiser runs twice tonight when it runs four times, which
 * is worse than saying "every 6 h" and leaving them to work it out.
 */
import { describe, it, expect } from 'vitest'
import { firesIn, firesAt, parseCron, describeCron } from './cron-window.js'

const at = (iso: string) => new Date(iso)

describe('the fleet\'s real expressions', () => {
  it('*/15 — rank defend fires 96 times a day', () => {
    expect(firesIn('*/15 * * * *', at('2026-08-05T00:00:00Z')).count).toBe(96)
  })

  it('*/30 — budget enforcement fires 48 times', () => {
    expect(firesIn('*/30 * * * *', at('2026-08-05T00:00:00Z')).count).toBe(48)
  })

  it('20 */6 — the bid optimiser fires 4 times, at :20', () => {
    const r = firesIn('20 */6 * * *', at('2026-08-05T00:00:00Z'))
    expect(r.count).toBe(4)
    expect(r.fires).toEqual([
      '2026-08-05T00:20:00.000Z', '2026-08-05T06:20:00.000Z',
      '2026-08-05T12:20:00.000Z', '2026-08-05T18:20:00.000Z',
    ])
  })

  it('30 6 — harvest fires once, and only once', () => {
    const r = firesIn('30 6 * * *', at('2026-08-05T00:00:00Z'))
    expect(r.count).toBe(1)
    expect(r.next).toBe('2026-08-05T06:30:00.000Z')
  })

  it('7,22,37,52 — a minute list fires 4× an hour', () => {
    expect(firesIn('7,22,37,52 * * * *', at('2026-08-05T00:00:00Z')).count).toBe(96)
  })

  it('35 */6 — the structural reconcile fires 4 times', () => {
    expect(firesIn('35 */6 * * *', at('2026-08-05T00:00:00Z')).count).toBe(4)
  })

  it('* * * * * — every minute is 1,440', () => {
    expect(firesIn('* * * * *', at('2026-08-05T00:00:00Z')).count).toBe(1440)
  })
})

describe('the window is honest about its edges', () => {
  it('never reports a fire that already happened', () => {
    // 06:30 has passed when "now" is 07:00 — the next one is tomorrow's.
    const r = firesIn('30 6 * * *', at('2026-08-05T07:00:00Z'))
    expect(r.next).toBe('2026-08-06T06:30:00.000Z')
  })

  it('does not fire at the instant `from` itself when that minute is already underway', () => {
    // 06:30:40 is inside the 06:30 minute; that run has started.
    const r = firesIn('30 6 * * *', at('2026-08-05T06:30:40Z'))
    expect(r.next).toBe('2026-08-06T06:30:00.000Z')
  })

  it('returns no fires when the window contains none', () => {
    const r = firesIn('30 6 * * *', at('2026-08-05T07:00:00Z'), 6)
    expect(r.count).toBe(0)
    expect(r.next).toBeNull()
  })

  it('caps the list but never the count', () => {
    const r = firesIn('*/15 * * * *', at('2026-08-05T00:00:00Z'), 24, 3)
    expect(r.fires).toHaveLength(3)
    expect(r.count).toBe(96)
  })
})

describe('weekly expressions', () => {
  it('0 2 * * 0 — Sunday only', () => {
    // 2026-08-05 is a Wednesday; the next Sunday is 2026-08-09.
    const r = firesIn('0 2 * * 0', at('2026-08-05T00:00:00Z'), 24 * 7)
    expect(r.next).toBe('2026-08-09T02:00:00.000Z')
    expect(r.count).toBe(1)
  })

  it('treats 7 as Sunday, like crontab does', () => {
    expect(firesAt(parseCron('0 2 * * 7'), at('2026-08-09T02:00:00Z'))).toBe(true)
  })

  it('day-of-month and day-of-week together are a UNION, per crontab', () => {
    // "the 1st, or any Monday" — fires on a Wednesday the 1st AND on a Monday the 3rd.
    const c = parseCron('0 0 1 * 1')
    expect(firesAt(c, at('2026-07-01T00:00:00Z'))).toBe(true)  // the 1st, a Wednesday
    expect(firesAt(c, at('2026-07-06T00:00:00Z'))).toBe(true)  // a Monday, the 6th
    expect(firesAt(c, at('2026-07-07T00:00:00Z'))).toBe(false) // neither
  })
})

describe('refuses to guess', () => {
  it('throws on the wrong number of fields rather than inventing one', () => {
    expect(() => parseCron('*/15 * * *')).toThrow(/5 fields/)
  })

  it('throws on an out-of-range value', () => {
    expect(() => parseCron('99 * * * *')).toThrow()
  })

  it('throws on a zero step', () => {
    expect(() => parseCron('*/0 * * * *')).toThrow()
  })
})

describe('describeCron', () => {
  it('reads the cadence off the expression, not off a label someone typed', () => {
    expect(describeCron('*/15 * * * *')).toBe('every 15 min')
    expect(describeCron('20 */6 * * *')).toBe('every 6 h at :20')
    expect(describeCron('30 6 * * *')).toBe('daily 06:30 UTC')
    expect(describeCron('45 * * * *')).toBe('hourly at :45')
    expect(describeCron('* * * * *')).toBe('every minute')
    expect(describeCron('7,22,37,52 * * * *')).toBe('4× an hour')
    expect(describeCron('0 2 * * 0')).toBe('weekly, 02:00 UTC')
  })

  it('falls back to the raw expression rather than lying about an unknown shape', () => {
    expect(describeCron('not a cron')).toBe('not a cron')
  })
})
