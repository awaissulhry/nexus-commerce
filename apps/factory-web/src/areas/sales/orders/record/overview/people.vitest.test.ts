import { describe, expect, it } from 'vitest'
import { placeWords } from './people'

/** F-OO-100 (order overview lane: one file per section) — People's rules, moved with people.ts out of overview.vitest.test.ts unchanged. */

describe('Overview’s facts (F-SA-233): People', () => {
  it('people: places only — a site · line · team, or an outside workshop; never an operator', () => {
    expect(placeWords({ site: { code: 'S1', name: 'Main site' }, line: { code: 'L2', name: 'Line 2' }, team: null, workshop: null })).toBe('Main site · Line 2')
    expect(placeWords({ site: null, line: null, team: null, workshop: { name: 'Workshop Beta Leather' } })).toBe('Workshop Beta Leather')
  })
})
