/**
 * P2 review 10 — the page-load prefetch adds no credentials of its own (apps/web/CLAUDE.md: `install-fetch.ts` adds the
 * credentials, the CSRF header and `x-nexus-workspace-id`; never by hand). This proves it still carries them: the
 * prefetch is made through the patched `fetch`, exactly like every other read of the page.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules() })

describe('the page-load prefetch goes through the fetch patch', () => {
  it('carries the session credentials and the business profile of the URL', async () => {
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_WORKSPACES_ENABLED', '1')
    const sent: Array<{ url: string; init?: RequestInit }> = []
    vi.stubGlobal('location', { href: 'http://web.test/w/biz_profile_1/products/p1/edit/studio', origin: 'http://web.test', pathname: '/w/biz_profile_1/products/p1/edit/studio' })
    vi.stubGlobal('fetch', (url: RequestInfo | URL, init?: RequestInit) => { sent.push({ url: String(url), init }); return Promise.resolve(new Response('x')) })
    vi.stubGlobal('window', globalThis)

    const { installAuthFetch } = await import('@/lib/auth/install-fetch')
    installAuthFetch()
    const { startPrefetch, clearPrefetches } = await import('./prefetchStore')
    const { masterSheetUrl } = await import('./sheetUrls')
    startPrefetch(masterSheetUrl('p1', 'IT', 'it'))

    expect(sent).toHaveLength(1)
    expect(sent[0].url).toBe('http://web.test/backend/api/products/p1/studio/sheet?market=IT&locale=it')
    expect(sent[0].init?.credentials).toBe('include')
    expect(new Headers(sent[0].init?.headers).get('x-nexus-workspace-id')).toBe('biz_profile_1')
    clearPrefetches()
  })
})
