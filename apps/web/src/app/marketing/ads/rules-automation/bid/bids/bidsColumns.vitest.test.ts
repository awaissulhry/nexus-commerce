import { describe, expect, it } from 'vitest'
import { BID_COLUMN_SPECS, bidColumns, bidColumnSpecs } from './bidsColumns'
import type { BidGridRow } from './bidsModel'

const shownOf = (cols: ReturnType<typeof bidColumns>) => cols.filter((c) => !c.initialHide)
const widthOf = (cols: ReturnType<typeof bidColumns>) => cols.reduce((sum, c) => sum + (c.flex ? (c.minWidth ?? 0) : (c.width ?? 0)), 0)
const ALL = { engine: true, brain: true }

describe('the bids table\'s columns', () => {
  const cols = bidColumns(false)

  it('draws every column Customise names, once, in the same order', () => {
    expect(cols.map((c) => c.colId)).toEqual(BID_COLUMN_SPECS.map((c) => c.key))
    expect(new Set(cols.map((c) => c.colId)).size).toBe(cols.length)
    expect(bidColumns(false, ALL).map((c) => c.colId)).toEqual(bidColumnSpecs(ALL).map((c) => c.key))
  })

  it('has the page\'s words (7 d everywhere), the keyword pinned first', () => {
    expect(bidColumns(false, ALL).map((c) => c.headerName)).toEqual([
      'Keyword', 'Match', 'Portfolio', 'Campaign · Ad group', 'Who sets it', 'Auto', 'Bid now', 'Suggested', 'Goal', 'Brain bid',
      'Last change', 'Changes 7 d', 'Results 7 d', 'Trend 7 d', 'Clicks 7 d', 'Orders 7 d', 'ACoS 7 d', 'Spend 7 d', 'Max CPC',
    ])
    expect(cols[0].pinned).toBe('left')
  })

  it('shows the Owner\'s view by default; Match, Portfolio, Changes 7 d, Trend, the single 7 d numbers and Max CPC wait in Customise', () => {
    const hidden = ['match', 'portfolio', 'changes7d', 'spark', 'clicks', 'orders', 'acos', 'spend', 'maxCpc']
    expect(cols.filter((c) => c.initialHide).map((c) => c.colId)).toEqual(hidden)
    expect(BID_COLUMN_SPECS.filter((c) => c.hidden).map((c) => c.key)).toEqual(hidden)
    expect(shownOf(bidColumns(false, ALL)).map((c) => c.colId)).toEqual([
      'keyword', 'campaign', 'owner', 'auto', 'bidNow', 'suggested', 'goal', 'brainAim', 'lastChange', 'results',
    ])
  })

  it('never bakes `hide` into a definition: rebuilt columns must not put the person\'s own pick back (use audit A3)', () => {
    for (const c of [...bidColumns(false, ALL), ...bidColumns(true, ALL)]) expect(c.hide).toBeUndefined()
  })

  it('fits the 1440 px card (1312 px) with the row ticks (43 px), whichever columns the scope needs', () => {
    for (const f of [{ engine: false, brain: false }, { engine: true, brain: false }, { engine: false, brain: true }, ALL]) {
      expect(widthOf(shownOf(bidColumns(false, f))) + 43).toBeLessThanOrEqual(1312)
    }
    // the campaign over its ad group keeps a name's room when every column is there
    expect(bidColumns(false, ALL).find((c) => c.colId === 'campaign')?.minWidth).toBeGreaterThanOrEqual(172) // its header whole
    // "+€0.10 · 16 d ago" with its icon, and a rule's chip with "+1"
    expect(bidColumns(false).find((c) => c.colId === 'lastChange')?.width).toBeGreaterThanOrEqual(146)
    expect(bidColumns(false).find((c) => c.colId === 'owner')?.width).toBeGreaterThanOrEqual(136)
  })

  it('keeps every header\'s ⋮ menu, as the Rules table does', () => {
    expect(cols.some((c) => c.suppressHeaderMenuButton)).toBe(false)
  })

  it('gives the link cells their own keys (the owner\'s link and "+N"; the campaign and the ad group; Apply; the switch)', () => {
    const all = bidColumns(false, ALL)
    for (const id of ['owner', 'campaign', 'suggested', 'auto']) expect(typeof all.find((c) => c.colId === id)?.suppressKeyboardEvent).toBe('function')
  })

  it('puts the keyword, its bid and who sets it first on a phone, the tick, keyword and bid within its 264 px grid (A10)', () => {
    const phone = bidColumns(true)
    expect(phone.slice(0, 3).map((c) => c.colId)).toEqual(['keyword', 'bidNow', 'owner'])
    expect(43 + (phone[0].width ?? 0) + (phone[1].width ?? 0)).toBeLessThanOrEqual(264)
    expect(phone[1].cellRendererParams).toEqual({ compact: true })
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

describe('the columns a scope needs (nothing that could only say "—", use audit C-UI 1)', () => {
  it('Suggested is always there; Auto and Goal only where an engine runs a keyword; Brain bid only where the Brain sets a bid', () => {
    const ids = (f: typeof ALL) => bidColumns(false, f).map((c) => c.colId)
    expect(ids({ engine: false, brain: false })).toContain('suggested')
    expect(ids({ engine: false, brain: false })).not.toEqual(expect.arrayContaining(['auto']))
    expect(ids({ engine: false, brain: false }).some((id) => id === 'goal' || id === 'brainAim')).toBe(false)
    expect(ids({ engine: true, brain: false })).toEqual(expect.arrayContaining(['auto', 'goal']))
    expect(ids({ engine: true, brain: false })).not.toContain('brainAim')
    expect(ids({ engine: false, brain: true })).toContain('brainAim')
  })
})
