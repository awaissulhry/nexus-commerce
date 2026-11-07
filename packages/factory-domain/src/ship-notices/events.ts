import { z } from 'zod'
import { defineEvent } from '../events/define'
import { SHIP_NOTICE_STATUSES, VERDICTS } from '../purchasing/ship-notices/rules'

/**
 * Ship notices (B-W2b-182; SCM-106, SCM-107, SCM-110). apps/factory-api's modules/purchasing/ship-notices emits them in the
 * command that changes the notice: the supplier in the portal (sent, changed, cancelled), our dock (its note), the goods
 * receipt that names it (received) and its reversal (reopened). Their own module folder because check-event-contract
 * wants `src/<module>/events.ts` (the code is purchasing/ship-notices). A draft is the supplier's own work: no event.
 *
 *   ship_notice.sent       the supplier announced a delivery (numbered from the company's ASN series)
 *   ship_notice.changed    a sent notice changed: its terms (dates, carrier, tracking, DDT), its lines or packing list, or
 *                          our dock note
 *   ship_notice.cancelled  the supplier cancelled a sent notice before it was received (its lines are open again)
 *   ship_notice.received   a posted goods receipt named it: what came per line is kept (with or without differences)
 *   ship_notice.reopened   that receipt was reversed: the notice waits for the goods again
 *
 * Office screens: inventory.stock.view over the notice's company and site (Warehouse › Receipts, the inbound board).
 * Partner sessions: the portal's own list (portal/notifications/live.ts) for the supplier's own party. Ids, numbers, dates,
 * counts and states: never a price, an amount or a person's name.
 */

const live = { permission: 'inventory.stock.view', fields: ['shipNoticeId', 'number', 'purchaseOrderId', 'status', 'partyId'] } as const
const base = { shipNoticeId: z.uuid(), number: z.string().min(1).max(40), purchaseOrderId: z.uuid(), partyId: z.uuid(), status: z.enum(SHIP_NOTICE_STATUSES) }
const day = z.iso.date()

export const events = [
  defineEvent({
    type: 'ship_notice.sent',
    context: 'ship-notices',
    description: 'A supplier announced a delivery against a purchase order (lines, lots and dye batches, the packing list per hide, transport): numbered from the company ASN series, it is on the inbound board.',
    payload: z.strictObject({ ...base, shipDate: day, expectedDate: day, lines: z.number().int().min(1), hides: z.number().int().min(0), verdict: z.enum(VERDICTS) }),
    live,
  }),
  defineEvent({
    type: 'ship_notice.changed',
    context: 'ship-notices',
    description: 'A sent ship notice changed before it was received: its terms, its lines or its packing list (by the supplier), or our dock note.',
    payload: z.strictObject({ ...base, what: z.enum(['TERMS', 'LINES', 'PACKING_LIST', 'DOCK_NOTE']), expectedDate: day.nullable() }),
    live,
  }),
  defineEvent({
    type: 'ship_notice.cancelled',
    context: 'ship-notices',
    description: 'The supplier cancelled a sent ship notice before it was received, with its reason; its lines are open again.',
    payload: z.strictObject({ ...base }),
    live,
  }),
  defineEvent({
    type: 'ship_notice.received',
    context: 'ship-notices',
    description: 'A posted goods receipt named the ship notice: it is received, with what came per line (the lines that differ from what was announced counted).',
    payload: z.strictObject({ ...base, receiptId: z.uuid(), lines: z.number().int().min(0), differing: z.number().int().min(0) }),
    live,
  }),
  defineEvent({
    type: 'ship_notice.reopened',
    context: 'ship-notices',
    description: 'The goods receipt of a ship notice was reversed: the notice waits for the goods again.',
    payload: z.strictObject({ ...base, receiptId: z.uuid() }),
    live,
  }),
] as const
