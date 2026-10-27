/**
 * Reviews Insights › Brief — the rules the Generate button is held with (at least 20 reviews and Amazon topic mentions
 * in the period; 10 briefs a day per business, in words), the scope (a channel and market), and Amazon = topics only:
 * review text from Amazon (a review feed) never reaches the AI — only Amazon's English topics and the reviews a person
 * imported. Real SQL (PGlite with the production schema and policies); the AI call is a stand-in (fetch is stubbed, so
 * nothing leaves this machine).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))

const spotlight = await import('./review-spotlight.service.js')
const { generateSpotlight, SpotlightHeldError, BRIEF_DAILY_LIMIT, mayReadText, scopeLabel, spotlightHistory, spotlightScopes, briefChanges, getLatestSpotlight } = spotlight

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000)

let seq = 0
const review = (channel: string, marketplace: string | null, rating: number, body: string, source: string, themes: string[] = [], label = 'POSITIVE') => {
  seq += 1
  return database.client.review.create({
    data: {
      channel, marketplace, externalReviewId: `test-brief-${seq}`, rating, body, postedAt: daysAgo(3), ingestSource: source,
      sentiment: { create: { label, score: 0, categories: themes, model: 'test' } },
    } as never,
  })
}

describe('Reviews Insights › Brief (real SQL)', () => {
  const prompts: string[] = []

  beforeAll(async () => {
    database = await formulaDatabase()
  }, 120_000)

  afterAll(async () => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    await database?.close()
  })

  it('pure: scope words, and which review text the AI may read', () => {
    expect(scopeLabel({ channel: null, market: null })).toBe('All channels and markets')
    expect(scopeLabel({ channel: 'AMAZON', market: null })).toBe('Amazon — all markets')
    expect(scopeLabel({ channel: 'EBAY', market: 'IT' })).toBe('eBay Italy')
    expect(scopeLabel({ channel: 'SHOPIFY', market: null })).toBe('Shopify')
    expect(mayReadText({ channel: 'AMAZON', ingestSource: 'AMAZON_VOC' })).toBe(false)
    expect(mayReadText({ channel: 'AMAZON', ingestSource: 'IMPORT_CSV' })).toBe(true)
    expect(mayReadText({ channel: 'EBAY', ingestSource: 'EBAY_API' })).toBe(true)
    const changes = briefChanges(
      [{ rating: 5, triageStatus: 'RESPONDED', sentiment: null }, { rating: 1, triageStatus: null, sentiment: { label: 'NEGATIVE', categories: ['FIT_SIZING'] } }],
      [{ rating: 5, triageStatus: null, sentiment: null }],
    )
    expect(changes.map((c) => [c.key, c.before, c.now, c.change])).toEqual([
      ['avgRating', 5, 3, -2], ['negativeShare', 0, 50, 50], ['topComplaint', 0, 1, 1], ['replied', 0, 50, 50], ['reviews', 1, 2, 1],
    ])
  })

  it('fewer than 20 reviews and topic mentions: held, in words', async () => {
    await inside(async () => {
      for (let i = 0; i < 5; i++) await review('EBAY', 'IT', 5, 'Ottima giacca', 'EBAY_API', ['COMFORT'])
    })
    const held = await inside(() => generateSpotlight({ channel: 'EBAY', marketplace: 'IT' })).catch((e) => e)
    expect(held).toBeInstanceOf(SpotlightHeldError)
    expect(held).toMatchObject({ statusCode: 409, reason: 'too_few' })
    expect(held.message).toBe('A brief needs at least 20 reviews and Amazon topic mentions in the period; eBay Italy has 5 in 30 days. Pick a longer period, or more markets.')
  })

  it('the AI reads eBay, Shopify and imported reviews and Amazon’s topics — never Amazon review text from a feed', async () => {
    await inside(async () => {
      for (let i = 0; i < 15; i++) await review('SHOPIFY', null, 2, `Too tight on the chest ${i}`, 'MANUAL', ['FIT_SIZING'], 'NEGATIVE')
      await review('AMAZON', 'DE', 2, 'Imported text: fällt klein aus', 'IMPORT_CSV', ['FIT_SIZING'], 'NEGATIVE')
      await review('AMAZON', 'DE', 1, 'FEED-ONLY Amazon text that must stay out', 'AMAZON_VOC', ['FIT_SIZING'], 'NEGATIVE')
      await database.client.amazonReviewInsight.create({
        data: { asin: 'B0TESTBRF1', marketplace: 'DE', accessStatus: 'OK', starRating: 4.4, reviewCount: 300, positiveTopics: [], negativeTopics: [{ topic: 'Runs small', mentionCount: 12, ratingImpact: -0.5, snippets: ['Order a size up'] }] } as never,
      })
    })
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key-not-real')
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
      prompts.push(JSON.parse(init.body).messages[0].content)
      return new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ complaints: [], praises: [], emerging: [], recommendations: [], findings: [{ theme: 'FIT_SIZING', title: 'It runs small', trend: 'worse', text: '16 reviews say it runs small.' }] }) }] }), { status: 200 })
    }))
    const row = await inside(() => generateSpotlight({}))
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('Imported text: fällt klein aus')
    expect(prompts[0]).toContain('[Amazon DE negative {FIT_SIZING}] Runs small — 12 mentions')
    expect(prompts[0]).not.toContain('FEED-ONLY')
    expect(prompts[0]).not.toMatch(/4\.4|300/)
    expect(row).toMatchObject({ channel: null, marketplace: null, usedAi: true, headline: 'It runs small.', reviewCount: 22 })
    const content = row.content as { sources: unknown; findings: Array<{ evidence: unknown[] }>; changes: unknown[] }
    expect(content.sources).toEqual({ reviews: 21, amazonTopics: 1, amazonTopicsAt: expect.any(String), amazonReviewText: false })
    expect(content.findings[0].evidence).toEqual([{ kind: 'reviews', theme: 'FIT_SIZING', count: 17 }, { kind: 'theme', theme: 'FIT_SIZING', mentions: 12 }])
    expect(content.changes.length).toBeGreaterThan(3)
    expect((await inside(() => getLatestSpotlight({})))?.id).toBe(row.id)
    expect(await inside(() => getLatestSpotlight({ channel: 'EBAY' }))).toBeNull()
  })

  it('10 briefs a day per business: the 11th is held, in words', async () => {
    await inside(async () => {
      const made = await database.client.reviewSpotlight.count()
      for (let i = made; i < BRIEF_DAILY_LIMIT; i++) {
        await database.client.reviewSpotlight.create({ data: { channel: 'SHOPIFY', windowDays: 30, reviewCount: 20, headline: `Test ${i}`, content: {} } as never })
      }
    })
    const held = await inside(() => generateSpotlight({})).catch((e) => e)
    expect(held).toBeInstanceOf(SpotlightHeldError)
    expect(held).toMatchObject({ statusCode: 429, reason: 'daily_limit', message: '10 briefs a day for this business: 10 made today. Try again tomorrow.' })
  })

  it('history and the "Brief for" options say whether a brief exists, and today’s limit', async () => {
    const history = await inside(() => spotlightHistory({}))
    expect(history.items).toHaveLength(BRIEF_DAILY_LIMIT)
    expect(history.items.some((i) => i.label === 'All channels and markets')).toBe(true)
    const shopify = await inside(() => spotlightHistory({ channel: 'SHOPIFY' }))
    expect(shopify.items.every((i) => i.channel === 'SHOPIFY')).toBe(true)
    const scopes = await inside(() => spotlightScopes({}))
    expect(scopes.limit).toEqual({ perDay: 10, usedToday: 10, left: 0 })
    const byLabel = Object.fromEntries(scopes.options.map((o) => [o.label, o]))
    expect(byLabel['All channels and markets']).toMatchObject({ material: 34, tooFew: false, latest: expect.any(Object) })
    expect(byLabel['eBay Italy']).toMatchObject({ material: 5, tooFew: true, latest: null, note: 'Too few reviews (5)' })
    expect(byLabel['Amazon Germany']).toMatchObject({ material: 14, tooFew: true })
    expect(byLabel.Shopify.note).toMatch(/^Brief from /)
  })
})
