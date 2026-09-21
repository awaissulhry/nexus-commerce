/**
 * The public API origin — one accessor, after three readers drifted apart.
 *
 * ## The outage this came from, measured 2026-09-21
 *
 * `NEXUS_PUBLIC_API_URL` held `https://nexus-commerce-api-production.up.railway.app`. That host
 * **resolves** (`69.46.46.126`) and answers **HTTP 404** — a Railway domain with no service behind
 * it — where the live API answers **HTTP 200** on a different host. Every OAuth callback was built
 * from it, and both Shopify and Etsy refused the sign-in:
 *
 *   Shopify: *"The redirect_uri is not whitelisted"*
 *   Etsy:    *"The requested redirect URL is not permitted"*
 *
 * 🔴 **Those refusals were luck.** Had either channel accepted the URL, consent would have
 * succeeded and the operator would have landed on a 404 — nothing connected, and no error
 * anywhere in Nexus, because the failure happens at the channel. Shopify's webhook registration
 * reads the same value, so its subscriptions would have pointed at the dead host and orders would
 * simply never have arrived.
 *
 * ## What these tests hold
 *
 * The rule is now in one place. They do NOT claim the host answers — that is a network fact, and
 * a configuration reader is the wrong place to assert it. What they pin is every way the value can
 * be wrong *on its face*, and that an unset variable falls through to `RAILWAY_PUBLIC_DOMAIN`
 * rather than to an empty string, because an empty string is what produced a host-less
 * `redirect_uri` that said nothing.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { publicApiOrigin, publicApiBaseValue } from './public-api-origin.js'

const LIVE = 'https://nexusapi-production-b7bb.up.railway.app'

/** Clear all three so each case states its own world. */
function only(vars: Record<string, string>) {
  for (const name of ['NEXUS_PUBLIC_API_URL', 'PUBLIC_API_URL', 'RAILWAY_PUBLIC_DOMAIN']) {
    vi.stubEnv(name, vars[name] ?? '')
  }
}

afterEach(() => vi.unstubAllEnvs())

describe('1. which variable wins', () => {
  it('prefers NEXUS_PUBLIC_API_URL', () => {
    only({ NEXUS_PUBLIC_API_URL: LIVE, PUBLIC_API_URL: 'https://second.example', RAILWAY_PUBLIC_DOMAIN: 'third.example' })
    expect(publicApiOrigin()).toEqual({ origin: LIVE })
  })

  it('falls back to PUBLIC_API_URL', () => {
    only({ PUBLIC_API_URL: LIVE, RAILWAY_PUBLIC_DOMAIN: 'third.example' })
    expect(publicApiOrigin()).toEqual({ origin: LIVE })
  })

  it('🔴 falls back to RAILWAY_PUBLIC_DOMAIN — the source the sign-in path used to ignore', () => {
    // The old oauth reader stopped at PUBLIC_API_URL and returned ''. Railway sets this to the
    // host actually serving the deployment, so an unset variable self-heals instead of producing
    // a host-less redirect_uri.
    only({ RAILWAY_PUBLIC_DOMAIN: 'nexusapi-production-b7bb.up.railway.app' })
    expect(publicApiOrigin()).toEqual({ origin: LIVE })
  })

  it('🟢 CONTROL — with nothing set it reports an error naming the variable', () => {
    only({})
    const got = publicApiOrigin()
    expect(got).toHaveProperty('error')
    expect((got as { error: string }).error).toContain('NEXUS_PUBLIC_API_URL')
  })
})

describe('2. the shapes that must not pass', () => {
  it('🔴 refuses plain HTTP — every channel rejects a non-HTTPS callback', () => {
    only({ NEXUS_PUBLIC_API_URL: 'http://nexusapi-production-b7bb.up.railway.app' })
    expect(publicApiOrigin()).toHaveProperty('error')
  })

  it('refuses credentials embedded in the address', () => {
    only({ NEXUS_PUBLIC_API_URL: 'https://user:pass@api.example.test' })
    expect(publicApiOrigin()).toHaveProperty('error')
  })

  it('reports an unparseable value instead of throwing', () => {
    // A throw here would take down whatever asked, including a read-only readiness check.
    only({ NEXUS_PUBLIC_API_URL: 'https://   ' })
    expect(() => publicApiOrigin()).not.toThrow()
    expect(publicApiOrigin()).toHaveProperty('error')
  })

  it.each(['', '   '])('treats %p as unset rather than as an origin', (value) => {
    only({ NEXUS_PUBLIC_API_URL: value, RAILWAY_PUBLIC_DOMAIN: 'nexusapi-production-b7bb.up.railway.app' })
    expect(publicApiOrigin()).toEqual({ origin: LIVE })
  })
})

describe('3. normalisation — the callback is glued straight onto this', () => {
  it('drops a trailing slash, so the callback has no double slash', () => {
    only({ NEXUS_PUBLIC_API_URL: `${LIVE}/` })
    expect(publicApiOrigin()).toEqual({ origin: LIVE })
  })

  it('adds https:// to a bare host', () => {
    only({ NEXUS_PUBLIC_API_URL: 'nexusapi-production-b7bb.up.railway.app' })
    expect(publicApiOrigin()).toEqual({ origin: LIVE })
  })

  it('keeps an explicit port', () => {
    only({ NEXUS_PUBLIC_API_URL: 'https://api.example.test:8443' })
    expect(publicApiOrigin()).toEqual({ origin: 'https://api.example.test:8443' })
  })

  it('🔴 a value that is merely WRONG still passes — and that is honest', () => {
    // The 2026-09-21 host was well-formed HTTPS and simply dead. A configuration reader cannot
    // tell that apart from a good one; only a request can. Asserting otherwise here would be a
    // guard that claims more than it checks.
    only({ NEXUS_PUBLIC_API_URL: 'https://nexus-commerce-api-production.up.railway.app' })
    expect(publicApiOrigin()).toEqual({ origin: 'https://nexus-commerce-api-production.up.railway.app' })
  })
})

describe('4. 🔴 the RAW value keeps what the sign-in guard has to see', () => {
  /**
   * The first version of this module returned `.origin` to every caller. That broke four existing
   * tests in `cx-connect-configuration`, and each was protecting something real. Those cases are
   * restated here against the accessor itself, so the collapse cannot be re-attempted quietly.
   */
  it('🔴 keeps a FRAGMENT, so the callback guard can refuse it', () => {
    // `.origin` discarded this and turned a refused misconfiguration into a silent pass.
    only({ NEXUS_PUBLIC_API_URL: 'https://example.test/#fragment' })
    expect(publicApiBaseValue()).toBe('https://example.test/#fragment')
  })

  it('🔴 keeps http://localhost, which is Shopify local development', () => {
    // A blanket HTTPS rule here killed the explicit, opt-in local callback.
    only({ NEXUS_PUBLIC_API_URL: 'http://localhost:8091' })
    expect(publicApiBaseValue()).toBe('http://localhost:8091')
  })

  it('keeps a path rather than flattening it to the host', () => {
    only({ NEXUS_PUBLIC_API_URL: 'https://example.test/base' })
    expect(publicApiBaseValue()).toBe('https://example.test/base')
  })

  it('🟢 CONTROL — the STRICT reader still refuses both of those', () => {
    // The two policies must stay different. If this ever passes, they have been collapsed again.
    only({ NEXUS_PUBLIC_API_URL: 'http://localhost:8091' })
    expect(publicApiOrigin()).toHaveProperty('error')
    only({ NEXUS_PUBLIC_API_URL: 'https://user:pass@example.test' })
    expect(publicApiOrigin()).toHaveProperty('error')
  })

  it('adds a scheme only when one is missing', () => {
    only({ RAILWAY_PUBLIC_DOMAIN: 'bare.example.test' })
    expect(publicApiBaseValue()).toBe('https://bare.example.test')
    only({ NEXUS_PUBLIC_API_URL: 'http://already.example.test' })
    expect(publicApiBaseValue()).toBe('http://already.example.test')
  })

  it('returns null when nothing is set, so the caller decides what that means', () => {
    only({})
    expect(publicApiBaseValue()).toBeNull()
  })
})
