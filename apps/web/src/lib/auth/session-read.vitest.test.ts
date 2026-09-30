/**
 * P2 (2026-09-30, I4-2) — the session read no longer puts `/auth/csrf` in front of `/auth/me`, and the product studio
 * draws while the session is read (its reads are refused by the API without one anyway).
 */
import { describe, expect, it } from 'vitest'
import { readSession, rendersBeforeSession } from './session-read'

/** A fetch whose answers are released by the test, recording the order requests start in. */
function heldFetch() {
  const started: string[] = []
  const release = new Map<string, (response: Response) => void>()
  const doFetch = (url: string) => {
    started.push(url.replace(/^.*\/api/, '/api'))
    return new Promise<Response>((resolve) => release.set(url.replace(/^.*\/api/, '/api'), resolve))
  }
  return { started, release, doFetch }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('readSession', () => {
  it('starts the CSRF read and the session read together, not one after the other', async () => {
    const held = heldFetch()
    const answer = readSession('http://web.test/backend', held.doFetch)
    await Promise.resolve()
    // Neither has answered yet, and both are on the wire.
    expect(held.started).toEqual(['/api/auth/csrf', '/api/auth/me'])
    held.release.get('/api/auth/me')!(json({ user: { id: 'u1' }, permissions: ['products.edit'] }))
    held.release.get('/api/auth/csrf')!(json({ csrfToken: 't1' }))
    await expect(answer).resolves.toEqual({ csrfToken: 't1', me: { user: { id: 'u1' }, permissions: ['products.edit'] } })
  })

  it('a failed CSRF read never costs the session, and a refused session is no session', async () => {
    const failingCsrf = (url: string) => url.endsWith('/csrf') ? Promise.reject(new TypeError('offline')) : Promise.resolve(json({ user: { id: 'u1' } }))
    await expect(readSession('', failingCsrf)).resolves.toEqual({ csrfToken: null, me: { user: { id: 'u1' } } })
    const anonymous = (url: string) => Promise.resolve(url.endsWith('/csrf') ? json({ csrfToken: 't2' }) : json({ error: 'unauthenticated' }, 401))
    await expect(readSession('', anonymous)).resolves.toEqual({ csrfToken: 't2', me: null })
  })
})

describe('rendersBeforeSession', () => {
  it('lets only the product studio draw while the session is read', () => {
    expect(rendersBeforeSession('/products/prod-family-1/edit/studio')).toBe(true)
    expect(rendersBeforeSession('/products/abc/edit/studio/')).toBe(true)
    expect(rendersBeforeSession('/products/abc/edit')).toBe(false)
    expect(rendersBeforeSession('/products')).toBe(false)
    expect(rendersBeforeSession('/settings/team')).toBe(false)
    expect(rendersBeforeSession('/products/abc/edit/studio-old')).toBe(false)
  })
})
