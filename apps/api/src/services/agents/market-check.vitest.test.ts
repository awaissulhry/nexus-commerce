/**
 * Phase 1 N1 — a market code this business does not have is refused at Claude's door, with the codes it does have.
 * The business's Marketplace rows and listed markets are stood in; the check reads only them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  rows: [] as Array<{ channel: string; code: string; isActive: boolean }>,
  listed: [] as Array<{ channel: string; marketplace: string }>,
  findMany: vi.fn(),
}))
vi.mock('../../db.js', () => ({
  default: {
    marketplace: {
      findMany: db.findMany.mockImplementation(async ({ where }: { where: { channel: { in: string[] } } }) =>
        db.rows.filter((row) => where.channel.in.includes(row.channel))),
    },
    channelListing: {
      findMany: async ({ where }: { where: { channel: { in: string[] } } }) => db.listed.filter((row) => where.channel.in.includes(row.channel)),
    },
  },
}))
vi.mock('./tool-registry.js', () => ({ getTool: () => undefined }))

import { marketRefusal, namedMarket } from './market-check.js'
import { PLAN_TOOL } from './tool-types.js'

const change = { name: 'publish-listing', readOnly: false }
const read = { name: 'listing-matrix', readOnly: true }

describe('namedMarket', () => {
  it('reads the channel and the market as the door does', () => {
    expect(namedMarket({ channel: 'ebay', marketplace: 'it' })).toEqual({ channel: 'EBAY', code: 'IT' })
    expect(namedMarket({ channel: 'EBAY', market: 'EBAY_DE' })).toEqual({ channel: 'EBAY', code: 'DE' })
    expect(namedMarket({ channel: 'AMAZON', marketplace: '*' })).toBeNull()
    expect(namedMarket({ channel: 'AMAZON', market: 'EU' })).toBeNull()
    expect(namedMarket({ market: 'IT' })).toBeNull()
    expect(namedMarket({ channel: 'AMAZON_ADS', market: 'IT' })).toBeNull()
  })
})

describe('marketRefusal', () => {
  beforeEach(() => {
    db.findMany.mockClear()
    db.rows = [
      { channel: 'EBAY', code: 'IT', isActive: true }, { channel: 'EBAY', code: 'DE', isActive: true }, { channel: 'EBAY', code: 'UK', isActive: false },
      { channel: 'SHOPIFY', code: 'GLOBAL', isActive: true },
    ]
    db.listed = []
  })

  it('counts a market the business already lists in, even without a market row', async () => {
    db.listed = [{ channel: 'EBAY', marketplace: 'ES' }]
    expect(await marketRefusal(change, { channel: 'EBAY', marketplace: 'ES' })).toBeNull()
    expect(await marketRefusal(change, { channel: 'EBAY', marketplace: 'FR' })).toContain('Its eBay markets: IT, DE, UK (inactive), ES.')
  })

  it('refuses a market the business does not have, and lists the ones it has', async () => {
    expect(await marketRefusal(change, { channel: 'EBAY', marketplace: 'ES' })).toBe(
      'eBay market ES not found in this business. Its eBay markets: IT, DE, UK (inactive). business-overview lists every market with its code. Nothing was queued.')
    expect(await marketRefusal(change, { channel: 'SHOPIFY', market: 'IT' })).toContain('Its Shopify markets: GLOBAL.')
  })

  it('lets through a market the business has, eBay\'s own site id, and GB for UK', async () => {
    expect(await marketRefusal(change, { channel: 'EBAY', marketplace: 'DE' })).toBeNull()
    expect(await marketRefusal(change, { channel: 'EBAY', market: 'EBAY_IT' })).toBeNull()
    expect(await marketRefusal(change, { channel: 'EBAY', market: 'GB' })).toBeNull()
  })

  it('does not check a channel with no market rows, a read, or a call that names no market', async () => {
    expect(await marketRefusal(change, { channel: 'ETSY', market: 'XX' })).toBeNull()
    expect(await marketRefusal(read, { channel: 'EBAY', market: 'ES' })).toBeNull()
    expect(await marketRefusal(change, { productId: 'p' })).toBeNull()
    expect(db.findMany).toHaveBeenCalledTimes(1)
  })

  it('checks publish-review, the read a publish is decided on', async () => {
    expect(await marketRefusal({ name: 'publish-review', readOnly: true }, { channel: 'EBAY', market: 'ES' })).toMatch(/eBay market ES not found in this business.*Nothing was read\.$/)
  })

  it('checks each step of a change plan', async () => {
    const plan = { name: PLAN_TOOL, readOnly: false }
    const refusal = await marketRefusal(plan, { title: 't', steps: [
      { tool: 'publish-listing', args: { channel: 'EBAY', marketplace: 'IT' } },
      { tool: 'publish-listing', args: { channel: 'EBAY', marketplace: 'FR' } },
    ] }, () => change)
    expect(refusal).toBe('Step 2: eBay market FR not found in this business. Its eBay markets: IT, DE, UK (inactive). business-overview lists every market with its code. Nothing was queued.')
  })
})
