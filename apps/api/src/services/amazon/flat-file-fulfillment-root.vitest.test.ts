/**
 * Amazon sheet gaps U4b (bugs 1, 9) — the old flat-file page builds ONE `fulfillment_availability` root per row, for the
 * feed and for the local save alike. A filled restock date or "always available" used to fall through to the generic
 * column loop, which replaced the whole root and lost the code and the quantity (the FBA-flip path on the next save).
 * An FBA row sends only its code; a label value is read as the code it names; deep offer columns never build an offer
 * without our price. Expected payloads are written out in full. Pure: no database.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { AmazonFlatFileService } from './flat-file.service.js'

const IT = 'APJ6JRA9NG5V4'
const svc = new AmazonFlatFileService({} as never, {} as never)

// The manifest's Pattern C expansion of fulfillment_availability (what the route passes as expandedFields).
const EXPANDED: Record<string, string> = {
  fulfillment_availability__fulfillment_channel_code: 'fulfillment_availability.fulfillment_channel_code',
  fulfillment_availability__quantity: 'fulfillment_availability.quantity',
  fulfillment_availability__lead_time_to_ship_max_days: 'fulfillment_availability.lead_time_to_ship_max_days',
  fulfillment_availability__restock_date: 'fulfillment_availability.restock_date',
  fulfillment_availability__is_inventory_available: 'fulfillment_availability.is_inventory_available',
}
const LABELS = { enumCodeMap: { 'fulfillment_availability.is_inventory_available': { Abilitato: 'true', Disabilitato: 'false' } } }

const feedAttrs = (row: Record<string, unknown>, feedSchema: Record<string, unknown> = {}) =>
  JSON.parse(svc.buildJsonFeedBodyWithReport([{ item_sku: 'SKU-1', product_type: 'GLOVES', ...row } as never], 'IT', 'SELLER', EXPANDED, feedSchema as never).body)
    .messages[0].attributes as Record<string, any>
const savedAttrs = (row: Record<string, unknown>, enumCodeMap: Record<string, Record<string, string>> = {}) =>
  (svc as any).buildCollapsedAttrs({ item_sku: 'SKU-1', product_type: 'GLOVES', ...row }, EXPANDED, 'IT', IT, 'it_IT', enumCodeMap) as Record<string, any>

beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-02T09:00:00Z')) })
afterAll(() => { vi.useRealTimers() })

const FBM_ROW = {
  fulfillment_availability__fulfillment_channel_code: 'DEFAULT',
  fulfillment_availability__quantity: '5',
  fulfillment_availability__lead_time_to_ship_max_days: '3',
  fulfillment_availability__restock_date: '2026-11-01',
}
const FBM_ROOT = [{ fulfillment_channel_code: 'DEFAULT', quantity: 5, lead_time_to_ship_max_days: 3, restock_date: '2026-11-01' }]

describe('one fulfilment root: code + quantity + lead time + restock (bug 1)', () => {
  it('the feed: DEFAULT, qty 5, restock 2026-11-01 → one root holds all of them', () => {
    expect(feedAttrs(FBM_ROW).fulfillment_availability).toEqual(FBM_ROOT)
  })

  it('the local save: the same root', () => {
    expect(savedAttrs(FBM_ROW).fulfillment_availability).toEqual(FBM_ROOT)
  })

  it('always available joins the same root (a label value is read as its boolean)', () => {
    const row = { ...FBM_ROW, fulfillment_availability__is_inventory_available: 'Disabilitato' }
    const root = [{ ...FBM_ROOT[0], is_inventory_available: false }]
    expect(feedAttrs(row, LABELS).fulfillment_availability).toEqual(root)
    expect(savedAttrs(row, LABELS.enumCodeMap).fulfillment_availability).toEqual(root)
    expect(feedAttrs({ ...FBM_ROW, fulfillment_availability__is_inventory_available: 'true' }).fulfillment_availability)
      .toEqual([{ ...FBM_ROOT[0], is_inventory_available: true }])
  })

  it('a restock date that has passed is not sent; the code and the quantity stay', () => {
    const row = { ...FBM_ROW, fulfillment_availability__restock_date: '2026-09-01' }
    expect(feedAttrs(row).fulfillment_availability).toEqual([{ fulfillment_channel_code: 'DEFAULT', quantity: 5, lead_time_to_ship_max_days: 3 }])
  })

  it('a restock date alone (no quantity) still carries the code', () => {
    const row = { fulfillment_availability__fulfillment_channel_code: 'DEFAULT', fulfillment_availability__restock_date: '2026-11-01' }
    expect(feedAttrs(row).fulfillment_availability).toEqual([{ fulfillment_channel_code: 'DEFAULT', restock_date: '2026-11-01' }])
    expect(savedAttrs(row).fulfillment_availability).toEqual([{ fulfillment_channel_code: 'DEFAULT', restock_date: '2026-11-01' }])
  })

  it('MFN is the merchant code DEFAULT', () => {
    expect(feedAttrs({ ...FBM_ROW, fulfillment_availability__fulfillment_channel_code: 'MFN' }).fulfillment_availability).toEqual(FBM_ROOT)
  })

  it('a parent carries no fulfilment root', () => {
    expect(feedAttrs({ ...FBM_ROW, parentage_level: 'parent' }).fulfillment_availability).toBeUndefined()
    expect(savedAttrs({ ...FBM_ROW, parentage_level: 'parent' }).fulfillment_availability).toBeUndefined()
  })

  it('a blank or unknown code sends no root at all (fail-closed), and saves none', () => {
    const { fulfillment_availability__fulfillment_channel_code: _code, ...noCode } = FBM_ROW
    expect(feedAttrs(noCode).fulfillment_availability).toBeUndefined()
    expect(savedAttrs(noCode).fulfillment_availability).toBeUndefined()
    expect(feedAttrs({ ...FBM_ROW, fulfillment_availability__fulfillment_channel_code: 'SOMETHING' }).fulfillment_availability).toBeUndefined()
  })
})

describe('no merchant leaves under FBA (bug 9)', () => {
  const FBA_ROW = {
    fulfillment_availability__fulfillment_channel_code: 'AMAZON_EU',
    fulfillment_availability__quantity: '9',
    fulfillment_availability__lead_time_to_ship_max_days: '3',
    fulfillment_availability__restock_date: '2026-11-01',
    fulfillment_availability__is_inventory_available: 'true',
  }

  it('an AMAZON_EU row sends only the code: no quantity, lead time, restock or always available', () => {
    expect(feedAttrs(FBA_ROW).fulfillment_availability).toEqual([{ fulfillment_channel_code: 'AMAZON_EU' }])
  })

  it('the local save keeps only the code too', () => {
    expect(savedAttrs(FBA_ROW).fulfillment_availability).toEqual([{ fulfillment_channel_code: 'AMAZON_EU' }])
  })

  it('a Remote Fulfilment code is never rebuilt: no root, Amazon keeps its own', () => {
    expect(feedAttrs({ ...FBA_ROW, fulfillment_availability__fulfillment_channel_code: 'AMAZON_EU_RAFN' }).fulfillment_availability).toBeUndefined()
  })
})

describe('label values are read as their code, never sent as text', () => {
  it.each([
    ['Gestito dal venditore (default)'],
    ['GESTITO DAL VENDITORE (DEFAULT)'],
  ])('%s → DEFAULT with its quantity', (label) => {
    const row = { ...FBM_ROW, fulfillment_availability__fulfillment_channel_code: label }
    expect(feedAttrs(row).fulfillment_availability).toEqual(FBM_ROOT)
    expect(savedAttrs(row).fulfillment_availability).toEqual(FBM_ROOT)
  })

  it('Logistica di Amazon (UE) → AMAZON_EU, code only', () => {
    const row = { ...FBM_ROW, fulfillment_availability__fulfillment_channel_code: 'Logistica di Amazon (UE)' }
    expect(feedAttrs(row).fulfillment_availability).toEqual([{ fulfillment_channel_code: 'AMAZON_EU' }])
    expect(savedAttrs(row).fulfillment_availability).toEqual([{ fulfillment_channel_code: 'AMAZON_EU' }])
  })

  it('the submit FBA guard reads a label too: DEFAULT + quantity on an FBA SKU is a violation', async () => {
    const prisma = {
      product: { findMany: async () => [{ id: 'p1', sku: 'SKU-1', fulfillmentMethod: 'FBA' }] },
      stockLevel: { findMany: async () => [] },
    }
    const guard = new AmazonFlatFileService(prisma as never, {} as never)
    const rows = [{ item_sku: 'SKU-1', fulfillment_availability__fulfillment_channel_code: 'Gestito dal venditore (default)', fulfillment_availability__quantity: '5' }]
    expect(await guard.findFbaQtyViolations(rows, 'IT')).toEqual([{ sku: 'SKU-1', channel: 'DEFAULT' }])
    expect(await guard.findFbaQtyRows(rows)).toEqual([{ sku: 'SKU-1', channel: 'DEFAULT', severity: 'block' }])
  })
})

describe('deep offer columns never build an offer without our price (bug 9)', () => {
  const deepFields = {
    purchasable_offer__minimum_seller_allowed_price__schedule__value_with_tax: {
      field: 'purchasable_offer', rootIdx: 1, leaf: 'value_with_tax', type: 'number',
      segs: [{ key: 'minimum_seller_allowed_price', idx: 1 }, { key: 'schedule', idx: 1 }],
    },
  }

  it('without a price: no purchasable_offer at all (a partial update would clear the price)', () => {
    const attrs = feedAttrs({ purchasable_offer__minimum_seller_allowed_price__schedule__value_with_tax: '30' }, { deepFields })
    expect(attrs.purchasable_offer).toBeUndefined()
  })

  it('with a price: the deep leaf joins the one offer', () => {
    const attrs = feedAttrs({
      purchasable_offer__our_price: '49.90', purchasable_offer__currency: 'EUR',
      purchasable_offer__minimum_seller_allowed_price__schedule__value_with_tax: '30',
    }, { deepFields })
    expect(attrs.purchasable_offer).toEqual([{
      currency: 'EUR', marketplace_id: IT, audience: 'ALL',
      our_price: [{ schedule: [{ value_with_tax: 49.9 }] }],
      minimum_seller_allowed_price: [{ schedule: [{ value_with_tax: 30 }] }],
    }])
  })

  it('a parent never gets an offer from deep columns', () => {
    const attrs = feedAttrs({ parentage_level: 'parent', purchasable_offer__minimum_seller_allowed_price__schedule__value_with_tax: '30' }, { deepFields })
    expect(attrs.purchasable_offer).toBeUndefined()
  })
})
