/**
 * The eBay notification verifier, against real EC keys.
 *
 * These use actual signatures rather than mocks, because the thing being tested IS
 * the cryptography: a mocked verifier would pass whatever it was told to pass, which
 * is precisely the failure the code it replaces had. Every positive case is paired
 * with a negative one, so a verifier that always returned true would fail the suite.
 */
import crypto from 'node:crypto'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../connectors/ebay/client.js', () => ({ ebayAppToken: vi.fn(async () => 'app-token') }))

const {
  parseEbaySignatureHeader,
  toPublicKeyPem,
  verifyEbayNotification,
  ebayChallengeResponse,
  clearEbayPublicKeyCache,
} = await import('./ebay-signature.js')

const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const other = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })

/** eBay hands back the PEM markers with no line breaks inside. */
function ebayStyleKey(key: crypto.KeyObject): string {
  const b64 = key.export({ type: 'spki', format: 'der' }).toString('base64')
  return `-----BEGIN PUBLIC KEY-----${b64}-----END PUBLIC KEY-----`
}

function sign(payload: string, key: crypto.KeyObject = privateKey): string {
  return crypto.createSign('sha1').update(payload).end().sign(key).toString('base64')
}

function header(signature: string, kid = 'key-1'): string {
  return Buffer.from(JSON.stringify({ kid, signature }), 'utf8').toString('base64')
}

function mockKeyServer(key: crypto.KeyObject | null, status = 200) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: status === 200,
    status,
    json: async () => (key ? { key: ebayStyleKey(key) } : {}),
  })))
}

const BODY = { metadata: { topic: 'MARKETPLACE_ACCOUNT_DELETION' }, notification: { data: { username: 'someone' } } }

beforeEach(() => {
  clearEbayPublicKeyCache()
  vi.unstubAllGlobals()
})

describe('parseEbaySignatureHeader', () => {
  it('reads eBay\'s base64 JSON', () => {
    expect(parseEbaySignatureHeader(header('sig-value'))).toEqual({ kid: 'key-1', signature: 'sig-value' })
  })

  it.each([
    ['missing_header', undefined],
    ['malformed_header', Buffer.from('not json', 'utf8').toString('base64')],
    ['missing_kid', Buffer.from(JSON.stringify({ signature: 'x' }), 'utf8').toString('base64')],
    ['missing_signature', Buffer.from(JSON.stringify({ kid: 'k' }), 'utf8').toString('base64')],
  ])('fails closed with %s', (reason, value) => {
    expect(parseEbaySignatureHeader(value as string | undefined)).toBe(reason)
  })
})

describe('toPublicKeyPem', () => {
  it('inserts the line breaks Node needs and leaves a correct key alone', () => {
    const once = toPublicKeyPem(ebayStyleKey(publicKey))
    expect(once.startsWith('-----BEGIN PUBLIC KEY-----\n')).toBe(true)
    expect(once.endsWith('\n-----END PUBLIC KEY-----')).toBe(true)
    expect(toPublicKeyPem(once)).toBe(once)
    // It must actually load as a key, not merely look like one.
    expect(() => crypto.createPublicKey(once)).not.toThrow()
  })
})

describe('verifyEbayNotification', () => {
  it('accepts a signature over the canonical JSON — the form eBay signs', async () => {
    mockKeyServer(publicKey)
    const raw = Buffer.from(JSON.stringify(BODY), 'utf8')
    const v = await verifyEbayNotification({ rawBody: raw, header: header(sign(JSON.stringify(BODY))) })
    expect(v).toMatchObject({ ok: true, reason: 'ok', kid: 'key-1' })
  })

  it('accepts a signature over the bytes as they arrived, when they differ from the canonical form', async () => {
    mockKeyServer(publicKey)
    // Pretty-printed on the wire: same object, different bytes.
    const raw = Buffer.from(JSON.stringify(BODY, null, 2), 'utf8')
    const v = await verifyEbayNotification({ rawBody: raw, header: header(sign(raw.toString('utf8'))) })
    expect(v.ok).toBe(true)
  })

  it('REJECTS a tampered body — the mutation this whole file exists for', async () => {
    mockKeyServer(publicKey)
    const signed = JSON.stringify(BODY)
    const tampered = JSON.stringify({ ...BODY, notification: { data: { username: 'someone-else' } } })
    const v = await verifyEbayNotification({ rawBody: Buffer.from(tampered, 'utf8'), header: header(sign(signed)) })
    expect(v).toMatchObject({ ok: false, reason: 'signature_mismatch' })
  })

  it('REJECTS a signature made with a different key', async () => {
    mockKeyServer(publicKey)
    const raw = Buffer.from(JSON.stringify(BODY), 'utf8')
    const v = await verifyEbayNotification({ rawBody: raw, header: header(sign(JSON.stringify(BODY), other.privateKey)) })
    expect(v.ok).toBe(false)
  })

  it('REJECTS when the public key cannot be fetched — an unverifiable event is not an accepted one', async () => {
    mockKeyServer(null, 404)
    const raw = Buffer.from(JSON.stringify(BODY), 'utf8')
    const v = await verifyEbayNotification({ rawBody: raw, header: header(sign(JSON.stringify(BODY))) })
    expect(v).toMatchObject({ ok: false, reason: 'public_key_unavailable' })
  })

  it('REJECTS a body that is not JSON', async () => {
    mockKeyServer(publicKey)
    const raw = Buffer.from('<xml/>', 'utf8')
    const v = await verifyEbayNotification({ rawBody: raw, header: header(sign('<xml/>')) })
    expect(v).toMatchObject({ ok: false, reason: 'body_unparseable' })
  })

  it('fetches each key once and reuses it', async () => {
    mockKeyServer(publicKey)
    const raw = Buffer.from(JSON.stringify(BODY), 'utf8')
    const h = header(sign(JSON.stringify(BODY)))
    await verifyEbayNotification({ rawBody: raw, header: h })
    await verifyEbayNotification({ rawBody: raw, header: h })
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1)
  })
})

describe('ebayChallengeResponse', () => {
  it('is SHA-256 over code + token + endpoint, hex', () => {
    const expected = crypto.createHash('sha256').update('code').update('token').update('https://x/y').digest('hex')
    expect(ebayChallengeResponse('code', 'token', 'https://x/y')).toBe(expected)
  })

  it('changes when any one input changes — otherwise it would prove nothing', () => {
    const base = ebayChallengeResponse('code', 'token', 'https://x/y')
    expect(ebayChallengeResponse('code2', 'token', 'https://x/y')).not.toBe(base)
    expect(ebayChallengeResponse('code', 'token2', 'https://x/y')).not.toBe(base)
    expect(ebayChallengeResponse('code', 'token', 'https://x/z')).not.toBe(base)
  })
})
