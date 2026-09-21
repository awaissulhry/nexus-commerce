/**
 * P4.6a — the Etsy publish gate, and the gateway honouring it.
 *
 * The behavioural half matters more than the table: before this slice `publishModeOf('ETSY')` was the
 * literal `'live'`, so a gateway write with `channel: 'ETSY'` went straight out to api.etsy.com. The
 * `sends` cases below are the positive control — they prove the refusals are the gate at work and not
 * a broken fixture — and the read case proves the gate did not also switch Etsy's readers off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ calls: [] as string[] }))
vi.mock('./gateway/account.js', () => import('../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('./gateway/ledger.js', () => import('../test-support/gateway-stubs.js').then((m) => m.ledgerModule))
vi.mock('./cx/token.service.js', () => ({ getAccessToken: vi.fn(async () => 'etsy-token') }))

import { gatewayLedger } from '../test-support/gateway-stubs.js'
import { __rateTest } from './gateway/rate.js'
import { GatewayRefusal, gatewayFetch } from './gateway/gateway.js'
import { assertEtsyWriteAllowed, etsyWriteRefusal, getEtsyPublishMode, isEtsyPublishEnabled } from './etsy-publish-gate.service.js'

/** Both switches, set together, so a test never inherits the other one from the shell. */
function etsyMode(flag: string | undefined, mode?: string) {
  if (flag === undefined) vi.stubEnv('NEXUS_ENABLE_ETSY_PUBLISH', '')
  else vi.stubEnv('NEXUS_ENABLE_ETSY_PUBLISH', flag)
  vi.stubEnv('ETSY_PUBLISH_MODE', mode ?? '')
}

const write = () => gatewayFetch({
  channel: 'ETSY', operation: 'PATCH /shops/:id/listings/:id', kind: 'write', connectionId: 'etsy-1',
  url: 'https://api.etsy.com/v3/application/shops/42/listings/7', method: 'PATCH',
  body: JSON.stringify({ quantity: 3 }), headers: { 'x-api-key': 'key:secret' },
})

beforeEach(() => {
  __rateTest.useMemory(); h.calls = []; gatewayLedger.length = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    h.calls.push(String(url))
    return new Response('{"listing_id":7}', { status: 200 })
  }))
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); __rateTest.reset() })

describe('P4.6a — getEtsyPublishMode', () => {
  it('is gated with nothing set — an Etsy write needs a deliberate variable', () => {
    etsyMode(undefined)
    expect(isEtsyPublishEnabled()).toBe(false)
    expect(getEtsyPublishMode()).toBe('gated')
  })
  it.each(['true', '1', 'yes'])('the master flag accepts %s and lands in dry-run when no mode is set', (flag) => {
    etsyMode(flag)
    expect(getEtsyPublishMode()).toBe('dry-run')
  })
  it.each(['live', 'production'])('%s is the only way to reach live', (mode) => {
    etsyMode('true', mode)
    expect(getEtsyPublishMode()).toBe('live')
  })
  it('the master flag WINS: off + ETSY_PUBLISH_MODE=live is still gated', () => {
    etsyMode('false', 'live')
    expect(getEtsyPublishMode()).toBe('gated')
  })
  it.each(['sandbox', 'dry-run', 'DRYRUN', 'liv', ''])('%p falls to dry-run — Etsy has no sandbox host to fall into', (mode) => {
    etsyMode('true', mode)
    expect(getEtsyPublishMode()).toBe('dry-run')
  })
  it('the refusal sentence names the mode, and live has none', () => {
    etsyMode(undefined); expect(etsyWriteRefusal()).toBe('Etsy publishing is turned off. Nothing was sent to Etsy.')
    etsyMode('true'); expect(etsyWriteRefusal()).toBe('Etsy publishing is in dry-run mode. Nothing was sent to Etsy.')
    etsyMode('true', 'live'); expect(etsyWriteRefusal()).toBeNull()
    expect(() => assertEtsyWriteAllowed()).not.toThrow()
    etsyMode(undefined)
    expect(() => assertEtsyWriteAllowed()).toThrow('Etsy publishing is turned off')
  })
})

describe('P4.6a — the gateway applies it to an Etsy WRITE', () => {
  it('gated: nothing is sent, and the ledger says why', async () => {
    etsyMode(undefined)
    await expect(write()).rejects.toMatchObject({
      name: 'GatewayRefusal', outcome: 'gated', code: 'PUBLISH_GATED', statusCode: 503,
      message: 'Nothing was sent to Etsy: Etsy publishing is switched off.',
    })
    expect(h.calls).toEqual([])
    expect(gatewayLedger.at(-1)).toMatchObject({ channel: 'ETSY', outcome: 'gated', errorCode: 'PUBLISH_GATED', success: false })
  })
  it('dry-run: nothing is sent, and it is recorded as would_send', async () => {
    etsyMode('true')
    await expect(write()).rejects.toMatchObject({ outcome: 'would_send', code: 'DRY_RUN', statusCode: 200 })
    expect(h.calls).toEqual([])
    expect(gatewayLedger.at(-1)).toMatchObject({ outcome: 'would_send', errorCode: 'DRY_RUN' })
  })
  it('sandbox is NOT a way through: Etsy has no sandbox host, so it is dry-run, not a live send', async () => {
    etsyMode('true', 'sandbox')
    const refusal = await write().then(() => null, (e) => e as GatewayRefusal)
    expect(refusal).toBeInstanceOf(GatewayRefusal)
    // NOT 'NO_SANDBOX_HOST': the mode never becomes 'sandbox', so the call is held one step earlier.
    expect(refusal?.code).toBe('DRY_RUN')
    expect(h.calls).toEqual([])
  })
  it('POSITIVE CONTROL — live: the same call IS sent to api.etsy.com', async () => {
    etsyMode('true', 'live')
    const response = await write()
    expect(h.calls).toEqual(['https://api.etsy.com/v3/application/shops/42/listings/7'])
    expect(response.status).toBe(200)
    expect(gatewayLedger.at(-1)).toMatchObject({ outcome: 'sent', success: true })
  })
  it('POSITIVE CONTROL — a READ is never gated: it is sent while writes are switched off', async () => {
    etsyMode(undefined)
    const response = await gatewayFetch({
      channel: 'ETSY', operation: 'GET /shops/:id', kind: 'read', connectionId: 'etsy-1',
      url: 'https://api.etsy.com/v3/application/shops/42', method: 'GET', headers: { 'x-api-key': 'key:secret' },
    })
    expect(h.calls).toEqual(['https://api.etsy.com/v3/application/shops/42'])
    expect(response.status).toBe(200)
    expect(gatewayLedger.at(-1)).toMatchObject({ outcome: 'sent' })
  })
})
