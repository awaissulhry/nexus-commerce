import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
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

const APP = fileURLToPath(new URL('../../..', import.meta.url))

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

  it('points every link at a page that exists today', () => {
    const pages: InsightsPage[] = ['themes', 'products', 'alerts', 'fixes', 'brief']
    const hrefs = [
      inboxHref(), inboxHref({ import: 1 }), inboxHref({ channel: 'EBAY', market: 'DE', stars: [1] }),
      requestsHref(), requestsHref({ inserts: 1 }), requestsHref({ preview: true }),
      ruleHref('rule-1'),
      ...pages.map(page => insightsHref(page)),
      insightsHref('products', { product: 'product-1' }),
      reviewsSettingsHref(), reviewsSettingsHref('automations'),
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
    expect(insightsHref('themes', { channel: 'AMAZON', sort: 'impact' })).toBe('/marketing/reviews/heatmap?channel=AMAZON')
    expect(insightsHref('products', { product: 'a b' })).toBe('/marketing/reviews/products/a%20b')
  })

  it('sends Settings to Settings › Channels until the Reviews settings page exists', () => {
    expect(reviewsSettingsHref('sources')).toBe('/settings/channels')
  })
})
