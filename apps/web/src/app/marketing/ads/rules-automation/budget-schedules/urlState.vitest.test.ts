/**
 * BSP.0 — the URL contract, pinned.
 *
 * The brief names four malformed inputs that must render the default view instead of throwing
 * (`?weeks=abc`, `?weeks=999`, `?market=ZZ`, `?open=garbage`). They are here as assertions rather
 * than only as clicks on production, because seven later sessions add sections to this page and
 * each of them will edit the client around this contract.
 */
import { describe, it, expect } from 'vitest'
import {
  parseUrlState, parseOpen, serialiseUrlState, patchUrlState, needsNormalising,
  currentMonthUTC, shiftMonth,
  DEFAULT_MARKET, DEFAULT_WEEKS, DEFAULT_METRIC,
} from './urlState'

const at = (qs: string) => parseUrlState(new URLSearchParams(qs))

describe('parseUrlState — absent means the default', () => {
  it('renders the default view from an empty query', () => {
    expect(at('')).toEqual({
      market: DEFAULT_MARKET, portfolio: '', campaign: '', line: '',
      weeks: DEFAULT_WEEKS, month: currentMonthUTC(), metric: DEFAULT_METRIC, section: null, open: null,
    })
  })

  it('treats the `all` sentinel on a grain as "not narrowed"', () => {
    const s = at('portfolio=all&campaign=all&line=all')
    expect([s.portfolio, s.campaign, s.line]).toEqual(['', '', ''])
  })
})

describe('parseUrlState — a malformed value falls back and never throws', () => {
  it('?market=ZZ falls back to all', () => {
    expect(at('market=ZZ').market).toBe(DEFAULT_MARKET)
  })

  it('accepts the four real markets', () => {
    for (const m of ['IT', 'DE', 'ES', 'FR']) expect(at(`market=${m}`).market).toBe(m)
  })

  it('?weeks=abc falls back to 8', () => {
    expect(at('weeks=abc').weeks).toBe(DEFAULT_WEEKS)
  })

  it('?weeks=999 falls back to 8', () => {
    expect(at('weeks=999').weeks).toBe(DEFAULT_WEEKS)
  })

  it('rejects out-of-range and non-integer weeks, accepts the bounds', () => {
    expect(at('weeks=0').weeks).toBe(DEFAULT_WEEKS)
    expect(at('weeks=-4').weeks).toBe(DEFAULT_WEEKS)
    expect(at('weeks=27').weeks).toBe(DEFAULT_WEEKS)
    expect(at('weeks=8.5').weeks).toBe(DEFAULT_WEEKS)
    expect(at('weeks=').weeks).toBe(DEFAULT_WEEKS)
    expect(at('weeks=1').weeks).toBe(1)
    expect(at('weeks=26').weeks).toBe(26)
  })

  it('?metric=nonsense falls back to spend', () => {
    expect(at('metric=nonsense').metric).toBe(DEFAULT_METRIC)
    expect(at('metric=clicks').metric).toBe('clicks')
  })

  it('?section=nonsense is dropped rather than rendered', () => {
    expect(at('section=nonsense').section).toBeNull()
    expect(at('section=hours').section).toBe('hours')
  })

  it('an unknown param is ignored entirely', () => {
    expect(at('bogus=1&market=IT').market).toBe('IT')
    expect(serialiseUrlState(at('bogus=1&market=IT'))).toBe('market=IT')
  })
})

describe('parseOpen — a typed pair, or nothing', () => {
  it('?open=garbage leaves the rail closed', () => {
    expect(parseOpen('garbage')).toBeNull()
  })

  it('rejects an unknown kind, an empty id and a leading colon', () => {
    expect(parseOpen('wat:IT')).toBeNull()
    expect(parseOpen('schedule:')).toBeNull()
    expect(parseOpen(':abc')).toBeNull()
    expect(parseOpen('')).toBeNull()
    expect(parseOpen(null)).toBeNull()
  })

  it('accepts the four kinds', () => {
    expect(parseOpen('plan:IT')).toEqual({ kind: 'plan', id: 'IT' })
    expect(parseOpen('schedule:abc')).toEqual({ kind: 'schedule', id: 'abc' })
    expect(parseOpen('event:e1')).toEqual({ kind: 'event', id: 'e1' })
    expect(parseOpen('campaign:c1')).toEqual({ kind: 'campaign', id: 'c1' })
  })

  it('refuses a plan for a market this account does not sell in', () => {
    expect(parseOpen('plan:ZZ')).toBeNull()
    expect(parseOpen('plan:US')).toBeNull()
  })

  it('keeps every character after the first colon, so an id containing one survives', () => {
    expect(parseOpen('schedule:a:b')).toEqual({ kind: 'schedule', id: 'a:b' })
  })
})

describe('portfolio ⇄ campaign are mutually exclusive and campaign wins', () => {
  it('drops the portfolio when both are present', () => {
    const s = at('portfolio=p1&campaign=c1')
    expect(s.campaign).toBe('c1')
    expect(s.portfolio).toBe('')
  })

  it('normalises the URL rather than leaving the pair in the address bar', () => {
    expect(serialiseUrlState(at('portfolio=p1&campaign=c1'))).toBe('campaign=c1')
    expect(needsNormalising(new URLSearchParams('portfolio=p1&campaign=c1'))).toBe(true)
  })

  it('keeps a portfolio when no campaign is set', () => {
    expect(at('portfolio=p1').portfolio).toBe('p1')
  })
})

describe('serialiseUrlState — only non-defaults are written', () => {
  it('the default view serialises to the bare path', () => {
    expect(serialiseUrlState(at(''))).toBe('')
  })

  it('round-trips every non-default', () => {
    const qs = 'market=IT&portfolio=p1&line=l1&weeks=12&metric=clicks&section=hours&open=plan%3AIT'
    expect(parseUrlState(new URLSearchParams(serialiseUrlState(at(qs))))).toEqual(at(qs))
  })

  it('a param equal to its default never appears to have been chosen', () => {
    expect(serialiseUrlState(at('market=all&weeks=8&metric=spend'))).toBe('')
  })
})

describe('patchUrlState — the single writer', () => {
  const cur = (qs: string) => new URLSearchParams(qs)

  it('sets a value and clears one with the empty string', () => {
    expect(patchUrlState(cur('market=IT'), { market: 'DE' })).toBe('market=DE')
    expect(patchUrlState(cur('market=IT'), { market: '' })).toBe('')
  })

  it('cannot write a value the parser would reject', () => {
    expect(patchUrlState(cur(''), { weeks: '999' })).toBe('')
    expect(patchUrlState(cur(''), { market: 'ZZ' })).toBe('')
    expect(patchUrlState(cur(''), { open: 'garbage' })).toBe('')
  })

  it('enforces the exclusion when a campaign is chosen over a live portfolio', () => {
    expect(patchUrlState(cur('portfolio=p1'), { campaign: 'c1' })).toBe('campaign=c1')
  })

  it('closing the rail clears `open` and leaves the rest', () => {
    expect(patchUrlState(cur('market=IT&open=plan%3AIT'), { open: '' })).toBe('market=IT')
  })
})

describe('needsNormalising — rewrite once, and not on every load', () => {
  it('is false for an already-canonical query', () => {
    expect(needsNormalising(new URLSearchParams(''))).toBe(false)
    expect(needsNormalising(new URLSearchParams('market=IT&weeks=12'))).toBe(false)
  })

  it('is false for a merely reordered query', () => {
    expect(needsNormalising(new URLSearchParams('weeks=12&market=IT'))).toBe(false)
  })

  it('is true for a malformed or contradictory one', () => {
    expect(needsNormalising(new URLSearchParams('weeks=abc'))).toBe(true)
    expect(needsNormalising(new URLSearchParams('market=ZZ'))).toBe(true)
    expect(needsNormalising(new URLSearchParams('open=garbage'))).toBe(true)
    expect(needsNormalising(new URLSearchParams('portfolio=p1&campaign=c1'))).toBe(true)
  })

  it('ignores params this page does not own, so another feature’s query is not stripped', () => {
    expect(needsNormalising(new URLSearchParams('utm_source=x'))).toBe(false)
  })
})


describe('month — the money window', () => {
  it('defaults to the current month computed in UTC, matching the server', () => {
    const n = new Date()
    const expected = `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, '0')}`
    expect(at('').month).toBe(expected)
    expect(currentMonthUTC()).toBe(expected)
  })

  it('rejects every malformed form and falls back to the current month', () => {
    for (const bad of ['abc', '2026-13', '2026-00', '26-08', '2026-8', '2026-', '', '2026-012', '2026/08']) {
      expect(at(`month=${bad}`).month).toBe(currentMonthUTC())
    }
  })

  it('accepts a valid past and future month', () => {
    expect(at('month=2026-07').month).toBe('2026-07')
    expect(at('month=2026-09').month).toBe('2026-09')
    expect(at('month=2025-01').month).toBe('2025-01')
    expect(at('month=2026-12').month).toBe('2026-12')
  })

  it('omits the current month from the URL so "now" stays a bare link', () => {
    expect(serialiseUrlState(at(`month=${currentMonthUTC()}`))).toBe('')
    expect(needsNormalising(new URLSearchParams(`month=${currentMonthUTC()}`))).toBe(true)
  })

  it('keeps a non-current month and round-trips it', () => {
    expect(serialiseUrlState(at('month=2026-07'))).toBe('month=2026-07')
    expect(parseUrlState(new URLSearchParams('month=2026-07'))).toEqual(at('month=2026-07'))
  })

  it('rewrites a malformed month rather than leaving it in the address bar', () => {
    expect(needsNormalising(new URLSearchParams('month=2026-13'))).toBe(true)
    expect(serialiseUrlState(at('month=2026-13'))).toBe('')
  })

  it('cannot be written through patchUrlState if the parser would reject it', () => {
    expect(patchUrlState(new URLSearchParams(''), { month: '2026-13' })).toBe('')
    expect(patchUrlState(new URLSearchParams(''), { month: '2026-07' })).toBe('month=2026-07')
  })

  it('composes with the other params', () => {
    const qs = 'market=IT&month=2026-07&weeks=12'
    expect(serialiseUrlState(at(qs))).toBe('market=IT&weeks=12&month=2026-07')
  })
})

describe('shiftMonth — the stepper', () => {
  it('steps within a year', () => {
    expect(shiftMonth('2026-08', 1)).toBe('2026-09')
    expect(shiftMonth('2026-08', -1)).toBe('2026-07')
  })

  it('crosses the year boundary in both directions', () => {
    expect(shiftMonth('2026-12', 1)).toBe('2027-01')
    expect(shiftMonth('2026-01', -1)).toBe('2025-12')
  })

  it('steps by more than one month', () => {
    expect(shiftMonth('2026-08', 5)).toBe('2027-01')
    expect(shiftMonth('2026-08', -8)).toBe('2025-12')
  })

  it('round-trips, so the stepper cannot drift', () => {
    let m = '2026-08'
    for (let i = 0; i < 30; i++) m = shiftMonth(m, 1)
    for (let i = 0; i < 30; i++) m = shiftMonth(m, -1)
    expect(m).toBe('2026-08')
  })

  it('always produces a value the parser accepts', () => {
    let m = '2026-01'
    for (let i = 0; i < 24; i++) {
      m = shiftMonth(m, 1)
      expect(parseUrlState(new URLSearchParams(`month=${m}`)).month).toBe(m)
    }
  })
})
