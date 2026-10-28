import { describe, expect, it } from 'vitest'
import { resolveActiveNav } from './app-rail-active'
import { buildAppNav } from './app-nav'

/**
 * The app's own rail rows through the one-current-row rule. The rule's tests moved with it to the design system
 * (`packages/ui/src/patterns/shell/app-rail-active.vitest.test.ts`); these two need the web's `app-nav.ts`.
 */
describe('resolveActiveNav on the app nav', () => {
  it('Listings: the page lights Listings; the menu has no Legacy row since the legacy exit (2026-10-26)', () => {
    const nav = buildAppNav({}, { amazon: true, ebay: true })
    expect(resolveActiveNav(nav, '/listings')).toEqual({ href: '/listings', depth: 1 })
    expect(resolveActiveNav(nav, '/listings/amazon/it')).toEqual({ href: '/listings/amazon/it', depth: 3 })
    const listings = nav.find((item) => item.href === '/listings')
    expect(listings?.children?.map((child) => child.label)).toEqual(['Amazon', 'eBay', 'Shopify', 'Etsy'])
  })

  it('Listings: each store page lights its own row (2026-10-24)', () => {
    const nav = buildAppNav({}, { amazon: true, ebay: true })
    expect(resolveActiveNav(nav, '/listings/amazon')).toEqual({ href: '/listings/amazon', depth: 2 })
    expect(resolveActiveNav(nav, '/listings/ebay/de')).toEqual({ href: '/listings/ebay/de', depth: 3 })
    expect(resolveActiveNav(nav, '/listings/shopify')).toEqual({ href: '/listings/shopify', depth: 2 })
    // A market without its own row lights the store's.
    expect(resolveActiveNav(nav, '/listings/amazon/nl')).toEqual({ href: '/listings/amazon', depth: 2 })
  })
})
