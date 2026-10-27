import { describe, expect, it } from 'vitest'
import { parseInboxQuery } from '../../inbox/inboxQuery'
import {
  changeTone,
  heatCellHref,
  heatCellText,
  heatMatrix,
  heatSubtitle,
  impactView,
  inboxPeriodFor,
  parseHeatMetric,
  parseThemeSort,
  pointsWords,
  shareWords,
  sourcesWords,
  themeHref,
  themesTiles,
  topicsBanner,
  trendLabel,
  type HeatmapAnswer,
  type ThemesAnswer,
} from './themesModel'

const answer = (over: Partial<ThemesAnswer> = {}): ThemesAnswer => ({
  scope: { channel: null, market: null, period: '30d', sort: 'mentions' },
  summary: { reviewsRead: 1284, negativeShare: 14.2, negativeShareChange: -2.4, biggestRiser: { key: 'FIT_SIZING', label: 'Fit & sizing', change: 6.2 }, themeCount: 8, amazonTopicMarkets: 5, amazonTopicsAt: '2026-10-20T06:00:00Z' },
  themes: [],
  amazon: { markets: [], notOffered: null },
  generatedAt: '2026-10-26T10:00:00Z',
  ...over,
})

describe('numbers in words', () => {
  it('says points, shares and the sort and heatmap modes', () => {
    expect(pointsWords(6)).toBe('+6 pts')
    expect(pointsWords(-2.4)).toBe('−2.4 pts')
    expect(pointsWords(0)).toBe('Same')
    expect(pointsWords(null)).toBe('—')
    expect(shareWords(18)).toBe('18%')
    expect(shareWords(12.5)).toBe('12.5%')
    expect(shareWords(null)).toBe('—')
    expect(parseThemeSort('impact')).toBe('impact')
    expect(parseThemeSort('nonsense')).toBe('mentions')
    expect(parseHeatMetric('negativeShare')).toBe('negativeShare')
    expect(parseHeatMetric(null)).toBe('mentions')
  })

  it('colours star impact by how much harm it does, and says where it comes from', () => {
    expect(impactView({ starImpact: -0.8, starImpactFrom: 'reviews', tooFew: false })).toEqual({ text: '−0.80 ★', tone: 'danger', words: '0.80 stars below your average' })
    expect(impactView({ starImpact: -0.2, starImpactFrom: 'amazon_topic', tooFew: false })).toEqual({ text: '−0.20 ★', tone: 'warning', words: '0.20 stars below your average, from Amazon’s topics' })
    expect(impactView({ starImpact: 1, starImpactFrom: 'reviews', tooFew: false }).words).toBe('1.00 star above your average')
    expect(impactView({ starImpact: null, starImpactFrom: null, tooFew: true })).toEqual({ text: '—', tone: 'neutral', words: 'Too few mentions to measure its effect on stars' })
  })

  it('reads a rise as bad news for a complaint and good news for praise', () => {
    expect(changeTone({ change: 6, mood: 'negative' })).toBe('bad')
    expect(changeTone({ change: -3, mood: 'negative' })).toBe('good')
    expect(changeTone({ change: 4, mood: 'positive' })).toBe('good')
    expect(changeTone({ change: 4, mood: 'mixed' })).toBeNull()
    expect(changeTone({ change: null, mood: 'negative' })).toBeNull()
  })

  it('says a trend line for a reader, or that there are too few to trend', () => {
    expect(trendLabel({ label: 'Comfort', trend: [1, 0, 2, 3, 1, 0, 4, 2] })).toBe('Comfort, mentions a week over the last 8 weeks: 1, 0, 2, 3, 1, 0, 4, 2')
    expect(trendLabel({ label: 'Safety', trend: null })).toBe('Safety: too few to trend')
    expect(sourcesWords({ sources: { reviews: 12, amazonTopics: 40 } })).toBe('12 reviews · 40 Amazon topic mentions')
    expect(sourcesWords({ sources: { reviews: 1, amazonTopics: 0 } })).toBe('1 review')
  })
})

describe('tiles', () => {
  it('counts what was read, and says fewer negative reviews is good news', () => {
    const t = themesTiles(answer())
    expect(t.read).toBe('1,284')
    expect(t.readHint).toBe('plus Amazon topics for 5 markets')
    expect(t.negative).toBe('14%')
    expect(t.negativeDelta).toEqual({ value: '−2 pts', positive: true })
    expect(t.riser).toBe('Fit & sizing')
    expect(t.riserDelta).toEqual({ value: '+6 pts', positive: false })
    expect(t.themes).toBe('8')
  })

  it('says when nothing rose and no topics were read — never a zero that is not one', () => {
    const t = themesTiles(answer({ summary: { ...answer().summary, biggestRiser: null, amazonTopicMarkets: 0, negativeShare: null, negativeShareChange: null } }))
    expect(t.riser).toBe('None')
    expect(t.riserDelta).toBeNull()
    expect(t.readHint).toBe('reviews and feedback in the period')
    expect(t.negative).toBe('—')
    expect(t.negativeDelta).toBeNull()
  })
})

describe('Amazon banner', () => {
  it('explains Amazon’s topics where they can show, and lists the markets it could not read', () => {
    const banner = topicsBanner(answer({ amazon: { markets: [{ market: 'ES', label: 'Amazon Spain', state: 'needs_role', words: 'Amazon refused the topics.', topicsAt: null }], notOffered: null } }), { channel: null, market: null })
    expect(banner?.title).toBe('Amazon topics are weekly and in English only.')
    expect(banner?.problems).toEqual(['Amazon Spain: Amazon refused the topics.'])
    expect(topicsBanner(answer(), { channel: 'EBAY', market: null })).toBeNull()
  })

  it('says Amazon.nl has no topics', () => {
    const banner = topicsBanner(answer({ amazon: { markets: [], notOffered: 'Amazon gives no review topics for Amazon.nl.' } }), { channel: 'AMAZON', market: 'NL' })
    expect(banner).toMatchObject({ tone: 'warning', title: 'Not available on Amazon.nl' })
  })
})

describe('heatmap', () => {
  const heat: HeatmapAnswer = {
    dates: Array.from({ length: 10 }, (_, i) => `2026-10-${String(17 + i).padStart(2, '0')}`),
    categories: ['FIT_SIZING', 'SHIPPING'],
    cells: [
      { date: '2026-10-20', category: 'FIT_SIZING', total: 5, positive: 1, neutral: 2, negative: 2, value: 5 },
      { date: '2026-10-26', category: 'SHIPPING', total: 1, positive: 1, neutral: 0, negative: 0, value: 1 },
    ],
    sinceDays: 10,
    marketplace: null,
    channel: null,
    metric: 'mentions',
  }

  it('lays themes in rows and days in columns; a day without a mention has no measurement', () => {
    const m = heatMatrix(heat)
    expect(m.rowLabels).toEqual(['Fit & sizing', 'Shipping'])
    expect(m.data[0][3]).toBe(5)
    expect(m.data[0][0]).toBeNull()
    expect(m.data[1][9]).toBe(1)
    expect(m.colTitles[9]).toBe('Mon 26 Oct')
    // The newest column always carries its day; one label a week.
    expect(m.colLabels[9]).toBe('26 Oct')
    expect(m.colLabels[2]).toBe('19 Oct')
    expect(m.colLabels[3]).toBe('')
  })

  it('words a cell, and opens the Inbox on that theme over the shortest period that holds the day', () => {
    expect(heatCellText('Fit & sizing', '2026-10-20', heat.cells[0], 'mentions')).toBe('Fit & sizing · Tue 20 Oct: 5 mentions, 2 negative — opens these reviews in the Inbox')
    expect(heatCellText('Fit & sizing', '2026-10-20', { ...heat.cells[0], value: 40 }, 'negativeShare')).toBe('Fit & sizing · Tue 20 Oct: 40% negative (2 negative of 5 mentions) — opens these reviews in the Inbox')
    expect(heatCellText('Shipping', '2026-10-17', null, 'mentions')).toBe('Shipping · Sat 17 Oct: no reviews mention it')
    const now = new Date('2026-10-26T12:00:00Z')
    expect(inboxPeriodFor('2026-10-24', now)).toBe('7d')
    expect(inboxPeriodFor('2026-10-01', now)).toBe('30d')
    expect(inboxPeriodFor('2026-08-01', now)).toBe('90d')
    expect(inboxPeriodFor('2026-01-01', now)).toBe('12m')
    const href = heatCellHref('FIT_SIZING', '2026-10-20', { channel: 'AMAZON', market: 'DE' }, now)
    expect(href).toBe('/marketing/reviews/inbox?period=7d&channel=AMAZON&market=DE&theme=FIT_SIZING')
    // The Inbox reads it back.
    const q = parseInboxQuery(href.slice(href.indexOf('?'))).query
    expect(q.themes).toEqual(['FIT_SIZING'])
    expect(q.period).toBe('7d')
    expect(themeHref('SHIPPING', { channel: null, market: null, period: '90d' })).toBe('/marketing/reviews/inbox?period=90d&theme=SHIPPING')
  })

  it('says the card’s line, and that 12 months shows 90 days', () => {
    expect(heatSubtitle(heat, 'mentions', '30d')).toBe('Mentions a day, last 10 days')
    expect(heatSubtitle(null, 'negativeShare', '7d')).toBe('Share of a theme’s mentions that are negative, a day, last 7 days')
    expect(heatSubtitle({ ...heat, sinceDays: 90 }, 'mentions', '12m')).toBe('Mentions a day, last 90 days (the map shows at most 90 days)')
  })
})
