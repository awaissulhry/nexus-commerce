import { describe, expect, it } from 'vitest'
import {
  MANAGE_BRIEF,
  WRITING_HELD,
  briefEyebrow,
  briefMeta,
  briefText,
  changeDelta,
  changeValue,
  costWords,
  emptyBrief,
  evidenceLinks,
  generateHeld,
  generateLabel,
  generatedWords,
  historyWords,
  optionFor,
  type ScopesAnswer,
  type Spotlight,
} from './briefModel'

const scopes = (over: Partial<ScopesAnswer> = {}): ScopesAnswer => ({
  options: [
    { channel: null, marketplace: null, label: 'All channels and markets', material: 128, tooFew: false, latest: { id: 'b-1', generatedAt: '2026-10-26T09:00:00Z' }, note: 'Brief from 26 Oct' },
    { channel: 'EBAY', marketplace: 'IT', label: 'eBay Italy', material: 13, tooFew: true, latest: null, note: 'Too few reviews (13)' },
  ],
  limit: { perDay: 10, usedToday: 3, left: 7 },
  minReviews: 20,
  windowDays: 30,
  ...over,
})

const brief = (over: Partial<Spotlight> = {}): Spotlight => ({
  id: 'b-1',
  productId: null,
  channel: null,
  marketplace: null,
  windowDays: 30,
  reviewCount: 128,
  headline: 'Fit complaints rose in Germany.',
  content: {
    sentiment: { positive: 80, neutral: 20, negative: 28, total: 128, avgRating: 4.1 },
    complaints: [],
    praises: [],
    emerging: [],
    recommendations: [],
    findings: [{ n: 1, theme: 'FIT_SIZING', title: 'Fit complaints rose', trend: 'worse', text: 'Buyers say it runs small.', evidence: [{ kind: 'reviews', theme: 'FIT_SIZING', count: 9 }, { kind: 'alert', id: 'a-1', market: 'DE' }] }],
    changes: [
      { key: 'avgRating', what: 'Average rating', before: 4.3, now: 4.1, change: -0.2, higherIsBetter: true, unit: 'stars' },
      { key: 'negativeShare', what: 'Negative share', before: 12, now: 16, change: 4, higherIsBetter: false, unit: 'percent' },
    ],
    sources: { reviews: 120, amazonTopics: 40, amazonTopicsAt: '2026-10-20T06:00:00Z', amazonReviewText: false },
  },
  model: 'claude',
  usedAi: true,
  generatedAt: '2026-10-26T09:00:00Z',
  ...over,
})

const ALL = { channel: null, market: null, period: '30d' as const }

describe('Generate', () => {
  it('finds the scope’s option and holds the button with why', () => {
    expect(optionFor(scopes(), { channel: 'EBAY', market: 'IT' })?.material).toBe(13)
    expect(optionFor(scopes(), { channel: 'AMAZON', market: 'DE' })).toBeNull()
    expect(generateHeld({ canManage: false, writing: false, scopes: scopes(), scope: ALL })).toBe(MANAGE_BRIEF)
    expect(generateHeld({ canManage: true, writing: true, scopes: scopes(), scope: ALL })).toBe(WRITING_HELD)
    expect(generateHeld({ canManage: true, writing: false, scopes: scopes({ limit: { perDay: 10, usedToday: 10, left: 0 } }), scope: ALL })).toBe('10 briefs a day for this business: 10 made today. Try again tomorrow.')
    expect(generateHeld({ canManage: true, writing: false, scopes: scopes(), scope: { channel: 'EBAY', market: 'IT' } })).toBe('eBay Italy has 13 reviews in 30 days; a brief needs 20. Pick a longer period, or more markets.')
    expect(generateHeld({ canManage: true, writing: false, scopes: scopes(), scope: { channel: 'SHOPIFY', market: null } })).toMatch(/^Shopify has 0 reviews/)
    expect(generateHeld({ canManage: true, writing: false, scopes: scopes(), scope: ALL })).toBeNull()
    expect(costWords(scopes())).toBe('About 30 seconds · a small AI cost · 3 of 10 today')
    expect(generateLabel(null)).toBe('Generate a brief')
    expect(generateLabel(brief())).toBe('Generate again')
  })
})

describe('the brief', () => {
  it('says what it covers and what it was made from — never Amazon review text', () => {
    expect(briefEyebrow(brief(), ALL)).toBe('Voice of the customer · All channels and markets · last 30 days')
    expect(briefEyebrow(null, { channel: 'AMAZON', market: 'DE', period: '90d' })).toBe('Voice of the customer · Amazon Germany · last 90 days')
    expect(briefMeta(brief())).toBe('Written Mon 26 Oct from 120 reviews and the Amazon topics of Tue 20 Oct · by AI')
    expect(briefMeta(brief({ usedAi: false }))).toMatch(/without AI \(the AI service was not available\)/)
    expect(generatedWords(brief({ usedAi: false }))).toMatch(/without AI/)
  })

  it('links each finding to its evidence', () => {
    const links = evidenceLinks(brief().content.findings![0], { channel: 'AMAZON', market: null, period: '90d' })
    expect(links).toEqual([
      { label: '9 reviews about Fit & sizing', href: '/marketing/reviews/inbox?period=90d&channel=AMAZON&theme=FIT_SIZING' },
      { label: 'Open alert · DE', href: '/marketing/reviews/insights/alerts?channel=AMAZON&market=DE&period=90d&status=ALL' },
    ])
  })

  it('says before, now and the change, coloured by whether it is good news', () => {
    const [rating, negative] = brief().content.changes!
    expect(changeValue(rating.before, 'stars')).toBe('4.3')
    expect(changeValue(negative.now, 'percent')).toBe('16%')
    expect(changeValue(null, 'count')).toBe('—')
    expect(changeDelta(rating)).toEqual({ text: '−0.2', tone: 'bad' })
    expect(changeDelta(negative)).toEqual({ text: '+4 pts', tone: 'bad' })
    expect(changeDelta({ ...negative, change: -3 })).toEqual({ text: '−3 pts', tone: 'good' })
  })

  it('copies as plain text', () => {
    const text = briefText(brief(), ALL)
    expect(text.split('\n').slice(0, 5)).toEqual([
      'Voice of the customer · All channels and markets · last 30 days',
      'Fit complaints rose in Germany.',
      '',
      '1. Fit complaints rose (Worse)',
      '   Buyers say it runs small.',
    ])
    expect(text).toContain('- Average rating: 4.3 → 4.1 (−0.2)')
  })

  it('lists earlier briefs and says why there is none', () => {
    expect(historyWords({ id: 'h', generatedAt: '2026-10-19T09:00:00Z', channel: 'AMAZON', marketplace: 'DE', label: 'Amazon Germany', windowDays: 30, reviewCount: 40, headline: null, usedAi: true })).toEqual({ date: 'Mon 19 Oct', scope: 'Amazon Germany · 30 days' })
    expect(emptyBrief(scopes(), { channel: 'EBAY', market: 'IT' }).title).toBe('Not enough reviews for a brief')
    expect(emptyBrief(scopes(), ALL)).toEqual({ headline: 'No brief yet for All channels and markets', title: 'Generate the first brief', text: expect.stringMatching(/^Nexus reads/) })
  })
})
