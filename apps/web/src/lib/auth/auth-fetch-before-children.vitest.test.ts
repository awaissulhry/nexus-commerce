/**
 * 2026-09-30 — the session travels on a child's FIRST call, even when that call is made from the child's own mount
 * effect.
 *
 * `installAuthFetch` (the wrapper that adds `credentials: 'include'` to every API call) used to be installed only in
 * `AuthProvider`'s mount effect. React runs a child's effects before its parent's, so the notifications bell's first
 * poll left on the plain `fetch`, without the session cookie, and came back 401 (measured on a private stack with
 * enforce off: the poll at mount carried no cookie; the one 30 s later carried `nexus_session`).
 *
 * This workspace's vitest has no DOM, so the order is modelled, not simulated by React: the page is rendered with
 * `renderToStaticMarkup` (the render phase runs; no effect runs at all), and the child's mount effect is queued in
 * its render and run afterwards — before any parent effect, which is React's own order. `AuthProvider`'s effect never
 * runs here, which is the strictest form of "the child's effect runs first".
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/workspaces/navigation', () => ({
  usePathname: () => '/products',
  useRouter: () => ({ replace: () => undefined, push: () => undefined }),
}))

const API = 'http://127.0.0.1:8130'
const WEB = 'http://127.0.0.1:3130'
let sent: Array<{ url: string; init: RequestInit | undefined }> = []
let mountEffects: Array<() => Promise<unknown>> = []

/** As `NotificationsBell`: its first poll is made from its own mount effect. */
function Bell() {
  mountEffects.push(() => window.fetch(`${API}/api/notifications?limit=30`, { cache: 'no-store' }))
  return null
}

async function renderPage() {
  const { AuthProvider } = await import('./AuthProvider')
  renderToStaticMarkup(createElement(AuthProvider, null, createElement(Bell)))
  for (const effect of mountEffects) await effect()
}

beforeEach(() => {
  vi.resetModules()                                  // a fresh `installed` flag in install-fetch per test
  vi.stubEnv('NEXT_PUBLIC_API_URL', API)
  vi.stubEnv('NEXT_PUBLIC_AUTH_ENFORCE', '')         // enforce OFF: children render while auth loads
  vi.stubEnv('NEXT_PUBLIC_WORKSPACES_ENABLED', '')
  sent = []; mountEffects = []
  vi.stubGlobal('window', {
    fetch: vi.fn(async (url: string, init?: RequestInit) => { sent.push({ url: String(url), init }); return new Response('{}') }),
    location: { href: `${WEB}/products`, origin: WEB, pathname: '/products' },
  })
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('the auth fetch wrapper is in place before any child can fetch', () => {
  it('🔴 a child fetching in its own mount effect sends the session on its FIRST call', async () => {
    await renderPage()
    expect(sent).toHaveLength(1)
    expect(sent[0].url).toBe(`${API}/api/notifications?limit=30`)
    expect(sent[0].init).toMatchObject({ credentials: 'include', cache: 'no-store' })
  })

  it('it is installed once, however often the provider renders (idempotent)', async () => {
    const { AuthProvider } = await import('./AuthProvider')
    renderToStaticMarkup(createElement(AuthProvider, null, null))
    const wrapped = window.fetch
    renderToStaticMarkup(createElement(AuthProvider, null, null))
    expect(window.fetch).toBe(wrapped)
    await window.fetch(`${API}/api/auth/me`)
    expect(sent).toHaveLength(1)                     // one wrapper, one underlying call — not a wrapper around a wrapper
  })

  it('a call to another origin is left exactly as it was', async () => {
    const { AuthProvider } = await import('./AuthProvider')
    renderToStaticMarkup(createElement(AuthProvider, null, null))
    await window.fetch('https://fonts.example.test/a.woff2', { cache: 'force-cache' })
    expect(sent[0].init).toEqual({ cache: 'force-cache' })
  })

  it('on the server (no window) the provider renders and installs nothing', async () => {
    vi.unstubAllGlobals()
    const { AuthProvider } = await import('./AuthProvider')
    expect(() => renderToStaticMarkup(createElement(AuthProvider, null, createElement('span', null, 'page')))).not.toThrow()
    expect(renderToStaticMarkup(createElement(AuthProvider, null, createElement('span', null, 'page')))).toBe('<span>page</span>')
  })
})
