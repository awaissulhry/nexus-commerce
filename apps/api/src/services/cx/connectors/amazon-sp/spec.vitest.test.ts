import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { amazonSpSpec } from './spec.js'
import type { ConnectionHandle } from '../../catalog.js'

const request = vi.fn()
const token = vi.fn(async () => 'account-specific-fixture-token')
const handle: ConnectionHandle = {
  id: 'amazon-one',
  channelKey: 'AMAZON_SP',
  channelType: 'AMAZON',
  region: 'EU',
  identity: { userId: 'SELLERONE' },
  grantedScopes: [],
  token,
}
const markets = {
  payload: [{
    marketplace: { id: 'MARKETONE', name: 'Test market', countryCode: 'IT', defaultCurrencyCode: 'EUR' },
    participation: { isParticipating: true },
  }],
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', request)
  request.mockImplementation(async () => Response.json(markets))
})
afterEach(() => vi.unstubAllGlobals())

describe('Amazon account verification', () => {
  it('uses the selected account handle and region for a heartbeat', async () => {
    expect(await amazonSpSpec.heartbeat(handle)).toMatchObject({ ok: true, identity: { userId: 'SELLERONE' } })
    expect(request).toHaveBeenCalledWith(
      'https://sellingpartnerapi-eu.amazon.com/sellers/v1/marketplaceParticipations',
      expect.objectContaining({ headers: { 'x-amz-access-token': 'account-specific-fixture-token' } }),
    )
  })

  it('does not request Amazon when the account token is unavailable', async () => {
    token.mockRejectedValueOnce(new Error('This account was disconnected.'))
    expect(await amazonSpSpec.heartbeat(handle)).toMatchObject({ ok: false })
    expect(request).not.toHaveBeenCalled()
  })

  it('accepts Amazon’s callback seller identity after proving the fresh seller grant works', async () => {
    expect(await amazonSpSpec.identity(handle)).toEqual({ userId: 'SELLERONE' })
    expect(request).toHaveBeenCalledOnce()
    expect(String(request.mock.calls[0][0])).toContain('/sellers/v1/marketplaceParticipations')
    request.mockResolvedValueOnce(new Response('', { status: 403 }))
    await expect(amazonSpSpec.identity(handle)).rejects.toThrow('seller verification failed')
  })

  it('refuses missing seller identity without selecting an environment seller', async () => {
    await expect(amazonSpSpec.identity({ ...handle, identity: null })).rejects.toThrow('seller identity')
    expect(request).not.toHaveBeenCalled()
  })

  it('discovers marketplaces from this token only', async () => {
    expect(await amazonSpSpec.discoverScopes!(handle)).toEqual([{
      kind: 'marketplace',
      externalId: 'IT',
      label: 'Test market',
      region: 'EU',
      isActive: true,
      metadata: { marketplaceId: 'MARKETONE', currency: 'EUR' },
    }])
  })

  it.each([[403, 'forbidden'], [401, 'auth_revoked'], [429, 'rate_limited'], [503, 'transient']] as const)(
    'classifies HTTP %i as %s',
    async (status, errorClass) => {
      request.mockResolvedValue(new Response('', { status }))
      expect(await amazonSpSpec.heartbeat(handle)).toMatchObject({ ok: false, errorClass })
    },
  )

  it('declares Amazon’s application-role permission model and annual seller renewal', () => {
    expect(amazonSpSpec.auth.permissionModel).toBe('application_roles')
    expect(amazonSpSpec.auth.identityRequired).toBe(true)
    expect(amazonSpSpec.auth.refreshTokenLifetimeSec).toBe(365 * 86_400)
    expect(amazonSpSpec.auth.refreshTokenRequired).toBe(true)
  })
})
