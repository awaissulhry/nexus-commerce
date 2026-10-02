import { afterEach, beforeEach, expect, it, vi } from 'vitest'

/**
 * MCP full control 07 (lead ruling 2026-10-02) — the eBay merchant location (where items ship from) is the business's
 * own default warehouse, never an address in code.
 *
 * RED before the fix: ensureMerchantLocation sent a hard-coded town, region and postal code (with two env overrides),
 * whatever the business — and the business's real seat is not that town. Now the address is read from the business's
 * default warehouse (street, postal code, town, country); without a whole one the call is refused with what to fill
 * in, and nothing is sent to eBay. Every address here is invented.
 */
const s = vi.hoisted(() => ({ send: vi.fn(), warehouse: vi.fn() }))
vi.mock('../db.js', () => ({ default: { warehouse: { findFirst: s.warehouse } } }))
vi.mock('./outbound-api-call-log.service.js', () => ({ recordApiCall: (_input: unknown, run: () => unknown) => run() }))
vi.mock('./gateway/account.js', () => import('../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('./gateway/ledger.js', () => import('../test-support/gateway-stubs.js').then((m) => m.ledgerModule))
import { asResponse } from '../test-support/gateway-stubs.js'
import { EbayService } from './marketplaces/ebay.service.js'

const service = new EbayService()
const WAREHOUSE = { addressLine1: 'Via Magazzino 9', addressLine2: null, city: 'Testborgo', postalCode: '00199', country: 'IT' }

beforeEach(() => {
  vi.clearAllMocks()
  s.send.mockResolvedValue({ ok: true, status: 204, text: async () => '' })
  vi.stubGlobal('fetch', (...args: unknown[]) => asResponse(s.send(...args)))
  vi.spyOn(service as any, 'getAccessToken').mockResolvedValue('fixture')
  vi.stubEnv('NEXUS_ENABLE_EBAY_PUBLISH', 'true')
  vi.stubEnv('EBAY_PUBLISH_MODE', 'live')
  vi.stubEnv('EBAY_LOCATION_ADDRESS', 'Via Env 1')
  vi.stubEnv('EBAY_LOCATION_POSTAL_CODE', '11111')
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

it('sends the default warehouse\'s address, and nothing from code or env', async () => {
  s.warehouse.mockResolvedValue(WAREHOUSE)
  await service.ensureMerchantLocation()
  expect(s.send).toHaveBeenCalledTimes(1)
  const body = JSON.parse(String((s.send.mock.calls[0][1] as RequestInit).body))
  expect(body).toEqual({
    merchantLocationStatus: 'ENABLED',
    locationTypes: ['WAREHOUSE'],
    location: { address: { addressLine1: 'Via Magazzino 9', city: 'Testborgo', postalCode: '00199', country: 'IT' } },
  })
  expect(s.warehouse).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ isDefault: true, sharedFromLocationId: null }) }))
})

it.each([
  ['no default warehouse', null],
  ['a warehouse without its postal code', { ...WAREHOUSE, postalCode: null }],
  ['a warehouse without its street', { ...WAREHOUSE, addressLine1: '  ' }],
])('refuses with %s, and sends nothing', async (_name, warehouse) => {
  s.warehouse.mockResolvedValue(warehouse)
  await expect(service.ensureMerchantLocation()).rejects.toThrow(/Fill in the address of the default warehouse .* Nothing was sent to eBay/)
  expect(s.send).not.toHaveBeenCalled()
})
