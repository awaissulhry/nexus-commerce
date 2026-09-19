/**
 * P0.3 (docs/channel-connections/FINAL-PLAN.md, S14) — operator webhooks: the secret is sealed at
 * rest, create/edit refuse non-public URLs, and BOTH senders (the test fire and the alert
 * dispatcher) go through lib/outbound-webhook.ts.
 *
 * The real sender runs unless a test replaces one call. A local server counts what arrives, so every
 * "refused" is also "0 requests received" on the server the positive controls do reach.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { createHmac, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const rows = new Map<string, Record<string, any>>()
  let next = 0
  return {
    rows,
    deliver: null as unknown as ReturnType<typeof vi.fn>,
    audit: vi.fn(),
    notificationWebhook: {
      findMany: async (args?: { where?: { isActive?: boolean } }) =>
        [...rows.values()].filter((r) => args?.where?.isActive === undefined || r.isActive === args.where.isActive),
      findUnique: async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `wh${++next}`, createdAt: new Date(), lastFiredAt: null, lastStatus: null, lastError: null, consecutiveFails: 0, ...data }
        rows.set(row.id, row)
        return row
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = { ...rows.get(where.id)!, ...data }
        rows.set(where.id, row)
        return row
      },
      delete: async ({ where }: { where: { id: string } }) => { rows.delete(where.id) },
    },
  }
})
vi.mock('../db.js', () => ({ default: { notificationWebhook: h.notificationWebhook } }))
vi.mock('../utils/settings-audit.js', () => ({ writeSettingsAudit: h.audit }))
vi.mock('../lib/auth/current-user.js', () => ({ currentProfileUser: async () => ({ id: 'user-1' }) }))
vi.mock('../utils/logger.js', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
vi.mock('../lib/outbound-webhook.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/outbound-webhook.js')>()
  h.deliver = vi.fn(real.deliverWebhook)
  return { ...real, deliverWebhook: (...args: Parameters<typeof real.deliverWebhook>) => h.deliver(...args) }
})

import { __test as cryptoTest, decryptSecret, encryptSecret } from '../lib/crypto.js'
import { WEBHOOK_ERROR_MAX_CHARS } from '../lib/outbound-webhook.js'
import { emitWebhookEvent } from '../services/webhook-dispatch.service.js'
import settingsWebhooksRoutes from './settings-webhooks.routes.js'

const hits: string[] = []
let server: Server
let port = 0
let app: FastifyInstance
let realDeliver: (...args: any[]) => Promise<any>

beforeAll(async () => {
  realDeliver = h.deliver.getMockImplementation()!
  server = createServer((request, response) => {
    hits.push(request.url ?? '')
    request.resume()
    if (request.url === '/big') response.writeHead(500).end('z'.repeat(200_000))
    else response.writeHead(200).end('ok')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
  app = Fastify()
  await app.register(settingsWebhooksRoutes, { prefix: '/api' })
  await app.ready()
})
afterAll(async () => { await app.close(); server.closeAllConnections(); await new Promise((r) => server.close(r)) })
beforeEach(() => {
  vi.stubEnv('NEXUS_CREDENTIAL_ENC_KEY', randomBytes(32).toString('base64'))
  cryptoTest.resetKeyCache()
  h.rows.clear()
  hits.length = 0
  h.deliver.mockClear()
})
afterEach(() => { vi.unstubAllEnvs(); cryptoTest.resetKeyCache() })

const sign = (secret: string, body: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
const create = (url: string) =>
  app.inject({ method: 'POST', url: '/api/settings/webhooks', payload: { label: 'Ops', url, events: ['LOW_STOCK'] } })
const seed = (fields: Record<string, unknown>) =>
  h.notificationWebhook.create({ data: { label: 'Old', url: 'https://hooks.example.com/n', secretPrefix: 'aaaaaaaa', events: [], isActive: true, ...fields } })
/** Stand-in for one delivery: capture what would be sent, answer 200. */
const captureOnce = () => {
  const sent: Array<{ body: string; headers: Record<string, string> }> = []
  h.deliver.mockImplementationOnce(async (input: { body: string; headers: Record<string, string> }) => {
    sent.push(input)
    return { ok: true, status: 200, error: null, tookMs: 1 }
  })
  return sent
}

describe('P0.3 — the secret is sealed at rest', () => {
  it('create stores a v1 envelope, returns the raw secret once, and the envelope opens to it', async () => {
    const response = await create('https://hooks.example.com/nexus')
    expect(response.statusCode).toBe(200)
    const { secret, webhook } = response.json()
    expect(secret).toMatch(/^[0-9a-f]{64}$/)
    const stored = h.rows.get(webhook.id)!.secretHash as string
    expect(stored.startsWith('v1:')).toBe(true)
    expect(stored).not.toContain(secret)
    expect(decryptSecret(stored)).toBe(secret)
    expect(webhook.secretPrefix).toBe(secret.slice(0, 8))
  })
  it('refuses to save (503) when the encryption key is missing — plain text is never written', async () => {
    vi.stubEnv('NEXUS_CREDENTIAL_ENC_KEY', '')
    cryptoTest.resetKeyCache()
    const response = await create('https://hooks.example.com/nexus')
    expect(response.statusCode).toBe(503)
    expect(response.json().error).toMatch(/encryption key/)
    expect(h.rows.size).toBe(0)
  })
})

describe('P0.3 — create and edit refuse non-public URLs', () => {
  it.each(['http://localhost:3000/hook', 'https://localhost/hook', 'https://10.0.0.1/h', 'https://169.254.169.254/latest', 'http://hooks.example.com/h'])(
    'create refuses %s and saves nothing', async (url) => {
      const response = await create(url)
      expect(response.statusCode).toBe(400)
      expect(h.rows.size).toBe(0)
    })
  it('edit refuses a private URL and leaves the row as it was; a public one saves (control)', async () => {
    const { webhook } = (await create('https://hooks.example.com/nexus')).json()
    const refused = await app.inject({ method: 'PATCH', url: `/api/settings/webhooks/${webhook.id}`, payload: { url: 'https://169.254.169.254/latest' } })
    expect(refused.statusCode).toBe(400)
    expect(h.rows.get(webhook.id)!.url).toBe('https://hooks.example.com/nexus')
    const saved = await app.inject({ method: 'PATCH', url: `/api/settings/webhooks/${webhook.id}`, payload: { url: 'https://hooks2.example.com/x' } })
    expect(saved.statusCode).toBe(200)
    expect(h.rows.get(webhook.id)!.url).toBe('https://hooks2.example.com/x')
  })
})

describe('P0.3 — the test fire', () => {
  it('to 127.0.0.1 (a row saved before P0.3) is refused, and the local server receives 0 requests', async () => {
    const rows = [
      await seed({ url: `https://127.0.0.1:${port}/ok`, secretHash: encryptSecret('s'.repeat(64)) }),
      await seed({ url: `http://localhost:${port}/ok`, secretHash: encryptSecret('s'.repeat(64)) }),
    ]
    for (const row of rows) {
      const response = await app.inject({ method: 'POST', url: `/api/settings/webhooks/${row.id}/test` })
      // https://127.0.0.1 fails the address rule; http://localhost fails the HTTPS rule first.
      expect(response.json()).toMatchObject({ ok: false, status: 0, error: expect.stringMatching(/public internet address|HTTPS/) })
      expect(h.rows.get(row.id)).toMatchObject({ lastStatus: 0, consecutiveFails: 1, lastError: expect.stringMatching(/public|HTTPS/) })
    }
    expect(hits).toHaveLength(0)
  })
  it('signs with the sealed secret (positive control: what is sent verifies with the secret the operator got)', async () => {
    const { webhook, secret } = (await create('https://hooks.example.com/nexus')).json()
    const sent = captureOnce()
    const response = await app.inject({ method: 'POST', url: `/api/settings/webhooks/${webhook.id}/test` })
    expect(response.json()).toMatchObject({ ok: true, status: 200 })
    expect(sent).toHaveLength(1)
    expect(sent[0].headers['X-Nexus-Signature']).toBe(sign(secret, sent[0].body))
  })
  it('a pre-P0.3 plain-text row still signs, and is sealed on the same write', async () => {
    const plain = 'b'.repeat(64)
    const row = await seed({ secretHash: plain })
    const sent = captureOnce()
    await app.inject({ method: 'POST', url: `/api/settings/webhooks/${row.id}/test` })
    expect(sent[0].headers['X-Nexus-Signature']).toBe(sign(plain, sent[0].body))
    const stored = h.rows.get(row.id)!.secretHash as string
    expect(stored.startsWith('v1:')).toBe(true)
    expect(decryptSecret(stored)).toBe(plain)
  })
  it('a bcrypt row and an unreadable sealed secret answer 409 and send nothing', async () => {
    const bcrypt = await seed({ secretHash: '$2b$10$abcdefghijklmnopqrstuv' })
    const broken = await seed({ secretHash: 'v1:AAAA.BBBB.CCCC' })
    for (const row of [bcrypt, broken]) {
      const response = await app.inject({ method: 'POST', url: `/api/settings/webhooks/${row.id}/test` })
      expect(response.statusCode).toBe(409)
    }
    expect(h.deliver).not.toHaveBeenCalled()
  })
  it('stores at most 500 characters of a long reply', async () => {
    const row = await seed({ secretHash: encryptSecret('c'.repeat(64)), url: `http://hooks.example.test:${port}/big` })
    // Reach the local server through the real sender with the test transport seam.
    h.deliver.mockImplementationOnce((input: unknown) => realDeliver(input, {
      resolve: ((_h: string, _o: unknown, cb: (e: null, a: unknown) => void) => cb(null, [{ address: '127.0.0.1', family: 4 }])) as never,
      isAllowed: () => true,
      allowHttp: true,
    }))
    const response = await app.inject({ method: 'POST', url: `/api/settings/webhooks/${row.id}/test` })
    expect(response.json()).toMatchObject({ ok: false, status: 500 })
    expect(hits).toEqual(['/big'])
    expect((h.rows.get(row.id)!.lastError as string).length).toBeLessThanOrEqual(WEBHOOK_ERROR_MAX_CHARS)
  })
})

describe('P0.3 — the alert dispatcher uses the same sender', () => {
  it('an alert to 127.0.0.1 is refused, recorded, and the local server receives 0 requests', async () => {
    const row = await seed({ url: `https://127.0.0.1:${port}/ok`, secretHash: encryptSecret('d'.repeat(64)) })
    const result = await emitWebhookEvent({ event: 'LOW_STOCK', data: {} })
    expect(result).toMatchObject({ matched: 1, delivered: 0, failed: 1 })
    expect(h.rows.get(row.id)).toMatchObject({ consecutiveFails: 1, lastError: expect.stringMatching(/public/) })
    expect(hits).toHaveLength(0)
  })
  it('signs with the opened secret, and seals a plain-text row on its bookkeeping write (positive control)', async () => {
    const plain = 'e'.repeat(64)
    const row = await seed({ secretHash: plain })
    const sent = captureOnce()
    const result = await emitWebhookEvent({ event: 'LOW_STOCK', data: { sku: 'X' } })
    expect(result).toMatchObject({ matched: 1, delivered: 1 })
    expect(sent[0].headers['X-Nexus-Signature']).toBe(sign(plain, sent[0].body))
    expect(decryptSecret(h.rows.get(row.id)!.secretHash as string)).toBe(plain)
  })
  it('skips a bcrypt row and records an unreadable sealed secret without sending', async () => {
    await seed({ secretHash: '$2b$10$abcdefghijklmnopqrstuv' })
    const broken = await seed({ secretHash: 'v1:AAAA.BBBB.CCCC' })
    const result = await emitWebhookEvent({ event: 'LOW_STOCK', data: {} })
    expect(result).toMatchObject({ matched: 2, skipped: 1, failed: 1, delivered: 0 })
    expect(h.rows.get(broken.id)!.lastError).toMatch(/cannot be read/)
    expect(h.deliver).not.toHaveBeenCalled()
  })
})
