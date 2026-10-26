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
    expect(ids).toEqual(['reviews', 'requests', 'insights'])
    expect(ids.every(id => /^[a-z0-9-]+$/.test(id))).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
    const groups = nav.buildReviewsNavigation('/marketing/reviews')
    expect(groups.map(group => !!group.collapsible)).toEqual([false, true, true])
  })

  it('keeps the business in native links and marks exactly one row as the page', () => {
    const rows = items('/w/business_a/marketing/reviews/desk')
    expect(rows.find(item => item.label === 'Inbox')).toMatchObject({ href: '/w/business_a/marketing/reviews/desk', active: true })
    expect(rows.find(item => item.label === 'Overview')?.href).toBe('/w/business_a/marketing/reviews')
    expect(rows.find(item => item.label === 'Rules')?.href).toBe('/w/business_a/marketing/reviews/requests/rules')
    expect(rows.find(item => item.label === 'Timing')?.href).toBe('/w/business_a/marketing/reviews/requests/timing')
    expect(rows.filter(item => item.active)).toHaveLength(1)
    expect(items('/marketing/reviews/desk').find(item => item.label === 'Inbox')?.href).toBe('/marketing/reviews/desk')
  })

  it('filters permissions before scoping URLs and drops empty groups', () => {
    const onlyReviews = (permission: string) => permission === 'pages.reviews'
    const groups = nav.buildReviewsNavigation('/w/business_a/marketing/reviews', onlyReviews)
    const labels = groups.flatMap(group => group.items).map(item => item.label)
    expect(labels).toEqual(['Overview', 'Inbox', 'Queue', 'Rules', 'Timing', 'Themes', 'Products', 'Alerts', 'Fixes', 'Brief'])
    expect(groups.every(group => group.items.length > 0)).toBe(true)
    expect(nav.buildReviewsNavigation('/marketing/reviews', () => false)).toEqual([])
    // A row with its own permission (the Settings row PR D adds) needs it as well as the page permission.
    const settings = { label: 'Settings', href: '/marketing/reviews/settings', icon: Settings, permission: 'reviews.manage' }
    expect(nav.reviewsNavItemAllowed(settings, onlyReviews)).toBe(false)
    expect(nav.reviewsNavItemAllowed(settings, p => p === 'pages.reviews' || p === 'reviews.manage')).toBe(true)
  })

  it('keeps nested pages selected without matching similarly named routes', () => {
    expect(active('/w/business_b/marketing/reviews/requests/rules/rule-id')).toEqual(['Rules'])
    expect(active('/marketing/reviews/requests/timing')).toEqual(['Timing'])
    expect(active('/marketing/reviews/requests')).toEqual(['Queue'])
    expect(active('/marketing/reviews')).toEqual(['Overview'])
    expect(active('/marketing/reviews/')).toEqual(['Overview'])
    expect(active('/marketing/reviewsx')).toEqual([])
    expect(active('/marketing/reviews/automation')).toEqual([])
  })

  it('lets each row own the old addresses of its page', () => {
    expect(active('/marketing/reviews/heatmap')).toEqual(['Themes'])
    expect(active('/marketing/reviews/products/product-id')).toEqual(['Products'])
    expect(active('/marketing/reviews/by-product')).toEqual(['Products'])
    expect(active('/marketing/reviews/spikes')).toEqual(['Alerts'])
    expect(active('/marketing/reviews/actions')).toEqual(['Fixes'])
    expect(active('/marketing/reviews/spotlight')).toEqual(['Brief'])
    expect(active('/marketing/reviews/import')).toEqual(['Inbox'])
    expect(active('/marketing/reviews/requests/rules')).toEqual(['Rules'])
    expect(active('/marketing/reviews/requests/rules/new')).toEqual(['Rules'])
    expect(active('/marketing/reviews/requests/rulesx')).toEqual(['Queue'])
    expect(active('/marketing/reviews/advanced')).toEqual(['Overview'])
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
    expect(trail('/marketing/reviews/desk')).toBe('Marketing › Reviews › Inbox*')
    expect(trail('/marketing/reviews/requests')).toBe('Marketing › Reviews › Requests › Queue*')
    expect(trail('/marketing/reviews/heatmap')).toBe('Marketing › Reviews › Insights › Themes*')
    expect(trail('/marketing/reviews/automation')).toBe('Marketing › Reviews')
  })

  it('ends a record page on its list, as a link', () => {
    expect(trail('/marketing/reviews/requests/rules/rule-id')).toBe('Marketing › Reviews › Requests › Rules')
    expect(trail('/marketing/reviews/products/product-id')).toBe('Marketing › Reviews › Insights › Products')
  })

  it('sends a group crumb to the group’s first page', () => {
    const crumbs = model.reviewsCrumbTrail('/marketing/reviews/spikes')
    expect(crumbs.map(c => c.href)).toEqual(['/marketing', '/marketing/reviews', '/marketing/reviews/heatmap', '/marketing/reviews/spikes'])
  })
})
