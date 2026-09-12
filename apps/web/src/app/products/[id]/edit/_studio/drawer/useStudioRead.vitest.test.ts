/**
 * #307 — the parts of the shared read that can be tested without a renderer.
 *
 * `environment: 'node'` here (see vitest.config.ts): no jsdom, no React plugin, so the HOOK is not
 * exercised — its behaviour was verified in the browser instead (#300/#317, watched fail → pass
 * with the guard as the only variable). What IS pinned here is the 404/501 split, which is the
 * piece three hooks each used to re-decide, and the deadline constant that #284 turns on.
 */
import { describe, expect, it, afterEach, vi } from 'vitest'
import { NotShipped, studioFetch, STUDIO_READ_DEADLINE_MS } from './useStudioRead'

const real = globalThis.fetch
afterEach(() => {
  globalThis.fetch = real
})

function respondWith(status: number) {
  const spy = vi.fn(async (_url: string, _init?: RequestInit) => new Response(status === 204 ? null : '{}', { status }))
  globalThis.fetch = spy as unknown as typeof fetch
  return spy
}

describe('studioFetch — the not-shipped split', () => {
  it('raises NotShipped on 404, the route not being mounted', async () => {
    respondWith(404)
    await expect(studioFetch('http://x/y', new AbortController().signal)).rejects.toBeInstanceOf(NotShipped)
  })

  it('raises NotShipped on 501, the route declaring itself unimplemented', async () => {
    respondWith(501)
    await expect(studioFetch('http://x/y', new AbortController().signal)).rejects.toBeInstanceOf(NotShipped)
  })

  it('does NOT raise on 500 — a failing endpoint is not an absent one', async () => {
    respondWith(500)
    const res = await studioFetch('http://x/y', new AbortController().signal)
    expect(res.status).toBe(500)
  })

  it('returns 400 and 204 for the caller to read — compare treats them as "no listing"', async () => {
    respondWith(400)
    expect((await studioFetch('http://x/y', new AbortController().signal)).status).toBe(400)
    respondWith(204)
    expect((await studioFetch('http://x/y', new AbortController().signal)).status).toBe(204)
  })

  it('returns ok responses untouched', async () => {
    respondWith(200)
    expect((await studioFetch('http://x/y', new AbortController().signal)).ok).toBe(true)
  })

  it('passes the abort signal and no-store through to fetch', async () => {
    const spy = respondWith(200)
    const ctl = new AbortController()
    await studioFetch('http://x/y', ctl.signal)
    const init = spy.mock.calls[0][1]
    expect(init?.signal).toBe(ctl.signal)
    expect(init?.cache).toBe('no-store')
  })

  it('propagates a network rejection rather than converting it to NotShipped', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    await expect(studioFetch('http://x/y', new AbortController().signal)).rejects.not.toBeInstanceOf(NotShipped)
  })
})

describe('the deadline', () => {
  it('is 30s — a read with no ceiling waits as long as the network makes it (#284)', () => {
    expect(STUDIO_READ_DEADLINE_MS).toBe(30_000)
  })
})
