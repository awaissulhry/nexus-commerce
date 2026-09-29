import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const { apiTarget, backendRewrites, backendHeaders } = require('./backendRewrite.cjs') as {
  apiTarget(env: Record<string, string | undefined>): string
  backendRewrites(env: Record<string, string | undefined>): Array<{ source: string; destination: string }>
  backendHeaders(env: Record<string, string | undefined>): Array<{ source: string; headers: Array<{ key: string; value: string }> }>
}

describe('the /backend API calls are a Vercel external rewrite, not a function (paused-site incident 2026-09-27)', () => {
  const on = { NEXT_PUBLIC_WORKSPACES_ENABLED: '1', NEXUS_API_PROXY_TARGET: 'https://api.example.test/' }
  it('rewrites every API path to the API origin, except the channel-connect callback that keeps its cookie-path fix', () => {
    const [rule] = backendRewrites(on)
    expect(rule.destination).toBe('https://api.example.test/api/:path')
    // Same pattern language as Next's matcher for this case: the named group's own regex decides.
    const pattern = new RegExp(`^/backend/api/${rule.source.match(/:path\((.*)\)$/)![1]}$`)
    for (const path of ['/backend/api/products/p1/media', '/backend/api/listings/events', '/backend/api/cxo/x', '/backend/api/auth/login'])
      expect(pattern.test(path), path).toBe(true)
    for (const path of ['/backend/api/cx', '/backend/api/cx/callback/ebay', '/backend/api/cx/start'])
      expect(pattern.test(path), path).toBe(false)
  })
  it('turns off upstream caching for API answers', () => {
    expect(backendHeaders(on)).toEqual([{ source: '/backend/api/:path*', headers: [{ key: 'x-vercel-enable-rewrite-caching', value: '0' }] }])
  })
  it('does nothing without business profiles (the browser then calls the API directly)', () => {
    expect(backendRewrites({ NEXUS_API_PROXY_TARGET: 'https://api.example.test' })).toEqual([])
    expect(backendHeaders({})).toEqual([])
  })
  it('finds the API the way the function proxy did', () => {
    expect(apiTarget({ NEXUS_API_PROXY_TARGET: 'api.example.test' })).toBe('https://api.example.test')
    expect(apiTarget({ NEXT_PUBLIC_API_URL: 'http://127.0.0.1:8095' })).toBe('http://127.0.0.1:8095')
    expect(apiTarget({})).toBe('https://nexusapi-production-b7bb.up.railway.app')
  })
})

describe('nothing puts a Vercel function back in front of the API', () => {
  it('next.config.js installs the rewrite ahead of the route handler, and the middleware skips /backend', () => {
    const config = readFileSync(new URL('../../../next.config.js', import.meta.url), 'utf8')
    expect(config).toMatch(/beforeFiles:\s*backendRewrites\(process\.env\)/)
    const proxy = readFileSync(new URL('../../proxy.ts', import.meta.url), 'utf8')
    expect(proxy).toMatch(/matcher: \['\/\(\(\?!backend\//)
  })
})

describe('next start keeps a proxied API call open as long as the API needs (web on Railway, 2026-09-29)', () => {
  it('waits longer than the Amazon ZIP may take before its first byte (90 s; Next cuts at 30 s by default)', () => {
    const config = require('../../../next.config.js') as { experimental?: { proxyTimeout?: number } }
    expect(config.experimental?.proxyTimeout).toBeGreaterThan(90_000)
  })
  it('lets a proxied upload through whole up to the largest one the app sends (a 500 MB Content Hub ZIP)', () => {
    const config = require('../../../next.config.js') as { experimental?: { proxyClientMaxBodySize?: string } }
    const [, size, unit] = /^(\d+)(mb|gb)$/i.exec(config.experimental?.proxyClientMaxBodySize ?? '') ?? []
    expect(Number(size) * (unit?.toLowerCase() === 'gb' ? 1024 : 1)).toBeGreaterThanOrEqual(500)
  })
})
