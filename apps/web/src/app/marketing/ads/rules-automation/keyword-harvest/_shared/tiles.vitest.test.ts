import { describe, expect, it } from 'vitest'
import { isHarvestView, nextShow, termsTiles, tileAccent } from './tiles'
import type { CandidateTotals } from './types'

const totals: CandidateTotals = {
  candidates: 12, ready: 10, needDestination: 1, needCampaign: 1, held: 0, waiting: 3, inFlight: 0, harvested30d: 0, worse: 2,
  waitingToJudge: 0, skipped: 4, ownedBySibling: 0, belowBar: 5, atHome: 9, waitingRequests: 2, waitingStale: 0,
}

describe('the tile strip', () => {
  it('Terms: Ready · Waiting for you · Harvested · 60 d · Worse, from the read\'s totals', () => {
    const t = termsTiles({ ...totals, harvestedWindow: 0 })
    expect(t.map((x) => [x.id, x.label, x.value])).toEqual([
      ['ready', 'Ready', 10], ['waiting', 'Waiting for you', 3], ['harvested', 'Harvested · 60 d', 0], ['worse', 'Worse', 2],
    ])
    // A tile with nothing to show does not filter.
    expect(t.find((x) => x.id === 'harvested')?.filters).toBe(false)
  })
  it('Waiting for you counts what can be approved; out-of-date asks are said beside it (N-S1)', () => {
    const w = termsTiles({ ...totals, waiting: 5, waitingStale: 2 }).find((x) => x.id === 'waiting')
    expect(w).toMatchObject({ value: 3, hint: '2 out of date' })
  })
  it('Harvested without the page\'s own count reads "—", never the 30-day number under a 60-day label', () => {
    expect(termsTiles(totals).find((x) => x.id === 'harvested')?.value).toBeNull()
  })
  it('a dash before the first read, never a made-up 0', () => {
    expect(termsTiles(null).every((t) => t.value === null && !t.filters)).toBe(true)
  })
  it('a click sets the tile, again clears it, a tile without rows does nothing', () => {
    expect(nextShow(null, { id: 'ready', filters: true })).toBe('ready')
    expect(nextShow('ready', { id: 'ready', filters: true })).toBeNull()
    expect(nextShow(null, { id: 'worse', filters: false })).toBeUndefined()
    // A filter left on a tile that emptied can still be cleared.
    expect(nextShow('worse', { id: 'worse', filters: false })).toBeNull()
  })
  it('a quiet dot for an empty tile', () => {
    expect(tileAccent({ tone: 'danger', value: 0 })).toBe('var(--nds-border-strong)')
    expect(tileAccent({ tone: 'danger', value: 1 })).toBe('var(--nds-danger)')
  })
  it('views', () => {
    expect(isHarvestView('sources')).toBe(true)
    expect(isHarvestView('bids')).toBe(false)
  })
})
