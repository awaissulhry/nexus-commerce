import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Settings } from 'lucide-react'

let nav: typeof import('./reviews-navigation')
let model: typeof import('./reviews-nav')
beforeAll(async () => {
  vi.stubEnv('NEXT_PUBLIC_WORKSPACES_ENABLED', '1')
  vi.resetModules()
  nav = await import('./reviews-navigation')
  model = await import('./reviews-nav')
})
afterAll(() => vi.unstubAllEnvs())

const items = (path: string, has?: (p: string) => boolean, counts?: { needReply?: number }) =>
  nav.buildReviewsNavigation(path, has, counts).flatMap(group => group.items)
const active = (path: string) => items(path).filter(item => item.active).map(item => item.label)

describe('reviews navigation', () => {
  it('provides unique, whitespace-free IDs for the disclosure labels and their panels', () => {
    const ids = nav.buildReviewsNavigation('/marketing/reviews').map(group => group.id)
    expect(ids).toEqual(['reviews', 'requests', 'insights', 'channels', 'settings'])
    expect(ids.every(id => /^[a-z0-9-]+$/.test(id))).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
    const groups = nav.buildReviewsNavigation('/marketing/reviews')
    expect(groups.map(group => !!group.collapsible)).toEqual([false, true, true, true, false])
    // Settings sits alone at the bottom, under no drawn heading (as the design draws it).
    expect(groups.at(-1)).toMatchObject({ label: 'Reviews settings', hideLabel: true })
    expect(groups.at(-1)?.items.map(item => item.label)).toEqual(['Settings'])
  })

  it('keeps the business in native links and marks exactly one row as the page', () => {
    const rows = items('/w/business_a/marketing/reviews/inbox')
    expect(rows.find(item => item.label === 'Inbox')).toMatchObject({ href: '/w/business_a/marketing/reviews/inbox', active: true })
    expect(rows.find(item => item.label === 'Overview')?.href).toBe('/w/business_a/marketing/reviews')
    expect(rows.find(item => item.label === 'Rules')?.href).toBe('/w/business_a/marketing/reviews/requests/rules')
    expect(rows.find(item => item.label === 'Timing')?.href).toBe('/w/business_a/marketing/reviews/requests/timing')
    expect(rows.find(item => item.label === 'Settings')?.href).toBe('/w/business_a/marketing/reviews/settings')
    expect(rows.filter(item => item.active)).toHaveLength(1)
    expect(items('/marketing/reviews/inbox').find(item => item.label === 'Inbox')?.href).toBe('/marketing/reviews/inbox')
  })

  it('filters permissions before scoping URLs and drops empty groups', () => {
    const onlyReviews = (permission: string) => permission === 'pages.reviews'
    const groups = nav.buildReviewsNavigation('/w/business_a/marketing/reviews', onlyReviews)
    const labels = groups.flatMap(group => group.items).map(item => item.label)
    expect(labels).toEqual(['Overview', 'Inbox', 'Queue', 'Rules', 'Timing', 'Themes', 'Products', 'Alerts', 'Fixes', 'Brief', 'Amazon', 'eBay', 'Shopify', 'Etsy'])
    expect(groups.every(group => group.items.length > 0)).toBe(true)
    expect(nav.buildReviewsNavigation('/marketing/reviews', () => false)).toEqual([])
    // The Settings row needs "Manage reviews" as well as the page permission; without it its group goes too.
    expect(groups.map(group => group.id)).toEqual(['reviews', 'requests', 'insights', 'channels'])
    const manager = (permission: string) => permission === 'pages.reviews' || permission === 'reviews.manage'
    expect(nav.buildReviewsNavigation('/marketing/reviews', manager).flatMap(group => group.items).map(item => item.label).at(-1)).toBe('Settings')
    const settings = model.REVIEWS_NAV.flatMap(group => group.items).find(item => item.label === 'Settings')
    expect(settings).toMatchObject({ href: '/marketing/reviews/settings', icon: Settings, permission: 'reviews.manage' })
    expect(nav.reviewsNavItemAllowed(settings!, onlyReviews)).toBe(false)
    expect(nav.reviewsNavItemAllowed(settings!, manager)).toBe(true)
  })

  it('keeps nested pages selected without matching similarly named routes', () => {
    expect(active('/w/business_b/marketing/reviews/requests/rules/rule-id')).toEqual(['Rules'])
    expect(active('/marketing/reviews/requests/timing')).toEqual(['Timing'])
    expect(active('/marketing/reviews/requests')).toEqual(['Queue'])
    expect(active('/marketing/reviews/inbox')).toEqual(['Inbox'])
    expect(active('/marketing/reviews')).toEqual(['Overview'])
    expect(active('/marketing/reviews/')).toEqual(['Overview'])
    expect(active('/marketing/reviewsx')).toEqual([])
    expect(active('/marketing/reviews/settings')).toEqual(['Settings'])
    expect(active('/w/business_a/marketing/reviews/settings')).toEqual(['Settings'])
  })

  it('lets each row own the old addresses of its page', () => {
    expect(active('/marketing/reviews/insights/themes')).toEqual(['Themes'])
    expect(active('/w/business_a/marketing/reviews/insights/products')).toEqual(['Products'])
    expect(active('/marketing/reviews/insights/alerts')).toEqual(['Alerts'])
    expect(active('/marketing/reviews/insights/fixes')).toEqual(['Fixes'])
    expect(active('/marketing/reviews/insights/brief')).toEqual(['Brief'])
    expect(active('/marketing/reviews/insights/briefx')).toEqual([])
    expect(active('/marketing/reviews/requests/rules')).toEqual(['Rules'])
    expect(active('/marketing/reviews/requests/rules/new')).toEqual(['Rules'])
    expect(active('/marketing/reviews/requests/rulesx')).toEqual(['Queue'])
    // The retired pages redirect (next.config.js): no row keeps a temporary claim on their addresses.
    for (const retired of [
      '/marketing/reviews/desk', '/marketing/reviews/import', '/marketing/reviews/inserts', '/orders/reviews/rules',
      // PR E: the old Insights pages.
      '/marketing/reviews/heatmap', '/marketing/reviews/by-product', '/marketing/reviews/products/product-id',
      '/marketing/reviews/spikes', '/marketing/reviews/actions', '/marketing/reviews/spotlight',
    ]) {
      expect(active(retired)).toEqual([])
    }
    expect(active('/marketing/reviews/advanced')).toEqual(['Overview'])
    // The old Automation page redirects to Settings › Automations.
    expect(active('/marketing/reviews/automation')).toEqual(['Settings'])
  })

  it('lists a row per channel market under Amazon and eBay, and marks the market page itself', () => {
    const markets = { AMAZON: ['IT', 'de', 'GB', 'bad1'], EBAY: ['IT'] }
    const channels = nav.buildReviewsNavigation('/w/business_a/marketing/reviews/amazon/it', undefined, undefined, markets).find(group => group.id === 'channels')!
    expect(channels.items.map(item => item.label)).toEqual(['Amazon', 'Amazon Italy', 'Amazon Germany', 'Amazon United Kingdom', 'eBay', 'eBay Italy', 'Shopify', 'Etsy'])
    expect(channels.items.map(item => item.href)).toEqual([
      '/w/business_a/marketing/reviews/amazon', '/w/business_a/marketing/reviews/amazon/it', '/w/business_a/marketing/reviews/amazon/de',
      '/w/business_a/marketing/reviews/amazon/uk', '/w/business_a/marketing/reviews/ebay', '/w/business_a/marketing/reviews/ebay/it',
      '/w/business_a/marketing/reviews/shopify', '/w/business_a/marketing/reviews/etsy',
    ])
    expect(channels.items.filter(item => item.active).map(item => item.label)).toEqual(['Amazon Italy'])
    const activeWith = (path: string) => nav.buildReviewsNavigation(path, undefined, undefined, markets).flatMap(group => group.items).filter(item => item.active).map(item => item.label)
    expect(activeWith('/marketing/reviews/amazon')).toEqual(['Amazon'])
    expect(activeWith('/marketing/reviews/ebay/it')).toEqual(['eBay Italy'])
    expect(activeWith('/marketing/reviews/amazon/gb')).toEqual(['Amazon United Kingdom'])
    // A market without a row (not sold there yet) keeps its channel's row current; no markets read → the channel rows only.
    expect(activeWith('/marketing/reviews/ebay/de')).toEqual(['eBay'])
    expect(active('/marketing/reviews/amazon/fr')).toEqual(['Amazon'])
    expect(items('/marketing/reviews').filter(item => /^(Amazon|eBay)/.test(item.label)).map(item => item.label)).toEqual(['Amazon', 'eBay'])
  })

  it('shows the needs-a-reply badge on the Inbox only when there is something to reply to', () => {
    const inbox = (needReply?: number) => items('/marketing/reviews', undefined, { needReply }).find(item => item.label === 'Inbox')?.badge
    expect(inbox(12)).toBe('12')
    expect(inbox(1284)).toBe('1,284')
    expect(inbox(0)).toBeUndefined()
    expect(inbox(undefined)).toBeUndefined()
    expect(items('/marketing/reviews', undefined, { needReply: 5 }).filter(item => item.badge != null).map(item => item.label)).toEqual(['Inbox'])
  })
})

describe('reviews crumbs', () => {
  const trail = (path: string) => model.reviewsCrumbTrail(path).map(c => `${c.label}${c.current ? '*' : ''}`).join(' › ')

  it('reads Marketing › Reviews › [group] › page, with the page shown marked', () => {
    expect(trail('/marketing/reviews')).toBe('Marketing › Reviews*')
    expect(trail('/marketing/reviews/inbox')).toBe('Marketing › Reviews › Inbox*')
    expect(trail('/marketing/reviews/requests')).toBe('Marketing › Reviews › Requests › Queue*')
    expect(trail('/marketing/reviews/insights/themes')).toBe('Marketing › Reviews › Insights › Themes*')
    expect(trail('/marketing/reviews/settings')).toBe('Marketing › Reviews › Settings*')
  })

  it('ends a record page on its list, as a link', () => {
    expect(trail('/marketing/reviews/requests/rules/rule-id')).toBe('Marketing › Reviews › Requests › Rules')
  })

  it('Shopify and Etsy are one page each: their row is current there, crumbs end on the channel (PR I)', () => {
    expect(trail('/marketing/reviews/etsy')).toBe('Marketing › Reviews › Etsy*')
    expect(trail('/marketing/reviews/shopify')).toBe('Marketing › Reviews › Shopify*')
    expect(model.findReviewsNavItem('/marketing/reviews/etsy')?.label).toBe('Etsy')
  })

  it('a channel page reads Marketing › Reviews › Amazon › Italy (no "Channels" crumb)', () => {
    expect(trail('/marketing/reviews/amazon')).toBe('Marketing › Reviews › Amazon*')
    expect(trail('/marketing/reviews/amazon/it')).toBe('Marketing › Reviews › Amazon › Italy*')
    expect(trail('/marketing/reviews/ebay/gb')).toBe('Marketing › Reviews › eBay › United Kingdom*')
    expect(model.reviewsCrumbTrail('/marketing/reviews/ebay/de').map(c => c.href)).toEqual(['/marketing', '/marketing/reviews', '/marketing/reviews/ebay', '/marketing/reviews/ebay/de'])
  })

  it('sends a group crumb to the group’s first page', () => {
    const crumbs = model.reviewsCrumbTrail('/marketing/reviews/insights/alerts')
    expect(crumbs.map(c => c.href)).toEqual(['/marketing', '/marketing/reviews', '/marketing/reviews/insights/themes', '/marketing/reviews/insights/alerts'])
  })
})
