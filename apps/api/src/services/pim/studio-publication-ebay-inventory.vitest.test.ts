/** PE P3.3 — the Inventory group sender on stubbed eBay answers (no network). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const s = vi.hoisted(() => ({ mode: 'live' as string }))
vi.mock('../ebay-publish-gate.service.js', () => ({ getEbayPublishMode: () => s.mode }))
vi.mock('../ebay-auth.service.js', () => ({ ebayAuthService: { getValidToken: async () => 'token' } }))
vi.mock('../ebay-trading-api.service.js', () => ({ callTradingApi: vi.fn(), escapeXml: (v: string) => v, siteIdForMarket: () => '101' }))
vi.mock('../gateway/ebay.js', () => ({ ebaySend: vi.fn() }))
vi.mock('../gateway/channels.js', () => ({ ebayListingLanguage: async () => 'it-IT' }))

import { sendEbayInventoryGroup } from './studio-publication-ebay-inventory.js'
import { readEbayInventoryListing } from '../live-read/ebay-inventory.js'

const destination = { productId: 'family', channel: 'EBAY' as const, marketplace: 'IT', accountId: 'account', aliasKey: '', expectedSkus: ['FAM-M'], itemId: '9000000001', parentSku: 'FAM' }
const liveGroup = { title: 'Jacket', description: '<p>Warm</p>', imageUrls: ['https://img.example/1.jpg'], aspects: { Marca: ['Brand'] }, variantSKUs: ['FAM-M'],
  variesBy: { specifications: [{ name: 'Taglia', values: ['M'] }] } }
function reads(opts: { putStatus?: number; after?: Record<string, unknown> | null; listingLags?: boolean } = {}) {
  const events: string[] = []
  let current: Record<string, unknown> | null = liveGroup
  return { events,
    group: vi.fn(async () => { events.push('read'); return current ? { status: 200, body: structuredClone(current) } : { status: 500, body: null } }),
    items: vi.fn(async (skus: string[]) => skus.map(sku => ({ sku, statusCode: 200, inventoryItem: { product: { aspects: { Taglia: ['M'] } }, availability: { shipToLocationAvailability: { quantity: 2 } } } }))),
    getItem: vi.fn(async () => ({ xml: current && !opts.listingLags ? `<GetItemResponse><Item><ItemID>9000000001</ItemID><Title>${current.title}</Title></Item></GetItemResponse>` : null, error: current ? undefined : 'no item' })),
    put: vi.fn(async (_key: string, body: Record<string, unknown>) => {
      events.push('put'); const status = opts.putStatus ?? 204
      if (status < 300) current = opts.after === undefined ? structuredClone(body) : opts.after
      return { status, text: status >= 400 ? '{"errors":[{"errorId":25002}]}' : '' }
    }) }
}
const revision = async (r: ReturnType<typeof reads>) => (await readEbayInventoryListing(destination, r)).revision!
const group = { ...liveGroup, title: 'Winter jacket' }

beforeEach(() => { s.mode = 'live'; vi.stubEnv('NEXUS_EBAY_REAL_API', 'true'); vi.stubEnv('EBAY_SANDBOX', 'false') })
afterEach(() => { vi.unstubAllEnvs() })

describe('sendEbayInventoryGroup', () => {
  it('re-reads, journals the exact request BEFORE the PUT, and verifies the sent field on read-back', async () => {
    const r = reads(), expectedRevision = await revision(r)
    const beforeSend = vi.fn(async () => { r.events.push('journal') })
    const receipt = await sendEbayInventoryGroup({ destination, groupKey: 'FAM', group, expectedRevision, fields: ['title'], reads: r, beforeSend })
    expect(beforeSend).toHaveBeenCalledWith({ operation: 'PUT inventory_item_group', groupKey: 'FAM', body: group })
    expect(r.events.slice(-3)).toEqual(['journal', 'put', 'read'])
    expect(receipt).toMatchObject({ reference: 'FAM', verified: true, warnings: [] })
  })

  it('eBay changed after the review: nothing is journaled or sent', async () => {
    const r = reads(), beforeSend = vi.fn()
    await expect(sendEbayInventoryGroup({ destination, groupKey: 'FAM', group, expectedRevision: 'stale', fields: ['title'], reads: r, beforeSend })).rejects.toMatchObject({ notSent: true })
    expect(beforeSend).not.toHaveBeenCalled()
    expect(r.put).not.toHaveBeenCalled()
  })

  it('a failed journal stops the send', async () => {
    const r = reads(), expectedRevision = await revision(r)
    await expect(sendEbayInventoryGroup({ destination, groupKey: 'FAM', group, expectedRevision, fields: ['title'], reads: r, beforeSend: async () => { throw new Error('journal down') } }))
      .rejects.toMatchObject({ notSent: true, message: 'journal down' })
    expect(r.put).not.toHaveBeenCalled()
  })

  it('a 4xx from eBay is "not sent"; a 5xx is unknown (no notSent flag)', async () => {
    const refused = reads({ putStatus: 400 })
    await expect(sendEbayInventoryGroup({ destination, groupKey: 'FAM', group, expectedRevision: await revision(refused), fields: ['title'], reads: refused })).rejects.toMatchObject({ notSent: true })
    const unknown = reads({ putStatus: 503 })
    const error = await sendEbayInventoryGroup({ destination, groupKey: 'FAM', group, expectedRevision: await revision(unknown), fields: ['title'], reads: unknown }).catch(e => e)
    expect(error).toBeInstanceOf(Error)
    expect(error.notSent).toBeUndefined()
  })

  it('accepted but the read-back differs: not verified, with a warning naming the field', async () => {
    const r = reads({ after: liveGroup })
    const receipt = await sendEbayInventoryGroup({ destination, groupKey: 'FAM', group, expectedRevision: await revision(r), fields: ['title'], reads: r })
    expect(receipt).toMatchObject({ verified: false, warnings: ['eBay accepted the update, but the read-back differs for: title.'] })
  })

  it('the group matches but the live listing still shows the old title: NOT verified, with a warning', async () => {
    const r = reads({ listingLags: true })
    const receipt = await sendEbayInventoryGroup({ destination, groupKey: 'FAM', group, expectedRevision: await revision(r), fields: ['title'], reads: r })
    expect(receipt.verified).toBe(false)
    expect(receipt.warnings).toEqual(['eBay stored the change, but the live listing does not show it yet for: title. eBay may need a publish step; check the listing.'])
  })

  it('refuses before any read when live eBay publishing is off', async () => {
    s.mode = 'gated'
    const r = reads()
    await expect(sendEbayInventoryGroup({ destination, groupKey: 'FAM', group, expectedRevision: 'x', fields: ['title'], reads: r })).rejects.toMatchObject({ notSent: true })
    expect(r.group).not.toHaveBeenCalled()
  })
})
