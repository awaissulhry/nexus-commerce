import type { SettlementAnswer } from '@nexus/factory-domain/sales/orders/orders'
import { settlementOf } from '../../invoicing/from-shipment/settlement'
import type { Reader } from './store'

/**
 * Is the order settled: every line shipped, invoiced and paid? (PLAN §4.7 "Closing the order": B-W1-25 builds the CLOSED
 * state and the close command, whose guard asks this port; B-W1-51 answers it in the money module.) Read-only, inside
 * the caller's transaction or on its client.
 *
 * The answer is the money module's own computation, read now (modules/invoicing/from-shipment/settlement `settlementOf`:
 * every size shipped and billed by issued TD01/TD24, every fiscal document delivered by SDI, the deposits deducted, the
 * balance paid, no refund due), never a stored flag. Its `order.fully_settled` event is only the trigger: the worker's
 * handler (./handlers) asks this port again under the order's lock before it closes. Tests may put another port in
 * place (`useOrderSettlement`).
 */

export interface OrderSettlementPort {
  settlementOf(db: Reader, order: { readonly id: string }): Promise<SettlementAnswer>
}

/** The money module's settlement (B-W1-51), as the close guard reads it. */
export const moneySettlementPort: OrderSettlementPort = {
  async settlementOf(db, order) {
    const found = await settlementOf(db, order.id)
    if (!found) return { settled: false, missing: [{ code: 'NOT_FOUND', message: 'The order is not found.' }], source: 'invoicing' }
    return { settled: found.settlement.settled, missing: found.settlement.missing.map((gap) => ({ code: gap.code, message: gap.message })), source: 'invoicing' }
  },
}

let current: OrderSettlementPort = moneySettlementPort

/** Another port (a test's); `undefined` puts the money module's back. */
export function useOrderSettlement(port: OrderSettlementPort | undefined): void {
  current = port ?? moneySettlementPort
}

/** The port in use. */
export const orderSettlement = (): OrderSettlementPort => current
