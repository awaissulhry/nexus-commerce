import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { withWorkspace } from '../../lib/workspace-context.js'

let row: Record<string, unknown> | null
const findUnique = vi.fn(async () => row ? { ...row } : null)
const decryptCalls = vi.fn()
const app = { clientId: 'synthetic-client', clientSecret: 'synthetic-client-secret' }
const getChannelApp = vi.fn(async () => app)
vi.mock('../../db.js', () => ({ default: { channelConnection: { findUnique },
  channelAccountGrant: { findFirst: async () => ({ connectionId: 'owned-account' }) },
} }))
vi.mock('./apps.service.js', () => ({ getChannelApp }))
vi.mock('./events.service.js', () => ({ recordConnectionEvent: vi.fn(), SYSTEM_ACTOR: { kind: 'system' } }))
vi.mock('../monitoring/alert.service.js', () => ({ alertService: { createAlert: vi.fn() }, AlertType: { CONNECTION_HEALTH: 'CONNECTION_HEALTH' } }))
const crypto = await import('../../lib/crypto.js')
const catalog = await import('./catalog.js')
const tokenService = await import('./token.service.js')
await import('./connectors/ebay/spec.js')
const OWNER = 'inspection-owner'
const inspect = () => withWorkspace({ workspaceId: OWNER, actorUserId: null, membershipId: null, roleKeys: [] }, () => tokenService.inspectEbayRefreshGrant('owned-account'))
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

beforeEach(async () => {
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  vi.stubEnv('NEXUS_CX_TOKEN_SERVICE', '1')
  vi.stubEnv('NEXUS_CREDENTIAL_ENC_KEY', randomBytes(32).toString('base64'))
  vi.stubEnv('NEXUS_KMS_KEY_ID', '')
  vi.stubGlobal('fetch', vi.fn(async () => response({ active: true, client_id: app.clientId })))
  vi.clearAllMocks()
  row = { id: 'owned-account', workspaceId: OWNER, channelType: 'EBAY', managedBy: 'oauth', authStatus: 'connected', isActive: true,
    grantVersion: 4, connectionMetadata: { environment: 'production' },
    credentialsEnc: (await crypto.encryptCredentials({ accessToken: 'synthetic-cached-access', refreshToken: 'synthetic-current-refresh', accessTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString() })).blob,
  }
  const original = crypto.decryptCredentials
  vi.spyOn(crypto, 'decryptCredentials').mockImplementation(async blob => { decryptCalls(); return original(blob) })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe('eBay current refresh-grant evidence', () => {
  it('introspects the refresh token even when a cached access token is valid', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    vi.mocked(fetch).mockResolvedValueOnce(response({ active: false }))
    expect(await inspect()).toEqual({ connectionId: 'owned-account', workspaceId: OWNER, grantVersion: 4, active: false })
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(url).toBe('https://api.ebay.com/identity/v1/oauth2/token/introspect')
    expect(new URLSearchParams(String(init?.body))).toEqual(new URLSearchParams({ token: 'synthetic-current-refresh', token_type_hint: 'refresh_token' }))
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' } })
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(timeout).toHaveBeenCalledWith(20_000)
    expect(getChannelApp).toHaveBeenCalledWith('EBAY', 'production')
  })

  it('returns only the owned grant version and activity, never token or identity response fields', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ active: true, client_id: app.clientId, username: 'private-seller', scope: 'private-scopes', iat: 42, extra: 'synthetic-current-refresh' }))
    const evidence = await inspect()
    expect(evidence).toEqual({ connectionId: 'owned-account', workspaceId: OWNER, grantVersion: 4, active: true })
    expect(Object.isFrozen(evidence)).toBe(true)
    expect(JSON.stringify(evidence)).not.toMatch(/private-|synthetic-|iat|scope/)
  })

  it('retains the version actually inspected if reconnect completes during the HTTP call', async () => {
    vi.mocked(fetch).mockImplementationOnce(async () => { row!.grantVersion = 5; return response({ active: false }) })
    expect(await inspect()).toMatchObject({ grantVersion: 4, active: false })
    expect(row!.grantVersion).toBe(5)
  })

  it('supports pre-versioned grants without manufacturing a new local generation', async () => {
    row!.grantVersion = 0
    expect(await inspect()).toMatchObject({ grantVersion: 0, active: true })
    expect(row!.grantVersion).toBe(0)
  })

  it('uses the owned sandbox app and sandbox OAuth endpoint when configured', async () => {
    row!.connectionMetadata = { environment: 'sandbox' }
    await inspect()
    expect(getChannelApp).toHaveBeenCalledWith('EBAY', 'sandbox')
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('https://api.sandbox.ebay.com/identity/v1/oauth2/token/introspect')
  })

  it('refuses a foreign account even with a publish share, before decrypting or calling the channel', async () => {
    row!.workspaceId = 'another-business'
    await expect(inspect()).rejects.toMatchObject({ code: 'account_not_owned' })
    expect(decryptCalls).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['wrong channel', { channelType: 'ETSY' }], ['inactive account', { isActive: false }],
    ['revoked', { authStatus: 'revoked' }], ['disconnected', { authStatus: 'disconnected' }],
    ['unversioned shape', { grantVersion: undefined }], ['negative version', { grantVersion: -1 }],
    ['non-integer version', { grantVersion: 1.1 }], ['environment-managed', { managedBy: 'env' }],
  ])('refuses %s before a network request', async (_name, change) => {
    Object.assign(row!, change)
    await expect(inspect()).rejects.toMatchObject({ code: 'EBAY_GRANT_INSPECTION_UNAVAILABLE' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('refuses a missing account without choosing another connection', async () => {
    row = null
    await expect(inspect()).rejects.toMatchObject({ code: 'EBAY_GRANT_INSPECTION_UNAVAILABLE' })
    expect(findUnique).toHaveBeenCalledExactlyOnceWith({ where: { id: 'owned-account' } })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('refuses legacy token-service mode at processing time', async () => {
    vi.stubEnv('NEXUS_CX_TOKEN_SERVICE', '0')
    await expect(inspect()).rejects.toMatchObject({ reason: 'canonical_service_required' })
    expect(findUnique).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not substitute an access token when the refresh token is missing', async () => {
    row!.credentialsEnc = (await crypto.encryptCredentials({ accessToken: 'synthetic-access-only' })).blob
    await expect(inspect()).rejects.toMatchObject({ reason: 'credential_missing' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([' ', 42, { token: 'not-a-string' }])('refuses malformed encrypted refresh-token material before transport: %j', async refreshToken => {
    row!.credentialsEnc = (await crypto.encryptCredentials({ accessToken: 'synthetic-access-only', refreshToken })).blob
    await expect(inspect()).rejects.toMatchObject({ reason: 'credential_missing' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('distinguishes unavailable decryption from missing credentials without exposing the failure', async () => {
    vi.mocked(crypto.decryptCredentials).mockRejectedValueOnce(new Error('sensitive key/token material'))
    await expect(inspect()).rejects.toMatchObject({ reason: 'credential_unavailable', message: 'The current eBay refresh grant could not be verified.' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('refuses unavailable application credentials with a private configuration error', async () => {
    getChannelApp.mockRejectedValueOnce(new Error('sensitive client secret material'))
    await expect(inspect()).rejects.toMatchObject({ reason: 'configuration', message: 'The current eBay refresh grant could not be verified.' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['missing spec', 'missing URL', 'throwing URL'])('keeps %s inside the private configuration error contract', async mode => {
    const spec = catalog.getChannelSpec('EBAY')
    vi.spyOn(catalog, 'getChannelSpec').mockImplementationOnce(() => {
      if (mode === 'missing spec') throw new Error('sensitive registry failure')
      return { ...spec, auth: { ...spec.auth, introspectUrl: mode === 'missing URL' ? undefined : () => { throw new Error('sensitive configuration failure') } } }
    })
    await expect(inspect()).rejects.toMatchObject({ reason: 'configuration', message: 'The current eBay refresh grant could not be verified.' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([null, [], {}, { active: 'false' }, { active: 0 }, { active: true, client_id: 'wrong-app' }, { active: true, client_id: 123 }])('refuses malformed or wrong-app evidence: %j', async value => {
    vi.mocked(fetch).mockResolvedValueOnce(response(value))
    await expect(inspect()).rejects.toMatchObject({ reason: 'invalid_response' })
  })

  it.each([400, 401, 403, 500, 503])('keeps HTTP %s unresolved instead of declaring the seller revoked', async status => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ active: false, error: 'synthetic-current-refresh' }, status))
    await expect(inspect()).rejects.toMatchObject({ code: 'EBAY_GRANT_INSPECTION_UNAVAILABLE', reason: 'remote_error' })
  })

  it('reports explicit throttling separately for a budget-preserving retry', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ error: 'rate limited' }, 429))
    await expect(inspect()).rejects.toMatchObject({ reason: 'rate_limited' })
  })

  it.each([
    ['7200', 'Wed, 23 Sep 2026 00:00:00 GMT'],
    ['Wed, 23 Sep 2026 02:00:00 GMT', 'Wed, 23 Sep 2026 00:00:00 GMT'],
    ['Wednesday, 23-Sep-26 02:00:00 GMT', 'Wednesday, 23-Sep-26 00:00:00 GMT'],
    ['Wed Sep 23 02:00:00 2026', 'Wed Sep 23 00:00:00 2026'],
  ])('preserves the provider retry delay %s independently of local clock skew', async (retry, date) => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': retry, Date: date } }))
    await expect(inspect()).rejects.toMatchObject({ reason: 'rate_limited', retryAfterMs: 7_200_000 })
  })

  it.each(['-1', '1.5', 'NaN', 'Infinity', '9'.repeat(100), 'not a date', '2026-09-23T02:00:00Z'])('ignores an invalid or unrepresentable retry delay %s', async retry => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': retry } }))
    await expect(inspect()).rejects.toMatchObject({ reason: 'rate_limited', retryAfterMs: undefined })
  })

  it('never includes transport errors or response bodies in the thrown diagnostic', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('sensitive synthetic-current-refresh'))
    await expect(inspect()).rejects.toMatchObject({ reason: 'transport', message: 'The current eBay refresh grant could not be verified.' })
    vi.mocked(fetch).mockResolvedValueOnce(new Response('sensitive synthetic-current-refresh', { status: 200 }))
    await expect(inspect()).rejects.toMatchObject({ reason: 'invalid_response', message: 'The current eBay refresh grant could not be verified.' })
  })

  it('refuses an oversized body and cancels the response stream', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(16_385)); }, cancel })
    vi.mocked(fetch).mockResolvedValueOnce(new Response(body))
    await expect(inspect()).rejects.toMatchObject({ reason: 'invalid_response' })
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('does not turn a body read failure into inactive-token evidence or expose its error', async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('sensitive body read detail')) } })
    vi.mocked(fetch).mockResolvedValueOnce(new Response(body))
    await expect(inspect()).rejects.toMatchObject({ reason: 'invalid_response', message: 'The current eBay refresh grant could not be verified.' })
  })

  it('uses the request deadline throughout a response body that stalls after headers', async () => {
    const deadline = new AbortController()
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    vi.mocked(fetch).mockImplementationOnce(async (_url, init) => {
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        init!.signal!.addEventListener('abort', () => controller.error(init!.signal!.reason), { once: true })
        started()
      } })
      return new Response(body)
    })
    const checking = inspect()
    await ready
    deadline.abort(new Error('sensitive deadline failure'))
    await expect(checking).rejects.toMatchObject({ reason: 'invalid_response', message: 'The current eBay refresh grant could not be verified.' })
  })
})
