import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PRESET, SCOPE_PRESETS, parseScope, scopeToParams, scopeToQuery, scopeKey,
  ACCOUNT_SCOPE, presetLabel, type AdsScope,
} from './ads-scope'

const sp = (qs: string) => new URLSearchParams(qs)

/**
 * The server's vocabulary, copied from apps/api/src/services/ads-core/date-range.ts.
 * If someone widens RangePreset there, this list is what makes the mismatch loud
 * instead of silent — resolveRange's default branch quietly returns SEVEN DAYS
 * for anything it does not recognise.
 */
const SERVER_PRESETS = [
  'today', 'yesterday', 'last7', 'last14', 'last30', 'last90',
  'wtd', 'mtd', 'last_month', 'qtd', 'ytd', 'last_year', 'lifetime',
]

/** The DateRangePicker's keys — deliberately NOT used by this section. */
const PICKER_PRESETS = [
  'thisWeek', 'lastWeek', 'thisMonth', 'lastMonth', 'last3m', 'last12m',
  'last18m', 'last24m', 'thisQuarter', 'lastQuarter', 'latest7', 'latest30', 'latest60',
]

describe('date vocabulary', () => {
  it('uses ONLY keys the server can resolve', () => {
    for (const p of SCOPE_PRESETS) expect(SERVER_PRESETS, p.key).toContain(p.key)
  })

  it('never adopts a DateRangePicker key — those resolve to 7 days server-side', () => {
    const ours = new Set(SCOPE_PRESETS.map((p) => p.key as string))
    for (const bad of PICKER_PRESETS) expect(ours.has(bad), `${bad} must not be used`).toBe(false)
  })

  it('rejects an unknown preset rather than forwarding it to the server', () => {
    // The exact failure this guards: ?preset=latest30 would have been forwarded,
    // resolveRange would not match it, and 7 days would come back labelled 30.
    expect(parseScope(sp('preset=latest30')).preset).toBe(DEFAULT_PRESET)
    expect(scopeToQuery(parseScope(sp('preset=latest30')))).toContain(`preset=${DEFAULT_PRESET}`)
  })
})

describe('parseScope', () => {
  it('defaults to the whole account over the default window', () => {
    expect(parseScope(sp(''))).toEqual(ACCOUNT_SCOPE)
  })

  it('reads a full scope', () => {
    expect(parseScope(sp('market=DE&scope=portfolio&id=pf1&preset=last7'))).toEqual({
      market: 'DE', grain: 'portfolio', id: 'pf1', preset: 'last7', start: null, end: null,
    })
  })

  it('falls back to the account when a grain has no id', () => {
    // A stale ?scope=portfolio with no id would otherwise filter to nothing and
    // read as "no data" rather than "no selection".
    const s = parseScope(sp('scope=portfolio'))
    expect(s.grain).toBe('account')
    expect(s.id).toBeNull()
  })

  it('accepts a custom range only when both ends are present', () => {
    expect(parseScope(sp('preset=custom&start=2026-08-01&end=2026-08-09')).preset).toBe('custom')
    expect(parseScope(sp('preset=custom&start=2026-08-01')).preset).toBe(DEFAULT_PRESET)
  })

  it('drops custom dates when the preset is not custom', () => {
    const s = parseScope(sp('preset=last7&start=2026-08-01&end=2026-08-09'))
    expect(s.start).toBeNull()
    expect(s.end).toBeNull()
  })

  it('falls back on an unknown grain', () => {
    expect(parseScope(sp('scope=galaxy&id=x')).grain).toBe('account')
  })
})

describe('scopeToQuery — what the API actually receives', () => {
  it('emits the server parameter names', () => {
    const q = sp(scopeToQuery({ ...ACCOUNT_SCOPE, market: 'IT', preset: 'last7' }))
    expect(q.get('marketplace')).toBe('IT')
    expect(q.get('preset')).toBe('last7')
  })

  it('sends explicit dates ONLY for a custom range', () => {
    const custom: AdsScope = { market: '', grain: 'account', id: null, preset: 'custom', start: '2026-08-01', end: '2026-08-09' }
    const q = sp(scopeToQuery(custom))
    expect(q.get('preset')).toBe('custom')
    expect(q.get('startDate')).toBe('2026-08-01')
    expect(q.get('endDate')).toBe('2026-08-09')
    // A preset must never carry client-computed dates — Rome anchoring is the
    // server's, and the browser's local midnight is not Rome's.
    expect(sp(scopeToQuery({ ...ACCOUNT_SCOPE, preset: 'mtd' })).get('startDate')).toBeNull()
  })

  it('never silently drops the grain', () => {
    const q = sp(scopeToQuery({ ...ACCOUNT_SCOPE, grain: 'product', id: 'B0ABC' }))
    expect(q.get('scopeGrain')).toBe('product')
    expect(q.get('scopeId')).toBe('B0ABC')
  })
})

describe('scopeToParams — what the URL shows', () => {
  it('stays empty at the default so a plain page URL is clean', () => {
    expect(scopeToParams(ACCOUNT_SCOPE).toString()).toBe('')
  })

  it('round-trips through the URL', () => {
    const s: AdsScope = { market: 'FR', grain: 'campaign', id: 'c9', preset: 'ytd', start: null, end: null }
    expect(parseScope(sp(scopeToParams(s).toString()))).toEqual(s)
  })
})

describe('scopeKey', () => {
  it('changes when any dimension changes', () => {
    const base = ACCOUNT_SCOPE
    const keys = new Set([
      scopeKey(base),
      scopeKey({ ...base, market: 'IT' }),
      scopeKey({ ...base, grain: 'campaign', id: 'c1' }),
      scopeKey({ ...base, preset: 'last7' }),
    ])
    expect(keys.size).toBe(4)
  })
})

describe('presetLabel', () => {
  it('names every preset and calls anything else a custom range', () => {
    for (const p of SCOPE_PRESETS) expect(presetLabel(p.key)).toBeTruthy()
    expect(presetLabel('custom')).toBe('Custom range')
  })
})
