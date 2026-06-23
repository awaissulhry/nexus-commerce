/**
 * ALA Phase 3 — validateListing (VALIDATION_PREVIEW) unit tests.
 *
 * Stubs the network (getAccessToken + fetchWithRetry) so the branch logic is
 * tested without live SP-API creds: PATCH vs PUT selection, the mode query
 * param, JSON-Patch body shape, and ERROR/WARNING parsing. Live behaviour is
 * smoke-tested separately on prod via scripts/_ala-vp-smoke.mjs.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { AmazonSpApiClient } from './amazon-sp-api.client.js'

function stub(client: AmazonSpApiClient, mockResponse: Record<string, unknown>) {
  const captured: { url?: string; init?: any } = {}
  ;(client as any).getAccessToken = async () => 'tok-123'
  ;(client as any).fetchWithRetry = async (url: string, init: any) => {
    captured.url = url
    captured.init = init
    return { json: async () => mockResponse }
  }
  return captured
}

describe('validateListing — VALIDATION_PREVIEW', () => {
  let client: AmazonSpApiClient
  beforeEach(() => { client = new AmazonSpApiClient() })

  it('patches → PATCH with mode=VALIDATION_PREVIEW and {productType, patches} body', async () => {
    const cap = stub(client, { status: 'VALID', issues: [] })
    const res = await client.validateListing({
      sellerId: 'S1', sku: 'SKU1', marketplaceId: 'APJ6JRA9NG5V4', productType: 'OUTERWEAR',
      patches: [{ op: 'replace', path: '/attributes/item_name', value: [{ value: 'X' }] }],
    })
    expect(res.available).toBe(true)
    expect(res.ok).toBe(true)
    expect(cap.init.method).toBe('PATCH')
    expect(cap.url).toContain('mode=VALIDATION_PREVIEW')
    expect(cap.url).toContain('marketplaceIds=APJ6JRA9NG5V4')
    const body = JSON.parse(cap.init.body)
    expect(body.productType).toBe('OUTERWEAR')
    expect(Array.isArray(body.patches)).toBe(true)
    expect(body.attributes).toBeUndefined()
  })

  it('attributes → PUT with {productType, requirements, attributes} body', async () => {
    const cap = stub(client, { status: 'VALID', issues: [] })
    const res = await client.validateListing({
      sellerId: 'S1', sku: 'SKU1', marketplaceId: 'APJ6JRA9NG5V4', productType: 'OUTERWEAR',
      attributes: { item_name: [{ value: 'X' }] },
    })
    expect(res.ok).toBe(true)
    expect(cap.init.method).toBe('PUT')
    const body = JSON.parse(cap.init.body)
    expect(body.requirements).toBe('LISTING')
    expect(body.attributes).toBeDefined()
    expect(body.patches).toBeUndefined()
  })

  it('ERROR-severity issue → ok=false with parsed error text + issues passthrough', async () => {
    stub(client, { status: 'INVALID', issues: [
      { code: '90220', message: 'missing attribute', severity: 'ERROR', attributeNames: ['country_of_origin'] },
      { code: '5000', message: 'a hint', severity: 'WARNING' },
    ] })
    const res = await client.validateListing({
      sellerId: 'S1', sku: 'SKU1', marketplaceId: 'APJ6JRA9NG5V4', productType: 'OUTERWEAR',
      patches: [{ op: 'replace', path: '/attributes/x', value: 1 }],
    })
    expect(res.ok).toBe(false)
    expect(res.available).toBe(true)
    expect(res.errors).toMatch(/90220/)
    expect(res.errors).toMatch(/country_of_origin/)
    expect(res.warnings.some((w) => w.code === '5000')).toBe(true)
    expect(Array.isArray(res.issues)).toBe(true)
  })

  it('only WARNING/INFO issues → ok=true but warnings surfaced', async () => {
    stub(client, { status: 'VALID', issues: [{ code: '5000', message: 'recommendation', severity: 'WARNING' }] })
    const res = await client.validateListing({
      sellerId: 'S1', sku: 'SKU1', marketplaceId: 'APJ6JRA9NG5V4', productType: 'OUTERWEAR',
      attributes: { item_name: [{ value: 'X' }] },
    })
    expect(res.ok).toBe(true)
    expect(res.warnings).toHaveLength(1)
  })

  it('missing credentials (getAccessToken throws) → available=false, never throws', async () => {
    ;(client as any).getAccessToken = async () => { throw new Error('no creds') }
    const res = await client.validateListing({
      sellerId: 'S1', sku: 'SKU1', marketplaceId: 'APJ6JRA9NG5V4', productType: 'OUTERWEAR',
      attributes: { item_name: [{ value: 'X' }] },
    })
    expect(res.available).toBe(false)
    expect(res.ok).toBe(false)
  })
})
