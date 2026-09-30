import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest'

// 2026-09-30 — the picker ignored `next`: a link without a business in its URL (a bookmark, a copied link) sent the
// person to the picker with `next`, and "Open profile" always went to the dashboard.
let paths: typeof import('./paths')
beforeAll(async () => { vi.stubEnv('NEXT_PUBLIC_WORKSPACES_ENABLED', '1'); vi.resetModules(); paths = await import('./paths') })
afterAll(() => vi.unstubAllEnvs())

describe('"Open profile" takes the person to the page they asked for, inside the chosen business', () => {
  it('keeps the page, its query and its hash', () => {
    expect(paths.profileEntryHref('business_a', '/products?search=GALE')).toBe('/w/business_a/products?search=GALE')
    expect(paths.profileEntryHref('business_a', '/settings/team#roles')).toBe('/w/business_a/settings/team#roles')
    expect(paths.profileEntryHref('business_a', '/products/p1/edit/studio')).toBe('/w/business_a/products/p1/edit/studio')
  })

  it('opens the chosen business even when `next` names another one', () => {
    expect(paths.profileEntryHref('business_a', '/w/business_b/orders?status=open')).toBe('/w/business_a/orders?status=open')
  })

  it('drops Next internals while keeping the requested page, real query and hash', () => {
    expect(paths.profileEntryHref('business_a', '/w/business_b/products?_rsc=cache&search=blue%20shirt#details'))
      .toBe('/w/business_a/products?search=blue%20shirt#details')
    expect(paths.profileEntryHref('business_a', '/orders?_rsc=cache#open'))
      .toBe('/w/business_a/orders#open')
  })

  it('goes to the dashboard when there is no page to go to', () => {
    for (const next of [null, undefined, '', '/', '/w/business_b', '/w/business_b?x=1']) {
      expect(paths.profileEntryHref('business_a', next), String(next)).toBe('/w/business_a/dashboard/overview')
    }
  })

  it('never follows another site, a backslash trick, or a page outside any business', () => {
    for (const next of ['https://example.test/products', '//example.test/products', '/\\example.test', 'products',
      '/profiles?next=%2Fproducts', '/login', '/settings/security', '/api/products', '/backend/api/products', '/_next/static/x.js']) {
      expect(paths.profileEntryHref('business_a', next), next).toBe('/w/business_a/dashboard/overview')
    }
  })
})
