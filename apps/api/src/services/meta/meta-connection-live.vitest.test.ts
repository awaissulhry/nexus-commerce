/**
 * Live-probe fix ACC-038 (2026-10-26) — meta-connection view app. Meta answered the app token (#102) "A user access token is
 * required to request this resource" on `<app>/authorized_adaccounts`, so that read goes with the business's SYSTEM-USER
 * token (the roles stay with the app token); an ad account another business in Nexus uses is its id and the flag only; the
 * app's connected client businesses are not read at all (Meta's v26 reference offers no read, and Meta refused it, #3):
 * the answer says so in words. Every call is one the real gateway lets through. Meta and the database are stubbed; made-up
 * ids only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Call = { operation: string; path: string; query?: Record<string, unknown>; auth?: unknown }
const h = vi.hoisted(() => ({ calls: [] as Call[], answer: null as null | ((c: Call) => unknown), taken: [] as Array<{ id: string }> }))
vi.mock('../../db.js', () => ({ default: { $queryRaw: vi.fn(async () => h.taken) } }))
vi.mock('../cx/token.service.js', () => ({ metaAppIdOf: vi.fn(async () => '1234567'), getAccessToken: vi.fn(async () => 'token') }))
vi.mock('../gateway/meta.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../gateway/meta.js')>()),
  metaCall: vi.fn(async (req: Call) => {
    h.calls.push({ operation: req.operation, path: req.path, query: req.query, auth: req.auth })
    const body = h.answer?.(req) ?? { data: [] }
    return { ok: true, status: 200, headers: {}, verdict: null, json: () => body }
  }),
}))

import { CLIENT_BUSINESSES_NOT_READ, liveApp } from './meta-connection-live.js'
import { metaUrl } from '../gateway/meta.js'
import { metaCallVerdict } from '../gateway/meta-calls.js'

beforeEach(() => { h.calls = []; h.answer = null; h.taken = [] })

describe('meta-connection view app', () => {
  it('reads the authorised ad accounts with the system-user token (ACC-038), the roles with the app token, and no client businesses', async () => {
    h.answer = (c) => (c.path.endsWith('/roles') ? { data: [{ user: '100000000000001', role: 'administrators' }] }
      : { data: [{ account_id: '1234567890', name: 'Shop A ads' }, { id: 'act_1234567891', account_id: '1234567891', name: 'Shop B ads' }] })
    h.taken = [{ id: '1234567891' }]
    const app = await liveApp('conn-1', '9876543210')
    expect(h.calls).toEqual([
      { operation: 'app.roles', path: '1234567/roles', query: { limit: 100 }, auth: 'app' },
      { operation: 'app.authorizedAdAccounts', path: '1234567/authorized_adaccounts', query: { business: '9876543210', fields: 'account_id,name', limit: 100 }, auth: 'account' },
    ])
    expect(app.authorizedAdAccounts).toEqual({
      items: [{ adAccountId: '1234567890', name: 'Shop A ads', takenByAnotherBusiness: false }, { adAccountId: '1234567891', takenByAnotherBusiness: true }],
      error: null,
    })
    expect(JSON.stringify(app)).not.toContain('Shop B')
    expect(app.clientBusinesses).toEqual({ items: null, error: CLIENT_BUSINESSES_NOT_READ })
    expect(CLIENT_BUSINESSES_NOT_READ).toMatch(/You can't perform this operation on this endpoint.*#3/)
    // Each call as the real gateway judges it, with the token it asks for.
    for (const c of h.calls) expect(metaCallVerdict({ method: 'GET', url: metaUrl(c.path, c.query as never), kind: 'read', auth: c.auth }).problem, c.operation).toBeNull()
  })
  it('without a business portfolio the authorised accounts are not asked for (one call: the roles)', async () => {
    const app = await liveApp('conn-1', null)
    expect(h.calls.map((c) => c.operation)).toEqual(['app.roles'])
    expect(app.authorizedAdAccounts).toEqual({ items: null, error: expect.stringMatching(/names no business portfolio/) })
  })
})
