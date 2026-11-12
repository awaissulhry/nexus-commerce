import { z } from 'zod'
import { defineEvent } from '../events/define'
import { AGREEMENT_STATUSES } from '../purchasing/subcontract-depth/terms'
import { CONSUMPTION_KINDS } from '../purchasing/subcontract-depth/balance'
import { COST_KINDS } from '../purchasing/subcontract-depth/cost'
import { SUBCONTRACT_ORDER_STATUSES } from '../purchasing/subcontracting/rules'

/**
 * Subcontracting in depth (B-W2b-331; SCM-049, SCM-143, SCM-144, SCM-146). apps/factory-api's
 * modules/purchasing/subcontract-depth emits them in the command that writes the change. Their own module folder because
 * check-event-contract wants `src/<module>/events.ts` (the code is purchasing/subcontract-depth); the order's types stay
 * `subcontract_order.*`, so the office's subcontract order record refreshes on them as on W2a's.
 *
 *   subcontract_agreement.changed      the written terms with a workshop: a revision written, its draft changed or deleted,
 *                                      signed (the revision in force superseded in the same act) or ended with why
 *   subcontract_order.balance_booked   the workshop's declaration of the material it used, returned and scrapped, or an
 *                                      adjustment after the receipt, booked (the material moved where it went)
 *   subcontract_order.cost_booked      a workshop charge booked on the order (or one taken back), onto the work order's cost
 *
 * Office screens: purchasing.view over the order's (the agreement's) company. Ids, numbers, counts, kinds and states: never a
 * price, an amount or a person's name.
 */

const orderLive = { permission: 'purchasing.view', fields: ['subcontractOrderId', 'number', 'status', 'partyId'] } as const
const order = { subcontractOrderId: z.uuid(), number: z.string().min(1).max(40), status: z.enum(SUBCONTRACT_ORDER_STATUSES), partyId: z.uuid() }

export const events = [
  defineEvent({
    type: 'subcontract_agreement.changed',
    context: 'subcontract-depth',
    description: 'The written terms with a workshop changed: a revision written, its draft edited or deleted, signed (superseding the revision in force) or ended with why.',
    payload: z.strictObject({
      agreementId: z.uuid(),
      partyId: z.uuid(),
      revision: z.number().int().min(1),
      status: z.enum(AGREEMENT_STATUSES),
      change: z.enum(['WRITTEN', 'EDITED', 'DELETED', 'SIGNED', 'ENDED']),
      supersededId: z.uuid().nullable(),
    }),
    live: { permission: 'purchasing.view', fields: ['agreementId', 'partyId', 'status', 'change'] },
  }),
  defineEvent({
    type: 'subcontract_order.balance_booked',
    context: 'subcontract-depth',
    description: "The workshop's declaration of the material it used, returned and scrapped, or an adjustment after the receipt, was booked on a subcontract order (the used material issued to the work order, the scrap written off).",
    payload: z.strictObject({ ...order, kind: z.enum(CONSUMPTION_KINDS), kitLineIds: z.array(z.uuid()).min(1).max(200), rowIds: z.array(z.uuid()).min(1).max(200), moves: z.number().int().min(0) }),
    live: orderLive,
  }),
  defineEvent({
    type: 'subcontract_order.cost_booked',
    context: 'subcontract-depth',
    description: "A workshop's charge (the fee at its price, transport, material, another charge) was booked on a subcontract order and onto its work order's cost, or one was taken back.",
    payload: z.strictObject({ ...order, entryId: z.uuid(), kind: z.enum(COST_KINDS), reversalOfId: z.uuid().nullable(), posted: z.boolean() }),
    live: orderLive,
  }),
] as const
