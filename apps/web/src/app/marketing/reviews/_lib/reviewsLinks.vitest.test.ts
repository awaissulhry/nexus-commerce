import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  channelHref,
  etsyClosedHref,
  etsyClosingHref,
  inboxHref,
  needsReplyHref,
  rulesHref,
  timingHref,
  insightsHref,
  productReviewsHref,
  requestsHref,
  reviewsSettingsHref,
  ruleHref,
  withQuery,
  type InsightsPage,
} from './reviewsLinks'
import { parseInboxQuery } from '../inbox/inboxQuery'
import { parseProductsQuery } from '../insights/products/productsQuery'
import { sectionFromSearch } from '../settings/_settings/settingsModel'

const APP = fileURLToPath(new URL('../../..', import.meta.url))
const WEB_ROOT = fileURLToPath(new URL('../../../../..', import.meta.url))

interface NextRedirect { source: string; destination: string; permanent?: boolean; has?: unknown[] }
const loadRedirects = async (): Promise<NextRedirect[]> => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cfg = require(join(WEB_ROOT, 'next.config.js')) as { redirects: () => Promise<NextRedirect[]> }
  return cfg.redirects()
}

/** True when `href`'s path is a page of the app (a `[param]` folder matches any one segment). */
function isPage(href: string): boolean {
  const segments = href.split(/[?#]/)[0].split('/').filter(Boolean)
  const walk = (dir: string, rest: string[]): boolean => {
    if (rest.length === 0) return existsSync(join(dir, 'page.tsx'))
    const [head, ...tail] = rest
    if (existsSync(join(dir, head)) && walk(join(dir, head), tail)) return true
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() && /^\[[^.\]]+\]$/.test(e.name))
      .some(e => walk(join(dir, e.name), tail))
  }
  return walk(APP, segments)
}

describe('reviews links', () => {
  it('builds a query without empty values', () => {
    expect(withQuery('/x')).toBe('/x')
    expect(withQuery('/x', { a: 'b', c: null, d: undefined, e: '', f: false, g: true })).toBe('/x?a=b&g=1')
    expect(withQuery('/x', { stars: [1, 2], none: [] })).toBe('/x?stars=1%2C2')
  })

  it('points every link at a page that exists', () => {
    const pages: InsightsPage[] = ['themes', 'products', 'alerts', 'fixes', 'brief']
    const hrefs = [
      inboxHref(), inboxHref({ import: 1 }), inboxHref({ channel: 'EBAY', market: 'DE', stars: [1] }),
      requestsHref(), requestsHref({ inserts: 1 }), requestsHref({ preview: true }),
      ruleHref('rule-1'),
      ...pages.map(page => insightsHref(page)),
      insightsHref('products', { product: 'product-1' }),
      '/marketing/reviews/insights',
      reviewsSettingsHref(), reviewsSettingsHref('automations'), reviewsSettingsHref('pipeline'),
      productReviewsHref('product-1'),
      channelHref('AMAZON'), channelHref('AMAZON', 'IT'), channelHref('EBAY'), channelHref('EBAY', 'GB'), channelHref('ETSY'), channelHref('SHOPIFY'),
      rulesHref(), timingHref(),
      needsReplyHref({ channel: 'ETSY' }), etsyClosingHref(), etsyClosedHref(),
    ]
    for (const href of hrefs) expect(isPage(href), href).toBe(true)
  })

  it('sends a channel to its Reviews page (Amazon and eBay; GB is the UK; Etsy and Shopify); other channels to the Inbox, scoped', () => {
    expect(channelHref('amazon')).toBe('/marketing/reviews/amazon')
    expect(channelHref('AMAZON', 'IT')).toBe('/marketing/reviews/amazon/it')
    expect(channelHref('EBAY', 'gb')).toBe('/marketing/reviews/ebay/uk')
    expect(channelHref('EBAY', 'DEFAULT')).toBe('/marketing/reviews/ebay')
    expect(channelHref('EBAY', null)).toBe('/marketing/reviews/ebay')
    // PR I: one page each, no market pages — a market never makes a path.
    expect(channelHref('SHOPIFY')).toBe('/marketing/reviews/shopify')
    expect(channelHref('shopify', 'IT')).toBe('/marketing/reviews/shopify')
    expect(channelHref('ETSY', 'IT')).toBe('/marketing/reviews/etsy')
    expect(channelHref('etsy', null)).toBe('/marketing/reviews/etsy')
    expect(channelHref('WOOCOMMERCE', 'DE')).toBe('/marketing/reviews/inbox?channel=WOOCOMMERCE&market=DE')
  })

  it('hands the Inbox every filter it reads', () => {
    expect(inboxHref()).toBe('/marketing/reviews/inbox')
    expect(inboxHref({ channel: 'EBAY', market: 'DE', stars: [1, 2], period: '7d' })).toBe('/marketing/reviews/inbox?period=7d&channel=EBAY&market=DE&stars=1%2C2')
    expect(inboxHref({ kind: 'seller', status: 'OVERDUE', theme: 'FIT_SIZING', family: 'fam-1' })).toBe('/marketing/reviews/inbox?kind=seller&status=OVERDUE&theme=FIT_SIZING&family=fam-1')
    expect(inboxHref({ import: 1, channel: 'EBAY' })).toBe('/marketing/reviews/inbox?channel=EBAY&import=1')
    expect(inboxHref({ import: true })).toBe('/marketing/reviews/inbox?import=1')
    // One review's pop-up (the Overview's Needs you › Reply): the Inbox reads it back on load.
    const reply = inboxHref({ channel: 'EBAY', market: 'IT', review: 'rev_1' })
    expect(reply).toBe('/marketing/reviews/inbox?channel=EBAY&market=IT&review=rev_1')
    expect(parseInboxQuery(reply.slice(reply.indexOf('?'))).review).toBe('rev_1')
    expect(inboxHref({ review: null })).toBe('/marketing/reviews/inbox')
    // A product's reviews by its SKU (the Inbox's search reads it back).
    expect(inboxHref({ theme: 'FIT_SIZING', q: 'TJ-BLK' })).toBe('/marketing/reviews/inbox?theme=FIT_SIZING&q=TJ-BLK')
    expect(parseInboxQuery('?q=TJ-BLK').query.q).toBe('TJ-BLK')
  })

  it('sends the Insights links to the Insights pages, with the scope and the page’s own values', () => {
    expect(insightsHref('themes')).toBe('/marketing/reviews/insights/themes')
    expect(insightsHref('themes', { channel: 'AMAZON', sort: 'impact', period: '90d' })).toBe('/marketing/reviews/insights/themes?channel=AMAZON&period=90d&sort=impact')
    // 30 days is the default period and leaves the address.
    expect(insightsHref('alerts', { market: 'DE', period: '30d', status: 'ALL' })).toBe('/marketing/reviews/insights/alerts?market=DE&status=ALL')
    expect(insightsHref('fixes', { kind: ['BULLETS', 'APLUS'], product: 'p-1' })).toBe('/marketing/reviews/insights/fixes?product=p-1&kind=BULLETS%2CAPLUS')
    expect(insightsHref('brief', { brief: 'b-1' })).toBe('/marketing/reviews/insights/brief?brief=b-1')
    // One product's reviews: its pop-up over Products, which reads `?product=` back.
    expect(insightsHref('products', { product: 'a b' })).toBe('/marketing/reviews/insights/products?product=a+b')
    expect(productReviewsHref('a b')).toBe('/marketing/reviews/insights/products?product=a+b')
    expect(productReviewsHref('p-1', { channel: 'EBAY', market: 'IT', period: '7d' })).toBe('/marketing/reviews/insights/products?channel=EBAY&market=IT&period=7d&product=p-1')
    const href = productReviewsHref('a b')
    expect(parseProductsQuery(href.slice(href.indexOf('?'))).product).toBe('a b')
  })

  it('sends the Requests links to the Queue, its windows and one rule’s editor, filters and all', () => {
    expect(requestsHref()).toBe('/marketing/reviews/requests')
    // A link keeps its page's period (audit A3); the Queue's own default (30 days) leaves the address.
    expect(requestsHref({ status: 'FAILED', channel: 'EBAY', market: 'DE', period: '7d' })).toBe('/marketing/reviews/requests?period=7d&status=FAILED&channel=EBAY&market=DE')
    expect(requestsHref({ status: 'SENT', period: '30d' })).toBe('/marketing/reviews/requests?status=SENT')
    // The badges' number: the one needs-a-reply rule, every date (audit A4, C1).
    expect(needsReplyHref()).toBe('/marketing/reviews/inbox?period=all&reply=needed')
    expect(needsReplyHref({ channel: 'EBAY', market: 'DE' })).toBe('/marketing/reviews/inbox?period=all&channel=EBAY&market=DE&reply=needed')
    // The Etsy page's "Window closing": of those, the Etsy windows closing within 10 days (the API counts this address).
    expect(etsyClosingHref()).toBe('/marketing/reviews/inbox?period=all&channel=ETSY&reply=closing')
    expect(parseInboxQuery(etsyClosingHref().slice(etsyClosingHref().indexOf('?'))).query).toMatchObject({ reply: 'closing', channels: ['ETSY'], period: 'all' })
    // "Window closed": the Etsy reviews that needed a reply but whose window ran out.
    expect(etsyClosedHref()).toBe('/marketing/reviews/inbox?period=all&channel=ETSY&reply=closed')
    expect(parseInboxQuery(etsyClosedHref().slice(etsyClosedHref().indexOf('?'))).query).toMatchObject({ reply: 'closed', channels: ['ETSY'], period: 'all' })
    expect(requestsHref({ inserts: 1 })).toBe('/marketing/reviews/requests?inserts=1')
    expect(requestsHref({ preview: true, channel: 'SHOPIFY' })).toBe('/marketing/reviews/requests?channel=SHOPIFY&preview=1')
    expect(ruleHref('rule 1/2')).toBe('/marketing/reviews/requests/rules/rule%201%2F2')
  })

  it('sends Settings to Reviews › Settings, scrolled to a section when asked', () => {
    expect(reviewsSettingsHref()).toBe('/marketing/reviews/settings')
    expect(reviewsSettingsHref(null)).toBe('/marketing/reviews/settings')
    expect(reviewsSettingsHref('automations')).toBe('/marketing/reviews/settings?section=automations')
    expect(reviewsSettingsHref('sources')).toBe('/marketing/reviews/settings?section=sources')
  })
})

describe('old Requests addresses', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  const OLD: Array<[string, string]> = [
    ['/marketing/reviews/inserts', '/marketing/reviews/requests?inserts=1'],
    ['/marketing/reviews/requests/test/preview', '/marketing/reviews/requests?preview=1'],
    ['/orders/reviews/rules/timing', '/marketing/reviews/requests/timing'],
    ['/orders/reviews/rules/send-times', '/marketing/reviews/requests/timing?section=send-hours'],
    ['/orders/reviews/rules', '/marketing/reviews/requests/rules'],
  ]

  it('land for good on the Requests page that does their job, also inside a business', async () => {
    vi.stubEnv('NEXT_PUBLIC_WORKSPACES_ENABLED', '1')
    const redirects = await loadRedirects()
    for (const [source, destination] of OLD) {
      expect(redirects.find((r) => r.source === source && !r.has), source).toMatchObject({ destination, permanent: true })
      expect(redirects.find((r) => r.source === `/w/:workspaceId${source}`)?.destination, source).toBe(`/w/:workspaceId${destination}`)
      expect(isPage(destination), destination).toBe(true)
      expect(isPage(source), `${source} has no page left`).toBe(false)
    }
  })
})

describe('old review pages retired with Reviews › Settings', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  const OLD: Array<[string, string]> = [
    ['/marketing/reviews/advanced', '/marketing/reviews'],
    ['/marketing/reviews/automation', '/marketing/reviews/settings?section=automations'],
    ['/performance/feedback', '/marketing/reviews/inbox?kind=seller'],
  ]

  it('land for good on the page that does their job, also inside a business', async () => {
    vi.stubEnv('NEXT_PUBLIC_WORKSPACES_ENABLED', '1')
    const redirects = await loadRedirects()
    for (const [source, destination] of OLD) {
      expect(redirects.find((r) => r.source === source && !r.has), source).toMatchObject({ destination, permanent: true })
      expect(redirects.find((r) => r.source === `/w/:workspaceId${source}`)?.destination, source).toBe(`/w/:workspaceId${destination}`)
      expect(isPage(destination), destination).toBe(true)
      expect(isPage(source), `${source} has no page left`).toBe(false)
    }
    // The pages read what the old addresses hand them: the Inbox's Seller feedback tab, the Automations section.
    expect(parseInboxQuery('?kind=seller').query.kind).toBe('seller')
    expect(sectionFromSearch('?section=automations')).toBe('automations')
  })
})

describe('old Insights pages retired with PR E', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  const OLD: Array<[string, string, string]> = [
    // [old address, where it lands, an example of the address with a value]
    ['/marketing/reviews/heatmap', '/marketing/reviews/insights/themes', '/marketing/reviews/heatmap'],
    ['/marketing/reviews/by-product', '/marketing/reviews/insights/products', '/marketing/reviews/by-product'],
    ['/marketing/reviews/products/:id', '/marketing/reviews/insights/products?product=:id', '/marketing/reviews/products/product-1'],
    ['/marketing/reviews/spikes', '/marketing/reviews/insights/alerts', '/marketing/reviews/spikes'],
    ['/marketing/reviews/actions', '/marketing/reviews/insights/fixes', '/marketing/reviews/actions'],
    ['/marketing/reviews/spotlight', '/marketing/reviews/insights/brief', '/marketing/reviews/spotlight'],
    ['/marketing/reviews/insights', '/marketing/reviews/insights/themes', '/marketing/reviews/insights'],
  ]

  it('land for good on the Insights page that does their job, also inside a business', async () => {
    vi.stubEnv('NEXT_PUBLIC_WORKSPACES_ENABLED', '1')
    const redirects = await loadRedirects()
    for (const [source, destination, example] of OLD) {
      expect(redirects.find((r) => r.source === source && !r.has), source).toMatchObject({ destination, permanent: true })
      expect(redirects.find((r) => r.source === `/w/:workspaceId${source}`)?.destination, source).toBe(`/w/:workspaceId${destination}`)
      expect(isPage(destination.replace(':id', 'product-1')), destination).toBe(true)
      if (source !== '/marketing/reviews/insights') expect(isPage(example), `${example} has no page left`).toBe(false)
    }
    // The Products page opens the product pop-up from the redirected address.
    expect(parseProductsQuery('?product=product-1').product).toBe('product-1')
  })
})
