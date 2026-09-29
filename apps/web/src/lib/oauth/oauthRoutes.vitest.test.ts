/**
 * MCP.5 — what the web app adds for connecting Claude: the metadata rewrite to the API, and the
 * consent page's headers (never framed, never leaked through the referrer).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { oauthHeaders, oauthRewrites } from './oauthRoutes.cjs'
import { isPublicPath } from '../auth/public-paths'
import { isIdentityPath } from '../workspaces/paths'

let proxy: typeof import('../../proxy').proxy
let matcher: string
beforeAll(async () => {
  vi.stubEnv('NEXT_PUBLIC_WORKSPACES_ENABLED', '1')
  vi.resetModules()
  const mod = await import('../../proxy')
  proxy = mod.proxy
  matcher = mod.config.matcher[0]!
})
afterAll(() => vi.unstubAllEnvs())

describe('MCP.5 — the web side of connecting Claude', () => {
  it('serves the issuer metadata from the API, whatever the business-profile switch says', () => {
    expect(oauthRewrites({ NEXT_PUBLIC_API_URL: 'https://api.example.test/' })).toEqual([
      { source: '/.well-known/oauth-authorization-server', destination: 'https://api.example.test/api/oauth/metadata' },
    ])
  })

  it('the consent page may not be framed, or leak its query through the referrer', () => {
    const [rule] = oauthHeaders()
    expect(rule!.source).toBe('/oauth/:path*')
    const headers = Object.fromEntries(rule!.headers.map((h: { key: string; value: string }) => [h.key, h.value]))
    expect(headers).toEqual({
      'Content-Security-Policy': "frame-ancestors 'none'",
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    })
  })

  it('the consent page needs no business profile and keeps its whole query', () => {
    expect(isPublicPath('/oauth/authorize')).toBe(true)
    expect(isIdentityPath('/oauth/authorize')).toBe(true)
    const response = proxy(new NextRequest('https://web.example.test/oauth/authorize?client_id=x&state=s'))
    expect(response.status).toBe(200)
    expect(response.headers.get('location')).toBeNull()
  })

  it('the proxy leaves /.well-known alone, so the rewrite reaches the API', () => {
    const matches = (path: string) => new RegExp(`^${matcher}$`).test(path)
    expect(matches('/.well-known/oauth-authorization-server')).toBe(false)
    expect(matches('/oauth/authorize')).toBe(true)
    expect(matches('/settings/channels')).toBe(true)
  })
})
