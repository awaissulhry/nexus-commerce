import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { PUBLIC_PREFIXES } from './lib/auth/public-paths'

let proxy: typeof import('./proxy').proxy
beforeAll(async () => { vi.stubEnv('NEXT_PUBLIC_WORKSPACES_ENABLED', '1'); vi.resetModules(); proxy = (await import('./proxy')).proxy })
afterAll(() => vi.unstubAllEnvs())

const at = (path: string) => proxy(new NextRequest(`https://web.example.test${path}`))

it('sends a business page with no profile in its URL to the profile picker (the control: a redirect is visible)', () => {
  const response = at('/settings/channels')
  expect(response.status).toBe(307)
  expect(new URL(response.headers.get('location')!).pathname).toBe('/profiles')
})

// 2026-09-16 — eBay returns the seller here with `code` + `state`. With profiles on, the proxy sent it
// to the profile picker, the code was dropped, and no eBay account could be connected.
it('lets eBay’s return page through with its code and state', () => {
  const response = at('/settings/channels/ebay-callback?code=c&state=s')
  expect(response.headers.get('location')).toBeNull()
  expect(response.headers.get('x-middleware-next')).toBe('1')
})

it('never sends a page reachable without a session to the profile picker', () => {
  expect(PUBLIC_PREFIXES.length).toBeGreaterThan(0)
  for (const prefix of PUBLIC_PREFIXES) {
    const path = prefix.endsWith('/') ? `${prefix}probe` : prefix
    expect(at(path).headers.get('location'), path).toBeNull()
  }
})
