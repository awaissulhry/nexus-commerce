import { describe, expect, it } from 'vitest'
import type { ReadinessLiveCounts } from '@nexus/shared/listing-readiness'
import {
  CHANNEL_STATE_OPTIONS,
  LIVE_TILE_HINT,
  LIVE_TILES,
  STOCK_OPTIONS,
  channelStatesOf,
  liveTileAccent,
  liveTileCount,
  liveTileIsLit,
  liveTileLabel,
  stockOf,
  withChannelStates,
  withLiveTile,
  withStock,
} from './liveFilters'
import { EMPTY_READINESS_QUERY, apiFilterParams, parseReadinessQuery } from './readinessQuery'

const stats: ReadinessLiveCounts = {
  listings: 4210, active: 3950, paused: 40, draft: 20, ended: 10, unknown: 2, notListed: 188, error: 12, suppressed: 4, outOfSync: 31, lowStock: 7,
}
const q = (search = '') => ({ ...parseReadinessQuery(search), page: 3 })

describe('the live tiles', () => {
  it('Live · Errors · Suppressed · Out of sync, from the API’s live stats', () => {
    expect(LIVE_TILES.map(liveTileLabel)).toEqual(['Live', 'Errors', 'Suppressed', 'Out of sync'])
    expect(LIVE_TILES.map((t) => liveTileCount(stats, t))).toEqual([3950, 12, 4, 31])
  })
  it('each says its unit: listings on the channel, not readiness listings', () => {
    expect(LIVE_TILE_HINT).toBe('listings on the channel')
  })
  it('Live toggles live=active; a click goes back to page 1', () => {
    const on = withLiveTile(q(), 'live')
    expect(on).toMatchObject({ live: ['active'], page: 1 })
    expect(liveTileIsLit(on, 'live')).toBe(true)
    expect(withLiveTile(on, 'live').live).toEqual([])
  })
  it('Live is lit only while Active is the one channel state', () => {
    expect(liveTileIsLit(q('?live=active,paused'), 'live')).toBe(false)
    expect(withLiveTile(q('?live=active,paused'), 'live').live).toEqual(['active'])
  })
  it('a flag tile toggles its flag, one tile flag at a time; Low stock stays', () => {
    const errors = withLiveTile(q('?flags=lowStock'), 'error')
    expect(errors.flags).toEqual(['error', 'lowStock'])
    expect(LIVE_TILES.filter((t) => liveTileIsLit(errors, t))).toEqual(['error'])
    const suppressed = withLiveTile(errors, 'suppressed')
    expect(suppressed.flags).toEqual(['suppressed', 'lowStock'])
    expect(withLiveTile(suppressed, 'suppressed').flags).toEqual(['lowStock'])
    expect(withLiveTile(q(), 'outOfSync').flags).toEqual(['outOfSync'])
  })
  it('the tiles send what they show: live=active, flags=error', () => {
    expect(apiFilterParams(withLiveTile(withLiveTile(EMPTY_READINESS_QUERY, 'live'), 'error'))).toEqual({ live: 'active', flags: 'error' })
  })
  it('the dots: Live green, Errors and Suppressed red, Out of sync amber', () => {
    expect(LIVE_TILES.map(liveTileAccent)).toEqual(['var(--nds-success)', 'var(--nds-danger)', 'var(--nds-danger)', 'var(--nds-warning)'])
  })
})

describe('Filters › Channel state', () => {
  it('the design system’s words; Not listed takes drafts too', () => {
    expect(CHANNEL_STATE_OPTIONS.map((o) => o.label)).toEqual(['Active', 'Inactive', 'Not listed', 'Ended', 'Unknown'])
    expect(withChannelStates(q(), ['not_listed']).live).toEqual(['draft', 'not_listed'])
  })
  it('choices → live, in the API’s order, back to page 1', () => {
    expect(withChannelStates(q(), ['ended', 'active', 'paused'])).toMatchObject({ live: ['active', 'paused', 'ended'], page: 1 })
    expect(withChannelStates(q('?live=active'), []).live).toEqual([])
  })
  it('live → the ticked choices (a link with a draft only ticks Not listed)', () => {
    expect(channelStatesOf(q('?live=paused,draft'))).toEqual(['paused', 'not_listed'])
    expect(channelStatesOf(q())).toEqual([])
  })
})

describe('Filters › Stock', () => {
  it('Low stock adds the lowStock flag; All stock takes it away; the tile flag stays', () => {
    expect(STOCK_OPTIONS.map((o) => o.label)).toEqual(['All stock', 'Low stock'])
    const low = withStock(q('?flags=error'), 'lowStock')
    expect(low).toMatchObject({ flags: ['error', 'lowStock'], page: 1 })
    expect(stockOf(low)).toBe('lowStock')
    expect(withStock(low, '').flags).toEqual(['error'])
    expect(stockOf(q())).toBe('')
  })
})

describe('one tile row (2026-10-26): Live · Errors in the row, Suppressed and Out of sync under Filters › Channel problem', () => {
  it('the row keeps Live and Errors', async () => {
    const { ROW_LIVE_TILES } = await import('./liveFilters')
    expect(ROW_LIVE_TILES).toEqual(['live', 'error'])
  })
  it('Channel problem is one choice at a time, the same flags the Errors tile sets; Low stock stays', async () => {
    const { CHANNEL_PROBLEM_OPTIONS, channelProblemOf, withChannelProblem } = await import('./liveFilters')
    const { EMPTY_READINESS_QUERY } = await import('./readinessQuery')
    expect(CHANNEL_PROBLEM_OPTIONS.map((o) => o.label)).toEqual(['All', 'Errors', 'Suppressed', 'Out of sync'])
    const low = { ...EMPTY_READINESS_QUERY, flags: ['lowStock' as const], page: 3 }
    const suppressed = withChannelProblem(low, 'suppressed')
    expect(suppressed).toMatchObject({ flags: ['suppressed', 'lowStock'], page: 1 })
    expect(channelProblemOf(suppressed)).toBe('suppressed')
    expect(withChannelProblem(suppressed, 'outOfSync').flags).toEqual(['outOfSync', 'lowStock'])
    expect(withChannelProblem(suppressed, '').flags).toEqual(['lowStock'])
    expect(withChannelProblem(low, 'nonsense').flags).toEqual(['lowStock'])
    expect(channelProblemOf(low)).toBe('')
  })
})

describe('the row’s All (2026-10-26)', () => {
  it('is lit only without a tile filter, and clears the live tiles’ filters (Low stock and other states stay)', async () => {
    const { anyLiveTileFilter, withoutLiveTiles } = await import('./liveFilters')
    const { EMPTY_READINESS_QUERY } = await import('./readinessQuery')
    expect(anyLiveTileFilter({ live: [], flags: [] })).toBe(false)
    expect(anyLiveTileFilter({ live: ['active'], flags: [] })).toBe(true)
    expect(anyLiveTileFilter({ live: [], flags: ['suppressed'] })).toBe(true)
    expect(anyLiveTileFilter({ live: ['paused'], flags: ['lowStock'] })).toBe(false)
    const q = { ...EMPTY_READINESS_QUERY, live: ['active' as const], flags: ['error' as const, 'lowStock' as const], page: 4 }
    expect(withoutLiveTiles(q)).toMatchObject({ live: [], flags: ['lowStock'], page: 1 })
    expect(withoutLiveTiles({ ...q, live: ['paused' as const, 'ended' as const] }).live).toEqual(['paused', 'ended'])
  })
})
