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
const revokeTokens = vi.fn(async (_id: string) => undefined)
vi.mock('../services/ebay-auth.service.js', () => ({ ebayAuthService: { revokeTokens } }))

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
  it('revokes at eBay and nulls every token column for an OAuth eBay account', async () => {
    updates.length = 0
    const res = await app.inject({ method: 'POST', url: '/api/accounts/ebay1/disconnect' })
    expect(res.statusCode).toBe(200)
    expect(revokeTokens).toHaveBeenCalledWith('ebay1')
    const last = updates.at(-1)!
    expect(last.data).toMatchObject({
      isActive: false,
      isPrimary: false,
      accessToken: null,
      refreshToken: null,
      tokenExpiresAt: null,
      ebayAccessToken: null,
      ebayRefreshToken: null,
      ebayTokenExpiresAt: null,
    })
  })

  it('still nulls tokens locally when the remote revoke fails', async () => {
    updates.length = 0
    revokeTokens.mockRejectedValueOnce(new Error('eBay down'))
    const res = await app.inject({ method: 'POST', url: '/api/accounts/ebay1/disconnect' })
    expect(res.statusCode).toBe(200)
    expect(updates.at(-1)!.data).toMatchObject({ isActive: false, accessToken: null, refreshToken: null })
  })

  it('leaves an env-managed row untouched apart from deactivation', async () => {
    updates.length = 0
    revokeTokens.mockClear()
    const res = await app.inject({ method: 'POST', url: '/api/accounts/amz1/disconnect' })
    expect(res.statusCode).toBe(200)
    expect(revokeTokens).not.toHaveBeenCalled()
    expect(updates.at(-1)!.data).not.toHaveProperty('accessToken')
  })
})
