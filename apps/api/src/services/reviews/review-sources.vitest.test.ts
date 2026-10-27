/**
 * Reviews area — review sources in words: each channel × market's state, what it gives and how it arrives, and the
 * setup problems a person can fix. Pure (`sourcesFromFacts`), no database. Every word a person reads is checked for
 * setting names: no variable name ever reaches the screen.
 */
import { describe, expect, it } from 'vitest'
import { arrivalWords, connectionProblem, dayWords, sourcesFromFacts, topicStates, type SourceFacts } from './review-sources.service.js'

const NOW = new Date('2026-10-26T12:00:00Z')
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000)
const daysAgo = (d: number) => hoursAgo(d * 24)

function facts(over: Partial<SourceFacts> = {}): SourceFacts {
  return {
    connections: [],
    topics: [],
    reviewGroups: [],
    lastReadAt: hoursAgo(0.3),
    ebayListingMarkets: [],
    ebayFeedbackOn: true,
    amazonTopicsOn: true,
    ...over,
  }
}

const conn = (channelType: string, marketplace: string | null, authStatus = 'connected', extra: Partial<SourceFacts['connections'][number]> = {}) =>
  ({ id: `${channelType}-${marketplace}`, channelType, marketplace, isActive: true, authStatus, lastErrorAt: null, isPrimary: true, ...extra })

const group = (channel: string, marketplace: string | null, ingestSource: string, count: number, lastPosted = daysAgo(2)) =>
  ({ channel, marketplace, ingestSource, count, lastPostedAt: lastPosted, lastIngestedAt: lastPosted })

/** Every string a person could read in the answer. */
function wordsOf(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(wordsOf)
  if (value && typeof value === 'object') return Object.entries(value).filter(([k]) => k !== 'id' && k !== 'fingerprint' && k !== 'channel' && k !== 'market' && k !== 'state').flatMap(([, v]) => wordsOf(v))
  return []
}

const SETTING_NAME = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|NEXUS|process\.env|=\s*(true|1)\b/

describe('review sources', () => {
  it('an eBay account whose sign-in expired is Not updating, says why and where to reconnect', () => {
    const out = sourcesFromFacts(facts({
      connections: [conn('EBAY', 'IT'), conn('EBAY', 'DE', 'needs_reauth', { lastErrorAt: hoursAgo(3) })],
      reviewGroups: [group('EBAY', 'IT', 'EBAY_API', 40), group('EBAY', 'DE', 'EBAY_API', 12)],
    }), NOW)
    const de = out.sources.find(s => s.channel === 'EBAY' && s.market === 'DE')!
    expect(de).toMatchObject({ state: 'not_updating', reason: 'Sign-in expired', reconnectHref: '/settings/channels/ebay', what: 'Seller feedback' })
    expect(de.since).toBe(hoursAgo(3).toISOString())
    const it_ = out.sources.find(s => s.channel === 'EBAY' && s.market === 'IT')!
    expect(it_).toMatchObject({ state: 'ok', reason: null, lastNote: 'read every 30 min', reviews: 40 })
    expect(out.setup.map(p => p.id)).toEqual(['ebay-signin:DE'])
    expect(out.setup[0]).toMatchObject({ title: 'eBay Germany stopped updating.', actionLabel: 'Reconnect in Settings', href: '/settings/channels/ebay' })
  })

  it('a review read that stopped shows Not updating with the last read, never a stale date as if fine', () => {
    const out = sourcesFromFacts(facts({ connections: [conn('EBAY', 'IT')], lastReadAt: hoursAgo(5) }), NOW)
    expect(out.sources[0]).toMatchObject({ state: 'not_updating', reason: `Nexus has not read eBay since ${dayWords(hoursAgo(5))}` })
    expect(out.setup).toEqual([]) // no person can fix a late job from here
  })

  it('when this Nexus does not read eBay feedback, it says so in words', () => {
    const out = sourcesFromFacts(facts({ connections: [conn('EBAY', 'IT')], ebayFeedbackOn: false }), NOW)
    expect(out.sources[0]).toMatchObject({ state: 'not_updating', reason: 'Nexus does not read eBay feedback in this setup yet', reconnectHref: null })
  })

  it('a market with old reviews and no account is Not updating without a banner', () => {
    const out = sourcesFromFacts(facts({ reviewGroups: [group('EBAY', 'FR', 'EBAY_API', 3)] }), NOW)
    expect(out.sources[0]).toMatchObject({ market: 'FR', state: 'not_updating', reason: 'No eBay account is connected' })
    expect(out.setup).toEqual([])
  })

  it('an eBay account with no market covers every eBay market the business sells on, not Italy only', () => {
    const out = sourcesFromFacts(facts({
      connections: [conn('EBAY', null)],
      reviewGroups: [group('EBAY', 'IT', 'EBAY_API', 40)],
      ebayListingMarkets: ['IT', 'DE', 'gb', 'EBAY_FR'],
    }), NOW)
    const ebay = out.sources.filter(s => s.channel === 'EBAY')
    expect(ebay.map(s => s.market)).toEqual(['DE', 'IT', 'UK'])
    for (const s of ebay) expect(s).toMatchObject({ state: 'ok', reason: null, reconnectHref: null, lastNote: 'read every 30 min' })
    expect(ebay.find(s => s.market === 'IT')!.reviews).toBe(40)
    expect(out.setup).toEqual([])
  })

  it('an account-wide eBay account that stopped: every market says why, ONE banner names eBay', () => {
    const out = sourcesFromFacts(facts({
      connections: [conn('EBAY', null, 'needs_reauth', { lastErrorAt: hoursAgo(3) })],
      ebayListingMarkets: ['IT', 'DE'],
    }), NOW)
    const ebay = out.sources.filter(s => s.channel === 'EBAY')
    expect(ebay.map(s => [s.market, s.state, s.reason])).toEqual([['DE', 'not_updating', 'Sign-in expired'], ['IT', 'not_updating', 'Sign-in expired']])
    expect(out.setup).toHaveLength(1)
    expect(out.setup[0]).toMatchObject({ id: 'ebay-signin:ALL', title: 'eBay stopped updating.', href: '/settings/channels/ebay' })
    expect(out.setup[0].words).toContain('Nexus cannot read new feedback from eBay or send replies there')
  })

  it("a market's own account comes first; a switched-off one falls back to the account-wide account", () => {
    const out = sourcesFromFacts(facts({
      connections: [conn('EBAY', null), conn('EBAY', 'FR', 'needs_reauth'), conn('EBAY', 'DE', 'connected', { isActive: false })],
      ebayListingMarkets: ['DE', 'FR'],
    }), NOW)
    const by = Object.fromEntries(out.sources.filter(s => s.channel === 'EBAY').map(s => [s.market, s]))
    expect(by.FR).toMatchObject({ state: 'not_updating', reason: 'Sign-in expired' })
    expect(by.DE).toMatchObject({ state: 'ok', reason: null })
    expect(out.setup.map(p => p.id)).toEqual(['ebay-signin:FR'])
  })

  it('an account-wide eBay account with no market to show yet is one row for eBay; listings alone without an account add nothing', () => {
    const wide = sourcesFromFacts(facts({ connections: [conn('EBAY', null)] }), NOW)
    expect(wide.sources).toEqual([expect.objectContaining({ channel: 'EBAY', market: null, state: 'ok', what: 'Seller feedback' })])
    const none = sourcesFromFacts(facts({ ebayListingMarkets: ['IT', 'DE'] }), NOW)
    expect(none.sources.filter(s => s.channel === 'EBAY')).toEqual([])
  })

  it('Amazon: topics per market, stars only from imported reviews, no topics on Amazon.nl', () => {
    const out = sourcesFromFacts(facts({
      topics: [
        { marketplace: 'IT', accessStatus: 'OK', fetchedAt: daysAgo(6) },
        { marketplace: 'ES', accessStatus: 'OK', fetchedAt: daysAgo(6) },
      ],
      reviewGroups: [group('AMAZON', 'IT', 'IMPORT_CSV', 31), group('AMAZON', 'NL', 'IMPORT_CSV', 2)],
    }), NOW)
    const byMarket = Object.fromEntries(out.sources.map(s => [s.market, s]))
    expect(byMarket.IT).toMatchObject({ state: 'ok', what: 'Topics · stars from imported reviews', lastNote: 'file import · topics 20 Oct', reviews: 31 })
    expect(byMarket.ES).toMatchObject({ what: 'Topics · no reviews imported', lastNote: 'topics 20 Oct', reviews: 0 })
    expect(byMarket.NL.what).toBe('Stars from imported reviews · no topics on Amazon.nl')
  })

  it('a refused topics read for the missing role is ONE setup problem that names the markets and the last good read', () => {
    const out = sourcesFromFacts(facts({
      topics: [
        { marketplace: 'IT', accessStatus: 'OK', fetchedAt: daysAgo(13) },
        { marketplace: 'IT', accessStatus: 'NEEDS_BRAND_ANALYTICS_ROLE', fetchedAt: daysAgo(6) },
        { marketplace: 'DE', accessStatus: 'NEEDS_BRAND_ANALYTICS_ROLE', fetchedAt: daysAgo(6) },
      ],
    }), NOW)
    expect(out.setup).toHaveLength(1)
    const p = out.setup[0]
    expect(p).toMatchObject({ id: 'amazon-topics-role', title: 'Amazon review topics did not update.', actionLabel: 'Fix in Settings', href: '/settings/channels/amazon' })
    expect(p.words).toContain('for Germany, Italy')
    expect(p.words).toContain('Topics stay at Tue 13 Oct')
    // The newest read decides: topics that came back clear the problem.
    const fixed = topicStates([{ marketplace: 'IT', accessStatus: 'NEEDS_BRAND_ANALYTICS_ROLE', fetchedAt: daysAgo(13) }, { marketplace: 'IT', accessStatus: 'OK', fetchedAt: daysAgo(6) }])
    expect(fixed.get('IT')!.roleMissing).toBe(false)
  })

  it('an Amazon sign-in that expired is a setup problem', () => {
    const out = sourcesFromFacts(facts({ connections: [conn('AMAZON', null, 'revoked')] }), NOW)
    expect(out.setup.map(p => p.id)).toEqual(['amazon-signin'])
    expect(out.setup[0].words.startsWith('Access was removed on the channel.')).toBe(true)
  })

  it('Shopify reviews arrive by file import', () => {
    const out = sourcesFromFacts(facts({ reviewGroups: [group('SHOPIFY', null, 'IMPORT_CSV', 18, daysAgo(0))] }), NOW)
    expect(out.sources[0]).toMatchObject({ channel: 'SHOPIFY', market: null, state: 'ok', what: 'Store review app, by file import', lastNote: 'last file import 26 Oct', reviews: 18 })
  })

  it('Etsy (PR I): one row once an account is connected; off, broken or read every 30 minutes', () => {
    const etsy = (over: Partial<SourceFacts>) => sourcesFromFacts(facts(over), NOW).sources.find(s => s.channel === 'ETSY')
    expect(etsy({})).toBeUndefined()
    const conn = { id: 'e1', channelType: 'ETSY', marketplace: null, isActive: true, authStatus: 'connected', lastErrorAt: null, isPrimary: true }
    expect(etsy({ connections: [conn] })).toMatchObject({ state: 'not_updating', reason: 'Nexus does not read Etsy reviews in this setup yet' })
    expect(etsy({ connections: [conn], etsyReadOn: true, etsyLastReadAt: daysAgo(0) })).toMatchObject({ state: 'ok', what: 'Shop reviews, one photo each', lastNote: 'read every 30 min · last 26 Oct' })
    expect(etsy({ connections: [{ ...conn, authStatus: 'needs_reauth' }], etsyReadOn: true })).toMatchObject({ state: 'not_updating', reason: 'Sign-in expired', reconnectHref: '/settings/channels/etsy' })

    // Reviews from Italian and German orders: one row per market, no extra market-less row.
    const markets = sourcesFromFacts(facts({ connections: [conn], etsyReadOn: true, reviewGroups: [group('ETSY', 'IT', 'ETSY_API', 4, daysAgo(1)), group('ETSY', 'DE', 'ETSY_API', 1, daysAgo(9))] }), NOW)
      .sources.filter(s => s.channel === 'ETSY')
    expect(markets.map(s => [s.market, s.reviews])).toEqual([['DE', 1], ['IT', 4]])
  })

  it('Etsy with no shop connected (lane N4): one "Not connected" row with Connect, kept apart from what Nexus reads', () => {
    // Nothing held, nothing connected: one row, no numbers made up, never "read every 30 minutes".
    const none = sourcesFromFacts(facts({ etsyReadOn: true, etsyLastReadAt: daysAgo(0) }), NOW)
    expect(none.sources.find(s => s.channel === 'ETSY')).toBeUndefined()
    expect(none.notConnected).toEqual([{
      channel: 'ETSY', market: null, state: 'not_connected', reason: 'No Etsy shop is connected', since: null,
      reconnectHref: '/settings/channels/etsy', what: 'Shop reviews, one photo each', lastNote: null, lastReviewAt: null, reviews: 0,
      readsItself: false,
    }])
    expect(none.setup).toEqual([]) // not connecting a channel is a choice, not a problem to fix
    expect(wordsOf(none.notConnected).filter(w => SETTING_NAME.test(w))).toEqual([])

    // Etsy reviews held from before (a shop since removed, or a file): their real numbers, still "Not connected".
    const held = sourcesFromFacts(facts({ etsyReadOn: true, reviewGroups: [group('ETSY', 'IT', 'ETSY_API', 3, daysAgo(4)), group('ETSY', null, 'IMPORT_CSV', 2, daysAgo(9))] }), NOW)
    expect(held.sources.find(s => s.channel === 'ETSY')).toBeUndefined()
    expect(held.notConnected.map(s => [s.market, s.state, s.reviews, s.lastReviewAt])).toEqual([['IT', 'not_connected', 5, daysAgo(4).toISOString()]])

    // Once a shop is connected (even one that needs a fix) Etsy is a source again, and nothing is "not connected".
    const etsyConn = conn('ETSY', null)
    expect(sourcesFromFacts(facts({ connections: [etsyConn], etsyReadOn: true }), NOW).notConnected).toEqual([])
    expect(sourcesFromFacts(facts({ connections: [{ ...etsyConn, authStatus: 'revoked' }], etsyReadOn: true }), NOW).sources.find(s => s.channel === 'ETSY'))
      .toMatchObject({ state: 'not_updating', reconnectHref: '/settings/channels/etsy', readsItself: true })
  })

  it('Shopify via Judge.me (PR I): the row says the app is read', () => {
    const out = sourcesFromFacts(facts({ shopifyApp: { connected: true, lastReadAt: daysAgo(0) } }), NOW)
    expect(out.sources.find(s => s.channel === 'SHOPIFY')).toMatchObject({ what: 'Store review app (Judge.me), read every 30 min', lastNote: 'Judge.me read 26 Oct' })
    expect(arrivalWords('ETSY_API')).toBe('read from Etsy')
    expect(arrivalWords('JUDGEME_API')).toBe('read from Judge.me')
  })

  it('names states and arrivals in words', () => {
    expect(connectionProblem(undefined, 'eBay')).toBe('No eBay account is connected')
    expect(connectionProblem({ isActive: false, authStatus: 'connected' }, 'eBay')).toBe('The eBay account is switched off in Nexus')
    expect(connectionProblem({ isActive: true, authStatus: 'degraded' }, 'eBay')).toBeNull()
    expect(arrivalWords('IMPORT_CSV')).toBe('file import')
    expect(arrivalWords('FIXTURE')).toBeNull()
  })

  it('no setting name ever reaches a word a person reads', () => {
    const variants: SourceFacts[] = [
      facts({ connections: [conn('EBAY', 'IT')] }),
      facts({ ebayFeedbackOn: false, amazonTopicsOn: false, connections: [conn('EBAY', 'IT'), conn('AMAZON', null, 'needs_reauth')], reviewGroups: [group('AMAZON', 'IT', 'IMPORT_CSV', 3)] }),
      facts({ lastReadAt: null, connections: [conn('EBAY', 'DE', 'disconnected')], topics: [{ marketplace: 'FR', accessStatus: 'NEEDS_BRAND_ANALYTICS_ROLE', fetchedAt: daysAgo(1) }] }),
      facts({ connections: [conn('EBAY', null, 'revoked')], ebayListingMarkets: ['IT', 'DE'] }),
    ]
    for (const f of variants) {
      const words = wordsOf(sourcesFromFacts(f, NOW)).filter(w => !w.startsWith('/settings/'))
      expect(words.length).toBeGreaterThan(0)
      for (const w of words) expect(w).not.toMatch(SETTING_NAME)
    }
  })
})
