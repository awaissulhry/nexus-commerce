/**
 * P6.2b — `recoverEbaySigningKeyExpiry`, driven end to end with the answer PRODUCTION GOT.
 *
 * This is the path that failed on deployment `5e51055d` (2026-09-21), and it is here because a
 * mutation survived without it: putting `new Date(meta.expirationTime)` back — the exact
 * production defect — broke nothing. P6.2 had covered this function with source-text
 * assertions only, so the one arm that mattered was never run.
 *
 * The fixture is eBay's real shape, taken from this repo's own fixture in
 * `signing.vitest.test.ts:297`: `expirationTime: '1731536000'` — epoch seconds, as a string,
 * exactly as `optionalString` normalises it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  recorded: [] as Array<{ key: string; environment: string; expiresAt: Date | null }>,
  meta: { signingKeyId: 'k1', jwe: 'j', publicKey: 'pub', signingKeyCipher: 'ED25519', expirationTime: '1731536000' } as Record<string, unknown>,
  app: { signingKeyId: 'k1', signingKey: null, signingKeyExpiresAt: null, signingKeyCheckedAt: null, clientId: 'id', clientSecret: 'secret' } as Record<string, unknown>,
  warns: [] as Array<{ msg: string; ctx: unknown }>,
  infos: [] as Array<{ msg: string; ctx: unknown }>,
}))

vi.mock('../../apps.service.js', () => ({
  getChannelApp: vi.fn(async () => h.app),
  storeSigningKey: vi.fn(async () => {}),
  recordSigningKeyExpiry: vi.fn(async (key: string, environment: string, expiresAt: Date | null) => {
    // The production failure, reproduced: Prisma refuses an invalid Date for the WHOLE update,
    // so `signingKeyCheckedAt` never lands either.
    if (expiresAt instanceof Date && Number.isNaN(expiresAt.getTime())) {
      throw new Error('Invalid value for argument `signingKeyExpiresAt`: Provided Date object is invalid. Expected Date.')
    }
    h.recorded.push({ key, environment, expiresAt })
  }),
}))
vi.mock('./key-management.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./key-management.js')>()),
  getEbaySigningKey: vi.fn(async () => h.meta),
  createEbaySigningKey: vi.fn(async () => ({ ...h.meta, privateKey: 'pk' })),
}))
vi.mock('../../token.service.js', () => ({ getAccessToken: vi.fn(async () => 'tok') }))
vi.mock('../../events.service.js', () => ({ recordConnectionEvent: vi.fn(async () => {}) }))
vi.mock('../../../../utils/logger.js', () => ({
  logger: {
    warn: (msg: string, ctx: unknown) => { h.warns.push({ msg, ctx }) },
    info: (msg: string, ctx: unknown) => { h.infos.push({ msg, ctx }) },
    error: () => {}, debug: () => {},
  },
}))

import { recoverEbaySigningKeyExpiry } from './client.js'

beforeEach(() => {
  h.recorded = []; h.warns = []; h.infos = []
  // `ebayAppToken` lives in the module under test and calls eBay's token endpoint directly, so a
  // module mock cannot reach it — an unstubbed run of this file made a REAL request to
  // api.ebay.com (which answered 401 invalid_client). fetch is stubbed so nothing here leaves the machine.
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('/identity/v1/oauth2/token')) {
      return new Response(JSON.stringify({ access_token: 'app-token' }), { status: 200 })
    }
    throw new Error(`unexpected network call in a unit test: ${String(url)}`)
  }))
  h.app = { signingKeyId: 'k1', signingKey: null, signingKeyExpiresAt: null, signingKeyCheckedAt: null, clientId: 'id', clientSecret: 'secret' }
  h.meta = { signingKeyId: 'k1', jwe: 'j', publicKey: 'pub', signingKeyCipher: 'ED25519', expirationTime: '1731536000' }
})
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('P6.2b — recoverEbaySigningKeyExpiry', () => {
  it('🔴 THE PRODUCTION CASE: epoch seconds as a string become a real date, and it is recorded', async () => {
    const result = await recoverEbaySigningKeyExpiry('production')
    expect(result).toMatchObject({ checked: true, signingKeyId: 'k1', expiresAt: '2024-11-13T22:13:20.000Z' })
    expect(h.recorded).toEqual([{ key: 'EBAY', environment: 'production', expiresAt: new Date('2024-11-13T22:13:20.000Z') }])
    expect(h.warns).toEqual([])
    expect(h.infos.at(-1)?.msg).toBe('[cx-ebay] recorded the signing key expiry')
  })

  it('eBay naming NO expiry records a null AND the checked-at — the P3.6 discriminator', async () => {
    delete h.meta.expirationTime
    const result = await recoverEbaySigningKeyExpiry('production')
    expect(result).toMatchObject({ checked: true, expiresAt: null, unreadable: false })
    expect(h.recorded).toEqual([{ key: 'EBAY', environment: 'production', expiresAt: null }])
    expect(h.warns).toEqual([])
  })

  it('an expiry we CANNOT read is still recorded as checked, and names the raw value', async () => {
    h.meta.expirationTime = 'whenever'
    const result = await recoverEbaySigningKeyExpiry('production')
    // Not a failure: we asked, eBay answered, the answer was unusable. Three different facts,
    // and only this one used to be indistinguishable from "we never asked".
    expect(result).toMatchObject({ checked: true, expiresAt: null, unreadable: true })
    expect(h.recorded).toEqual([{ key: 'EBAY', environment: 'production', expiresAt: null }])
    expect(h.warns.at(0)?.msg).toBe('[cx-ebay] eBay named a signing key expiry we could not read')
    expect(h.warns.at(0)?.ctx).toMatchObject({ rawExpirationTime: 'whenever' })
  })

  it('POSITIVE CONTROL: no stored key means no call and no record', async () => {
    h.app = { signingKeyId: null, signingKey: null, signingKeyExpiresAt: null, signingKeyCheckedAt: null, clientId: 'id', clientSecret: 'secret' }
    const result = await recoverEbaySigningKeyExpiry('production')
    expect(result).toMatchObject({ checked: false, signingKeyId: null, error: 'no signing key stored' })
    expect(h.recorded).toEqual([])
  })

  it('POSITIVE CONTROL: the mocked recorder really does refuse an invalid Date, as Prisma does', async () => {
    const { recordSigningKeyExpiry } = await import('../../apps.service.js')
    await expect(recordSigningKeyExpiry('EBAY', 'production', new Date('nonsense')))
      .rejects.toThrow('Provided Date object is invalid')
    expect(h.recorded).toEqual([])
  })

  it('a read that throws is reported, not swallowed, and signing stays up', async () => {
    const km = await import('./key-management.js')
    vi.mocked(km.getEbaySigningKey).mockRejectedValueOnce(new Error('eBay said 500'))
    const result = await recoverEbaySigningKeyExpiry('production')
    expect(result).toMatchObject({ checked: false, signingKeyId: 'k1', expiresAt: null, error: 'eBay said 500' })
    expect(h.warns.at(-1)?.msg).toBe('[cx-ebay] could not read the signing key expiry')
  })
})
