/**
 * MCP full control L8 — the Matrix door never pins an eBay listing to 0 while the account's out-of-stock option is not ON:
 * eBay would END the item. The option is read from eBay (here: faked) when a pin to 0 on eBay is previewed or committed,
 * and the shared preview refuses it by name — in the preview and in the commit's re-check of a carried preview, so a page
 * that previewed without it still cannot write it. ON allows it; a pin above 0 never asks eBay.
 *
 * On an in-process PostgreSQL (PGlite) with the generated schema and the production row policies. Every id is invented.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any, option: vi.fn() }))
vi.mock('@nexus/database', async (original) => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { ...(await original<object>()), default: state.db.client }
})
vi.mock('../outbound-enqueue.js', () => ({ fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn(async () => undefined) }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(async () => undefined), refreshMany: vi.fn(async () => undefined), refreshInTransaction: vi.fn(async () => undefined) } }))
vi.mock('../channel-delist.service.js', async (original) => ({ ...(await original<object>()), readEbayOutOfStockPreference: state.option }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { EBAY_ZERO_REFUSAL } from '@nexus/shared/matrix-preview'
import type { VerbPreview } from '@nexus/shared/matrix-contract'
import { runMatrixVerb } from './matrix-write.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const ids = { account: '', listing: '' }
const ctx = { productId: 'l8-zero', actor: 'studio@example.test', can: () => true }
const pin = (value: number) => ({ params: { verb: 'pin-quantity' as const, value }, targets: [{ rowId: 'l8-zero', coordinateKey: 'EBAY:IT' }] })
const held = async () => (await state.db.db.query(`SELECT quantity, "followMasterQuantity", version FROM "ChannelListing" WHERE id = $1`, [ids.listing])).rows[0]

beforeAll(() => scoped(async () => {
  await prisma.marketplace.create({ data: { channel: 'EBAY', code: 'IT', name: 'eBay IT', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
  ids.account = (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'Test eBay', isActive: true, isPrimary: true, externalAccountId: 'TEST-L8-EBAY' } })).id
  await prisma.product.create({ data: { id: 'l8-zero-parent', sku: 'TEST-SKU-L8-P', name: 'L8 parent', basePrice: 10, isParent: true } })
  await prisma.product.create({ data: { id: 'l8-zero', sku: 'TEST-SKU-L8', name: 'L8', basePrice: 10, totalStock: 9, parentId: 'l8-zero-parent' } })
  ids.listing = (await prisma.channelListing.create({ data: { productId: 'l8-zero', channel: 'EBAY', channelConnectionId: ids.account, channelMarket: 'EBAY_IT', marketplace: 'IT', region: 'IT',
    price: 10, quantity: 5, followMasterQuantity: true, listingStatus: 'ACTIVE', isPublished: true, externalListingId: 'TEST-ITEM-L8' } })).id
}), 120_000)
afterAll(async () => { await state.db?.close() }, 60_000)
beforeEach(() => { state.option.mockReset() })

describe('an eBay pin to 0 needs the out-of-stock option ON', () => {
  it.each(['OFF', 'UNKNOWN'])('option %s: the preview refuses it by name, and a carried preview is refused at commit — nothing written', (option) => scoped(async () => {
    state.option.mockResolvedValue(option)
    const preview = await runMatrixVerb(ctx, { ...pin(0), commit: false }) as VerbPreview
    expect(preview.changes).toEqual([])
    expect(preview.refusals).toEqual([expect.objectContaining({ coordinateKey: 'EBAY:IT', kind: 'guard', reason: EBAY_ZERO_REFUSAL })])
    expect(state.option).toHaveBeenCalledWith(ids.account, 'IT')
    // A page that previewed without the option carries the change; the server's re-check refuses it.
    const before = await held()
    const carried: VerbPreview = { verb: 'pin-quantity', changes: [{ rowId: 'l8-zero', sku: 'TEST-SKU-L8', coordinateKey: 'EBAY:IT', cell: 'syncQty', from: 9, to: 0, fromLabel: 'Follow 9', toLabel: 'Pinned 0' }],
      refusals: [], notices: [], confirm: 'none', confirmWord: null, simulated: false }
    const committed = await runMatrixVerb(ctx, { params: { verb: 'pin-quantity' } as never, targets: pin(0).targets, commit: true, preview: carried }) as { results: Array<{ outcome: string; reason?: string }> }
    expect(committed.results).toEqual([expect.objectContaining({ outcome: 'refused', reason: EBAY_ZERO_REFUSAL })])
    expect(await held()).toEqual(before)
  }))

  it('option ON: the pin to 0 is previewed and applied', () => scoped(async () => {
    state.option.mockResolvedValue('ON')
    const preview = await runMatrixVerb(ctx, { ...pin(0), commit: false }) as VerbPreview
    expect(preview.changes).toEqual([expect.objectContaining({ cell: 'syncQty', to: 0 })])
    const committed = await runMatrixVerb(ctx, { ...pin(0), commit: true }) as { results: Array<{ outcome: string }> }
    expect(committed.results).toEqual([expect.objectContaining({ outcome: 'applied' })])
    expect(await held()).toMatchObject({ quantity: 0, followMasterQuantity: false })
  }))

  it('a pin above 0 never asks eBay', () => scoped(async () => {
    const preview = await runMatrixVerb(ctx, { ...pin(3), commit: false }) as VerbPreview
    expect(preview.changes).toHaveLength(1)
    expect(state.option).not.toHaveBeenCalled()
  }))
})
