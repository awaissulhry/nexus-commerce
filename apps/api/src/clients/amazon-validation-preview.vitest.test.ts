import { afterEach, expect, it, vi } from 'vitest'
import { AmazonSpApiClient } from './amazon-sp-api.client.js'
afterEach(() => vi.restoreAllMocks())
const request = { sellerId: 'seller', sku: 'SKU / 1', marketplaceId: 'APJ6JRA9NG5V4', productType: 'COAT', patches: [{ op: 'replace', path: '/attributes/brand', value: [{ value: 'Brand' }] }] }
function fixture(body: unknown, status = 200) {
  const client = new AmazonSpApiClient()
  vi.spyOn(client as any, 'getAccessToken').mockResolvedValue('test-token')
  const transport = vi.spyOn(client as any, 'fetchWithRetry').mockResolvedValue(new Response(JSON.stringify(body), { status }))
  return { client, transport }
}
it('validates the serialized patches for the exact SKU without publishing', async () => {
  const { client, transport } = fixture({ sku: request.sku, status: 'VALID', issues: [] })
  expect(await client.validateListing(request)).toMatchObject({ ok: true, available: true })
  const [url, init] = transport.mock.calls[0] as any[]
  expect(new URL(url).searchParams.get('mode')).toBe('VALIDATION_PREVIEW')
  expect(new URL(url).pathname).toContain(encodeURIComponent(request.sku))
  expect(init.method).toBe('PATCH')
  expect(JSON.parse(init.body)).toEqual({ productType: request.productType, patches: request.patches })
})
it('rejects INVALID even if Amazon omits issue details', async () => {
  const { client } = fixture({ sku: request.sku, status: 'INVALID', issues: [] })
  expect(await client.validateListing(request)).toMatchObject({ ok: false, available: true, errors: expect.stringContaining('invalid') })
})
it.each([{}, { sku: 'OTHER', status: 'VALID' }, { sku: request.sku, status: 'ACCEPTED' }, { sku: request.sku, status: 'VALID', issues: {} }])('does not accept an unrecognized result: %j', async body => {
  expect(await fixture(body).client.validateListing(request)).toMatchObject({ ok: false, available: false })
})
it('does not mistake an HTTP error with no issues array for a valid result', async () => {
  expect(await fixture({ errors: [{ message: 'Forbidden' }] }, 403).client.validateListing(request)).toMatchObject({ ok: false, available: false, errors: expect.stringContaining('403') })
})
it('retains Amazon request errors even when their details property is empty', async () => {
  const body = { errors: [{ code: 'InvalidInput', message: 'Invalid empty value provided in patch at index of 35.', details: '' }] }
  expect(await fixture(body, 400).client.validateListing(request)).toMatchObject({ ok: false, available: false, errors: expect.stringContaining('Invalid empty value'), rawResponse: body })
})
it('retains nonblocking warnings on a valid preview', async () => {
  const result = await fixture({ sku: request.sku, status: 'VALID', issues: [{ code: 'TIP', message: 'Improve image quality', severity: 'WARNING' }] }).client.validateListing(request)
  expect(result.ok).toBe(true)
  expect(result.warnings).toHaveLength(1)
})
