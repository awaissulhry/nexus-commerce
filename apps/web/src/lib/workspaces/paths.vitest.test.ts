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
