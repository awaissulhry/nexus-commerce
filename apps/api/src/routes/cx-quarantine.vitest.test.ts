import Fastify from 'fastify'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { FEATURES as F } from '@nexus/shared/permissions'
import { permissionForRoute } from '../lib/auth/permissions-manifest.js'

const state = vi.hoisted(() => ({ list: vi.fn(), adopt: vi.fn() }))
vi.mock('../services/cx/ingress/ebay-admission.js', () => ({ listOwnEbayQuarantine: state.list, adoptEbayQuarantine: state.adopt,
  EbayAdmissionError: class extends Error { constructor(readonly reason: string) { super('Internal details must stay private') } },
}))
vi.mock('../db.js', () => ({ default: {} }))
vi.mock('../jobs/cx-heartbeat.job.js', () => ({ runHeartbeatFor: vi.fn() }))
vi.mock('../services/cx/token.service.js', () => ({ refreshNow: vi.fn(), revoke: vi.fn(), RefreshFailed: class extends Error {}, RefreshContended: class extends Error {} }))
const { default: routes } = await import('./cx-connections.routes.js')
const { EbayAdmissionError } = await import('../services/cx/ingress/ebay-admission.js')
const app = Fastify(), base = '/api/cx/connections/owned-account/ebay-quarantine'
const noticeId = '3e388c12-39b7-45b0-ae75-8f2b57d1b1f9'
beforeAll(async () => { await app.register(routes, { prefix: '/api' }); await app.ready() })
afterAll(async () => { await app.close() })
beforeEach(() => { vi.resetAllMocks(); state.list.mockResolvedValue({ items: [], nextCursor: null }); state.adopt.mockResolvedValue({ receiptId: 'owned-receipt', workspaceId: 'owned-profile' }) })

it('keeps both recovery operations behind the existing integrations permission', () => {
  expect(permissionForRoute('GET', base)).toBe(F.settingsIntegrationsManage)
  expect(permissionForRoute('POST', `${base}/${noticeId}/adopt`)).toBe(F.settingsIntegrationsManage)
})
it('passes only the named account and validated pagination to the owner-only reader', async () => {
  const response = await app.inject(`${base}?after=${noticeId}&take=3`)
  expect(response.statusCode).toBe(200)
  expect(response.headers['cache-control']).toBe('no-store')
  expect(response.json()).toEqual({ items: [], nextCursor: null })
  expect(state.list).toHaveBeenCalledExactlyOnceWith('owned-account', { after: noticeId, take: 3 })
})
it.each(['take=0', 'take=-1', 'take=1.5', 'take=no', 'after=not-a-receipt'])('rejects invalid recovery pagination without reading private metadata: %s', query => {
  return app.inject(`${base}?${query}`).then(response => {
    expect(response.statusCode).toBe(400)
    expect(state.list).not.toHaveBeenCalled()
  })
})
it('assigns the exact retained notice to the named account without executing its handler', async () => {
  const response = await app.inject({ method: 'POST', url: `${base}/${noticeId}/adopt`, payload: { workspaceId: 'ignored-foreign-profile', connectionId: 'ignored-foreign-account' } })
  expect(response.statusCode).toBe(200)
  expect(response.json()).toEqual({ assigned: true, receiptId: 'owned-receipt' })
  expect(state.adopt).toHaveBeenCalledExactlyOnceWith(noticeId, 'owned-account')
  expect(state.list).not.toHaveBeenCalled()
})
it('rejects an invalid notice identifier before assignment', async () => {
  const response = await app.inject({ method: 'POST', url: `${base}/not-a-notice/adopt` })
  expect(response.statusCode).toBe(400)
  expect(state.adopt).not.toHaveBeenCalled()
})
it.each([['adoption_forbidden', 403], ['owner_unavailable', 409], ['identity_conflict', 409], ['cipher_unavailable', 503]] as const)
  ('returns a private static %s error with HTTP%s', async (reason, status) => {
    state.adopt.mockRejectedValueOnce(new EbayAdmissionError(reason))
    const response = await app.inject({ method: 'POST', url: `${base}/${noticeId}/adopt` })
    expect(response.statusCode).toBe(status)
    expect(response.json()).toMatchObject({ code: reason })
    expect(response.body).not.toContain('Internal details')
  })
it('does not disclose database exceptions or payloads in recovery-read failures', async () => {
  state.list.mockRejectedValueOnce(new Error('synthetic private ciphertext and SQL'))
  const response = await app.inject(base)
  expect(response.statusCode).toBe(503)
  expect(response.body).not.toMatch(/ciphertext|SQL/)
})
