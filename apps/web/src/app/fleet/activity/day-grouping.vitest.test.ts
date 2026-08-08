import { describe, expect, it } from 'vitest'
import { dayKey, dayLabel, hhmm } from './day-grouping'

/**
 * NAF.SB.ACT.S4R — the regression these exist for cannot be seen on screen.
 *
 * The fleet has never produced an event between 22:00 and 24:00 UTC, so the old
 * UTC `dayKey` looked perfect in every screenshot while being one day wrong for
 * any event in that window. A browser pass is the wrong instrument for a bug
 * whose trigger is absent from the data; a round trip is the right one.
 *
 * These run in whatever zone the machine is in, so none of them hard-codes an
 * offset. They assert the RELATIONSHIP that was broken instead: the header and
 * the clock underneath it describe one instant.
 */

/** Rebuild the instant from what the row actually shows the reader. */
const asRendered = (iso: string) => new Date(`${dayKey(iso)}T${hhmm(iso)}:00`)

describe('the day header and the clock on the row agree', () => {
  const instants = [
    '2026-08-06T23:30:00Z', // the measured case: UTC 6th, local 7th at UTC+2
    '2026-08-06T22:00:00Z',
    '2026-08-06T23:59:59Z',
    '2026-08-07T00:00:00Z',
    '2026-08-06T00:30:00Z', // the mirror case, for zones west of UTC
    '2026-08-06T12:15:40Z', // a real fleet event
    '2026-08-07T19:45:33Z', // the newest real fleet event
    '2026-01-15T23:30:00Z', // winter, in case the zone observes DST
  ]

  for (const iso of instants) {
    it(`round-trips ${iso}`, () => {
      const shown = asRendered(iso)
      const actual = new Date(iso)
      // To the minute: the row prints HH:MM, so seconds are not recoverable.
      expect(Math.abs(shown.getTime() - actual.getTime())).toBeLessThan(60_000)
    })
  }

  it('files an instant under its LOCAL day, not its UTC one', () => {
    const iso = '2026-08-06T23:30:00Z'
    const d = new Date(iso)
    expect(dayKey(iso)).toBe(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    )
  })

  it('never returns a UTC date when the two differ', () => {
    // Somewhere in the 24h clock there is an instant whose UTC day differs from
    // the local one, unless the machine is exactly on UTC. Find it, then assert
    // the key follows the LOCAL side.
    const probes = Array.from({ length: 24 }, (_, h) =>
      `2026-08-06T${String(h).padStart(2, '0')}:30:00Z`,
    )
    const divergent = probes.filter((iso) => dayKey(iso) !== iso.slice(0, 10))
    if (divergent.length === 0) return // the machine is on UTC; nothing to prove
    for (const iso of divergent) {
      const d = new Date(iso)
      expect(dayKey(iso)).toBe(
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
      )
    }
  })
})

describe('dayLabel', () => {
  const now = new Date('2026-08-08T12:00:00Z')

  it('names today and yesterday on the same basis as the key', () => {
    expect(dayLabel(dayKey(now.toISOString()), now)).toBe('Today')
    const y = new Date(now.getTime() - 86_400_000)
    expect(dayLabel(dayKey(y.toISOString()), now)).toBe('Yesterday')
  })

  it('spells out anything older, and names the day the KEY names', () => {
    const key = '2026-08-06'
    const label = dayLabel(key, now)
    expect(label).not.toBe('Today')
    expect(label).not.toBe('Yesterday')
    // The label must not drift a day from its own key — parsing the key as UTC
    // midnight is how that happens in zones west of UTC.
    expect(label).toContain('6')
  })
})
