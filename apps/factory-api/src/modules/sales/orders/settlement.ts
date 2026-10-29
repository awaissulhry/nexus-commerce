import type { SettlementAnswer } from '@nexus/factory-domain/sales/orders/orders'
import type { Reader } from './store'

/**
 * Is the order settled: every line shipped, invoiced and paid? (PLAN §4.7 "Closing the order": B-W1-25 builds the CLOSED
 * state and the close command, whose guard asks this port; B-W1-51 answers it in the money module.) Read-only, inside
 * the caller's transaction or on its client.
 *
 * Until the money module plugs its own computation in (`useOrderSettlement`), the answer is its word: the newest of the
 * order's settle events, `order.fully_settled` (settled) or `order.unsettled` (not any more, with what is missing). The
 * money module emits one per change, under its lock on the order, so the newest is the state now. No event: not
 * settled (nothing says so yet).
 */

export interface OrderSettlementPort {
  settlementOf(db: Reader, order: { readonly id: string }): Promise<SettlementAnswer>
}

export const SETTLE_EVENTS = ['order.fully_settled', 'order.unsettled'] as const

/** The money module's gap codes (B-W1-51 invoicing/from-shipment/settlement), in words. */
const GAP_WORDS: Readonly<Record<string, string>> = Object.freeze({
  ORDER_CANCELLED: 'The order is cancelled.',
  NOT_SHIPPED: 'Not every ordered piece is shipped.',
  NOT_INVOICED: 'Not every shipped piece is invoiced.',
  OVER_INVOICED: 'More is invoiced than shipped.',
  NO_INVOICE: 'No invoice bills the order yet.',
  AT_SDI: 'An invoice is not delivered by SDI yet.',
  DEPOSIT_NOT_DEDUCTED: 'A deposit invoice is not deducted in full yet.',
  DEPOSIT_NOT_INVOICED: 'A paid deposit has no deposit invoice yet.',
  BALANCE_DUE: 'A balance is still due.',
  REFUND_DUE: 'A refund is due to the customer.',
})

const NOTHING_YET: SettlementAnswer = Object.freeze({
  settled: false,
  missing: Object.freeze([{ code: 'NOT_SETTLED', message: 'Nothing says yet that every line is shipped, invoiced and paid.' }]),
  source: 'settle-events',
})

/** The default port: the newest settle event of the order. */
export const settleEventsPort: OrderSettlementPort = {
  async settlementOf(db, order) {
    const last = await db.outboxEvent.findFirst({
      where: { type: { in: [...SETTLE_EVENTS] }, payload: { path: ['orderId'], equals: order.id } },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      select: { type: true, payload: true },
    })
    if (!last) return NOTHING_YET
    if (last.type === 'order.fully_settled') return { settled: true, missing: [], source: 'settle-events' }
    const payload = (last.payload ?? {}) as { missing?: unknown }
    const codes = Array.isArray(payload.missing) ? payload.missing.filter((code): code is string => typeof code === 'string') : []
    const missing = codes.length > 0 ? codes.map((code) => ({ code, message: GAP_WORDS[code] ?? `Not settled: ${code}.` })) : [{ code: 'UNSETTLED', message: 'The order is not settled any more.' }]
    return { settled: false, missing, source: 'settle-events' }
  },
}

let current: OrderSettlementPort = settleEventsPort

/** The money module's computation (or a test's); `undefined` puts the settle events back. */
export function useOrderSettlement(port: OrderSettlementPort | undefined): void {
  current = port ?? settleEventsPort
}

/** The port in use. */
export const orderSettlement = (): OrderSettlementPort => current
