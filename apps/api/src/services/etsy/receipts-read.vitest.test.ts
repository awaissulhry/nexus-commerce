/**
 * CX Etsy E1 — reading one receipt back: only Etsy's 404 means "not in this shop".
 *
 * Before E1, `pullEtsyReceipt` turned EVERY failure into `null`, so an expired token, a rate limit
 * and an Etsy outage were all recorded as "the receipt could not be read back for this shop" — a
 * routing answer — and nobody could tell them apart afterwards. These run through the REAL reader
 * (`read-client.ts`); only the gateway, the account and the token are stubbed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ answer: null as null | (() => Response | Promise<Response>), calls: [] as string[], token: null as unknown }))
vi.mock('../gateway/gateway.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../gateway/gateway.js')>()),
  gatewayFetch: vi.fn(async (req: { url: string }) => {
    h.calls.push(req.url)
    if (!h.answer) throw new Error('no answer configured')
    return h.answer()
  }),
}))
vi.mock('./account.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./account.js')>()),
  etsyAccount: vi.fn(async (accountId: string) => ({ accountId, shopId: '123', apiKey: 'key:secret' })),
}))
vi.mock('../cx/token.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../cx/token.service.js')>()),
  getAccessToken: vi.fn(async () => { if (h.token instanceof Error) throw h.token; return 'etsy-token' }),
}))
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const { pullEtsyReceipt, EtsyReceiptReadError } = await import('./receipts.service.js')
const { etsyReader } = await import('./read-client.js')
const { GatewayRefusal, GatewayNoAnswer } = await import('../gateway/gateway.js')
const { ConnectionNeedsReauth } = await import('../cx/token.service.js')

const status = (code: number, body = '{"error":"x"}') => () => new Response(body, { status: code })

beforeEach(() => { h.answer = null; h.calls = []; h.token = null })

describe('pullEtsyReceipt — which answers mean "not found"', () => {
  it('returns the receipt Etsy sent for the account\'s own shop path', async () => {
    h.answer = () => new Response(JSON.stringify({ receipt_id: 456 }), { status: 200 })
    expect(await pullEtsyReceipt('account-2', '456', '123')).toEqual({ receipt_id: 456 })
    expect(h.calls).toEqual(['https://api.etsy.com/v3/application/shops/123/receipts/456'])
  })

  it('returns null ONLY for Etsy\'s 404', async () => {
    h.answer = status(404)
    expect(await pullEtsyReceipt('account-2', '456', '123')).toBeNull()
  })

  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [429, 'rate_limited'],
    [500, 'server_error'],
    [502, 'server_error'],
    [503, 'server_error'],
    [400, 'rejected'],
    [409, 'rejected'],
  ] as const)('throws a typed error for HTTP %i (%s) instead of reporting "not found"', async (code, kind) => {
    h.answer = status(code)
    const failure = await pullEtsyReceipt('account-2', '456', '123').then(() => null, (error: unknown) => error)
    expect(failure).toBeInstanceOf(EtsyReceiptReadError)
    expect(failure).toMatchObject({ kind, status: code, receiptId: '456' })
    expect((failure as Error).message).toContain(`HTTP ${code}`)
  })

  it('throws a typed error when Etsy never answered, keeping the cause', async () => {
    h.answer = () => { throw new Error('socket hang up') }
    const failure = await pullEtsyReceipt('account-2', '456', '123').then(() => null, (error: unknown) => error)
    expect(failure).toBeInstanceOf(EtsyReceiptReadError)
    expect(failure).toMatchObject({ kind: 'no_answer', status: null })
    expect((failure as Error & { cause?: unknown }).cause).toBeInstanceOf(Error)
  })

  // Review fix: Nexus's own refusals were all reported as "no answer".
  it.each([
    ['a local rate-limit hold', () => new GatewayRefusal('refused', 'RATE_LIMITED_LOCAL', 'Not sent yet: the Etsy rate limit for this account needs 3 s more. Retry later.', 429), 'rate_limited', 429, 'needs 3 s more'],
    ['an account that needs sign-in', () => new GatewayRefusal('held', 'ACCOUNT_NEEDS_SIGNIN', 'Held, nothing sent: the Etsy account "Shop" needs to be reconnected.', 409), 'unauthorized', 409, 'needs to be reconnected'],
    ['no token for the account', () => new GatewayRefusal('held', 'TOKEN_UNAVAILABLE', 'Held, nothing sent: no Etsy token for this account (x).', 409), 'unauthorized', 409, 'no Etsy token'],
    ['publishing switched off', () => new GatewayRefusal('gated', 'PUBLISH_GATED', 'Nothing was sent to Etsy: Etsy publishing is switched off.', 503), 'not_sent', 503, 'switched off'],
    ['no answer at all', () => new GatewayNoAnswer('ETSY', 'GET /shops/:id/receipts/:id', 'timeout', 'aborted'), 'no_answer', null, 'did not answer'],
  ] as const)('maps %s to its own kind and keeps Nexus\'s sentence', async (_name, make, kind, status, sentence) => {
    h.answer = () => { throw make() }
    const failure = await pullEtsyReceipt('account-2', '456', '123').then(() => null, (error: unknown) => error)
    expect(failure).toBeInstanceOf(EtsyReceiptReadError)
    expect(failure).toMatchObject({ kind, status })
    expect((failure as Error).message).toContain(sentence)
  })

  it('maps a connection that needs re-authorisation to unauthorized', async () => {
    h.answer = () => new Response('{}', { status: 200 })
    h.token = new ConnectionNeedsReauth('account-2', 'needs_reauth')
    const failure = await pullEtsyReceipt('account-2', '456', '123').then(() => null, (error: unknown) => error)
    expect(failure).toMatchObject({ kind: 'unauthorized', status: null })
    expect((failure as Error).message).toContain('needs_reauth')
    expect(h.calls).toEqual([])
  })

  it('still refuses a different shop and a bad id before any request', async () => {
    await expect(pullEtsyReceipt('account-2', '456', '999')).rejects.toThrow(/different shop/)
    await expect(pullEtsyReceipt('account-2', '4.5')).rejects.toThrow(/positive whole number/)
    expect(h.calls).toEqual([])
  })
})

describe('the shared reader keeps its message for every other caller', () => {
  it('rejects with the same sentence as before, now carrying the HTTP status', async () => {
    h.answer = status(401)
    const reader = await etsyReader('account-2')
    const failure = await reader.get('/shops/123').then(() => null, (error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe('Etsy could not read this resource (HTTP 401).')
    expect(failure).toMatchObject({ status: 401 })
  })
  it('keeps the rate-limit sentence byte for byte', async () => {
    h.answer = status(429)
    const reader = await etsyReader('account-2')
    await expect(reader.get('/shops/123')).rejects.toThrow(/^Etsy could not read this resource \(HTTP 429\)\. Retry after the Etsy rate limit resets\.$/)
  })
})
