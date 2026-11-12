import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * Repairs and alterations in depth (B-W2b-342; SAL-384, SAL-385, SAL-387; follow-ups RR1:01, RR1:02). apps/factory-api's
 * modules/sales/repairs-depth emits them in the command that makes the move. Their own module folder (as
 * portal-returns/events.ts; check-event-contract wants src/<module>/events.ts): the code is factory-domain
 * sales/repairs-depth. The repair itself is still W2a's `repair.created` (also for a request from outside) and its stage
 * moves W2a's `repair.stage_changed` (the estimate's send and its yes move the stage in the same command).
 *
 *   repair_request.sent        a customer asked for a repair or an alteration from the portal or a claim link: a repair
 *                              AWAITING_GOODS, channel PORTAL or LINK
 *   repair_estimate.sent       an estimate revision was sent to the customer (its lines frozen)
 *   repair_estimate.answered   the customer accepted or declined it (by the portal, or recorded by the office)
 *   repair_estimate.withdrawn  a draft or a sent estimate was taken back (a new revision replaces it, or by hand)
 *
 * Reach the office's repairs screens (sales.repairs.view over the repair's company): ids, numbers and codes only; never a
 * price, a cost, a name or an address.
 */

const via = z.enum(['LINK', 'PORTAL', 'OFFICE'])

export const events = [
  defineEvent({
    type: 'repair_request.sent',
    context: 'repairs-depth',
    description: 'A customer asked for a repair or an alteration of one garment from the portal or a claim link: the repair waits for the garment (AWAITING_GOODS), channel PORTAL or LINK.',
    payload: z.strictObject({ repairId: z.uuid(), number: z.string(), partyId: z.uuid(), kind: z.enum(['REPAIR', 'ALTERATION']), via: z.enum(['PORTAL', 'LINK']), garmentSerial: z.string().nullable() }),
    live: { permission: 'sales.repairs.view', fields: ['repairId', 'number', 'partyId', 'kind', 'via'] },
  }),
  defineEvent({
    type: 'repair_estimate.sent',
    context: 'repairs-depth',
    description: "A repair's estimate (parts and labour) was sent to the customer: its lines and terms are frozen, the repair is estimated.",
    payload: z.strictObject({ repairId: z.uuid(), number: z.string(), estimateId: z.uuid(), revision: z.number().int().min(1), partyId: z.uuid(), replacedEstimateId: z.uuid().nullable() }),
    live: { permission: 'sales.repairs.view', fields: ['repairId', 'number', 'estimateId', 'revision'] },
  }),
  defineEvent({
    type: 'repair_estimate.answered',
    context: 'repairs-depth',
    description: "The customer accepted or declined a repair's estimate (in the portal, or by phone or mail as the office recorded it); an acceptance approves the repair.",
    payload: z.strictObject({ repairId: z.uuid(), number: z.string(), estimateId: z.uuid(), revision: z.number().int().min(1), partyId: z.uuid(), answer: z.enum(['ACCEPTED', 'DECLINED']), via }),
    live: { permission: 'sales.repairs.view', fields: ['repairId', 'number', 'estimateId', 'revision', 'answer', 'via'] },
  }),
  defineEvent({
    type: 'repair_estimate.withdrawn',
    context: 'repairs-depth',
    description: "A repair's draft or sent estimate was withdrawn (a new revision replaces it, or the office took it back).",
    payload: z.strictObject({ repairId: z.uuid(), number: z.string(), estimateId: z.uuid(), revision: z.number().int().min(1), from: z.enum(['DRAFT', 'SENT']) }),
    live: { permission: 'sales.repairs.view', fields: ['repairId', 'number', 'estimateId', 'revision'] },
  }),
] as const
