import { describe, expect, it } from 'vitest'
import { BID_COLUMN_SPECS, bidColumns, bidColumnSpecs } from './bidsColumns'
import type { BidGridRow } from './bidsModel'

describe('the bids table\'s columns', () => {
  const cols = bidColumns(false)

  it('draws every column Customise names, once, in the same order', () => {
    expect(cols.map((c) => c.colId)).toEqual(BID_COLUMN_SPECS.map((c) => c.key))
    expect(new Set(cols.map((c) => c.colId)).size).toBe(cols.length)
  })

  it('has the page\'s words (7 d everywhere), the keyword pinned first', () => {
    expect(cols.map((c) => c.headerName)).toEqual([
      'Keyword', 'Match', 'Portfolio', 'Campaign · Ad group', 'Who sets it', 'Bid now', 'Brain bid', 'Last change',
      'Changes 7 d', 'Results 7 d', 'Trend 7 d', 'Clicks 7 d', 'Orders 7 d', 'ACoS 7 d', 'Spend 7 d', 'Max CPC',
    ])
    expect(cols[0].pinned).toBe('left')
  })

  it('starts with match (it sits under the keyword), portfolio, the change count, the single 7 d numbers, spend and the max CPC hidden', () => {
    const hidden = ['match', 'portfolio', 'changes7d', 'clicks', 'orders', 'acos', 'spend', 'maxCpc']
    expect(cols.filter((c) => c.hide).map((c) => c.colId)).toEqual(hidden)
    expect(BID_COLUMN_SPECS.filter((c) => c.hidden).map((c) => c.key)).toEqual(hidden)
  })

  it('fits the shown columns into the 1440 px card (1312 px) with room for the campaign and ad group names', () => {
    const shown = cols.filter((c) => !c.hide)
    const fixed = shown.reduce((sum, c) => sum + (c.flex ? (c.minWidth ?? 0) : (c.width ?? 0)), 0)
    expect(fixed).toBeLessThanOrEqual(1312)
    // the campaign over its ad group: each line has the whole column
    expect(cols.find((c) => c.colId === 'campaign')?.minWidth).toBeGreaterThanOrEqual(250)
    expect(cols.find((c) => c.colId === 'owner')?.width).toBeGreaterThanOrEqual(170)
    // "−€10.05 · 59 min ago" with its icon
    expect(cols.find((c) => c.colId === 'lastChange')?.width).toBeGreaterThanOrEqual(160)
  })

  it('keeps every header\'s ⋮ menu, as the Rules table does', () => {
    expect(cols.some((c) => c.suppressHeaderMenuButton)).toBe(false)
  })

  it('gives the link cells their own keys (the owner\'s link and "+N"; the campaign and the ad group)', () => {
    expect(typeof cols.find((c) => c.colId === 'owner')?.suppressKeyboardEvent).toBe('function')
    expect(typeof cols.find((c) => c.colId === 'campaign')?.suppressKeyboardEvent).toBe('function')
  })

  it('puts the keyword, its bid and who sets it first on a phone, with a narrower pinned keyword', () => {
    const phone = bidColumns(true)
    expect(phone.slice(0, 3).map((c) => c.colId)).toEqual(['keyword', 'bidNow', 'owner'])
    expect(phone[0].width).toBeLessThan(cols[0].width!)
    expect([...phone.map((c) => c.colId)].sort()).toEqual([...cols.map((c) => c.colId)].sort())
  })

  it('says money in each row\'s own currency in the CSV words', () => {
    const bid = cols.find((c) => c.colId === 'bidNow')!
    const format = bid.valueFormatter as (p: { value: unknown; data?: Partial<BidGridRow> }) => string
    expect(format({ value: 15, data: { currency: 'EUR' } })).toBe('€0.15')
    expect(format({ value: 15, data: { currency: 'GBP' } })).toBe('£0.15')
    expect(format({ value: null, data: { currency: 'EUR' } })).toBe('—')
    const trend = cols.find((c) => c.colId === 'spark')!.valueFormatter as (p: { data?: Partial<BidGridRow> }) => string
    expect(trend({ data: { currency: 'GBP', spark: [10, 20] } })).toBe('2 readings, low £0.10, high £0.20, now £0.20')
  })
})

describe('the keyword-Auto columns', () => {
  const all = { suggested: true, auto: true, goal: true }

  it('are not there until the answer carries their fields (never a made-up value)', () => {
    expect(bidColumns(false).map((c) => c.colId)).not.toEqual(expect.arrayContaining(['auto']))
    expect(bidColumns(false).some((c) => c.colId === 'suggested' || c.colId === 'goal' || c.colId === 'auto')).toBe(false)
    expect(bidColumns(false, { suggested: true, auto: false, goal: false }).map((c) => c.colId)).toContain('suggested')
  })

  it('sit beside the bid, like Amazon\'s table, and make room: Brain bid, Last change and Trend start hidden', () => {
    const cols = bidColumns(false, all)
    const shown = cols.filter((c) => !c.hide).map((c) => c.colId)
    expect(shown).toEqual(['keyword', 'campaign', 'owner', 'auto', 'bidNow', 'suggested', 'goal', 'results'])
    expect(bidColumnSpecs(all).filter((c) => c.hidden).map((c) => c.key)).toEqual(expect.arrayContaining(['brainAim', 'lastChange', 'spark']))
    expect(cols.map((c) => c.colId)).toEqual(bidColumnSpecs(all).map((c) => c.key))
  })

  it('hide only as many quiet columns as they need room for: Trend, then Last change, then Brain bid', () => {
    const hiddenWith = (f: typeof all) => bidColumnSpecs(f).filter((c) => c.hidden && ['spark', 'lastChange', 'brainAim'].includes(c.key)).map((c) => c.key)
    expect(hiddenWith({ suggested: true, auto: false, goal: false })).toEqual(['spark'])
    expect(hiddenWith({ suggested: true, auto: true, goal: false })).toEqual(['lastChange', 'spark'])
    expect(hiddenWith(all)).toEqual(['brainAim', 'lastChange', 'spark'])
  })

  it('still fit the 1440 px card with the row checkboxes (43 px), with one, two or three of them', () => {
    for (const f of [{ suggested: true, auto: false, goal: false }, { suggested: true, auto: true, goal: false }, { suggested: false, auto: true, goal: true }, all]) {
      const shown = bidColumns(false, f).filter((c) => !c.hide)
      const fixed = shown.reduce((sum, c) => sum + (c.flex ? (c.minWidth ?? 0) : (c.width ?? 0)), 0)
      expect(fixed + 43).toBeLessThanOrEqual(1312)
    }
  })

  it('give Apply its Enter, and the Auto switch its own keys', () => {
    const cols = bidColumns(false, all)
    expect(typeof cols.find((c) => c.colId === 'suggested')?.suppressKeyboardEvent).toBe('function')
    expect(typeof cols.find((c) => c.colId === 'auto')?.suppressKeyboardEvent).toBe('function')
  })
})
