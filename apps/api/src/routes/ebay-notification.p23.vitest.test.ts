/**
 * P2.3 — an eBay lifecycle notification must be answered, not routed.
 *
 * `MARKETPLACE_ACCOUNT_DELETION` carries a `username`, never a seller object, so the
 * receiver's seller extraction yields undefined and `verifiedChannelWorkspace('EBAY')`
 * is left to pick one row out of however many eBay accounts are connected. With two it
 * raises `ingress_account_ambiguous` and the endpoint answers **503**.
 *
 * Measured against the real routing index before this fix, with a control:
 *   no seller id     -> ingress_account_ambiguous, statusCode 503
 *   known seller id  -> resolves to nexus_legacy_workspace
 *
 * eBay requires a 200 for that topic, marks an endpoint that fails it as down, and
 * answering it is a condition of holding production keys. So the more eBay accounts are
 * connected, the more certainly the erasure notice was refused.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const recorded: any[] = []
let routingThrows = true

vi.mock('../services/cx/ingress/ebay-signature.js', () => ({
  verifyEbayNotification: async () => ({ ok: true }),
  ebayChallengeResponse: () => 'stub-response',
}))
vi.mock('../services/cx/ingress/ledger.js', () => ({
  recordInbound: async (rec: any) => { recorded.push(rec); return { id: 'row-1', duplicate: false } },
}))
vi.mock('../lib/workspace-ingress.js', () => ({
  legacyIngress: (work: any) => work(),
  withIngressWorkspace: (_id: string, work: any) => work(),
  verifiedChannelWorkspace: async () => {
    if (routingThrows) {
      const e: any = new Error('The verified notification does not identify one connected seller.')
      e.code = 'ingress_account_ambiguous'; e.statusCode = 503
      throw e
    }
    return { workspaceId: 'ws-1', connectionId: 'conn-1' }
  },
}))
vi.mock('../services/connection-resolver.service.js', () => ({
  resolveConnection: async () => ({ id: 'conn-1' }),
  tryResolveConnection: async () => ({ id: 'conn-1' }),
  listActiveConnections: async () => [],
}))
vi.mock('../db.js', () => ({ default: new Proxy({}, { get: () => new Proxy({}, { get: () => async () => null }) }) }))
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@nexus/database/workspace-context', () => ({ workspaceKey: (k: object) => k }))

const Fastify = (await import('fastify')).default
const routes = (await import('./ebay-notification.routes.js')).default

async function post(body: unknown) {
  const app = Fastify()
  await app.register(routes as any)
  const payload = JSON.stringify(body)
  const res = await app.inject({
    method: 'POST', url: '/webhooks/ebay-notification',
    headers: { 'content-type': 'application/json', 'x-ebay-signature': 'stub' },
    payload,
  })
  await app.close()
  return res
}

beforeEach(() => {
  recorded.length = 0
  routingThrows = true
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
})

describe('lifecycle topics are answered before any account routing', () => {
  it('answers 200 to MARKETPLACE_ACCOUNT_DELETION even when no single account can be identified', async () => {
    const res = await post({
      metadata: { topic: 'MARKETPLACE_ACCOUNT_DELETION', notificationId: 'n-1' },
      notification: { data: { username: 'someone', userId: 'u-1' } },
    })
    // This was a 503 before P2.3, and a 503 here costs production keys.
    expect(res.statusCode).toBe(200)
  })

  it('answers AUTHORIZATION_REVOCATION rather than refusing it', async () => {
    const res = await post({
      metadata: { topic: 'AUTHORIZATION_REVOCATION', notificationId: 'n-2' },
      notification: { data: { username: 'someone' } },
    })
    // It is about the grant, not an order, so it names no seller to route by either.
    expect(res.statusCode).toBe(204)
  })

  it('STILL refuses an ordinary notification it cannot attribute — the fix is narrow', async () => {
    const res = await post({
      metadata: { topic: 'ITEM_SOLD', notificationId: 'n-3' },
      notification: { data: { orderId: '12-345' } },
    })
    // A sale that cannot be attributed to a business must not be handled in the
    // platform's workspace. 503 keeps it on eBay's retry schedule.
    expect(res.statusCode).toBe(503)
  })

  it('handles an ordinary notification normally once routing succeeds', async () => {
    routingThrows = false
    const res = await post({
      metadata: { topic: 'ITEM_SOLD', notificationId: 'n-4' },
      notification: { data: { orderId: '12-345' } },
    })
    expect(res.statusCode).toBe(204)
    expect(recorded.some((r) => r.channel === 'EBAY' && r.signatureOk === true)).toBe(true)
  })
})
