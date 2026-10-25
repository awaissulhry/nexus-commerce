import { describe, expect, it } from 'vitest'
import type { ReadinessChip, ReadinessLiveSummary } from '@nexus/shared/listing-readiness'
import { SELLING_STATE_LABEL } from '@nexus/shared/listing-actions'
import { factMeta } from '@/design-system/grid/renderers/presence'
import { SELLING_STATE_WORD } from '@/design-system/grid/renderers/sellingStatus'
import {
  LIVE_COLUMN,
  SAID_STATES,
  SUPPRESSED_WORD,
  chipGlyph,
  hasLiveColumn,
  liveMark,
  liveSentence,
  liveTotals,
  onChannelWords,
  orderWithLiveAfterMarkets,
  pageHasLive,
  problemParts,
  stateParts,
} from './liveMarks'

const summary = (over: Partial<ReadinessLiveSummary> = {}): ReadinessLiveSummary => ({
  state: 'active', listed: 1, notListed: 0, byState: { active: 1 }, externalId: null, url: null, priceMin: null, priceMax: null,
  currency: null, quantity: null, fulfillment: null, channelErrorCount: 0, suppressedCount: 0, outOfSyncCount: 0, syncFailedCount: 0,
  lastSyncedAt: null, duplicates: 0, ...over,
})
const chip = (over: Partial<ReadinessChip> = {}): ReadinessChip => ({
  destinationKey: 'k', state: 'ready', counts: { blocked: 0, warn: 0, notComputed: 0, absent: 0, ready: 1 }, issueCount: 0, pending: false,
  computedAt: null, ...over,
})
const MIXED = summary({ state: 'mixed', listed: 18, notListed: 2, byState: { active: 18 }, suppressedCount: 1 })

describe('the chip’s live mark', () => {
  it('● every listing Active, ◐ Mixed, ○ not selling (Not listed, Inactive, Ended, a draft)', () => {
    expect(liveMark(summary())).toBe('active')
    expect(liveMark(summary({ state: 'mixed' }))).toBe('mixed')
    for (const state of ['paused', 'ended', 'draft', 'not_listed'] as const) expect(liveMark(summary({ state }))).toBe('off')
  })
  it('▲ a problem on the channel wins over every other mark', () => {
    expect(liveMark(summary({ suppressedCount: 1 }))).toBe('problem')
    expect(liveMark(summary({ state: 'mixed', syncFailedCount: 2 }))).toBe('problem')
    expect(liveMark(summary({ state: 'not_listed', channelErrorCount: 1 }))).toBe('problem')
  })
  it('only a channel difference is no problem mark (the Out of sync tile counts it)', () => {
    expect(liveMark(summary({ outOfSyncCount: 3 }))).toBe('active')
  })
  it('no mark: not read from the channel (null, absent), or a state Nexus cannot name', () => {
    expect(liveMark(null)).toBeNull()
    expect(liveMark(undefined)).toBeNull()
    expect(liveMark(summary({ state: 'unknown' }))).toBeNull()
  })
})

describe('the chip’s glyph', () => {
  it('a page without live data draws every chip as before: the dot', () => {
    expect(chipGlyph(chip(), false)).toBe('dot')
    expect(chipGlyph(chip({ live: null }), false)).toBe('dot')
    expect(chipGlyph(chip({ live: summary({ state: 'ended' }) }), false)).toBe('dot')
  })
  it('with live data the dot means Active; Shared and a chip not read have no mark', () => {
    expect(chipGlyph(chip({ live: summary() }), true)).toBe('dot')
    expect(chipGlyph(chip({ live: null }), true)).toBe('none')
    expect(chipGlyph(chip(), true)).toBe('none')
    expect(chipGlyph(chip({ live: summary({ state: 'mixed' }) }), true)).toBe('mixed')
    expect(chipGlyph(chip({ live: summary({ state: 'paused' }) }), true)).toBe('off')
    expect(chipGlyph(chip({ live: summary({ suppressedCount: 1 }) }), true)).toBe('problem')
  })
  it('a chip waiting for its rebuild keeps the spinner', () => {
    expect(chipGlyph(chip({ pending: true, live: summary({ suppressedCount: 1 }) }), true)).toBe('pending')
    expect(chipGlyph(chip({ pending: true }), false)).toBe('pending')
  })
})

describe('does the answer carry live data?', () => {
  it('the families page: its live tiles', () => {
    expect(pageHasLive({ liveStats: { listings: 0 }, rows: [] })).toBe(true)
    expect(pageHasLive({ liveStats: null, rows: [{ chips: [chip({ live: null })] }] })).toBe(false)
  })
  it('an older API sends no live fields at all', () => {
    expect(pageHasLive({ rows: [{ chips: [chip()] }] })).toBe(false)
  })
  it('a family’s own page (members, no tiles): its chips', () => {
    expect(pageHasLive({ rows: [{ chips: [chip({ live: null }), chip({ live: summary() })] }] })).toBe(true)
    expect(pageHasLive({ rows: [] })).toBe(false)
  })
})

describe('the words are the design system’s', () => {
  it('the selling states', () => {
    for (const state of SAID_STATES) expect(SELLING_STATE_WORD[state]).toBe(SELLING_STATE_LABEL[state])
    expect(SUPPRESSED_WORD).toBe(factMeta('SUPPRESSED').label)
    expect(SUPPRESSED_WORD).toBe('Suppressed')
  })
})

describe('the totals and their words', () => {
  it('a draft and a product with no listing both read Not listed; the states in a fixed order', () => {
    const totals = liveTotals([summary({ state: 'mixed', listed: 6, notListed: 2, byState: { ended: 1, draft: 1, paused: 2, active: 2 } })])!
    expect(stateParts(totals)).toEqual(['2 Active', '2 Inactive', '3 Not listed', '1 Ended'])
  })
  it('the problems come last', () => {
    const totals = liveTotals([summary({ suppressedCount: 1, syncFailedCount: 2, channelErrorCount: 1, outOfSyncCount: 4 })])!
    expect(problemParts(totals)).toEqual(['1 Suppressed', '2 Push failed', '1 channel error', '4 Out of sync'])
    expect(problemParts(liveTotals([summary({ channelErrorCount: 3 })])!)).toEqual(['3 channel errors'])
  })
  it('sums every chip that carries live data; none → null', () => {
    const totals = liveTotals([summary({ byState: { active: 3 } }), null, undefined, summary({ state: 'not_listed', listed: 0, notListed: 1, byState: {} })])!
    expect(totals.byState).toMatchObject({ active: 3, not_listed: 1 })
    expect(liveTotals([null, undefined])).toBeNull()
    expect(liveTotals([])).toBeNull()
  })
  it('big numbers are grouped', () => {
    expect(stateParts(liveTotals([summary({ byState: { active: 3950 } })])!)).toEqual(['3,950 Active'])
  })
})

describe('the chip’s live sentence', () => {
  it('Mixed names each state, then the problems', () => {
    expect(liveSentence(MIXED, 'Amazon')).toBe('On Amazon: Mixed, 18 Active, 2 Not listed. 1 Suppressed.')
  })
  it('one product says its state; several in one state say how many', () => {
    expect(liveSentence(summary(), 'eBay')).toBe('On eBay: Active.')
    expect(liveSentence(summary({ state: 'not_listed', listed: 0, notListed: 1, byState: {} }), 'Shopify')).toBe('On Shopify: Not listed.')
    expect(liveSentence(summary({ listed: 20, byState: { active: 20 } }), 'Amazon')).toBe('On Amazon: 20 Active.')
    expect(liveSentence(summary({ state: 'draft' }), 'Etsy')).toBe('On Etsy: Not listed.')
  })
})

describe('the On the channel cell', () => {
  it('the row’s listings in view, summed over its chips; problems on their own line', () => {
    const words = onChannelWords([chip({ live: null }), chip({ live: MIXED }), chip({ live: summary({ state: 'paused', byState: { paused: 1 } }) })])
    expect(words).toEqual({ states: '18 Active · 1 Inactive · 2 Not listed', problems: '1 Suppressed', text: '18 Active · 1 Inactive · 2 Not listed · 1 Suppressed' })
  })
  it('no live data on the row: nothing (the cell draws the dash)', () => {
    expect(onChannelWords([chip({ live: null }), chip()])).toBeNull()
    expect(onChannelWords([])).toBeNull()
  })
})

describe('the On the channel column', () => {
  it('starts with the page when the last visit had it', () => {
    expect(hasLiveColumn({ columnOrder: { orderedColIds: ['ag-Grid-AutoColumn', 'markets', LIVE_COLUMN] } })).toBe(true)
    expect(hasLiveColumn({ columnOrder: { orderedColIds: ['ag-Grid-AutoColumn', 'markets'] } })).toBe(false)
    expect(hasLiveColumn({})).toBe(false)
    expect(hasLiveColumn(undefined)).toBe(false)
  })
  it('a column that arrives later goes right after Markets, once', () => {
    expect(orderWithLiveAfterMarkets(['auto', 'markets', 'nextStep', 'checked', LIVE_COLUMN, 'actions'])).toEqual(['auto', 'markets', LIVE_COLUMN, 'nextStep', 'checked', 'actions'])
    expect(orderWithLiveAfterMarkets(['auto', 'nextStep', 'markets', 'checked', LIVE_COLUMN])).toEqual(['auto', 'nextStep', 'markets', LIVE_COLUMN, 'checked'])
  })
  it('nothing to move: already there, or no column', () => {
    expect(orderWithLiveAfterMarkets(['auto', 'markets', LIVE_COLUMN, 'nextStep'])).toBeNull()
    expect(orderWithLiveAfterMarkets(['auto', 'markets', 'nextStep'])).toBeNull()
    expect(orderWithLiveAfterMarkets([LIVE_COLUMN, 'nextStep'])).toBeNull()
  })
  it('step 4: the per-listing columns go right after Markets in their order, On the channel after them', () => {
    const order = ['status', 'price', 'qty', 'channelId', LIVE_COLUMN]
    expect(orderWithLiveAfterMarkets(['auto', 'markets', 'nextStep', 'checked', 'actions', LIVE_COLUMN, 'qty', 'status', 'price'], order))
      .toEqual(['auto', 'markets', 'status', 'price', 'qty', LIVE_COLUMN, 'nextStep', 'checked', 'actions'])
    expect(orderWithLiveAfterMarkets(['auto', 'markets', 'status', 'price', LIVE_COLUMN, 'nextStep'], order)).toBeNull()
  })
})
