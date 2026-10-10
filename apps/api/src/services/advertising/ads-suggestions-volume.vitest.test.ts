/**
 * F4 (2026-10-10, honest numbers) — the Suggestions queue's search volume comes from Amazon Brand Analytics WEEK rows
 * only (the read asks for `reportPeriod: 'WEEK'`), and the week travels with the number (`searchVolumeWeekStart`).
 * `newestWeekVolumes` picks, per market × query, the newest week that carries a volume; a 0 or missing volume is not a
 * reading and never shows as 0. Fake queries, round numbers.
 */
import { describe, it, expect } from 'vitest'
import { newestWeekVolumes } from './ads-suggestions.service.js'

const week = (d: string) => new Date(`${d}T00:00:00Z`)

describe('newestWeekVolumes — F4', () => {
  it('the newest week wins, with its start date; markets are apart', () => {
    const m = newestWeekVolumes([
      { marketplace: 'IT', searchQuery: 'test jacket', startDate: week('2026-09-20'), volume: 800 },
      { marketplace: 'IT', searchQuery: 'test jacket', startDate: week('2026-09-27'), volume: 900 },
      { marketplace: 'DE', searchQuery: 'test jacket', startDate: week('2026-09-13'), volume: 300 },
    ])
    expect(m.get('IT|test jacket')).toEqual({ volume: 900, weekStart: '2026-09-27' })
    expect(m.get('DE|test jacket')).toEqual({ volume: 300, weekStart: '2026-09-13' })
  })

  it('a week with no volume (0 or none) is not a reading: the newest week that has one is used, or nothing', () => {
    const m = newestWeekVolumes([
      { marketplace: 'IT', searchQuery: 'q1', startDate: week('2026-09-27'), volume: 0 },
      { marketplace: 'IT', searchQuery: 'q1', startDate: week('2026-09-20'), volume: 450 },
      { marketplace: 'IT', searchQuery: 'q2', startDate: week('2026-09-27'), volume: null },
    ])
    expect(m.get('IT|q1')).toEqual({ volume: 450, weekStart: '2026-09-20' })
    expect(m.has('IT|q2')).toBe(false)
  })
})
