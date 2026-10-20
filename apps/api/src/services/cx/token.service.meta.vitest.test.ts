/**
 * Meta (step 1) in the token service — R2 trap 2: Meta gives no refresh token, and that is NOT a dead sign-in.
 *
 *   - a never-expiring system-user token is used as it is; a 60-day one too until 30 days are left;
 *   - inside the last 30 days it is renewed with itself (GET oauth/access_token, grant_type=fb_exchange_token, through
 *     the gateway with no account token), and the new 60-day token is stored;
 *   - a renewal that fails while the token still works keeps serving the token (tried again after an hour); Meta saying
 *     the token is dead (190), or the token already past its date, needs a person: needs_reauth;
 *   - the app secret stays here: the gateway gets an appsecret_proof and the app token, nothing else.
 *
 * No network, no DB: an in-memory prisma and a stubbed gateway; credentials are real v1 envelopes under a throwaway
 * NEXUS_CREDENTIAL_ENC_KEY. Fixture tokens only.
 */
import { createHmac, randomBytes } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

process.env.NEXUS_CREDENTIAL_ENC_KEY = randomBytes(32).toString('base64')
delete process.env.NEXUS_KMS_KEY_ID
const workspacesFlagBefore = process.env.NEXUS_WORKSPACES_ENABLED
process.env.NEXUS_WORKSPACES_ENABLED = '0'
afterAll(() => {
  if (workspacesFlagBefore === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
  else process.env.NEXUS_WORKSPACES_ENABLED = workspacesFlagBefore
})

const h = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown> & { id: string }>(),
  events: [] as Array<Record<string, unknown>>,
  calls: [] as Array<{ url: string; auth: unknown; operation: string }>,
  answers: [] as Array<() => { status: number; ok: boolean; body: unknown; verdict?: { errorClass: string; channelCode: string } | null }>,
  linkDeletes: [] as string[],
}))

const prismaMock = {
  $transaction: vi.fn(async (fn: (tx: unknown) => Promise<void>) => fn(prismaMock)),
  channelConnection: {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (h.rows.get(where.id) ? { ...h.rows.get(where.id)! } : null)),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const r = h.rows.get(where.id)!
      for (const [k, v] of Object.entries(data)) if (v !== undefined) r[k] = v
      return { ...r }
    }),
    updateMany: vi.fn(async ({ where, data }: { where: { id: string } & Record<string, unknown>; data: Record<string, unknown> }) => {
      const r = h.rows.get(where.id)
      if (!r || Object.entries(where).some(([key, value]) => value !== undefined && r[key] !== value)) return { count: 0 }
      for (const [k, v] of Object.entries(data)) if (v !== undefined) r[k] = v
      return { count: 1 }
    }),
  },
  connectionEvent: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { h.events.push(data); return data }) },
  metaAccountLink: { deleteMany: vi.fn(async ({ where }: { where: { connectionId: string } }) => { h.linkDeletes.push(where.connectionId); return { count: 1 } }) },
  googleAccountLink: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  $executeRaw: vi.fn(async () => 1),
}
vi.mock('../../db.js', () => ({ default: prismaMock }))
vi.mock('../monitoring/alert.service.js', () => ({ alertService: { createAlert: vi.fn(async () => ({})) }, AlertType: { CONNECTION_HEALTH: 'CONNECTION_HEALTH' } }))
vi.mock('./legacy-channel-credentials.js', () => ({ clearLegacyChannelCredentials: vi.fn(async () => null) }))
vi.mock('../../utils/logger.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../utils/logger.js')>()), logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../gateway/gateway.js', () => {
  class GatewayRefusal extends Error {
    constructor(readonly outcome: string, readonly code: string, message: string) { super(message) }
  }
  return {
    GatewayRefusal,
    gatewayCall: vi.fn(async (req: { url: string; auth: unknown; operation: string }) => {
      h.calls.push({ url: req.url, auth: req.auth, operation: req.operation })
      const a = h.answers.shift()?.() ?? { status: 200, ok: true, body: { access_token: 'renewed-token', token_type: 'bearer', expires_in: 5_183_944 } }
      return { ...a, url: req.url, verdict: a.verdict ?? null, json: () => a.body }
    }),
  }
})

const { registerChannel } = await import('./catalog.js')
const { encryptCredentials, decryptCredentials } = await import('../../lib/crypto.js')
const { getAccessToken, metaAppAccessToken, metaRequestProof, revoke, RefreshFailed, __tokenTest } = await import('./token.service.js')

registerChannel({
  key: 'META', channelType: 'META', displayName: 'Meta (test)', available: true,
  auth: {
    mode: 'api_key', tokenUrl: () => 'https://graph.facebook.com/v26.0/oauth/access_token', tokenRequestAuth: 'body', scopeSeparator: ',',
    codeParamInCallback: 'code', pkce: false, requiredScopes: ['ads_read'], accessTokenLifetimeSec: null, refreshTokenLifetimeSec: null,
    refreshTokenRequired: false, rotatesRefreshToken: false,
  },
  identity: async () => null, heartbeat: async () => ({ ok: true, latencyMs: 1 }), rateLimit: { parse: () => null, model: 'points' },
  webhooks: { scheme: 'none', subscriptionApi: false, lifecycleTopics: [] }, apiVersion: 'v26.0', sandbox: { available: false },
  tokenExpirationBufferSec: 30 * 86_400,
})

const DAY = 86_400_000
const APP = { appId: '1234567', appSecret: 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6' }
let seq = 0
async function seed(expiresInDays: number | null, row: Record<string, unknown> = {}): Promise<string> {
  const id = `meta-${++seq}`
  const accessTokenExpiresAt = expiresInDays === null ? null : new Date(Date.now() + expiresInDays * DAY).toISOString()
  const { blob } = await encryptCredentials({ accessToken: 'current-token', refreshToken: null, accessTokenExpiresAt, extra: { metaApp: APP } })
  h.rows.set(id, {
    id, workspaceId: 'nexus_legacy_workspace', channelType: 'META', managedBy: 'oauth', authStatus: 'connected', isActive: true, displayName: 'Meta (Shop A)',
    consecutiveFailures: 0, credentialsEnc: blob, credentialsKeyId: 'env', accessToken: null, refreshToken: null, ebayAccessToken: null, ebayRefreshToken: null,
    accessTokenExpiresAt: accessTokenExpiresAt ? new Date(accessTokenExpiresAt) : null, refreshTokenExpiresAt: null, tokenExpiresAt: null, ebayTokenExpiresAt: null,
    refreshLeaseUntil: null, refreshLeaseOwner: null, grantVersion: 1, connectionMetadata: null, lastError: null, ...row,
  })
  return id
}
const credsOf = async (id: string) => (await decryptCredentials(h.rows.get(id)!.credentialsEnc as string)) as { accessToken: string; refreshToken: string | null; accessTokenExpiresAt: string | null; extra: Record<string, unknown> }
const eventsOf = (type: string) => h.events.filter((e) => e.type === type)

beforeAll(async () => { await encryptCredentials({ warm: true }) })
beforeEach(() => { h.rows.clear(); h.events.length = 0; h.calls.length = 0; h.answers.length = 0; h.linkDeletes.length = 0; __tokenTest.clearInflight() })

describe('Meta: no refresh token is not a dead sign-in', () => {
  it('a never-expiring token is used as it is: no renewal, no call', async () => {
    const id = await seed(null)
    await expect(getAccessToken(id)).resolves.toBe('current-token')
    expect(h.calls).toHaveLength(0)
  })
  it('a 60-day token with more than 30 days left is used as it is', async () => {
    const id = await seed(45)
    await expect(getAccessToken(id)).resolves.toBe('current-token')
    expect(h.calls).toHaveLength(0)
  })
  it('inside the last 30 days it is renewed with itself — fb_exchange_token, no account token — and the new 60-day token is stored', async () => {
    const id = await seed(20)
    await expect(getAccessToken(id)).resolves.toBe('renewed-token')
    expect(h.calls).toHaveLength(1)
    const url = new URL(h.calls[0].url)
    expect(h.calls[0]).toMatchObject({ auth: 'none', operation: 'token.renew' })
    expect(url.pathname).toBe('/v26.0/oauth/access_token')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      grant_type: 'fb_exchange_token', client_id: APP.appId, client_secret: APP.appSecret, set_token_expires_in_60_days: 'true', fb_exchange_token: 'current-token',
    })
    const creds = await credsOf(id)
    expect(creds.accessToken).toBe('renewed-token')
    expect(creds.refreshToken).toBeNull()
    expect(Date.parse(creds.accessTokenExpiresAt!) - Date.now()).toBeGreaterThan(59 * DAY)
    expect(creds.extra.metaApp).toEqual(APP)
    expect(h.rows.get(id)!.authStatus).toBe('connected')
    expect(eventsOf('refresh')).toHaveLength(1)
    expect(eventsOf('refresh_failed')).toHaveLength(0)
  })
  it('a renewal that fails while the token works keeps serving it, records why, and waits an hour before asking again', async () => {
    const id = await seed(10)
    h.answers.push(() => ({ status: 500, ok: false, body: { error: { code: 2 } }, verdict: { errorClass: 'transient', channelCode: '2' } }))
    await expect(getAccessToken(id)).resolves.toBe('current-token')
    expect(h.rows.get(id)!.authStatus).toBe('connected')
    expect(eventsOf('refresh_failed')).toEqual([expect.objectContaining({ detail: expect.objectContaining({ keptCurrentToken: true, errorClass: 'transient' }) })])
    await expect(getAccessToken(id)).resolves.toBe('current-token')
    expect(h.calls).toHaveLength(1)
  })
  it('Meta saying the token is dead (190) needs a new token: needs_reauth', async () => {
    const id = await seed(10)
    h.answers.push(() => ({ status: 400, ok: false, body: { error: { code: 190 } }, verdict: { errorClass: 'auth_revoked', channelCode: '190' } }))
    await expect(getAccessToken(id)).rejects.toBeInstanceOf(RefreshFailed)
    expect(h.rows.get(id)!.authStatus).toBe('needs_reauth')
  })
  it('a token past its date needs a person, and the sentence names the date; nothing is sent', async () => {
    const id = await seed(-2)
    const err = await getAccessToken(id).catch((e) => e)
    expect(err).toBeInstanceOf(RefreshFailed)
    expect(err.message).toMatch(/expired on \d{4}-\d{2}-\d{2}/)
    expect(h.calls).toHaveLength(0)
    expect(h.rows.get(id)!.authStatus).toBe('needs_reauth')
  })
})

describe('the app secret never leaves the token service', () => {
  it('the gateway gets a time-stamped appsecret_proof for a token, and the app token for debug_token', async () => {
    const id = await seed(null)
    const proof = await metaRequestProof(id, 'current-token')
    expect(proof.appsecret_proof).toBe(createHmac('sha256', APP.appSecret).update(`current-token|${proof.appsecret_time}`).digest('hex'))
    await expect(metaAppAccessToken(id)).resolves.toBe(`${APP.appId}|${APP.appSecret}`)
  })
  it('a connection with no stored app is refused (no proof without the secret)', async () => {
    const id = await seed(null)
    const { blob } = await encryptCredentials({ accessToken: 'current-token' })
    h.rows.get(id)!.credentialsEnc = blob
    await expect(metaRequestProof(id, 'current-token')).rejects.toThrow(/No Meta app id and secret/)
  })
})

describe('disconnect', () => {
  it('lets go of this business\'s Meta picks (each id in ONE business) and never calls Meta', async () => {
    const id = await seed(null)
    await revoke(id, { kind: 'operator', userId: 'u-1' }, 'operator')
    expect(h.linkDeletes).toEqual([id])
    expect(h.rows.get(id)!).toMatchObject({ isActive: false, authStatus: 'disconnected', credentialsEnc: null })
    expect(h.calls).toHaveLength(0)
  })
})

