import { beforeAll, afterAll, expect, it, vi } from 'vitest'
let paths: typeof import('./paths')
beforeAll(async () => { vi.stubEnv('NEXT_PUBLIC_WORKSPACES_ENABLED', '1'); vi.resetModules(); paths = await import('./paths') })
afterAll(() => vi.unstubAllEnvs())

it('keeps business context in copied links but personal and public routes independent', () => {
  expect(paths.workspaceHref('business_a', '/products?search=SKU')).toBe('/w/business_a/products?search=SKU')
  for (const path of ['/settings/profile', '/settings/security', '/settings/profiles', '/profiles', '/accept-workspace-invite?token=abc', '/backend/api/products', 'https://example.test/', '//example.test/']) expect(paths.workspaceHref('business_a', path)).toBe(path)
  expect(paths.workspaceHref('business_a', '/w/business_b/products')).toBe('/w/business_b/products')
  expect(paths.workspaceFromPath('/w/business_b/products')).toBe('business_b')
})
it('switches sections without carrying another business’s record ID or account filter', () => {
  expect(paths.workspaceSwitchPath('/w/business_a/products/foreign-id/edit?accountId=foreign')).toBe('/products')
  expect(paths.workspaceSwitchPath('/w/business_a/settings/channels?connectionId=foreign')).toBe('/settings/channels')
  expect(paths.workspaceSwitchPath('/settings/profile')).toBe('/dashboard/overview')
})

// 2026-09-30 — after every sign-in the address read `/profiles?next=%2Fdashboard%2Foverview%3F_rsc%3D…`: the proxy built
// `next` from a client-side navigation, and Next adds `_rsc` to each of those requests.
it('drops Next’s internal `_rsc` from a destination and keeps everything else exactly as written', () => {
  expect(paths.withoutNextInternals('/dashboard/overview?_rsc=TvnZkL2Whu58I-dd')).toBe('/dashboard/overview')
  expect(paths.withoutNextInternals('/products?search=SKU%201&_rsc=abc&sort=price')).toBe('/products?search=SKU%201&sort=price')
  expect(paths.withoutNextInternals('/products?_rsc=abc&tab=a+b#top')).toBe('/products?tab=a+b#top')
  expect(paths.withoutNextInternals('/products?%5Frsc=abc')).toBe('/products')
  // Nothing internal: the very same string, spelling and all.
  for (const href of ['/products', '/products?', '/products?search=a%2Bb&search=c', '/products?rsc=1&x_rsc=2#_rsc', '/products?bad=%E0%A4%A']) {
    expect(paths.withoutNextInternals(href)).toBe(href)
  }
})

it('signs in to a same-site `next` without `_rsc`, and to the dashboard otherwise', () => {
  expect(paths.afterSignInPath('/dashboard/overview?_rsc=TvnZkL2Whu58I-dd')).toBe('/dashboard/overview')
  expect(paths.afterSignInPath('/oauth/authorize?client_id=c&state=s')).toBe('/oauth/authorize?client_id=c&state=s')
  for (const unsafe of [null, undefined, '', 'https://example.test/', '//example.test/', '/\\example.test', 'dashboard']) {
    expect(paths.afterSignInPath(unsafe)).toBe('/dashboard/overview')
  }
})
