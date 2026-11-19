import { z } from 'zod'
import { defineEvent, livePartyId } from '../events/define'

/**
 * B-CP-017 (customer page plan C3; design customer-page 11 §1.2; the money wall, Owner O1-O4): the customer's own price of a
 * sales order changed (factory-db sales-brand-prices.prisma OrderBrandPrice) — typed or removed by the office (apps/factory-api
 * modules/sales/brand-prices), taken over from the customer's portal request, carried by a split, or removed with its line
 * (B-CP-024). Emitted once per command that changed a row, about the order (`subject`).
 *
 *   sales_order.brand_price_changed   the customer's prices of an order changed: its price check reads differently now
 *
 * The money wall: the payload names the order and its customer only — never an amount, a currency, a state ("equal", "not
 * equal"), a count of lines or who typed it. Live: only to an office viewer who holds the PRICE grain over the order's company
 * and customer (`money.price` is a permission like any other: events/live.ts can()), so the "Price check" card and the price
 * columns re-read; a Sales worker, a Production manager or the floor is never sent it (the screen they see has no price to
 * re-read). The brand wall: `partyId` (livePartyId) is the order's customer, never in the live fields; a viewer limited to
 * other customers is not sent it. OFFICE ONLY: the portal is never told here (its own price check is B-CP-019's).
 */

const live = { permission: 'money.price', fields: ['orderId'] } as const

export const brandPriceChanged = defineEvent({
  type: 'sales_order.brand_price_changed',
  context: 'brand-prices',
  description: "The customer's own prices of a sales order changed (typed, removed, taken over from its request, or carried by a split).",
  payload: z.strictObject({ orderId: z.uuid(), partyId: livePartyId() }),
  live,
})

export const events = [brandPriceChanged] as const
