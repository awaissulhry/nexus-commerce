/**
 * RD.P0 — the scope contract, tested where it is pure.
 *
 * P1–P7 all narrow rows through these functions, so a precedence mistake here would show up as
 * "the grid disagrees with the tiles" three sections later. The cases that matter are the ones
 * that came out of the measurement rather than the design:
 *
 *   · a group's market is a DERIVED SET (`RankScheduleGroup.marketplace` is null on 9 of 16 rows);
 *   · a coarser grain is never cleared when a narrower one is picked, only overridden;
 *   · defaults are absent from the URL, and unknown params survive a filter click.
 */
import { describe, expect, it } from 'vitest'
import {
  EMPTY_SCOPE, applyUrlState, boundBy, campaignMatchesScope, groupMatchesScope,
  overriddenGrains, parseUrlState, urlStateToQuery,
} from './scope'
import { EMPTY_RUNTIME, type RdCampaignRow, type RdGroupRow } from './types'

const group = (over: Partial<RdGroupRow['scope']>, id = 'g1'): RdGroupRow => ({
  id, name: id, enabled: true, timezone: 'Europe/Rome',
  defaultTargetKey: 'rest-of-search', activeTargetKey: 'own-top',
  windowsRaw: [], windowCount: 0, portfolioId: null, portfolioName: null,
  scope: { marketplaces: [], portfolioIds: [], productLineIds: [], campaignIds: [], ...over },
  campaignCount: 0, membersTotal: 0, membersEnabled: 0,
  lastEvaluatedAt: null, lastApplied: null, failedWrites: 0, governedElsewhere: 0,
  performance: { costCents: 0, salesCents: 0, orders: 0, clicks: 0, impressions: 0, acos: null, windowDays: 30 },
})

const campaign = (over: Partial<RdCampaignRow>): RdCampaignRow => ({
  campaignId: 'c1', campaignName: 'c1', marketplace: 'IT', portfolioId: null, portfolioName: null,
  productLineIds: [], status: 'ENABLED', groupId: 'g1', groupName: 'g1', scheduleEnabled: null,
  lastEvaluatedAt: null, lastApplied: null,
  runtime: { ...EMPTY_RUNTIME }, ...over,
})

describe('boundBy — most specific wins', () => {
  it('is null when nothing narrows', () => {
    expect(boundBy(EMPTY_SCOPE)).toBeNull()
    expect(boundBy({ ...EMPTY_SCOPE, market: '' })).toBeNull()
  })

  it('treats market=all as not narrowing', () => {
    expect(boundBy({ ...EMPTY_SCOPE, market: 'all' })).toBeNull()
    expect(boundBy({ ...EMPTY_SCOPE, market: 'IT' })).toBe('market')
  })

  it('picks the narrowest grain, not the last one set', () => {
    expect(boundBy({ market: 'IT', portfolio: 'p1', product: '', campaign: '' })).toBe('portfolio')
    expect(boundBy({ market: 'IT', portfolio: 'p1', product: 'pr1', campaign: '' })).toBe('product')
    expect(boundBy({ market: 'IT', portfolio: 'p1', product: 'pr1', campaign: 'c1' })).toBe('campaign')
  })

  it('names the coarser grains that are still set but no longer narrowing', () => {
    expect(overriddenGrains({ market: 'IT', portfolio: 'p1', product: '', campaign: 'c1' }))
      .toEqual(['portfolio', 'market'])
    expect(overriddenGrains({ ...EMPTY_SCOPE, market: 'IT' })).toEqual([])
  })
})

describe('groupMatchesScope — every grain is a derived SET', () => {
  it('matches a market held by any member campaign', () => {
    const g = group({ marketplaces: ['DE', 'IT'] })
    expect(groupMatchesScope(g, { ...EMPTY_SCOPE, market: 'DE' })).toBe(true)
    expect(groupMatchesScope(g, { ...EMPTY_SCOPE, market: 'ES' })).toBe(false)
  })

  it('matches a portfolio a member campaign carries even when the group has none of its own', () => {
    // 3 of 4 live groups are portfolio-scoped; the fourth is not, and its member still has one.
    const g = group({ portfolioIds: ['172873896995892'] })
    expect(groupMatchesScope(g, { ...EMPTY_SCOPE, portfolio: '172873896995892' })).toBe(true)
  })

  it('lets the narrowest grain decide alone — a campaign match survives a contradicting market', () => {
    const g = group({ marketplaces: ['IT'], campaignIds: ['c9'] })
    expect(groupMatchesScope(g, { market: 'DE', portfolio: '', product: '', campaign: 'c9' })).toBe(true)
  })

  it('keeps every row when nothing is picked', () => {
    expect(groupMatchesScope(group({}), EMPTY_SCOPE)).toBe(true)
  })
})

describe('campaignMatchesScope — scalars, because a campaign has one of each', () => {
  it('matches on its own market and portfolio', () => {
    const c = campaign({ marketplace: 'IT', portfolioId: 'p1' })
    expect(campaignMatchesScope(c, { ...EMPTY_SCOPE, market: 'IT' })).toBe(true)
    expect(campaignMatchesScope(c, { ...EMPTY_SCOPE, market: 'DE' })).toBe(false)
    expect(campaignMatchesScope(c, { ...EMPTY_SCOPE, portfolio: 'p1' })).toBe(true)
  })

  it('matches a product line among the several a campaign can advertise', () => {
    const c = campaign({ productLineIds: ['L1', 'L2'] })
    expect(campaignMatchesScope(c, { ...EMPTY_SCOPE, product: 'L2' })).toBe(true)
    expect(campaignMatchesScope(c, { ...EMPTY_SCOPE, product: 'L3' })).toBe(false)
  })
})

describe('the URL contract', () => {
  it('reads defaults out of an empty query', () => {
    const s = parseUrlState(new URLSearchParams(''))
    // FB.3c widened the contract: the schedules grid's four filters, the campaigns grain's four
    // additions, and the hourly card's weeks window all live in the URL now.
    expect(s).toEqual({
      market: 'all', portfolio: '', product: '', campaign: '', grain: 'schedules', row: '', drawer: '', tile: '', mode: '', signal: '', converge: '',
      status: '', health: '', baseline: '', windows: '', fresh: '', ceiling: '', cstatus: '', schedule: '', from: '', to: '',
    })
  })

  it('falls back rather than throwing on an unknown grain', () => {
    expect(parseUrlState(new URLSearchParams('grain=nonsense')).grain).toBe('schedules')
    expect(parseUrlState(new URLSearchParams('grain=campaigns')).grain).toBe('campaigns')
  })

  it('survives a null searchParams', () => {
    expect(parseUrlState(null).market).toBe('all')
  })

  it('never writes a default into the URL', () => {
    expect(urlStateToQuery({ market: 'all', grain: 'schedules', portfolio: '' })).toBe('')
    expect(urlStateToQuery({ market: 'IT', grain: 'campaigns' })).toBe('market=IT&grain=campaigns')
  })

  it('deletes a param when it is patched back to its default', () => {
    const out = applyUrlState(new URLSearchParams('market=IT&tile=capped'), { tile: '' })
    expect(out).toBe('market=IT')
  })

  it('preserves a param it has never heard of', () => {
    const out = applyUrlState(new URLSearchParams('ref=slack&market=DE'), { market: 'IT' })
    expect(new URLSearchParams(out).get('ref')).toBe('slack')
    expect(new URLSearchParams(out).get('market')).toBe('IT')
  })

  it('round-trips every field', () => {
    const state = {
      market: 'DE', portfolio: 'p1', product: 'pr1', campaign: 'c1', grain: 'campaigns' as const, row: 'r1', drawer: 'next24', tile: 'capped', mode: 'holding,chasing', signal: 'no-signal', converge: 'no',
      // FB.3c — the widened contract round-trips too, comma-joined multiselects included.
      status: 'active', health: 'bad,warn', baseline: 'own-top,comp-top', windows: 'none', fresh: 'stale,never', ceiling: 'base-alone', cstatus: 'PAUSED', schedule: 'g1', from: '2026-07-01', to: '2026-08-15',
    }
    expect(parseUrlState(new URLSearchParams(urlStateToQuery(state)))).toEqual(state)
  })
})

describe('FB.3 — the line grain moved from ?product= to ?line=', () => {
  it('reads the new spelling', () => {
    expect(parseUrlState(new URLSearchParams('line=pr1')).product).toBe('pr1')
  })

  it('still reads the old one, so links already shared keep working', () => {
    expect(parseUrlState(new URLSearchParams('product=pr1')).product).toBe('pr1')
  })

  it('prefers the new spelling when a link somehow carries both', () => {
    expect(parseUrlState(new URLSearchParams('line=new&product=old')).product).toBe('new')
  })

  it('writes only the new spelling, and deletes the old one it arrived on', () => {
    const qs = applyUrlState(new URLSearchParams('product=old'), { product: 'new' })
    expect(new URLSearchParams(qs).get('line')).toBe('new')
    expect(new URLSearchParams(qs).get('product')).toBeNull()
  })

  it('clearing the grain removes both spellings rather than leaving the stale one deciding', () => {
    const qs = applyUrlState(new URLSearchParams('product=old&line=new'), { product: '' })
    expect(new URLSearchParams(qs).get('line')).toBeNull()
    expect(new URLSearchParams(qs).get('product')).toBeNull()
  })
})
