/**
 * Meta ads step 30 — the HTTP contract of /webhooks/meta/<app id>. The receiver service is a double here except for
 * the signature itself, which is the real check over the bytes Fastify hands the route: proof that the body is never
 * parsed before a business's secret matched (a forged non-JSON body is 401, not 400), that Meta's long ids survive the
 * parse, and that Meta's verification GET echoes the challenge only for the right token and a connected app.
 */
import { createHmac } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const SECRET = 'a-made-up-app-secret-for-tests-01'
const APP = '1234567890123'
const h = vi.hoisted(() => ({
  appConnected: true,
  received: [] as Array<{ appId: string; body: unknown; signers: unknown[]; users: unknown[] }>,
  mismatches: [] as Array<{ appId: string; businesses: unknown[] }>,
  connectedAsked: 0,
  outcome: { changes: 1, recorded: 1, duplicates: 0, ignored: 0, handled: 1, failed: 0, later: 0, notRecorded: 0 } as Record<string, number> | null,
}))

vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../services/marketing/meta-ads/webhook-receiver.js', async () => {
  const { metaWebhookSignatureOk } = await import('../services/cx/connectors/meta/webhook-signature.js')
  return {
    META_APP_ID: /^\d{5,25}$/,
    metaAppConnected: async (appId: string) => { h.connectedAsked++; return h.appConnected && appId === APP },
    metaSignatureVerdicts: async (appId: string, raw: Buffer, header: string | undefined) => {
      const user = { workspaceId: 'ws-a', connectionId: 'conn-a', systemUserId: null }
      const ok = appId === APP && metaWebhookSignatureOk(raw, header, SECRET)
      return { users: appId === APP ? [user] : [], signers: ok ? [user] : [], mismatched: appId === APP && !ok ? [user] : [] }
    },
    receiveMetaWebhook: async (input: { appId: string; body: unknown; signers: unknown[]; users: unknown[] }) => { h.received.push(input); return h.outcome },
    recordMetaSignatureMismatch: async (appId: string, _raw: Buffer, _headers: unknown, businesses: unknown[]) => { h.mismatches.push({ appId, businesses }) },
  }
})

const Fastify = (await import('fastify')).default
const metaWebhookRoutes = (await import('./meta-webhooks.routes.js')).default

async function call(options: { method: 'GET' | 'POST'; url: string; payload?: string; headers?: Record<string, string> }) {
  const app = Fastify()
  await app.register(metaWebhookRoutes)
  const res = await app.inject({ method: options.method, url: options.url, payload: options.payload, headers: options.headers })
  await app.close()
  return res
}
const sign = (body: string, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(Buffer.from(body)).digest('hex')}`
const post = (body: string, signature: string | null = sign(body), appId = APP, contentType = 'application/json') =>
  call({ method: 'POST', url: `/webhooks/meta/${appId}`, payload: body, headers: { 'content-type': contentType, ...(signature ? { 'x-hub-signature-256': signature } : {}) } })

beforeEach(() => {
  h.appConnected = true
  h.received.length = 0
  h.mismatches.length = 0
  h.connectedAsked = 0
  h.outcome = { changes: 1, recorded: 1, duplicates: 0, ignored: 0, handled: 1, failed: 0, later: 0, notRecorded: 0 }
  vi.stubEnv('META_WEBHOOK_VERIFY_TOKEN', 'a-long-verify-token-for-tests')
})

describe('GET — Meta\'s verification', () => {
  const verify = (query: string, appId = APP) => call({ method: 'GET', url: `/webhooks/meta/${appId}?${query}` })
  it('echoes exactly hub.challenge, as text, for the right token and a connected app', async () => {
    const res = await verify('hub.mode=subscribe&hub.challenge=1158201444&hub.verify_token=a-long-verify-token-for-tests')
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('1158201444')
    expect(res.headers['content-type']).toMatch(/^text\/plain/)
    expect(res.headers['x-content-type-options']).toBe('nosniff')
  })
  it('403 for a wrong token, another mode, no challenge, an app no business uses, and when no token is set', async () => {
    expect((await verify('hub.mode=subscribe&hub.challenge=1&hub.verify_token=wrong')).statusCode).toBe(403)
    expect((await verify('hub.mode=unsubscribe&hub.challenge=1&hub.verify_token=a-long-verify-token-for-tests')).statusCode).toBe(403)
    expect((await verify('hub.mode=subscribe&hub.verify_token=a-long-verify-token-for-tests')).statusCode).toBe(403)
    expect((await verify('hub.mode=subscribe&hub.challenge=1&hub.verify_token=a-long-verify-token-for-tests', '5550000000000')).statusCode).toBe(403)
    vi.stubEnv('META_WEBHOOK_VERIFY_TOKEN', '')
    const unset = await verify('hub.mode=subscribe&hub.challenge=1&hub.verify_token=')
    expect(unset.statusCode).toBe(403)
    expect(unset.body).not.toContain('1')
    expect((await verify('hub.mode=subscribe&hub.challenge=%3Cscript%3E&hub.verify_token=a-long-verify-token-for-tests')).statusCode).toBe(403)
  })
})

describe('POST — a notification', () => {
  const body = '{"object":"ad_account","entry":[{"id":"1234567890","time":1782862117,"changes":[{"field":"subscriptions","value":{"subscription_id":1111111111,"object_id":120210000000000001}}]}]}'

  it('a signed delivery is parsed only after the check, with Meta\'s long ids intact, and answered 200', async () => {
    const res = await post(body)
    expect(res.statusCode).toBe(200)
    expect(h.received).toHaveLength(1)
    expect((h.received[0].body as any).entry[0].changes[0].value.object_id).toBe('120210000000000001')
    expect(h.received[0].signers).toEqual([{ workspaceId: 'ws-a', connectionId: 'conn-a', systemUserId: null }])
    expect(h.mismatches).toEqual([])
  })

  it('a charset on the content type changes nothing', async () => {
    expect((await post(body, sign(body), APP, 'application/json; charset=utf-8')).statusCode).toBe(200)
  })

  it('review F2 — a known app whose secret signs nothing: 200 (Meta must not unsubscribe), nothing read, the mismatch handed to the receiver for its row and notice', async () => {
    for (const res of [await post(body, null), await post(body, sign(body, 'a-forged-secret-00000000000000000'))]) {
      expect(res.statusCode).toBe(200)
    }
    expect(h.received).toEqual([])
    expect(h.mismatches).toEqual([{ appId: APP, businesses: [{ workspaceId: 'ws-a', connectionId: 'conn-a', systemUserId: null }] }, { appId: APP, businesses: [expect.anything()] }])
  })

  it('review F2 — an app no business uses: 401 before the body is read (even past the size cap), nothing stored', async () => {
    expect((await post(body, sign(body), '5550000000000')).statusCode).toBe(401)
    const huge = `{"x":"${'a'.repeat(5 * 1024 * 1024)}"}`
    expect((await post(huge, null, '5550000000000')).statusCode).toBe(401)
    expect((await post(body, sign(body), 'abc')).statusCode).toBe(401)
    expect(h.received).toEqual([])
    expect(h.mismatches).toEqual([])
    // The known app's cap is 4 MB.
    expect((await post(huge, null)).statusCode).toBe(413)
  })

  it('a forged body that is not even JSON is never parsed: 200 and nothing handed on', async () => {
    const res = await post('{not json', 'sha256=' + '0'.repeat(64))
    expect(res.statusCode).toBe(200)
    expect(h.received).toEqual([])
  })

  it('a SIGNED body that is not JSON is 400; an empty body 400', async () => {
    expect((await post('{not json')).statusCode).toBe(400)
    expect((await call({ method: 'POST', url: `/webhooks/meta/${APP}`, headers: { 'content-type': 'application/json' } })).statusCode).toBe(400)
  })

  it('503 when the ledger could not take a change (Meta resends; the recorded ones are duplicates); 200 for an unknown envelope', async () => {
    h.outcome = { changes: 2, recorded: 1, duplicates: 0, ignored: 0, handled: 1, failed: 0, later: 0, notRecorded: 1 }
    expect((await post(body)).statusCode).toBe(503)
    h.outcome = null
    expect((await post(body)).statusCode).toBe(200)
  })

  it('a handler failure is the ledger\'s to retry: Meta still gets 200', async () => {
    h.outcome = { changes: 1, recorded: 1, duplicates: 0, ignored: 0, handled: 0, failed: 1, later: 0, notRecorded: 0 }
    expect((await post(body)).statusCode).toBe(200)
  })
})
