/**
 * A1.1 — the SP-API client gates EVERY write method through getAmazonPublishMode(),
 * so no caller (incl. repricing → patchListingPrice, which used to be ungated) can
 * write to Amazon when publishing is disabled. When gated/dry-run the method
 * short-circuits with dryRun:true and makes NO HTTP call (so no creds/network).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { amazonSpApiClient } from './amazon-sp-api.client.js'

describe('A1.1 — SP-API write methods gate when publishing is disabled', () => {
  const prevFlag = process.env.NEXUS_ENABLE_AMAZON_PUBLISH
  beforeEach(() => {
    delete process.env.NEXUS_ENABLE_AMAZON_PUBLISH // → getAmazonPublishMode() === 'gated'
  })
  afterEach(() => {
    if (prevFlag === undefined) delete process.env.NEXUS_ENABLE_AMAZON_PUBLISH
    else process.env.NEXUS_ENABLE_AMAZON_PUBLISH = prevFlag
  })

  it('submitListingPayload short-circuits (dryRun, no HTTP)', async () => {
    const r = await amazonSpApiClient.submitListingPayload({ sellerId: 'S', sku: 'X', payload: {} as any })
    expect(r.dryRun).toBe(true)
    expect(r.success).toBe(true)
  })

  it('patchListingPrice short-circuits (the previously-ungated repricing path)', async () => {
    const r = await amazonSpApiClient.patchListingPrice({
      sellerId: 'S', sku: 'X', marketplaceId: 'APJ6JRA9NG5V4',
      productType: 'OUTERWEAR', price: 99.99, currencyCode: 'EUR', taxInclusive: true,
    })
    expect(r.dryRun).toBe(true)
    expect(r.success).toBe(true)
  })

  it('putListingsItem short-circuits', async () => {
    const r = await amazonSpApiClient.putListingsItem({
      sellerId: 'S', sku: 'X', marketplaceId: 'APJ6JRA9NG5V4',
      productType: 'OUTERWEAR', attributes: {},
    })
    expect(r.dryRun).toBe(true)
    expect(r.success).toBe(true)
  })

  it('with the master flag OFF, even AMAZON_PUBLISH_MODE=live stays gated', async () => {
    process.env.AMAZON_PUBLISH_MODE = 'live'
    const r = await amazonSpApiClient.patchListingPrice({
      sellerId: 'S', sku: 'X', marketplaceId: 'APJ6JRA9NG5V4',
      productType: 'OUTERWEAR', price: 50, currencyCode: 'EUR', taxInclusive: true,
    })
    expect(r.dryRun).toBe(true) // flag gate takes precedence over mode
    delete process.env.AMAZON_PUBLISH_MODE
  })
})
