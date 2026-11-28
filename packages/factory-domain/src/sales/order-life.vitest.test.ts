import { describe, expect, it } from 'vitest'
import { ORDER_LIFE, orderLifeOf, type OrderLife } from './order-life'
import { SALES_ORDER_STATUSES, type SalesOrderStatus } from './orders/orders'
import { REQUEST_STATUSES } from './portal-ordering/rules'

/** owb- (order workflow, b2.3): the nine words in every door — every SalesOrderStatus and request status, and the notes. */
describe('orderLifeOf: the order\'s life in nine words', () => {
  it('has the nine words of the design, in its order', () => {
    expect(ORDER_LIFE).toEqual(['DRAFT', 'SENT', 'CONFIRMED', 'IN_PRODUCTION', 'READY_TO_SHIP', 'SHIPPED', 'AT_OUR_WAREHOUSE', 'DELIVERED', 'WITHDRAWN'])
  })

  it('every request status: Draft, Sent, Refused = Withdrawn (refused), Withdrawn, Accepted as a quote = Sent (quote)', () => {
    const of = Object.fromEntries(REQUEST_STATUSES.map((status) => [status, orderLifeOf({ request: { status } })]))
    expect(of).toEqual({
      DRAFT: { life: 'DRAFT', note: null },
      SENT: { life: 'SENT', note: null },
      ACCEPTED: { life: 'CONFIRMED', note: null },
      REFUSED: { life: 'WITHDRAWN', note: { kind: 'REFUSED' } },
      WITHDRAWN: { life: 'WITHDRAWN', note: null },
    })
    expect(orderLifeOf({ request: { status: 'ACCEPTED', acceptedAs: 'QUOTE' } })).toEqual({ life: 'SENT', note: { kind: 'QUOTE' } })
    expect(orderLifeOf({ request: { status: 'ACCEPTED', acceptedAs: 'ORDER' } })).toEqual({ life: 'CONFIRMED', note: null })
  })

  it('every SalesOrderStatus maps to one of the nine (no word left out, none invented)', () => {
    const of = Object.fromEntries(SALES_ORDER_STATUSES.map((status) => [status, orderLifeOf({ order: { status } }).life])) as Record<SalesOrderStatus, OrderLife>
    expect(of).toEqual({
      CONFIRMED: 'CONFIRMED',
      IN_PRODUCTION: 'IN_PRODUCTION',
      READY: 'READY_TO_SHIP',
      PARTLY_SHIPPED: 'SHIPPED',
      SHIPPED: 'SHIPPED',
      CLOSED: 'SHIPPED',
      CANCELLED: 'WITHDRAWN',
      PENDING_APPROVAL: 'SENT',
      DELIVERED: 'DELIVERED',
    })
    for (const life of Object.values(of)) expect(ORDER_LIFE).toContain(life)
  })

  it('the notes: waits for the office\'s yes, cancelled, partly shipped with the pieces, waits for the print, printed', () => {
    expect(orderLifeOf({ order: { status: 'PENDING_APPROVAL' } }).note).toEqual({ kind: 'WAITS_FOR_APPROVAL' })
    expect(orderLifeOf({ order: { status: 'CANCELLED' } }).note).toEqual({ kind: 'CANCELLED' })
    expect(orderLifeOf({ order: { status: 'PARTLY_SHIPPED', pieces: { shipped: 40, total: 114 } } })).toEqual({ life: 'SHIPPED', note: { kind: 'PARTLY_SHIPPED', shipped: 40, total: 114 } })
    expect(orderLifeOf({ order: { status: 'PARTLY_SHIPPED' } }).note).toEqual({ kind: 'PARTLY_SHIPPED', shipped: 0, total: 0 })
    expect(orderLifeOf({ order: { status: 'CONFIRMED', printed: false } })).toEqual({ life: 'CONFIRMED', note: { kind: 'WAITS_FOR_PRINT' } })
    expect(orderLifeOf({ order: { status: 'CONFIRMED', printed: true } })).toEqual({ life: 'CONFIRMED', note: { kind: 'PRINTED' } })
    expect(orderLifeOf({ order: { status: 'CONFIRMED', printed: null } }).note).toBeNull()
    for (const status of ['IN_PRODUCTION', 'READY', 'SHIPPED', 'CLOSED', 'DELIVERED'] as const) expect(orderLifeOf({ order: { status } }).note, status).toBeNull()
  })

  it('Shipped and Closed: at our warehouse while the leg arrived and was not sent on; Delivered once every shipment that left arrived (as customerStatusOf)', () => {
    expect(orderLifeOf({ order: { status: 'SHIPPED', atOurWarehouse: true, shipments: { left: 1, delivered: 0 } } }).life).toBe('AT_OUR_WAREHOUSE')
    expect(orderLifeOf({ order: { status: 'CLOSED', atOurWarehouse: true } }).life).toBe('AT_OUR_WAREHOUSE')
    expect(orderLifeOf({ order: { status: 'SHIPPED', shipments: { left: 2, delivered: 2 } } }).life).toBe('DELIVERED')
    expect(orderLifeOf({ order: { status: 'CLOSED', shipments: { left: 2, delivered: 2 } } }).life).toBe('DELIVERED')
    expect(orderLifeOf({ order: { status: 'CLOSED', shipments: { left: 2, delivered: 1 } } }).life).toBe('SHIPPED')
    expect(orderLifeOf({ order: { status: 'SHIPPED', atOurWarehouse: false, shipments: { left: 0, delivered: 0 } } }).life).toBe('SHIPPED')
  })

  it('the order wins over its request once confirmed; neither record reads as a draft', () => {
    expect(orderLifeOf({ request: { status: 'ACCEPTED', acceptedAs: 'ORDER' }, order: { status: 'IN_PRODUCTION' } }).life).toBe('IN_PRODUCTION')
    expect(orderLifeOf({})).toEqual({ life: 'DRAFT', note: null })
  })
})
