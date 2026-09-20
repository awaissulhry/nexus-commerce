import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ read: vi.fn(), send: vi.fn() }))
vi.mock('./listing-push-controls.js', () => ({ readPushControls: mocks.read }))
// P1.2 — the feed calls go through the channel gateway; its account check and ledger are stood in.
vi.mock('./gateway/account.js', () => import('../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('./gateway/ledger.js', () => import('../test-support/gateway-stubs.js').then((m) => m.ledgerModule))
import { asResponse } from '../test-support/gateway-stubs.js'
import { buildInventoryNdjson, uploadFeedFile } from './ebay-feed.service.js'

const payload = () => buildInventoryNdjson([{ sku: 'GALE-DRAFT-FEED', quantity: 2, title: 'Local fixture' }])
const locks = [
  { syncPaused: true }, { offerClosedAt: new Date('2026-09-13') },
  ...['HELD', 'WITHDRAWN', 'ENDED', 'DISCONTINUED', 'RELEASED'].map(presenceIntent => ({ presenceIntent })),
]
beforeEach(() => {
  vi.clearAllMocks()
  // P1.2 — the upload now follows the eBay publish mode through the gateway; these model production (`live`).
  vi.stubEnv('NEXUS_ENABLE_EBAY_PUBLISH', 'true'); vi.stubEnv('EBAY_PUBLISH_MODE', 'live')
  mocks.read.mockResolvedValue([{}])
  mocks.send.mockResolvedValue({ ok: true })
  vi.stubGlobal('fetch', (...args: unknown[]) => asResponse(mocks.send(...args)))
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

it.each(locks)('refuses feed upload for %j before sending a file', async lock => {
  mocks.read.mockResolvedValue([{}, lock])
  await expect(uploadFeedFile('fixture-task', payload(), 'fixture-token', 'conn-1')).rejects.toThrow('PUSH_')
  expect(mocks.send).not.toHaveBeenCalled()
})
it('allows an unlocked feed and keeps its actual multipart payload', async () => {
  const ndjson = payload()
  await uploadFeedFile('fixture-task', ndjson, 'fixture-token', 'conn-1')
  expect(mocks.read).toHaveBeenCalledWith({ channel: 'EBAY', skus: ['GALE-DRAFT-FEED'], allowAbsent: true })
  expect(mocks.send).toHaveBeenCalledTimes(1)
  const [url, options] = mocks.send.mock.calls[0]
  expect(url).toMatch(/\/sell\/feed\/v1\/task\/fixture-task\/upload_file$/)
  expect(options.method).toBe('POST')
  expect(await options.body.get('file').text()).toBe(ndjson)
})
it('allows a new inventory item only after the stored-control lookup', async () => {
  mocks.read.mockResolvedValue([])
  await uploadFeedFile('fixture-task', payload(), 'fixture-token', 'conn-1')
  expect(mocks.read).toHaveBeenCalledOnce()
  expect(mocks.send).toHaveBeenCalledOnce()
})
it('refuses when stored controls cannot be read', async () => {
  mocks.read.mockRejectedValue(new Error('PUSH_CONTROL_UNAVAILABLE'))
  await expect(uploadFeedFile('fixture-task', payload(), 'fixture-token', 'conn-1')).rejects.toThrow('PUSH_CONTROL_UNAVAILABLE')
  expect(mocks.send).not.toHaveBeenCalled()
})
it.each(['', '{invalid', '{}', '{"sku":""}', '{"sku":42}', '{"sku":"GOOD"}\n{}'])('refuses an unaddressable payload %j', async ndjson => {
  await expect(uploadFeedFile('fixture-task', ndjson, 'fixture-token', 'conn-1')).rejects.toThrow('PUSH_CONTROL_UNAVAILABLE')
  expect(mocks.send).not.toHaveBeenCalled()
})
it('checks every row in a feed before its single upload', async () => {
  const ndjson = buildInventoryNdjson([{ sku: 'FIRST' }, { sku: 'SECOND' }])
  await uploadFeedFile('fixture-task', ndjson, 'fixture-token', 'conn-1')
  expect(mocks.read).toHaveBeenCalledWith({ channel: 'EBAY', skus: ['FIRST', 'SECOND'], allowAbsent: true })
})

it('P1.2 — in a gated environment the upload is refused by the gateway, nothing sent', async () => {
  vi.stubEnv('NEXUS_ENABLE_EBAY_PUBLISH', '')
  await expect(uploadFeedFile('fixture-task', payload(), 'fixture-token', 'conn-1')).rejects.toMatchObject({ code: 'PUBLISH_GATED' })
  expect(mocks.send).not.toHaveBeenCalled()
})
