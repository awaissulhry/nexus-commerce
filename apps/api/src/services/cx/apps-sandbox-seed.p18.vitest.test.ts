/**
 * P1.8 re-review (2026-09-24) — `getChannelApp('EBAY', 'sandbox')` must never hand out the PRODUCTION keys.
 *
 * With no sandbox ChannelApp row it fell back to the env seed (EBAY_CLIENT_ID / EBAY_CLIENT_SECRET), which is
 * the production keyset unless EBAY_ENVIRONMENT says SANDBOX — so a sandbox token request (a contract-run
 * account's refresh, `ebayAppToken('sandbox')`) would send the production client id and secret to eBay's
 * sandbox token endpoint. eBay issues a separate sandbox keyset; Amazon's SP-API sandbox and the Ads test host
 * take the production app, so they keep the fallback.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({ default: { channelApp: { findUnique: vi.fn(async () => null) } } }))

import { getChannelApp, __appsTest } from './apps.service.js'
import { ChannelAppConfigurationError } from './app-configuration-error.js'
import { ebayAppToken } from './connectors/ebay/client.js'

const fetchCalls: Array<{ url: string; authorization: string | null }> = []
beforeEach(() => {
  __appsTest(); fetchCalls.length = 0
  vi.stubEnv('EBAY_CLIENT_ID', 'PRD-client-0001'); vi.stubEnv('EBAY_CLIENT_SECRET', 'PRD-secret-0001'); vi.stubEnv('EBAY_ENVIRONMENT', '')
  vi.stubEnv('AMAZON_LWA_CLIENT_ID', 'amzn1.application-oa2-client.prd'); vi.stubEnv('AMAZON_LWA_CLIENT_SECRET', 'amzn-prd-secret')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    fetchCalls.push({ url: String(url), authorization: new Headers(init.headers).get('authorization') })
    return new Response(JSON.stringify({ access_token: 'app-token', expires_in: 7200 }), { status: 200 })
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __appsTest() })

describe('eBay sandbox app credentials', () => {
  it('no sandbox row and production env keys: eBay sandbox is NOT configured', async () => {
    await expect(getChannelApp('EBAY', 'sandbox')).rejects.toBeInstanceOf(ChannelAppConfigurationError)
  })
  it('positive control: the same env keys still serve eBay PRODUCTION', async () => {
    await expect(getChannelApp('EBAY', 'production')).resolves.toMatchObject({ clientId: 'PRD-client-0001', clientSecret: 'PRD-secret-0001' })
  })
  it('a sandbox app-token request never sends the production keys to eBay\'s sandbox', async () => {
    await expect(ebayAppToken('sandbox')).rejects.toBeInstanceOf(ChannelAppConfigurationError)
    expect(fetchCalls).toEqual([])
  })
  it('env keys DECLARED as sandbox (EBAY_ENVIRONMENT=SANDBOX) serve eBay sandbox', async () => {
    vi.stubEnv('EBAY_ENVIRONMENT', 'SANDBOX')
    await expect(getChannelApp('EBAY', 'sandbox')).resolves.toMatchObject({ clientId: 'PRD-client-0001' })
  })
  it('Amazon SP-API sandbox keeps the production app (its sandbox takes the production sign-in)', async () => {
    await expect(getChannelApp('AMAZON_SP', 'sandbox')).resolves.toMatchObject({ clientId: 'amzn1.application-oa2-client.prd' })
  })
})
