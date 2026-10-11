import { describe, expect, it } from 'vitest'
import { actionWord, decisionFacts, decisionFor, isLiveDecision, layerTag, layerWord, parseAcosPct, wouldWords, type BrainDecision } from './whyModel'

const decision = (over: Partial<BrainDecision> = {}): BrainDecision => ({
  targetId: 't1',
  keyword: 'race jacket (EXACT)',
  campaignId: 'c1',
  market: 'IT',
  action: 'write',
  layer: 'goal',
  currentCents: 40,
  decidedCents: 50,
  goalBidCents: 120,
  aimPct: 20,
  bandLoPct: 15,
  bandHiPct: 25,
  expectedAcosPct: 18.5,
  confidence: 0.8,
  dataDay: '2026-10-03',
  decidedAt: '2026-10-10T06:00:00Z',
  lastWriter: null,
  why: 'goal: …',
  mode: 'SHADOW',
  ...over,
})

describe('the brain\'s decision in words', () => {
  it('says a write as Up or Down, and anything else as Hold or Brake', () => {
    expect(actionWord(decision())).toEqual({ label: 'Up', tone: 'success' })
    expect(actionWord(decision({ decidedCents: 30 }))).toEqual({ label: 'Down', tone: 'warning' })
    expect(actionWord(decision({ action: 'hold' })).label).toBe('Hold')
    expect(actionWord(decision({ action: 'brake' })).label).toBe('Brake')
  })

  it('names the deciding layer without jargon, and tags only an unusual one', () => {
    expect(layerWord('min_bid_hour')).toBe('Night floor')
    expect(layerWord('no_goal')).toBe('Not enough data')
    expect(layerWord('restore')).toBe('Morning give-back')
    expect(layerWord('something_new')).toBe('Something new')
    expect(layerTag('goal')).toBeNull()
    expect(layerTag('band')).toBeNull()
    expect(layerTag('stock')).toBe('Low stock')
    expect(layerTag(null)).toBeNull()
  })

  it('lists its numbers in plain words, no confidence score, with dashes for what is hidden', () => {
    expect(decisionFacts(decision(), 'EUR')).toEqual([
      { label: 'Brain bid', value: '€1.20' },
      { label: 'Target ACoS', value: '20 %' },
      { label: 'Range', value: '15 % – 25 %' },
      { label: 'Expected ACoS', value: '18.5 %' },
      { label: 'Data to', value: '3 Oct' },
    ])
    expect(decisionFacts(decision(), 'GBP')[0].value).toBe('£1.20')
    const hidden = decisionFacts(decision({ goalBidCents: undefined, aimPct: undefined, bandLoPct: undefined, bandHiPct: undefined }), 'EUR')
    expect(hidden).toContainEqual({ label: 'Brain bid', value: '—' })
    expect(hidden).toContainEqual({ label: 'Range', value: '—' })
    // One Brain bid in the detail (A7): the row's, when it has one.
    expect(decisionFacts(decision(), 'EUR', 45)[0]).toEqual({ label: 'Brain bid', value: '€0.45' })
  })

  it('a watched decision says what it WOULD do, never a change that happened (A2)', () => {
    expect(isLiveDecision({ mode: 'LIVE' })).toBe(true)
    expect(isLiveDecision({ mode: 'SHADOW' })).toBe(false)
    expect(wouldWords({ action: 'write', currentCents: 50, decidedCents: 40 }, 'EUR')).toBe('Would lower to €0.40')
    expect(wouldWords({ action: 'write', currentCents: 40, decidedCents: 55 }, 'EUR')).toBe('Would raise to €0.55')
    expect(wouldWords({ action: 'hold', currentCents: 40, decidedCents: 40 }, 'EUR')).toBe('Would hold')
    expect(wouldWords({ action: 'brake', currentCents: 40, decidedCents: 10 }, 'GBP')).toBe('Would brake to £0.10')
  })

  it('finds the keyword\'s decision in a view\'s answer', () => {
    expect(decisionFor({ decisions: [decision({ targetId: 'x' }), decision()] }, 't1')?.targetId).toBe('t1')
    expect(decisionFor({ decisions: [] }, 't1')).toBeNull()
    expect(decisionFor(null, 't1')).toBeNull()
  })

  it('reads a target ACoS the what-if read takes (1–500 %)', () => {
    expect(parseAcosPct('20')).toBe(20)
    expect(parseAcosPct('17,5 %')).toBe(17.5)
    expect(parseAcosPct('0')).toBeNull()
    expect(parseAcosPct('600')).toBeNull()
    expect(parseAcosPct('abc')).toBeNull()
  })
})
