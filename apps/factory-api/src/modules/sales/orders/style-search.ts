import type { Prisma } from '@nexus/factory-db'
import { listPriceOf } from '../quotes/list-price'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { officeOrder } from './moves'
import { orderPriceChain } from './pricing'
import type { Reader } from './store'

/**
 * B-OL-033 (order lines plan, 18 F1 and F24) — the style search for an order: "Add a style" on the order's Lines tab
 * (`GET /product/styles?forOrder=<orderId>`, modules/product/styles listStyles). Owner rule 2026-11-16: "One brand must not be
 * able to see anything related to any other brand". The plain style search follows the person's reach, so the Owner and Sales
 * met another customer's private-label styles while adding to this customer's order (only the save refused them,
 * ../line-checks/private-label.ts). For an order it answers:
 *
 *   which styles  our own collection (no brand) and the order's customer's own private-label styles — a rider's team's too, as
 *                 the save allows them (B-W2b-290) — of the order's company (or every company's); never another customer's,
 *                 still within the person's own reach of styles
 *   the order     read as the person reads it (orders.view over its customer): an order they may not see, of another customer
 *                 or unknown, is "Sales order not found." in the same words
 *   priced        per active colourway, whether the customer's price list prices it (./pricing.ts orderPriceChain, the chain a
 *                 new line of the order is priced from): a yes or no, never the price, so every reader of the search may know it
 *                 (F24: Sales holds a colour with no list price in the dialog; someone who sees prices types it)
 */

/** One active colourway of a listed style, as the search for an order names it. */
export interface OrderColourway {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly listPriced: boolean
}

export interface OrderStyleSearch {
  /** The styles the order may take (beside the person's own reach and the search's other filters). */
  readonly where: Prisma.StyleWhereInput
  /** The active colourways of these styles, by style, each with whether the customer's price list prices it. */
  colourwaysOf(db: Reader, styleIds: readonly string[]): Promise<Map<string, OrderColourway[]>>
}

export async function orderStyleSearch(caller: CommandCaller, orderId: string): Promise<OrderStyleSearch> {
  const order = await officeOrder(caller, orderId)
  const team = await caller.withClient((client) => client.party.findUnique({ where: { id: order.partyId }, select: { teamPartyId: true } }))
  const own = [order.partyId, ...(team?.teamPartyId ? [team.teamPartyId] : [])]
  return {
    where: { AND: [{ OR: [{ brandPartyId: null }, { brandPartyId: { in: own } }] }, { OR: [{ companyId: order.companyId }, { companyId: null }] }] },
    async colourwaysOf(db, styleIds) {
      const out = new Map<string, OrderColourway[]>()
      if (styleIds.length === 0) return out
      const rows = await db.colourway.findMany({ where: { styleId: { in: [...styleIds] }, status: 'ACTIVE' }, select: { id: true, styleId: true, code: true, name: true }, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
      const { party, chain } = await orderPriceChain(db, order, serverClock.now(), styleIds)
      for (const row of rows) {
        const list = out.get(row.styleId) ?? []
        list.push({ id: row.id, code: row.code, name: row.name, listPriced: listPriceOf(chain, order.taxMode, party, row.styleId, row.id) !== null })
        out.set(row.styleId, list)
      }
      return out
    },
  }
}
