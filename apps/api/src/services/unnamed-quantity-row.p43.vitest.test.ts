/**
 * P4.3c — a quantity push must name what it is pushing to.
 *
 * Three propositions, tested apart:
 *   A. the VALUE the rule returns, for every shape a real producer emits;
 *   B. an unnamed quantity row never becomes a durable queue row;
 *   C. at dispatch it is refused, it reaches no channel adapter, and it does not
 *      mask the two shared refusals that already ran before it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { quantityRowTarget, unnamedQuantitySentence, UnnamedQuantityRowError } from './outbound-rows.js'

// ── A. the rule's VALUE ─────────────────────────────────────────────────────
describe('P4.3c quantityRowTarget', () => {
  it.each([
    // A quantity row that names its listing, in each of the three forms a caller writes.
    ['scalar listing id', { syncType: 'QUANTITY_UPDATE', channelListingId: 'cl-1' }, 'LISTING'],
    ['checked create connect', { syncType: 'QUANTITY_UPDATE', channelListing: { connect: { id: 'cl-1' } } }, 'LISTING'],
    ['loaded relation', { syncType: 'QUANTITY_UPDATE', channelListing: { id: 'cl-1' } }, 'LISTING'],
    // The shared eBay fan-out: a shared SKU is not a ChannelListing, so it names its ItemID.
    ['shared trading by payload itemId', { syncType: 'QUANTITY_UPDATE', channelListingId: null, payload: { pushVia: 'TRADING', itemId: '123' } }, 'SHARED_ITEM'],
    ['shared trading by externalListingId', { syncType: 'QUANTITY_UPDATE', channelListingId: null, externalListingId: '123', payload: { pushVia: 'TRADING' } }, 'SHARED_ITEM'],
    // The defect: a product-level quantity row.
    ['bare QUANTITY_UPDATE', { syncType: 'QUANTITY_UPDATE', productId: 'p-1' }, 'UNNAMED'],
    // The catalog PATCH's price+stock shape: the label is FULL_SYNC, the quantity is still in the payload.
    ['FULL_SYNC carrying a quantity', { syncType: 'FULL_SYNC', productId: 'p-1', payload: { price: 10, quantity: 42 } }, 'UNNAMED'],
    // `quantity: 0` is a real quantity — the zero-inventory value is the dangerous one.
    ['a quantity of zero', { syncType: 'PRICE_UPDATE', productId: 'p-1', payload: { quantity: 0 } }, 'UNNAMED'],
    // An ItemID alone is not the shared lane: a single eBay listing row must not slip through on it.
    ['externalListingId without pushVia', { syncType: 'QUANTITY_UPDATE', externalListingId: '123', productId: 'p-1' }, 'UNNAMED'],
    // An empty string is not a name. `Array.isArray([])` is TRUE, so an empty
    // updates list must not turn a price row into a quantity row.
    ['empty string listing id', { syncType: 'QUANTITY_UPDATE', channelListingId: '' }, 'UNNAMED'],
    ['whitespace listing id', { syncType: 'QUANTITY_UPDATE', channelListingId: '   ' }, 'UNNAMED'],
    ['empty updates array on a price row', { syncType: 'PRICE_UPDATE', productId: 'p-1', payload: { updates: [] } }, 'NOT_A_QUANTITY_ROW'],
    // Rows that carry no quantity are untouched, whatever they name.
    ['bare PRICE_UPDATE', { syncType: 'PRICE_UPDATE', productId: 'p-1', payload: { price: 10 } }, 'NOT_A_QUANTITY_ROW'],
    ['bare FULL_SYNC without a quantity', { syncType: 'FULL_SYNC', productId: 'p-1', payload: { title: 'x' } }, 'NOT_A_QUANTITY_ROW'],
    ['bare CONTENT_UPDATE', { syncType: 'CONTENT_UPDATE', productId: 'p-1', payload: {} }, 'NOT_A_QUANTITY_ROW'],
  ])('%s → %s', (_name, row, expected) => {
    expect(quantityRowTarget(row)).toBe(expected)
  })

  it('the sentence names the channel and says what cannot be applied', () => {
    const sentence = unnamedQuantitySentence('AMAZON')
    expect(sentence).toContain('AMAZON')
    expect(sentence).toContain('does not say which listing it is for')
  })
})

// ── B. the row never exists ─────────────────────────────────────────────────
const destination = vi.hoisted(() => ({ resolveDestinations: vi.fn() }))
describe('P4.3c: an unnamed quantity row is refused at birth', () => {
  beforeEach(() => {
    vi.resetModules()
    destination.resolveDestinations.mockReset()
    destination.resolveDestinations.mockImplementation(async (_db: unknown, rows: unknown[]) =>
      rows.map(() => ({ connectionId: 'conn-1', reason: 'ONLY_ACCOUNT' })))
  })

  const loadRows = async () => {
    vi.doMock('./outbound-destination.js', () => destination)
    return import('./outbound-rows.js')
  }

  it('createOutboundRow throws and writes nothing', async () => {
    const { createOutboundRow } = await loadRows()
    const create = vi.fn()
    const db = { outboundSyncQueue: { create, createMany: vi.fn(), findMany: vi.fn() } }
    // Assert the VALUE, not the class identity: this suite re-imports the module
    // under `resetModules`, so the thrown class is a different object than the one
    // imported at the top even though the refusal is the same refusal.
    const error = await createOutboundRow(db as never, {
      data: { productId: 'p-1', targetChannel: 'AMAZON', syncType: 'QUANTITY_UPDATE', syncStatus: 'PENDING', payload: { quantity: 99 } } as never,
    }).then(() => null, (e: Error & { code?: string }) => e)
    expect(error?.name).toBe(UnnamedQuantityRowError.name)
    expect(error?.code).toBe('UNNAMED_QUANTITY_ROW')
    expect(error?.message).toBe(unnamedQuantitySentence('AMAZON'))
    // The row must not exist, not merely be reported: a durable job is the harm.
    expect(create).not.toHaveBeenCalled()
    // And the refusal happens BEFORE the destination lookup, so it cannot be
    // reported as "no account" — a different fact with a different fix.
    expect(destination.resolveDestinations).not.toHaveBeenCalled()
  })

  it('createOutboundRows throws and writes nothing', async () => {
    const { createOutboundRows } = await loadRows()
    const createMany = vi.fn()
    const db = { outboundSyncQueue: { createMany, findMany: vi.fn() } }
    await expect(createOutboundRows(db as never, {
      data: [
        { productId: 'p-1', channelListingId: 'cl-1', targetChannel: 'AMAZON', syncType: 'QUANTITY_UPDATE', payload: { quantity: 1 } },
        { productId: 'p-1', targetChannel: 'AMAZON', syncType: 'QUANTITY_UPDATE', payload: { quantity: 1 } },
      ] as never,
    })).rejects.toThrow(/does not say which listing it is for/)
    // One bad row refuses the whole batch: half a cascade is worse than none.
    expect(createMany).not.toHaveBeenCalled()
  })

  it('positive control: the same row WITH a listing is created', async () => {
    const { createOutboundRow } = await loadRows()
    const create = vi.fn(async () => ({ id: 'q-1' }))
    const db = { outboundSyncQueue: { create, createMany: vi.fn(), findMany: vi.fn() } }
    await createOutboundRow(db as never, {
      data: { productId: 'p-1', channelListingId: 'cl-1', targetChannel: 'AMAZON', syncType: 'QUANTITY_UPDATE', syncStatus: 'PENDING', payload: { quantity: 99 } } as never,
    })
    expect(create).toHaveBeenCalledOnce()
    expect(create.mock.calls[0][0].data).toMatchObject({ channelListingId: 'cl-1', channelConnectionId: 'conn-1' })
  })

  it('positive control: the shared eBay fan-out row is created', async () => {
    const { createOutboundRows } = await loadRows()
    const createMany = vi.fn(async () => ({ count: 1 }))
    const db = { outboundSyncQueue: { createMany, findMany: vi.fn() } }
    await createOutboundRows(db as never, {
      data: [{
        productId: 'p-1', channelListingId: null, targetChannel: 'EBAY', targetRegion: 'IT',
        syncType: 'QUANTITY_UPDATE', externalListingId: '1234', maxRetries: 3,
        payload: { source: 'STOCK_MOVEMENT_SHARED', pushVia: 'TRADING', itemId: '1234', updates: [{ sku: 'A', quantity: 3 }] },
      }] as never,
    })
    expect(createMany).toHaveBeenCalledOnce()
  })
})

// ── C. dispatch refuses it, and masks nothing ───────────────────────────────
const m = vi.hoisted(() => {
  const outbound = vi.fn(() => { throw new Error('Unexpected outbound fetch') }); vi.stubGlobal('fetch', outbound)
  return { outbound, update: vi.fn(), claim: vi.fn(), findMany: vi.fn(), emit: vi.fn() }
})
vi.mock('../db.js', () => ({ default: { outboundSyncQueue: { update: m.update, updateMany: m.claim, findMany: m.findMany } } }))
vi.mock('./product-event.service.js', () => ({ productEventService: { emit: m.emit } }))
const { default: OutboundSyncService } = await import('./outbound-sync.service.js')
const ADAPTERS = ['syncToAmazon', 'syncToEbay', 'syncToShopify', 'syncToWoocommerce'] as const

describe('P4.3c: an unnamed quantity row is refused at dispatch', () => {
  let service: any
  beforeEach(() => {
    vi.clearAllMocks(); vi.stubEnv('AMAZON_PUBLISH_MODE', 'dry-run'); service = OutboundSyncService
    m.claim.mockResolvedValue({ count: 1 }); m.emit.mockResolvedValue(undefined)
    for (const name of ADAPTERS) vi.spyOn(service, name).mockResolvedValue({ success: true })
  })
  afterEach(() => { expect(m.outbound).not.toHaveBeenCalled(); vi.unstubAllEnvs() })

  it.each(['AMAZON', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE'])('%s: refused, terminal, and no adapter is entered', async (targetChannel) => {
    const result = await service.dispatchSync({
      id: 'q-unnamed', targetChannel, syncType: 'QUANTITY_UPDATE', productId: 'p-1', payload: { quantity: 77 },
    })
    expect(result).toMatchObject({ success: false, status: 'FAILED', errorCode: 'UNNAMED_QUANTITY_ROW', retryable: false })
    expect(result.message).toContain(targetChannel)
    for (const name of ADAPTERS) expect(service[name]).not.toHaveBeenCalled()
  })

  it('the lifecycle refusal still answers first — the new refusal masks nothing', async () => {
    // The SAME unnamed, quantity-carrying row, relabelled: the older verdict wins.
    expect(await service.dispatchSync({
      id: 'q-both', targetChannel: 'AMAZON', syncType: 'DELETE_LISTING', productId: 'p-1', payload: { quantity: 0 },
    })).toMatchObject({ errorCode: 'LIFECYCLE_DISPATCH_REFUSED' })
  })

  it.each([
    ['a listing', { channelListingId: 'cl-1' }],
    ['a shared ItemID', { channelListingId: null, externalListingId: '1234', payload: { pushVia: 'TRADING', itemId: '1234', quantity: 77 } }],
  ])('positive control: a quantity row naming %s reaches its adapter', async (_name, extra) => {
    expect(await service.dispatchSync({
      id: 'q-named', targetChannel: 'SHOPIFY', syncType: 'QUANTITY_UPDATE', productId: 'p-1', payload: { quantity: 77 }, ...extra,
    })).toEqual({ success: true })
    expect(service.syncToShopify).toHaveBeenCalledOnce()
  })
})

// ── D. the producer named in the plan row ───────────────────────────────────
describe('P4.3c: PATCH /api/catalog/products/:id queues no quantity', () => {
  it('never puts a quantity in the outbound payload', () => {
    const source = readFileSync(new URL('../routes/catalog.routes.ts', import.meta.url), 'utf8')
    // Strip comments first: the explanation of this rule quotes the code it removed.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    // Positive control for the stripper — it must not have emptied the file.
    expect(code).toContain('queueProductUpdate')
    expect(code.length).toBeGreaterThan(source.length / 2)
    expect(code).not.toMatch(/syncPayload\.quantity\s*=/)
    expect(code).not.toMatch(/["']QUANTITY_UPDATE["']/)
  })
})
