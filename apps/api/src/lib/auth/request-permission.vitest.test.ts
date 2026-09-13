import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

const session = vi.hoisted(() => ({ validate: vi.fn() }))
vi.mock('./session.js', () => ({ validateSession: session.validate }))
vi.mock('./rbac.js', async (original) => ({
  ...await original<typeof import('./rbac.js')>(),
  resolvePermissions: async () => ({ isOwner: false, permissions: new Set(['products.delete']) }),
}))
import { assertRequestPermission, requestUserId } from './request-permission.js'
import { sessionCookieName } from './cookies.js'

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })
describe('explicit operator permission and actor resolution', () => {
  it('loads the real session from the cookie once and returns that actor', async () => {
    vi.stubEnv('NEXUS_RBAC_MODE', '')
    delete process.env.NEXUS_RBAC_MODE
    session.validate.mockResolvedValue({ user: { id: 'resolved-session-user', roleKeys: [], permissionsVersion: 1 }, sessionId: 'session', mfaSatisfied: true })
    const app = Fastify()
    app.addHook('onRequest', async request => { request.cookies = { [sessionCookieName()]: 'valid-token' } })
    app.post('/guard', { preHandler: async request => {
      await assertRequestPermission(request, 'products.delete')
      await assertRequestPermission(request, 'products.delete')
    } }, async request => ({ actor: requestUserId(request) }))
    try {
      const result = await app.inject({ method: 'POST', url: '/guard' })
      expect(result.statusCode, result.body).toBe(200)
      expect(result.json()).toEqual({ actor: 'resolved-session-user' })
      expect(session.validate).toHaveBeenCalledExactlyOnceWith('valid-token')
    } finally { await app.close() }
  })

  it('an invalid session is forbidden even when the request body names a user', async () => {
    session.validate.mockResolvedValue(null)
    const app = Fastify()
    app.addHook('onRequest', async request => { request.cookies = { [sessionCookieName()]: 'expired-token' } })
    app.post('/guard', { preHandler: async request => assertRequestPermission(request, 'products.delete') }, async () => ({ wrote: true }))
    try {
      const result = await app.inject({ method: 'POST', url: '/guard', payload: { userId: 'forged-user' } })
      expect(result.statusCode).toBe(403)
      expect(session.validate).toHaveBeenCalledExactlyOnceWith('expired-token')
    } finally { await app.close() }
  })
})
