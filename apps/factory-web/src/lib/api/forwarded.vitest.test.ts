import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NO_TRUSTED_PROXIES, trustedProxies } from '@nexus/factory-domain/core/client-address'
import { config, proxy } from '../../proxy'
import { forgetWebTrustedProxies, FORWARDED_FOR, forwardedForOf, readWebTrustedProxies, RECEIVED_FORWARDED_FOR, webTrustedProxies, withReceivedForwardedForAside } from './forwarded'

// B-W2b-F57. Made-up addresses: documentation ranges for browsers, private ones for the edge.
const BROWSER = '198.51.100.7'
const EDGE = '100.64.3.4'

afterEach(() => {
  vi.unstubAllEnvs()
  forgetWebTrustedProxies()
})

describe('the edges in front of the web (FACTORY_TRUSTED_PROXIES)', () => {
  it('trusts nobody when unset off Railway (a browser talks to next dev itself)', () => {
    expect(readWebTrustedProxies(undefined, undefined)).toBe(NO_TRUSTED_PROXIES)
    expect(readWebTrustedProxies('', '')).toBe(NO_TRUSTED_PROXIES)
    expect(readWebTrustedProxies('private', undefined).has(EDGE)).toBe(true)
  })

  it('refuses a list that is not valid, in words, and needs one on Railway', () => {
    expect(() => readWebTrustedProxies('*', undefined)).toThrow(/FACTORY_TRUSTED_PROXIES is not valid: "\*" is not an address/)
    expect(() => readWebTrustedProxies('0.0.0.0/0', undefined)).toThrow(/never "trust everything"/)
    expect(() => readWebTrustedProxies(undefined, 'production')).toThrow(/FACTORY_TRUSTED_PROXIES is not set: on Railway .*\(`private`\), or `none`/)
    expect(() => readWebTrustedProxies('  ', 'production')).toThrow(/is not set/)
    expect(readWebTrustedProxies('none', 'production')).toBe(NO_TRUSTED_PROXIES)
  })

  it('reads the environment once', () => {
    vi.stubEnv('FACTORY_TRUSTED_PROXIES', 'private')
    expect(webTrustedProxies().description).toBe('private')
    vi.stubEnv('FACTORY_TRUSTED_PROXIES', 'loopback')
    expect(webTrustedProxies().description).toBe('private')
    forgetWebTrustedProxies()
    expect(webTrustedProxies().description).toBe('loopback')
  })
})

describe('the X-Forwarded-For the web sends to the API', () => {
  const after = (received: string | null, peer: string | null) => {
    const headers = new Headers()
    if (received !== null) headers.set(RECEIVED_FORWARDED_FOR, received)
    if (peer !== null) headers.set(FORWARDED_FOR, peer)
    return headers
  }

  it('drops what a browser wrote itself and sends its own address', () => {
    expect(forwardedForOf(after('192.0.2.1', BROWSER), NO_TRUSTED_PROXIES)).toBe(BROWSER)
    expect(forwardedForOf(after('192.0.2.1', '::ffff:198.51.100.7'), trustedProxies('private'))).toBe(BROWSER)
    expect(forwardedForOf(after(null, '::1'), NO_TRUSTED_PROXIES)).toBe('::1')
  })

  it('appends the edge to the chain a trusted edge sent (Railway: browser → edge → web)', () => {
    expect(forwardedForOf(after(BROWSER, EDGE), trustedProxies('private'))).toBe(`${BROWSER}, ${EDGE}`)
    expect(forwardedForOf(after(`192.0.2.1, ${BROWSER}`, EDGE), trustedProxies('private'))).toBe(`192.0.2.1, ${BROWSER}, ${EDGE}`)
  })

  it('sends nothing when the peer is unknown (the API then sees the web)', () => {
    expect(forwardedForOf(after(BROWSER, null), trustedProxies('private'))).toBeNull()
    expect(forwardedForOf(after(BROWSER, `${BROWSER}, ${EDGE}`), trustedProxies('private'))).toBeNull()
  })

  it('reads the web environment by default', () => {
    vi.stubEnv('FACTORY_TRUSTED_PROXIES', 'private')
    expect(forwardedForOf(after(BROWSER, EDGE))).toBe(`${BROWSER}, ${EDGE}`)
  })
})

describe('src/proxy.ts sets the received header aside on every request', () => {
  it('moves X-Forwarded-For aside and drops a browser copy of the aside header', () => {
    const moved = withReceivedForwardedForAside(new Headers({ [FORWARDED_FOR]: BROWSER, [RECEIVED_FORWARDED_FOR]: '192.0.2.66', cookie: 'a=b' }))
    expect(moved.get(FORWARDED_FOR)).toBeNull()
    expect(moved.get(RECEIVED_FORWARDED_FOR)).toBe(BROWSER)
    expect(moved.get('cookie')).toBe('a=b')
    const none = withReceivedForwardedForAside(new Headers({ [RECEIVED_FORWARDED_FOR]: '192.0.2.66' }))
    expect(none.get(RECEIVED_FORWARDED_FOR)).toBeNull()
    expect(none.get(FORWARDED_FOR)).toBeNull()
  })

  it('hands Next.js the request headers to use (the received X-Forwarded-For gone)', async () => {
    const { NextRequest } = await import('next/server')
    const answer = proxy(new NextRequest('http://localhost:3200/api/auth/office/me', { headers: { [FORWARDED_FOR]: '192.0.2.66' } }))
    expect(answer.headers.get('x-middleware-next')).toBe('1')
    expect(answer.headers.get(`x-middleware-request-${RECEIVED_FORWARDED_FOR}`)).toBe('192.0.2.66')
    expect(answer.headers.get('x-middleware-override-headers')?.split(',')).not.toContain(FORWARDED_FOR)
  })

  it('runs on the /api proxy and every page, never on Next.js static files', () => {
    const matcher = new RegExp(`^${config.matcher[0]}$`)
    for (const path of ['/api/auth/office/me', '/api/live', '/w/SCA/home', '/floor/me', '/portal/home', '/sign-in', '/']) expect(matcher.test(path), path).toBe(true)
    for (const path of ['/_next/static/chunks/app.js', '/_next/image', '/favicon.ico']) expect(matcher.test(path), path).toBe(false)
  })

  it('relies on Next.js writing the TCP peer into x-forwarded-for when a request has none (next/dist/server/base-server.js)', () => {
    // A Next.js upgrade that stops doing so fails here: the web would then send the peer it cannot know.
    const source = readFileSync(createRequire(import.meta.url).resolve('next/dist/server/base-server.js'), 'utf8')
    expect(source).toMatch(/req\.headers\['x-forwarded-for'\] \?\?= originalRequest == null \? void 0 : \(_originalRequest_socket1 = originalRequest\.socket\) == null \? void 0 : _originalRequest_socket1\.remoteAddress;/)
  })
})
