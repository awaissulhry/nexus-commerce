/**
 * Reviews Insights › Themes — the pure rules (review-insights-math.ts, review-themes.service.ts heatmapCells): star
 * impact, "too few", the mood, change in share, mentions a week, Amazon topics (topics only: their mentions, share and
 * effect on stars — never a star rating), the scope (Amazon.nl has no topics) and the heatmap's metric.
 */
import { describe, expect, it } from 'vitest'
import {
  amazonTopicMarkets, amazonTopicTheme, buildThemes, MIN_THEME_MENTIONS, parseInsightPeriod, parseInsightScope, parseTopicRows,
  sortThemes, themeMood, themesSummary, themeStarImpact, weeklyCounts, type ThemeReviewRow,
} from './review-insights-math.js'
import { heatmapCells, topicStates } from './review-themes.service.js'

const NOW = new Date('2026-10-26T12:00:00Z')
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000)
let seq = 0
function review(over: Partial<ThemeReviewRow> & { themes?: string[]; label?: string }): ThemeReviewRow {
  seq += 1
  return {
    id: `r${seq}`,
    channel: 'EBAY',
    marketplace: 'IT',
    rating: 5,
    postedAt: daysAgo(2),
    ingestSource: 'EBAY_API',
    body: 'Fine',
    bodyEnglish: null,
    language: 'en',
    sentiment: { label: over.label ?? 'POSITIVE', categories: over.themes ?? [], topPhrases: [] },
    ...over,
  }
}

describe('scope', () => {
  it('reads channel, market and period; anything unknown means all / 30 days', () => {
    expect(parseInsightScope({ channel: 'amazon', market: 'de' })).toEqual({ channel: 'AMAZON', market: 'DE' })
    expect(parseInsightScope({ channel: 'ALL', marketplace: 'gb' })).toEqual({ channel: null, market: 'UK' })
    expect(parseInsightScope({ channel: 'woo', market: '<script>' })).toEqual({ channel: null, market: null })
    expect(parseInsightPeriod('90d')).toBe('90d')
    expect(parseInsightPeriod('2y')).toBe('30d')
  })

  it('Amazon topics: UK, DE, FR, IT, ES only — never Amazon.nl, never for another channel', () => {
    expect(amazonTopicMarkets({ channel: null, market: null })).toEqual(['UK', 'DE', 'FR', 'IT', 'ES'])
    expect(amazonTopicMarkets({ channel: 'AMAZON', market: 'NL' })).toEqual([])
    expect(amazonTopicMarkets({ channel: 'EBAY', market: 'DE' })).toEqual([])
    expect(amazonTopicMarkets({ channel: null, market: 'DE' })).toEqual(['DE'])
  })
})

describe('Amazon topic → theme', () => {
  it.each([
    ['Runs small, order one size up', 'FIT_SIZING'],
    ['Comfortable on long rides', 'COMFORT'],
    ['Stitching came apart', 'DURABILITY'],
    ['CE armour in shoulders and elbows', 'SAFETY'],
    ['Took 9 days to arrive', 'SHIPPING'],
    ['Expensive but worth it', 'VALUE'],
    ['Love the colour', 'DESIGN'],
    ['Feels well made', 'QUALITY'],
    ['Quick reply from the seller', 'OTHER'],
  ])('%s → %s', (topic, theme) => {
    expect(amazonTopicTheme(topic)).toBe(theme)
  })
})

describe('star impact, mood and too few', () => {
  it('star impact = average stars of the reviews that mention it − the overall average (two decimals)', () => {
    expect(themeStarImpact([2, 2, 3, 3, 2], 4.2)).toBe(-1.8)
    expect(themeStarImpact([5, 5, 5, 4, 5], 4)).toBe(0.8)
  })

  it('needs 5 rated mentions; unrated ones do not count', () => {
    expect(themeStarImpact([2, 2, 2, 2], 4)).toBeNull()
    expect(themeStarImpact([2, 2, 2, 2, null, null], 4)).toBeNull()
    expect(themeStarImpact([2, 2, 2, 2, 2], null)).toBeNull()
  })

  it('mood: ≥ 60 % negative or positive, else mixed; fewer than 5 mentions is too few', () => {
    expect(themeMood(1, 4, 5)).toBe('negative')
    expect(themeMood(4, 1, 5)).toBe('positive')
    expect(themeMood(2, 2, 5)).toBe('mixed')
    expect(themeMood(0, 4, MIN_THEME_MENTIONS - 1)).toBe('too_few')
  })

  it('mentions a week, oldest first', () => {
    expect(weeklyCounts([daysAgo(1), daysAgo(2), daysAgo(8), daysAgo(55), daysAgo(60)], NOW)).toEqual([1, 0, 0, 0, 0, 0, 1, 2])
  })
})

describe('the Themes board', () => {
  const fit = (rating: number, days = 2) => review({ themes: ['FIT_SIZING'], label: 'NEGATIVE', rating, postedAt: daysAgo(days) })
  const happy = (n: number) => Array.from({ length: n }, () => review({ themes: ['COMFORT'], rating: 5 }))

  it('a theme with 5+ mentions has share, star impact, change and a trend; fewer is too few', () => {
    const rows = [fit(2), fit(2), fit(1), fit(2), fit(3), ...happy(5), review({ themes: ['SAFETY'], label: 'NEGATIVE', rating: 1 })]
    const prev = [review({ themes: ['FIT_SIZING'], label: 'NEGATIVE', rating: 2, postedAt: daysAgo(40) }), ...Array.from({ length: 9 }, () => review({ themes: ['COMFORT'], postedAt: daysAgo(40) }))]
    const themes = buildThemes({ rows, prevRows: prev, trendRows: rows, topics: [], now: NOW })
    const f = themes.find((t) => t.key === 'FIT_SIZING')!
    expect(f).toMatchObject({ mentions: 5, share: 45.5, mood: 'negative', tooFew: false, starImpactFrom: 'reviews', change: 35.5 })
    // overall = (2+2+1+2+3+5*5+1)/11 = 36/11 = 3.27; with theme = 2 → −1.27
    expect(f.starImpact).toBe(-1.27)
    expect(f.trend).toHaveLength(8)
    const safety = themes.find((t) => t.key === 'SAFETY')!
    expect(safety).toMatchObject({ mentions: 1, tooFew: true, mood: 'too_few', starImpact: null, trend: null })
  })

  it('Amazon topics: mentions, Amazon’s own share and effect on stars, English snippets — never a star rating or count', () => {
    const topics = parseTopicRows([{
      marketplace: 'de',
      fetchedAt: daysAgo(6),
      // A starRating / reviewCount on the row is never read: only the topics.
      positiveTopics: [{ topic: 'Comfortable on long rides', mentionCount: 40, ratingImpact: 0.3, share: 21, snippets: ['So comfy'] }],
      negativeTopics: [{ topic: 'Runs small', mentionCount: 30, ratingImpact: -0.6, share: 17, snippets: ['Order one size up'] }],
    }])
    const themes = buildThemes({ rows: [], prevRows: [], trendRows: [], topics, now: NOW })
    const f = themes.find((t) => t.key === 'FIT_SIZING')!
    expect(f).toMatchObject({ mentions: 30, share: 17, starImpact: -0.6, starImpactFrom: 'amazon_topic', change: null, trend: null, mood: 'negative' })
    expect(f.sources).toEqual({ reviews: 0, amazonTopics: 30 })
    expect(f.snippets).toEqual([{ text: 'Order one size up', english: null, source: 'amazon_topic', channel: 'AMAZON', market: 'DE', from: 'Amazon topic · DE', reviewId: null }])
    expect(JSON.stringify(themes)).not.toMatch(/starRating|reviewCount|average/)
  })

  it('reviews and topics together: review share and stars first, Amazon’s mentions added', () => {
    const rows = [fit(2), fit(2), fit(2), fit(2), fit(2), ...happy(5)]
    const topics = parseTopicRows([{ marketplace: 'IT', fetchedAt: daysAgo(3), positiveTopics: [], negativeTopics: [{ topic: 'Too tight', mentionCount: 12, ratingImpact: -0.9, snippets: ['Tight on the chest'] }] }])
    const f = buildThemes({ rows, prevRows: [], trendRows: rows, topics, now: NOW }).find((t) => t.key === 'FIT_SIZING')!
    expect(f).toMatchObject({ mentions: 17, share: 50, starImpactFrom: 'reviews', starImpact: -1.5 })
    expect(f.snippets.map((s) => s.source)).toEqual(['review', 'amazon_topic'])
  })

  it('a translated review is quoted with its English; the source is named', () => {
    const rows = [review({ themes: ['DURABILITY'], label: 'NEGATIVE', body: 'La zip si è rotta dopo due mesi', bodyEnglish: 'The zip broke after two months', language: 'it' })]
    const [t] = buildThemes({ rows, prevRows: [], trendRows: rows, topics: [], now: NOW })
    expect(t.snippets[0]).toMatchObject({ text: 'La zip si è rotta dopo due mesi', english: 'The zip broke after two months', from: 'eBay feedback · IT', source: 'review' })
    const imported = review({ channel: 'AMAZON', marketplace: 'FR', ingestSource: 'IMPORT_CSV', themes: ['QUALITY'], sentiment: { label: 'NEGATIVE', categories: ['QUALITY'], topPhrases: ['Le velcro se décolle'] } })
    expect(buildThemes({ rows: [imported], prevRows: [], trendRows: [], topics: [], now: NOW })[0].snippets[0].from).toBe('Imported review · Amazon · FR')
  })

  it('sorts by mentions, by star impact (most harmful first) or by change (biggest rise first); unknowns last', () => {
    const rows = [fit(1), fit(1), fit(1), fit(1), fit(1), ...happy(6), ...Array.from({ length: 2 }, () => review({ themes: ['VALUE'] }))]
    const themes = buildThemes({ rows, prevRows: [], trendRows: rows, topics: [], now: NOW })
    expect(sortThemes(themes, 'mentions').map((t) => t.key)).toEqual(['COMFORT', 'FIT_SIZING', 'VALUE'])
    expect(sortThemes(themes, 'impact').map((t) => t.key)).toEqual(['FIT_SIZING', 'COMFORT', 'VALUE'])
  })

  it('summary: reviews read, negative share and its change, the biggest riser, themes without Other', () => {
    const rows = [fit(1), fit(2), ...happy(3), review({ themes: ['OTHER'] })]
    const prev = [review({ rating: 5, postedAt: daysAgo(40) }), review({ rating: 1, postedAt: daysAgo(40), themes: ['FIT_SIZING'], label: 'NEGATIVE' })]
    const themes = buildThemes({ rows, prevRows: prev, trendRows: rows, topics: [], now: NOW })
    expect(themesSummary(rows, prev, themes)).toMatchObject({ reviewsRead: 6, negativeShare: 33.3, negativeShareChange: -16.7, themeCount: 2 })
  })
})

describe('heatmap and Amazon topic states', () => {
  it('cells only on days with reviews; the metric is mentions or negative share', () => {
    const since = new Date('2026-10-20T00:00:00Z')
    const rows = [
      { postedAt: new Date('2026-10-21T08:00:00Z'), sentiment: { label: 'NEGATIVE', categories: ['FIT_SIZING'] } },
      { postedAt: new Date('2026-10-21T09:00:00Z'), sentiment: { label: 'POSITIVE', categories: ['FIT_SIZING', 'COMFORT'] } },
    ]
    const mentions = heatmapCells(rows, since, NOW, 7, 'mentions', { channel: 'EBAY', market: null })
    expect(mentions.dates).toHaveLength(7)
    expect(mentions.categories).toEqual(['FIT_SIZING', 'COMFORT'])
    expect(mentions.cells.find((c) => c.category === 'FIT_SIZING')).toMatchObject({ date: '2026-10-21', total: 2, negative: 1, value: 2 })
    const share = heatmapCells(rows, since, NOW, 7, 'negativeShare', { channel: null, market: null })
    expect(share.cells.find((c) => c.category === 'FIT_SIZING')!.value).toBe(50)
    expect(share.cells.some((c) => c.date === '2026-10-22')).toBe(false)
  })

  it('a market without the Selling Partner Insights role says so; no rows is "no topics yet"', () => {
    const states = topicStates([
      { marketplace: 'DE', accessStatus: 'OK', fetchedAt: daysAgo(6) },
      { marketplace: 'ES', accessStatus: 'NEEDS_BRAND_ANALYTICS_ROLE', fetchedAt: daysAgo(6) },
    ], ['DE', 'ES', 'FR'])
    expect(states.map((s) => [s.market, s.state])).toEqual([['DE', 'ok'], ['ES', 'needs_role'], ['FR', 'no_data']])
    // One name for the role everywhere (audit B16): sellers need Selling Partner Insights (Brand Analytics is the vendors').
    expect(states[1].words).toMatch(/Selling Partner Insights role/)
  })
})
