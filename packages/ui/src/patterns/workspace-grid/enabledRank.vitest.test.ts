import { describe, expect, it } from 'vitest'
import { enabledRank } from './enabledRank'

// SF.1 — the ordering the grids use for their default view: live things first, archived last.
describe('enabledRank', () => {
  it('ranks boolean toggles (rules, rank schedules)', () => {
    expect(enabledRank(true)).toBe(0)
    expect(enabledRank(false)).toBe(1)
  })

  it('ranks Amazon campaign/ad-group/target statuses', () => {
    expect(enabledRank('ENABLED')).toBe(0)
    expect(enabledRank('PAUSED')).toBe(1)
    expect(enabledRank('ARCHIVED')).toBe(2)
  })

  it('ranks the eBay vocabulary too', () => {
    expect(enabledRank('RUNNING')).toBe(0)
    expect(enabledRank('ENDED')).toBe(2)
  })

  it('is case-insensitive', () => {
    expect(enabledRank('enabled')).toBe(0)
    expect(enabledRank('Archived')).toBe(2)
  })

  // A status we don't know about must not be silently buried below archived rows — the operator
  // would never find it. Middle band is the safe default.
  it('puts an unknown status with paused, never at the bottom', () => {
    expect(enabledRank('SOMETHING_NEW')).toBe(1)
    expect(enabledRank(undefined)).toBe(1)
    expect(enabledRank(null)).toBe(1)
    expect(enabledRank('')).toBe(1)
  })

  it('sorts a mixed list live-first, and is stable for equal ranks', () => {
    const rows = [
      { n: 'archived-a', s: 'ARCHIVED' },
      { n: 'paused-a', s: 'PAUSED' },
      { n: 'enabled-a', s: 'ENABLED' },
      { n: 'enabled-b', s: 'ENABLED' },
      { n: 'unknown-a', s: 'WEIRD' },
    ]
    const out = [...rows].sort((a, b) => enabledRank(a.s) - enabledRank(b.s)).map((r) => r.n)
    expect(out).toEqual(['enabled-a', 'enabled-b', 'paused-a', 'unknown-a', 'archived-a'])
  })
})
