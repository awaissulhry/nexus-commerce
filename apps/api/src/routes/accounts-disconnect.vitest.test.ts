/**
 * CX.0 (S11) — AccountsPanel "Disconnect" must revoke the grant at the channel
 * and null every token column; a disconnected row may not keep live credentials.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const updates: Array<{ where: unknown; data: Record<string, unknown> }> = []
const rows: Record<string, Record<string, unknown>> = {
  ebay1: { id: 'ebay1', channelType: 'EBAY', managedBy: 'oauth', isActive: true, isPrimary: false, accessToken: 'v^1.1#a', refreshToken: 'v^1.1#r' },
  amz1: { id: 'amz1', channelType: 'AMAZON', managedBy: 'env', isActive: true, isPrimary: true, accessToken: null, refreshToken: null },
}

// Any Prisma model → count() = 0; channelConnection gets findUnique/update.
const prismaMock = new Proxy(
  {},
  {
    get: (_t, model: string) =>
      model === 'channelConnection'
        ? {
            findUnique: async ({ where }: { where: { id: string } }) => rows[where.id] ?? null,
            update: async (args: { where: unknown; data: Record<string, unknown> }) => {
              updates.push(args)
              return args
            },
            count: async () => 0,
          }
        : { count: async () => 0, findMany: async () => [] },
  },
)

vi.mock('../db.js', () => ({ default: prismaMock }))
vi.mock('../services/connection-resolver.service.js', () => ({
  listActiveConnections: async () => [],
}))
const revoke = vi.fn(async (_id: string) => ({ revokedAtChannel: true }))
vi.mock('../services/cx/token.service.js', () => ({ revoke }))
vi.mock('../services/cx/catalog.js', () => ({
  channelKeyOf: (channel: string) => channel === 'EBAY' ? 'EBAY' : channel === 'AMAZON' ? 'AMAZON_SP' : null,
  tryGetChannelSpec: (key: string | null) => key ? { auth: { permissionModel: key === 'AMAZON_SP' ? 'application_roles' : 'oauth_scopes' } } : null,
  scopeDriftOf: () => [],
}))

let app: FastifyInstance
beforeAll(async () => {
  const { default: routes } = await import('./accounts.routes.js')
  app = Fastify()
  await app.register(routes, { prefix: '/api' })
})
afterAll(async () => {
  await app.close()
})

describe('POST /api/accounts/:id/disconnect', () => {
  it('uses the generic encrypted-grant revocation path for an OAuth account', async () => {
    updates.length = 0
    const res = await app.inject({ method: 'POST', url: '/api/accounts/ebay1/disconnect' })
    expect(res.statusCode).toBe(200)
    expect(revoke).toHaveBeenCalledWith('ebay1', { kind: 'operator', userId: null }, 'operator')
    expect(res.json()).toMatchObject({ success: true, revokedAtChannel: true })
  })

  it('reports a generic revoke failure without claiming disconnect succeeded', async () => {
    revoke.mockRejectedValueOnce(new Error('credential store unavailable'))
    const res = await app.inject({ method: 'POST', url: '/api/accounts/ebay1/disconnect' })
    expect(res.statusCode).toBe(500)
  })

  it('refuses to pretend an env-managed account was disconnected', async () => {
    updates.length = 0
    revoke.mockClear()
    const res = await app.inject({ method: 'POST', url: '/api/accounts/amz1/disconnect' })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ success: false, code: 'ENV_MANAGED' })
    expect(revoke).not.toHaveBeenCalled()
    expect(updates).toHaveLength(0)
  })
})
