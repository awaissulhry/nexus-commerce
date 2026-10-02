/**
 * P0.4 (docs/channel-connections/FINAL-PLAN.md) — eBay issue_refund is signed.
 *
 * eBay requires an RFC 9421 digital signature on refunds for EU/UK sellers. Before P0.4 the refund
 * went out on a plain fetch with only a bearer token, so eBay refused it (215xxx). The refund now
 * goes through the eBay connector client, which signs it with the app's Key Management key.
 *
 * Part 1 drives the real refund publisher and the real signing code (only the network, the token
 * and the stored key are stand-ins) and verifies the signature cryptographically against a base
 * rebuilt by hand. MCP full control 07 O12: the request carries the amount (orderLevelRefundAmount), so eBay refunds
 * exactly what Nexus records and caps. Part 2 is a census: every file that names an endpoint on eBay's must-sign list
 * must call it through the signing client.
 */
import { createHash, generateKeyPairSync, verify } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  findUnique: vi.fn(),
  recorded: [] as Array<Record<string, unknown>>,
  signingKey: null as null | { signingKeyId: string; jwe: string; privateKey: string; cipher: string },
}))
vi.mock('../../db.js', () => ({ default: { return: { findUnique: h.findUnique } } }))
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../outbound-api-call-log.service.js', () => ({
  recordApiCall: async (meta: Record<string, unknown>, fn: () => Promise<unknown>) => { h.recorded.push(meta); return fn() },
}))
vi.mock('../connection-resolver.service.js', () => ({ tryResolveConnection: async () => ({ id: 'conn-ebay-it' }) }))
vi.mock('../ebay-auth.service.js', () => ({ ebayAuthService: { getValidToken: async () => 'user-token' } }))
vi.mock('../cx/token.service.js', () => ({ getAccessToken: async () => 'user-token' }))
vi.mock('../cx/events.service.js', () => ({ recordConnectionEvent: vi.fn() }))
// P1.2 — ebayFetch sends through the channel gateway; its account check and ledger are stood in.
vi.mock('../gateway/account.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('../gateway/ledger.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.ledgerModule))
vi.mock('../cx/apps.service.js', () => ({
  getChannelApp: async () => ({ clientId: 'app', clientSecret: 'secret', signingKey: h.signingKey }),
  storeSigningKey: vi.fn(),
}))

import { publishRefundToChannel } from './refund-publisher.service.js'

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const JWE = 'eyJ.p04.test-jwe'

const ret = {
  id: 'ret-1',
  channel: 'EBAY',
  marketplace: 'IT',
  refundCents: 4990,
  currencyCode: 'EUR',
  reason: 'DAMAGED',
  notes: null,
  order: {
    id: 'order-1', channelOrderId: '12-34567-89012', channel: 'EBAY', marketplace: 'IT',
    fulfillmentMethod: 'FBM', ebayMetadata: null, amazonMetadata: null,
  },
}

let sent: Array<{ url: string; method: string; headers: Record<string, string>; body: string }>
let answer: () => Response

beforeEach(() => {
  h.signingKey = { signingKeyId: 'key-1', jwe: JWE, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), cipher: 'ED25519' }
  h.findUnique.mockResolvedValue(ret)
  h.recorded.length = 0
  sent = []
  answer = () => new Response(JSON.stringify({ refundId: '5001234' }), { status: 200 })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    sent.push({ url: String(url), method: String(init.method), headers: init.headers as Record<string, string>, body: String(init.body) })
    return answer()
  }))
})
afterEach(() => { vi.unstubAllGlobals() })

describe('P0.4 — eBay issue_refund is signed', () => {
  it('sends ONE request, carrying the four signature headers next to the bearer and marketplace', async () => {
    const result = await publishRefundToChannel({ returnId: 'ret-1' })
    expect(result).toMatchObject({ outcome: 'OK', channelRefundId: '5001234' })
    expect(sent).toHaveLength(1)
    const [request] = sent
    expect(request.url).toBe('https://api.ebay.com/sell/fulfillment/v1/order/12-34567-89012/issue_refund')
    expect(request.method).toBe('POST')
    expect(request.headers).toMatchObject({
      Authorization: 'Bearer user-token',
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_IT',
      'Accept-Language': 'en-US',
      'x-ebay-signature-key': JWE,
      'Content-Digest': `sha-256=:${createHash('sha256').update(request.body, 'utf8').digest('base64')}:`,
    })
    expect(request.headers['Signature-Input']).toMatch(/^sig1=\("content-digest" "x-ebay-signature-key" "@method" "@path" "@authority"\);created=\d+$/)
    // 07 O12 — the amount Nexus records is the amount eBay is asked for (before: no amount was sent at all).
    expect(JSON.parse(request.body)).toEqual({ reasonForRefund: 'ITEM_DAMAGED', comment: 'Refund issued via Nexus Commerce', orderLevelRefundAmount: { value: '49.90', currency: 'EUR' } })
    // The call ledger row is unchanged.
    expect(h.recorded).toEqual([expect.objectContaining({ channel: 'EBAY', operation: 'issueRefund', connectionId: 'conn-ebay-it', marketplace: 'EBAY_IT' })])
  })

  it('the signature verifies against a base rebuilt by hand from what was sent (and a changed base does not)', async () => {
    await publishRefundToChannel({ returnId: 'ret-1' })
    const [request] = sent
    const created = /created=(\d+)$/.exec(request.headers['Signature-Input'])![1]
    const base = [
      `"content-digest": ${request.headers['Content-Digest']}`,
      `"x-ebay-signature-key": ${JWE}`,
      '"@method": POST',
      '"@path": /sell/fulfillment/v1/order/12-34567-89012/issue_refund',
      '"@authority": api.ebay.com',
      `"@signature-params": ("content-digest" "x-ebay-signature-key" "@method" "@path" "@authority");created=${created}`,
    ].join('\n')
    const signature = Buffer.from(/^sig1=:([A-Za-z0-9+/=]+):$/.exec(request.headers.Signature)![1], 'base64')
    expect(verify(null, Buffer.from(base), publicKey, signature)).toBe(true)
    expect(verify(null, Buffer.from(base.replace('12-34567-89012', '12-34567-89013')), publicKey, signature)).toBe(false)
  })

  it('a signature rejection (215xxx) is a FAILED refund with eBay’s own words', async () => {
    answer = () => new Response(JSON.stringify({ errors: [{ errorId: 215002, message: 'Signature validation failed' }] }), { status: 400 })
    const result = await publishRefundToChannel({ returnId: 'ret-1' })
    expect(result).toMatchObject({ outcome: 'FAILED', error: expect.stringContaining('Signature validation failed') })
    expect(sent).toHaveLength(1)
  })
})

// ── Part 2: census ──────────────────────────────────────────────────────────────────────────────

const SRC = fileURLToPath(new URL('../../', import.meta.url))
const CONNECTOR_DIR = 'services/cx/connectors/ebay/'
/** eBay's "APIs in scope" for digital signatures, as they appear in our source. */
const MUST_SIGN = [
  /issue_refund/,
  /\/sell\/finances\//,
  /post-order\/v2\/(?:return|inquiry|casemanagement)\/[^'"`\s]*\/(?:issue_refund|decide)/,
  /post-order\/v2\/cancellation/,
  /['"`]GetAccount['"`]/,
]

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(full)
    return name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts') ? [full] : []
  })
}

describe('P0.4 — every must-sign eBay call goes through the signing client', () => {
  const hits = sourceFiles(SRC)
    .map((file) => ({ file: relative(SRC, file), text: readFileSync(file, 'utf8') }))
    .filter(({ text }) => MUST_SIGN.some((pattern) => pattern.test(text)))

  it('finds the known callers (the census is not looking at nothing)', () => {
    const files = hits.map((hit) => hit.file)
    expect(files).toContain('services/refunds/refund-publisher.service.ts')
    expect(files).toContain('services/ebay-financial-events.service.ts')
  })

  it('each caller outside the connector imports the signing client and makes no plain fetch call', () => {
    const offenders = hits
      .filter(({ file }) => !file.startsWith(CONNECTOR_DIR))
      .filter(({ text }) => !/connectors\/ebay\/client\.js/.test(text) || /(?<![A-Za-z0-9_])fetch\s*\(/.test(text))
      .map(({ file }) => file)
    expect(offenders).toEqual([])
  })
})
