import { describe, expect, it } from 'vitest'
import { HOME, SHIPPABLE, TODAY } from '../orders/design-data'
import { freeNoteKey, orderOfTask, replyHref, supplierKindOf, tilesFor, tilesOf, upcomingOf } from './model'

/**
 * SCR-189 › Home (B-W2b-179), pure: the five counts and where each opens (a page not built yet is a count without a link; a
 * page the person cannot open is no tile at all), the next deliveries by date, where "Reply" goes, the PO a "Confirm" row names.
 */

const BUILT = { orders: true, deliveries: false, documents: false, jobs: false }
const everything = () => true

describe('at a glance', () => {
  it('a supplier counts its orders, deliveries and documents; a workshop its jobs', () => {
    expect(tilesFor('SUPPLIER', BUILT).map((tile) => tile.key)).toEqual(['purchase_orders.to_confirm', 'deliveries.to_announce', 'purchase_orders.late', 'supplier_documents.expiring', 'deliveries.on_the_way'])
    expect(tilesFor('SUBCONTRACTOR', BUILT).map((tile) => tile.key)).toEqual(['jobs.to_accept', 'jobs.kit_to_confirm', 'jobs.ready_to_send_back', 'jobs.late', 'supplier_documents.expiring'])
  })

  it('each tile opens its list once that page is built; a count that could not be read is null, never 0', () => {
    const tiles = tilesOf(tilesFor('SUPPLIER', BUILT), HOME, everything)
    expect(tiles.find((tile) => tile.key === 'purchase_orders.to_confirm')).toMatchObject({ value: 2, href: '/orders?chip=TO_CONFIRM' })
    expect(tiles.find((tile) => tile.key === 'deliveries.to_announce')).toMatchObject({ value: 3, href: null })
    expect(tiles.find((tile) => tile.key === 'supplier_documents.expiring')?.value).toBeNull()
    expect(tilesOf(tilesFor('SUPPLIER', BUILT), null, everything).every((tile) => tile.value === null)).toBe(true)
  })

  it('fails closed: no tile for a page the person cannot open', () => {
    const tiles = tilesOf(tilesFor('SUPPLIER', BUILT), HOME, (permission) => permission === 'portal.purchaseOrders.view')
    expect(tiles.map((tile) => tile.key)).toEqual(['purchase_orders.to_confirm', 'purchase_orders.late'])
  })
})

describe('next deliveries', () => {
  it('the open lines by the day they are expected (a confirmed date first, else the date asked), late first, at most ten', () => {
    const lines = upcomingOf(SHIPPABLE, TODAY)
    expect(lines.map((line) => [line.code, line.late, line.announced])).toEqual([
      ['CP-NAPPA-N01', true, false],
      ['FOD-MESH-02', false, true],
      ['CP-PR-1', false, false],
    ])
    expect(upcomingOf(SHIPPABLE, TODAY, 1)).toHaveLength(1)
    expect(upcomingOf(null, TODAY)).toEqual([])
    expect(upcomingOf({ ...SHIPPABLE, orders: [{ ...SHIPPABLE.orders[0]!, lines: [{ ...SHIPPABLE.orders[0]!.lines[0]!, open: '0.0000' }] }] }, TODAY)).toEqual([])
  })
})

describe('rows of Home', () => {
  it('Reply opens the record’s Messages; Confirm names its PO; Free for suppliers is hidden per person', () => {
    const conversation = { record: { type: 'PurchaseOrder', id: 'po1', theirRef: null, ourRef: 'PO-1', subtitle: null, status: null } }
    expect(replyHref('/p/X', conversation, true)).toBe('/p/X/orders/po1?tab=messages#messages')
    expect(replyHref('/p/X', conversation, false)).toBe('/p/X/open/PurchaseOrder/po1#messages')
    expect(orderOfTask({ kind: 'CONFIRM_PO', href: '/p/X/open/PurchaseOrder/0190f0e2-7777-7000-8000-000000000001#task:a' })).toBe('0190f0e2-7777-7000-8000-000000000001')
    expect(orderOfTask({ kind: 'UPLOAD_DOCUMENT', href: '/p/X/open/PurchaseOrder/0190f0e2-7777-7000-8000-000000000001' })).toBeNull()
    expect(supplierKindOf(['SUBCONTRACTOR'])).toBe('SUBCONTRACTOR')
    expect(supplierKindOf(['SUPPLIER', 'SUBCONTRACTOR'])).toBe('SUPPLIER')
    expect(freeNoteKey('u1')).toBe('fw-portal-free-note:u1')
  })
})
