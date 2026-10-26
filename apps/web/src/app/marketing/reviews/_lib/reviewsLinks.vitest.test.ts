import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  inboxHref,
  insightsHref,
  productReviewsHref,
  requestsHref,
  reviewsSettingsHref,
  ruleHref,
  withQuery,
  type InsightsPage,
} from './reviewsLinks'
import { parseInboxQuery } from '../inbox/inboxQuery'
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
      reviewsSettingsHref(), reviewsSettingsHref('automations'), reviewsSettingsHref('pipeline'),
      productReviewsHref('product-1'),
    ]
    for (const href of hrefs) expect(isPage(href), href).toBe(true)
  })

  it('hands the Inbox every filter it reads; today’s other pages keep only the channel and market', () => {
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
    expect(insightsHref('themes', { channel: 'AMAZON', sort: 'impact' })).toBe('/marketing/reviews/heatmap?channel=AMAZON')
    expect(insightsHref('products', { product: 'a b' })).toBe('/marketing/reviews/products/a%20b')
  })

  it('sends the Requests links to the Queue, its windows and one rule’s editor, filters and all', () => {
    expect(requestsHref()).toBe('/marketing/reviews/requests')
    expect(requestsHref({ status: 'FAILED', channel: 'EBAY', market: 'DE', period: '7d' })).toBe('/marketing/reviews/requests?status=FAILED&channel=EBAY&market=DE')
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
