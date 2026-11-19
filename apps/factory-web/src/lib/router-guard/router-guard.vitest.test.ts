import { afterEach, describe, expect, it, vi } from 'vitest'
import { installRouterGuard, isRouterRequest, routerTarget, RouterGuardState, STUCK_COUNT, STUCK_HOLD_MS, STUCK_WINDOW_MS, WEB_BUILD_HEADER, webBuildOf, type WebBuild } from './guard'

/**
 * fx-12 (the customer page that reloaded itself, 2026-11-19): a tab of the build (`next start`) left open while the server
 * switched to `next dev` asked the four tabs of the strip ~480 times each (Next's `useOffline` took every answer it could not read
 * as "offline", heard the server answer its check, and asked again at once). The guard stops the router's requests of such a tab
 * as an abort (what Next never takes as offline: a navigation becomes a full page load, a prefetch waits) and any router stuck on
 * one address the same way.
 */

const ORIGIN = 'http://localhost:3300'
const PAGE = '/w/SCA/sales/customers/0198c1f4-cd00-7aeb-8a59-6c9b65bbe2b2?tab=work'
const router = { headers: { rsc: '1', 'next-router-prefetch': '1' } }

/** A window with a fetch that answers as a server of `served` (null: no header), counting what reached the network. */
function fakeWindow(served: WebBuild | null) {
  const sent: string[] = []
  const fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0]) => {
    sent.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    return new Response('0:{}', { headers: served ? { [WEB_BUILD_HEADER]: served } : {} })
  })
  const win = { fetch: fetch as unknown as typeof globalThis.fetch, location: { origin: ORIGIN } as Location }
  return { win, sent, fetch }
}

describe('fx-12 — the router guard', () => {
  afterEach(() => vi.restoreAllMocks())

  it('knows the build of its own code and the router’s requests (rsc: 1), nothing else', () => {
    expect(webBuildOf('production')).toBe('build')
    expect(webBuildOf('development')).toBe('dev')
    expect(webBuildOf(undefined)).toBe('dev')
    expect(isRouterRequest(PAGE, { headers: { rsc: '1' } })).toBe(true)
    expect(isRouterRequest(PAGE, { method: 'HEAD', headers: new Headers({ RSC: '1' }) })).toBe(true)
    expect(isRouterRequest(new Request(`${ORIGIN}${PAGE}`, { headers: { rsc: '1' } }))).toBe(true)
    expect(isRouterRequest('/api/parties/1')).toBe(false)
    expect(isRouterRequest('/api/parties/1', { headers: { accept: 'application/json' } })).toBe(false)
  })

  it('names the address a request is about without the router’s cache term', () => {
    expect(routerTarget(`${PAGE}&_rsc=1x2y`, ORIGIN)).toBe(PAGE)
    expect(routerTarget(new URL(`${ORIGIN}${PAGE}&_rsc=abc`), ORIGIN)).toBe(PAGE)
  })

  it('passes every request while the server is of this build: the same answers, nothing refused', async () => {
    const { win, sent } = fakeWindow('dev')
    installRouterGuard(win, 'dev')
    const answer = await win.fetch(PAGE, router)
    expect(answer.headers.get(WEB_BUILD_HEADER)).toBe('dev')
    expect((await win.fetch('/api/parties/1')).ok).toBe(true)
    expect(sent).toHaveLength(2)
  })

  it('a server of the other build: its answer never reaches the router, every later router request is refused before the network', async () => {
    // The Owner's tab: the build's code (`next start`), the dev server under it.
    const { win, sent } = fakeWindow('dev')
    installRouterGuard(win, 'build')
    await expect(win.fetch(PAGE, router)).rejects.toMatchObject({ name: 'AbortError' })
    expect(sent).toHaveLength(1)
    for (let round = 0; round < 50; round++) await expect(win.fetch(`${PAGE}&_rsc=${round}`, { method: 'HEAD', headers: { rsc: '1' } })).rejects.toMatchObject({ name: 'AbortError' })
    expect(sent).toHaveLength(1)
    // The API is not the router's: it passes.
    expect((await win.fetch('/api/parties/1')).ok).toBe(true)
    expect(sent).toHaveLength(2)
  })

  it('an answer that names no build (an older server) is the router’s as before', async () => {
    const { win, sent } = fakeWindow(null)
    installRouterGuard(win, 'build')
    expect((await win.fetch(PAGE, router)).ok).toBe(true)
    expect((await win.fetch(PAGE, router)).ok).toBe(true)
    expect(sent).toHaveLength(2)
  })

  it('a router stuck on one address: refused after STUCK_COUNT asks in the window, for STUCK_HOLD_MS, then sent again', () => {
    const state = new RouterGuardState('dev')
    let now = 1_000_000
    for (let ask = 1; ask < STUCK_COUNT; ask++) {
      expect(state.before(PAGE, now)).toEqual({ kind: 'send' })
      now += 50
    }
    expect(state.before(PAGE, now)).toEqual({ kind: 'refuse', why: 'stuck' })
    // Another address is not held.
    expect(state.before('/w/SCA/sales/orders', now)).toEqual({ kind: 'send' })
    expect(state.before(PAGE, now + STUCK_HOLD_MS - 1)).toEqual({ kind: 'refuse', why: 'stuck' })
    expect(state.before(PAGE, now + STUCK_HOLD_MS)).toEqual({ kind: 'send' })
  })

  it('a page that asks an address now and then is never held (asks spread over more than the window)', () => {
    const state = new RouterGuardState('build')
    let now = 0
    for (let ask = 0; ask < 10 * STUCK_COUNT; ask++) {
      expect(state.before(PAGE, now)).toEqual({ kind: 'send' })
      now += STUCK_WINDOW_MS / (STUCK_COUNT - 2)
    }
  })

  it('the stuck rule through fetch: the network sees at most STUCK_COUNT − 1 asks of one address in the window', async () => {
    const { win, sent } = fakeWindow('dev')
    let now = 0
    installRouterGuard(win, 'dev', () => now)
    const results = []
    for (let ask = 0; ask < 500; ask++) {
      results.push(await win.fetch(PAGE, router).then(() => 'sent', (error: DOMException) => error.name))
      now += 40 // 25 asks a second: the loop the Owner's tab ran
    }
    expect(sent.length).toBeLessThan(STUCK_COUNT)
    expect(results.filter((one) => one === 'AbortError')).toHaveLength(500 - sent.length)
  })

  it('installs once (a second install keeps the first) and undoes to the window’s own fetch', async () => {
    const { win, fetch } = fakeWindow('dev')
    const undo = installRouterGuard(win, 'dev')
    const guarded = win.fetch
    installRouterGuard(win, 'dev')
    expect(win.fetch).toBe(guarded)
    undo()
    expect(win.fetch).toBe(fetch)
  })
})

describe('fx-12 — next.config.ts names the build on every answer', () => {
  const configFor = async (phase: string) => (await import('../../../next.config')).default(phase)
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('`dev` under next dev, `build` for next build (the routes manifest next start serves)', async () => {
    vi.stubEnv('FACTORY_API_URL', 'http://127.0.0.1:8190')
    const header = async (phase: string) => {
      const rules = (await (await configFor(phase)).headers?.()) ?? []
      expect(rules).toEqual([{ source: '/:path*', headers: [{ key: WEB_BUILD_HEADER, value: expect.any(String) }] }])
      return rules[0]!.headers[0]!.value
    }
    expect(await header('phase-development-server')).toBe('dev')
    expect(await header('phase-production-build')).toBe('build')
  })
})
