/**
 * RA.SPINE S1 — the shared URL/scope contract, pinned.
 *
 * These are the rules ELEVEN pages share, so they are assertions rather than eleven clicks on
 * production. `budget-schedules/urlState.vitest.test.ts` keeps its own file and keeps passing
 * unchanged — it is the regression proof that generalising that module changed nothing about that
 * page. This file is the generalisation's own contract, not a second copy of it: nothing below
 * asserts a Budget-Pacing rule.
 *
 * The four the brief names explicitly are here (`?market=ZZ`, the `'all'` sentinel, the
 * mutually-exclusive pair, the round-trip), plus the one the spec got wrong — the full
 * `DATE_PRESETS` → `RangePreset` table, including every key with no equivalent.
 */
import { describe, it, expect } from 'vitest'
import {
  ALL_MARKETS, MARKETS, MARKET_ANY, marketOne,
  PICKER_TO_SERVER, adsScopeKeys, adsScopeNeedsNormalising, datePatchFromDays, datePatchFromPicker,
  grainAvailability, parseAdsScope, patchAdsScope, resolveScopeReach, writeAdsScope, ymdLocal,
  type AdsScopePolicy, type ScopeOptions,
} from './adsScope'

/** The seven pages for which an account-wide view is a legitimate answer. */
const ANY: AdsScopePolicy = { market: MARKET_ANY }
/** Share of Voice / Keyword Tracker: a share number needs a market to be a share OF. */
const ONE: AdsScopePolicy = { market: marketOne('IT') }
/** A page carrying the full spine, to exercise every opt-in param. */
const FULL: AdsScopePolicy = {
  market: MARKET_ANY,
  date: { preset: 'last30' },
  sort: { keys: ['spend', 'clicks', 'acos'], key: 'spend', dir: 'desc' },
  search: true,
  paged: true,
  row: true,
  drawers: ['activity', 'versions'],
}

const at = (qs: string, p: AdsScopePolicy = ANY) => parseAdsScope(new URLSearchParams(qs), p)
const round = (qs: string, p: AdsScopePolicy = ANY) => patchAdsScope(new URLSearchParams(qs), {}, p)

// ── market: the mechanism is shared, the policy is the page's ───────────────────────────────────

describe('market — the hook owns the mechanism, the page owns the policy', () => {
  it('an absent param means the page\'s documented default, not a stored preference', () => {
    expect(at('').market).toBe(ALL_MARKETS)
    expect(at('', ONE).market).toBe('IT')
  })

  it('accepts the four production markets under either policy', () => {
    for (const m of MARKETS) {
      expect(at(`market=${m}`).market).toBe(m)
      expect(at(`market=${m}`, ONE).market).toBe(m)
    }
  })

  it('?market=ZZ renders the default and never throws', () => {
    expect(at('market=ZZ').market).toBe(ALL_MARKETS)
    expect(at('market=ZZ', ONE).market).toBe('IT')
  })

  it('🔴 a page that says "all" is meaningless never resolves to it, even when the URL asks', () => {
    // This is the constraint the whole hook is shaped around: Share of Voice derives a share from
    // per-marketplace SQP, so an account-wide "share" is not a share of anything.
    expect(at(`market=${ALL_MARKETS}`, ONE).market).toBe('IT')
    expect(at(`market=${ALL_MARKETS}`).market).toBe(ALL_MARKETS)
  })

  it('a sandbox marketplace is not a scope', () => {
    for (const m of ['UK', 'NL', 'PL', 'SE', 'IE']) expect(at(`market=${m}`).market).toBe(ALL_MARKETS)
  })
})

// ── the sentinel ────────────────────────────────────────────────────────────────────────────────

describe("the 'all' sentinel belongs to market alone", () => {
  it("a grain carrying 'all' means 'not narrowed', and never travels as the literal", () => {
    const s = at('portfolio=all&campaign=all&line=all')
    expect([s.portfolio, s.campaign, s.line]).toEqual(['', '', ''])
    // The reverted RA scope bar would have emitted `?marketplace=all` — a marketplace of that
    // literal name: zero rows, no error.
    expect(round('portfolio=all&line=all')).toBe('')
  })

  it('an empty grain is not narrowed', () => {
    const s = at('portfolio=&campaign=&line=')
    expect([s.portfolio, s.campaign, s.line]).toEqual(['', '', ''])
  })
})

// ── the four grains ─────────────────────────────────────────────────────────────────────────────

describe('portfolio and campaign are mutually exclusive; the rest AND', () => {
  it('campaign wins, because it is the more specific of the two', () => {
    const s = at('portfolio=pf-1&campaign=c-9')
    expect(s.campaign).toBe('c-9')
    expect(s.portfolio).toBe('')
  })

  it('the pair is normalised out of the address bar, not merely ignored', () => {
    expect(round('portfolio=pf-1&campaign=c-9')).toBe('campaign=c-9')
  })

  it('market, line and campaign hold together — they AND, as ruleMatchesScope does', () => {
    const s = at('market=DE&line=p-1&campaign=c-9')
    expect([s.market, s.line, s.campaign]).toEqual(['DE', 'p-1', 'c-9'])
  })
})

// ── the round trip ──────────────────────────────────────────────────────────────────────────────

describe('round-trip — absent means the default, in both directions', () => {
  it('the canonical URL for the default view is the bare path', () => {
    expect(round('')).toBe('')
    expect(round(`market=${ALL_MARKETS}`)).toBe('')
    expect(round('market=IT', ONE)).toBe('')
    expect(round('preset=last30&sort=spend&dir=desc&page=1', FULL)).toBe('')
  })

  it('parse(write(x)) === x for a fully narrowed view', () => {
    const qs = 'market=DE&campaign=c-9&line=p-1&preset=custom&start=2026-07-01&end=2026-07-31&q=jacket&sort=clicks&dir=asc&page=3&row=r-2&drawer=activity'
    const first = parseAdsScope(new URLSearchParams(qs), FULL)
    const out = new URLSearchParams()
    writeAdsScope(out, first, FULL)
    expect(parseAdsScope(out, FULL)).toEqual(first)
  })

  it('?market=DE&preset=last30 survives a refresh unchanged', () => {
    expect(round('market=DE&preset=last30', FULL)).toBe('market=DE')
    const s = at('market=DE&preset=last30', FULL)
    expect([s.market, s.preset]).toEqual(['DE', 'last30'])
  })

  it('a merely reordered query is not a reason to navigate', () => {
    expect(adsScopeNeedsNormalising(new URLSearchParams('line=p-1&market=DE'), ANY)).toBe(false)
    expect(adsScopeNeedsNormalising(new URLSearchParams('market=DE&line=p-1'), ANY)).toBe(false)
  })

  it('a contradictory hand-typed pair IS a reason to navigate', () => {
    expect(adsScopeNeedsNormalising(new URLSearchParams('portfolio=pf-1&campaign=c-9'), ANY)).toBe(true)
    expect(adsScopeNeedsNormalising(new URLSearchParams('market=ZZ'), ANY)).toBe(true)
  })

  it('🔴 the guard shares the denominator of the value it guards', () => {
    const extra = (raw: URLSearchParams, out: URLSearchParams) => {
      const w = raw.get('weeks')
      if (w) out.set('weeks', w)
    }
    // Declared on BOTH sides: the writer re-emits it and the check counts it, so a page carrying
    // its own param sits still. Declaring it on only one side is the trap — a key the writer emits
    // but the check does not count reads as "not canonical" forever, and the effect renavigates on
    // every render.
    expect(adsScopeNeedsNormalising(new URLSearchParams('weeks=4'), ANY, ['weeks'], extra)).toBe(false)
    expect(adsScopeNeedsNormalising(new URLSearchParams('weeks=4'), ANY, [], extra)).toBe(true)
  })

  it('🔴 an UNDECLARED param is dropped on the first click, not on load', () => {
    // The check never sees it, so nothing rewrites the URL and the param looks safe…
    expect(adsScopeNeedsNormalising(new URLSearchParams('weeks=4'), ANY)).toBe(false)
    // …until any spine control moves, at which point it is gone. This is the failure mode a page
    // adopting the module has to know about: the symptom appears one interaction after the cause.
    expect(patchAdsScope(new URLSearchParams('weeks=4'), { market: 'DE' }, ANY)).toBe('market=DE')
  })

  it('a page keeps its own params through a spine edit', () => {
    const extra = (raw: URLSearchParams, out: URLSearchParams) => {
      const w = raw.get('weeks')
      if (w) out.set('weeks', w)
    }
    const qs = patchAdsScope(new URLSearchParams('weeks=4'), { market: 'DE' }, ANY, extra)
    expect(new URLSearchParams(qs).get('weeks')).toBe('4')
    expect(new URLSearchParams(qs).get('market')).toBe('DE')
  })

  it('an empty patch value clears the param', () => {
    expect(round('market=DE')).toBe('market=DE')
    expect(patchAdsScope(new URLSearchParams('market=DE'), { market: '' }, ANY)).toBe('')
  })
})

// ── opt-in params: adopting the module adds nothing a page did not have ─────────────────────────

describe('every param past the four grains is opt-in', () => {
  it('a page with no date/sort/search policy never parses or writes them', () => {
    const s = at('preset=last7&sort=clicks&dir=asc&q=x&page=4&row=r&drawer=activity')
    expect([s.preset, s.start, s.end, s.q, s.sort, s.page, s.row, s.drawer]).toEqual(['', '', '', '', '', 1, '', ''])
    expect(adsScopeKeys(ANY)).toEqual(['market', 'portfolio', 'campaign', 'line'])
  })

  it('and drops them from the URL rather than carrying a param nobody declared', () => {
    expect(round('sort=clicks&q=jacket')).toBe('')
  })

  it('a page that opts in gets the full key set', () => {
    expect(adsScopeKeys(FULL)).toEqual(
      ['market', 'portfolio', 'campaign', 'line', 'preset', 'start', 'end', 'q', 'sort', 'dir', 'page', 'row', 'drawer'],
    )
  })
})

describe('malformed values render the default and never throw', () => {
  it('?sort=nonsense falls back to the declared default', () => {
    expect(at('sort=nonsense', FULL).sort).toBe('spend')
    expect(at('dir=sideways', FULL).dir).toBe('desc')
  })

  it('?page rejects zero, negatives and fractions', () => {
    for (const p of ['0', '-4', '2.5', 'abc', '']) expect(at(`page=${p}`, FULL).page).toBe(1)
    expect(at('page=3', FULL).page).toBe(3)
  })

  it('?drawer=garbage leaves the panel closed rather than opening one titled after nothing', () => {
    expect(at('drawer=garbage', FULL).drawer).toBe('')
    expect(at('drawer=activity', FULL).drawer).toBe('activity')
  })

  it('a half-custom range falls back to the preset rather than an open-ended window', () => {
    expect(at('preset=custom&start=2026-07-01', FULL).preset).toBe('last30')
    expect(at('preset=custom&end=2026-07-31', FULL).preset).toBe('last30')
    expect(at('preset=custom&start=nonsense&end=2026-07-31', FULL).preset).toBe('last30')
    expect(at('preset=custom&start=2026-13-01&end=2026-07-31', FULL).preset).toBe('last30')
  })

  it('a reversed custom range is swapped, not rejected — a typo still has one reading', () => {
    const s = at('preset=custom&start=2026-07-31&end=2026-07-01', FULL)
    expect([s.start, s.end]).toEqual(['2026-07-01', '2026-07-31'])
  })
})

// ── the date adapter: the spec's number was wrong ───────────────────────────────────────────────

describe('DATE_PRESETS → RangePreset — one adapter, and a picker key never leaves it', () => {
  const MAPPED: Record<string, string> = {
    today: 'today', yesterday: 'yesterday', thisMonth: 'mtd', lastMonth: 'last_month',
    thisQuarter: 'qtd', latest7: 'last7', latest30: 'last30',
  }
  const UNMAPPED = ['thisWeek', 'lastWeek', 'last3m', 'last12m', 'last18m', 'last24m', 'lastQuarter', 'latest60']

  it('covers every one of the picker\'s 15 keys, with no third state', () => {
    expect(Object.keys(PICKER_TO_SERVER).sort()).toEqual([...Object.keys(MAPPED), ...UNMAPPED].sort())
    expect(Object.keys(PICKER_TO_SERVER)).toHaveLength(15)
  })

  it('maps the seven that produce the same window', () => {
    for (const [k, v] of Object.entries(MAPPED)) expect(PICKER_TO_SERVER[k]).toBe(v)
  })

  it('🔴 refuses the EIGHT with no equivalent — the spec said three', () => {
    // thisWeek starts Sunday, the server's `wtd` starts Monday (ISO). `last12m` is a trailing
    // twelve months; `last_year` is the previous calendar YEAR. The rest have no server preset at
    // all. Forwarding any of them hits `resolveRange`'s `default:` and returns SEVEN DAYS under
    // whatever label the operator picked.
    expect(UNMAPPED).toHaveLength(8)
    for (const k of UNMAPPED) expect(PICKER_TO_SERVER[k]).toBeNull()
  })

  it('an unmapped key travels as explicit dates, never as the nearest-looking preset', () => {
    const resolve = () => ({ start: new Date(2026, 6, 1), end: new Date(2026, 6, 31) })
    expect(datePatchFromPicker('lastQuarter', resolve)).toEqual({ preset: 'custom', start: '2026-07-01', end: '2026-07-31' })
    expect(datePatchFromPicker('thisWeek', resolve).preset).toBe('custom')
  })

  it('a mapped key travels as the server key, so the SERVER anchors the window to Rome', () => {
    const boom = () => { throw new Error('a mapped key must not be resolved in the browser') }
    expect(datePatchFromPicker('latest30', boom)).toEqual({ preset: 'last30', start: '', end: '' })
  })

  it('🔴 dates are read from LOCAL parts — toISOString would shift Rome back a day', () => {
    // 2026-08-12 00:00 local in Rome is 2026-08-11T22:00Z.
    const midnight = new Date(2026, 7, 12, 0, 0, 0)
    expect(ymdLocal(midnight)).toBe('2026-08-12')
    expect(midnight.toISOString().slice(0, 10)).not.toBe('2026-08-12')
  })

  it('a hand-picked calendar range is always explicit', () => {
    expect(datePatchFromDays(new Date(2026, 0, 5), new Date(2026, 0, 9)))
      .toEqual({ preset: 'custom', start: '2026-01-05', end: '2026-01-09' })
  })
})

// ── reach ───────────────────────────────────────────────────────────────────────────────────────

const OPTIONS: ScopeOptions = {
  totalCampaigns: 6,
  campaigns: [
    { id: 'c1', name: 'IT A', marketplace: 'IT', portfolioId: 'pf1' },
    { id: 'c2', name: 'IT B', marketplace: 'IT', portfolioId: 'pf1' },
    { id: 'c3', name: 'DE A', marketplace: 'DE', portfolioId: 'pf2' },
    { id: 'c4', name: 'DE B', marketplace: 'DE', portfolioId: null },
    { id: 'c5', name: 'FR A', marketplace: 'FR', portfolioId: 'pf2' },
    { id: 'c6', name: 'ES A', marketplace: 'ES', portfolioId: null },
  ],
  portfolios: [
    { externalPortfolioId: 'pf1', name: 'Jackets' },
    { externalPortfolioId: 'pf2', name: 'Gloves' },
  ],
  campaignsWithoutPortfolio: 2,
  productLines: [
    { id: 'L1', sku: 'GALE', name: 'Gale', variations: 3, campaigns: ['c1', 'c3', 'c5'],
      children: [{ id: 'v1', sku: 'GALE-M', name: 'Gale M', campaigns: ['c1'] }] },
    { id: 'L2', sku: 'AIREON', name: 'Aireon', variations: 1, campaigns: ['c2'], children: [] },
  ],
}
/** `OPTIONS` is never null here, so the non-null assertion is a fact, not a hope. */
const R = (s: Partial<{ market: string; portfolio: string; campaign: string; line: string }>, w?: Set<string>) =>
  resolveScopeReach(OPTIONS, { market: ALL_MARKETS, portfolio: '', campaign: '', line: '', ...s }, w)!

describe('reach — the same intersection the server enforces with', () => {
  it('is null before the options land, never a zero', () => {
    expect(resolveScopeReach(null, { market: 'IT', portfolio: '', campaign: '', line: '' })).toBeNull()
  })

  it('an unnarrowed scope reaches the whole account', () => {
    expect(R({})).toMatchObject({ resolved: 6, total: 6, applied: [], contradiction: null })
  })

  it('the grains AND, exactly as ruleMatchesScope does', () => {
    expect(R({ market: 'IT' }).resolved).toBe(2)
    expect(R({ market: 'IT', line: 'L1' }).resolved).toBe(1)      // c1 only — c3/c5 are DE/FR
    expect(R({ line: 'L1' }).resolved).toBe(3)
    expect(R({ market: 'DE', portfolio: 'pf2' }).resolved).toBe(1)
  })

  it('a child product resolves to its own campaigns, a parent to the whole line', () => {
    expect(R({ line: 'v1' }).resolved).toBe(1)
    expect(R({ line: 'L1' }).variations).toBe(3)
    expect(R({ line: 'v1' }).variations).toBeNull()
  })

  it('names the portfolio blind spot whenever a portfolio is chosen, healthy or not', () => {
    expect(R({ portfolio: 'pf1' }).notes[0]).toMatch(/2 of 6 campaigns carry no portfolio/)
    expect(R({ market: 'IT' }).notes).toEqual([])
  })

  it('🔴 a combination that can never fire is a REFUSAL, named — not an empty grid', () => {
    const r = R({ market: 'IT', portfolio: 'pf2' })
    expect(r.resolved).toBe(0)
    expect(r.contradiction).toBe('market IT + one portfolio have no campaign in common, so nothing scoped this way could ever match.')
  })

  it('an unnarrowed empty account is not a contradiction', () => {
    const empty = resolveScopeReach({ ...OPTIONS, totalCampaigns: 0, campaigns: [] }, { market: ALL_MARKETS, portfolio: '', campaign: '', line: '' })
    expect(empty!.contradiction).toBeNull()
  })

  it('🔴 writable is NULL when the page cannot know, and is never a fabricated zero', () => {
    // scope-options carries no write-gate field; the gate is a second endpoint. A zero here would
    // make "reaches nothing" and "not permitted to write" read identically — the exact collision
    // two numbers exist to prevent.
    expect(R({ market: 'IT' }).writable).toBeNull()
    expect(R({ market: 'IT' }, new Set(['c1'])).writable).toBe(1)
    expect(R({ market: 'IT' }, new Set()).writable).toBe(0)
  })
})

// ── grain availability ──────────────────────────────────────────────────────────────────────────

describe('a grain that cannot narrow says so, and never sits there inert', () => {
  it('all four are live on an account shaped like this one', () => {
    const g = grainAvailability(OPTIONS)
    expect([g.market.enabled, g.portfolio.enabled, g.line.enabled, g.campaign.enabled]).toEqual([true, true, true, true])
    expect(g.market.options).toBe(4)
  })

  it('a single-market account disables the market grain WITH a sentence', () => {
    const one = { ...OPTIONS, campaigns: OPTIONS.campaigns.map((c) => ({ ...c, marketplace: 'IT' })) }
    const g = grainAvailability(one)
    expect(g.market.enabled).toBe(false)
    expect(g.market.reason).toContain('IT')
  })

  it('an account with no portfolios says the binding can never reach anything', () => {
    const none = { ...OPTIONS, campaigns: OPTIONS.campaigns.map((c) => ({ ...c, portfolioId: null })) }
    expect(grainAvailability(none).portfolio.reason).toMatch(/no portfolio binding can reach anything/)
  })

  it('before the options land, every grain is disabled and says it is loading — not "empty"', () => {
    const g = grainAvailability(null)
    for (const k of ['market', 'portfolio', 'line', 'campaign'] as const) {
      expect(g[k].enabled).toBe(false)
      expect(g[k].reason).toMatch(/loading/i)
    }
  })
})
