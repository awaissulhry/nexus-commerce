import { describe, expect, it } from 'vitest'
import { combineLocal, localDay, localTime, momentValue, timeOptions, timeZoneWords } from './DateTimeField'

describe('DateTimeField — the moment it stores', () => {
  it('a local day and time round-trip through the stored instant', () => {
    const iso = momentValue('2026-09-21', '09:00', '09:00', null, null)
    const back = new Date(iso)
    expect([localDay(back), localTime(back)]).toEqual(['2026-09-21', '09:00'])
    expect(iso).toBe(combineLocal('2026-09-21', '09:00').toISOString())
  })

  it('a new day starts at the default time; no day is no value', () => {
    expect(localTime(new Date(momentValue('2026-09-21', '', '09:00', null, null)))).toBe('09:00')
    expect(momentValue('', '10:00', '09:00', null, null)).toBe('')
  })

  it('a chosen moment outside [min, max] is kept inside it', () => {
    const min = combineLocal('2026-09-21', '10:07')
    const max = combineLocal('2026-09-30', '18:00')
    expect(momentValue('2026-09-21', '09:00', '09:00', min, max)).toBe(min.toISOString())
    expect(momentValue('2026-10-02', '09:00', '09:00', min, max)).toBe(max.toISOString())
  })

  it('the first day offers no time before min; a stored time between steps stays offered', () => {
    const min = combineLocal('2026-09-21', '10:07')
    const first = timeOptions('2026-09-21', 15, min, null)
    expect(first[0]).toBe('10:15')
    expect(first).not.toContain('10:00')
    expect(timeOptions('2026-09-22', 15, min, null)).toHaveLength(96) // every quarter hour
    expect(timeOptions('2026-09-22', 60, min, null, '09:40')).toContain('09:40')
  })

  it('names the zone the times are in', () => {
    const words = timeZoneWords(new Date('2026-09-21T07:00:00Z'))
    expect(words).toContain(Intl.DateTimeFormat().resolvedOptions().timeZone)
  })
})
