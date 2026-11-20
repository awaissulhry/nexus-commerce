import { describe, expect, it } from 'vitest'
import { orderLinkCountsOf, type LinkChain } from './linked-counts'

/**
 * B-OO-012 (order overview §6; review F5; Owner D8): the ONE count of an order's linked records — live records only, what was
 * cancelled counted apart; drafts, credit notes (TD04) and deposit invoices (TD02) in their own parts. Made-up chains.
 */

const NONE: LinkChain = { workOrders: [], shipments: [], invoices: [], depositRequests: [] }
const chain = (parts: Partial<LinkChain>): LinkChain => ({ ...NONE, ...parts })
const wo = (status: string) => ({ status, id: `wo-${status}`, number: `WO-${status}` })
const shipment = (id: string, status: string, ddt: { number: string; date: string } | null = null, externalDdt: { number: string; date: string } | null = null) => ({ id, status, ddt, externalDdt })
const invoice = (docType: string, status: string) => ({ docType, status })

describe('orderLinkCountsOf: work orders', () => {
  it('each live state lands in its part; a cancelled one is counted apart, never in live', () => {
    const counts = orderLinkCountsOf(chain({ workOrders: ['DRAFT', 'RELEASED', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED', 'CLOSED', 'CANCELLED', 'CANCELLED'].map(wo) }))
    expect(counts.workOrders).toEqual({ live: 6, inWork: 2, draft: 1, onHold: 1, done: 2, cancelled: 2 })
    expect(counts.workOrders.inWork + counts.workOrders.draft + counts.workOrders.onHold + counts.workOrders.done).toBe(counts.workOrders.live)
  })

  it('only cancelled ones: nothing live (the Production badge says 0, the card says "1 cancelled" in words)', () => {
    expect(orderLinkCountsOf(chain({ workOrders: [wo('CANCELLED')] })).workOrders).toEqual({ live: 0, inWork: 0, draft: 0, onHold: 0, done: 0, cancelled: 1 })
  })
})

describe('orderLinkCountsOf: shipments and the last DDT', () => {
  it('a cancelled shipment is counted apart and its DDT is never the last one; a returned one stands', () => {
    const counts = orderLinkCountsOf(
      chain({
        shipments: [
          shipment('sh-1', 'SHIPPED', { number: '100/2026', date: '2026-11-02' }),
          shipment('sh-2', 'CANCELLED', { number: '102/2026', date: '2026-11-09' }),
          shipment('sh-3', 'RETURNED', { number: '101/2026', date: '2026-11-05' }),
          shipment('sh-4', 'DRAFT'),
        ],
      }),
    )
    expect(counts.shipments).toEqual({ live: 3, cancelled: 1, lastDdt: { number: '101/2026', date: '2026-11-05', shipmentId: 'sh-3', external: false } })
  })

  it('the paper DDT of a shipment made elsewhere counts; on the same day the later in the chain wins; none yet: null', () => {
    const elsewhere = orderLinkCountsOf(chain({ shipments: [shipment('sh-1', 'SHIPPED', { number: '100/2026', date: '2026-11-02' }), shipment('sh-2', 'SHIPPED', null, { number: 'P-7', date: '2026-11-02' })] }))
    expect(elsewhere.shipments.lastDdt).toEqual({ number: 'P-7', date: '2026-11-02', shipmentId: 'sh-2', external: true })
    expect(orderLinkCountsOf(chain({ shipments: [shipment('sh-1', 'DRAFT'), shipment('sh-2', 'PACKED')] })).shipments).toEqual({ live: 2, cancelled: 0, lastDdt: null })
    // The web's schema leaves both DDT fields out of an older answer: still counted.
    expect(orderLinkCountsOf(chain({ shipments: [{ id: 'sh-1', status: 'SHIPPED' }] })).shipments).toEqual({ live: 1, cancelled: 0, lastDdt: null })
  })
})

describe('orderLinkCountsOf: invoices and deposit requests', () => {
  it('issued = every one past DRAFT, credit notes (TD04) and deposit invoices (TD02) among them; drafts apart', () => {
    const counts = orderLinkCountsOf(
      chain({
        invoices: [invoice('TD01', 'ISSUED'), invoice('TD24', 'DELIVERED'), invoice('TD04', 'SENT'), invoice('TD02', 'ISSUED'), invoice('TD01', 'DRAFT'), invoice('TD04', 'DRAFT'), invoice('TD02', 'DRAFT')],
      }),
    )
    expect(counts.invoices).toEqual({ issued: 4, drafts: 3, creditNotes: 1, deposits: 1 })
  })

  it('open deposit requests only; a cancelled one is counted apart (paid and waived are neither)', () => {
    expect(orderLinkCountsOf(chain({ depositRequests: ['OPEN', 'OPEN', 'PAID', 'WAIVED', 'CANCELLED'].map((status) => ({ status })) })).depositRequests).toEqual({ open: 2, cancelled: 1 })
  })

  it('an order with nothing linked: every number 0, no DDT', () => {
    expect(orderLinkCountsOf(NONE)).toEqual({
      workOrders: { live: 0, inWork: 0, draft: 0, onHold: 0, done: 0, cancelled: 0 },
      shipments: { live: 0, cancelled: 0, lastDdt: null },
      invoices: { issued: 0, drafts: 0, creditNotes: 0, deposits: 0 },
      depositRequests: { open: 0, cancelled: 0 },
    })
  })
})

describe('a live number never counts a cancelled record', () => {
  it('whatever the mix, live = all − cancelled for work orders and shipments', () => {
    const statuses = ['DRAFT', 'CANCELLED', 'RELEASED', 'CANCELLED', 'COMPLETED']
    const counts = orderLinkCountsOf(chain({ workOrders: statuses.map(wo), shipments: statuses.map((status, index) => shipment(`sh-${index}`, status)) }))
    expect([counts.workOrders.live, counts.workOrders.cancelled]).toEqual([3, 2])
    expect([counts.shipments.live, counts.shipments.cancelled]).toEqual([3, 2])
  })
})
