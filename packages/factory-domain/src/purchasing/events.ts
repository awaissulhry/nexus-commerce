import { z } from 'zod'
import { defineEvent } from '../events/define'
import { PURCHASE_ORDER_STATUSES } from './orders'

/**
 * The purchasing module's events (plan A1 §3.4, §3.5; SCM-050, SCM-053, SCM-055; design 02 "Purchase orders", Live).
 * apps/factory-api's modules/purchasing emits them in the command that makes the change; the office screens that may see
 * the order (purchasing.view over its company and site) refresh the list and the record. Ids, numbers, counts and states
 * only: no quantity, no price (a purchase price is a cost).
 *
 *   purchase_order.created         a draft was made (by hand, or by "Draft PO" from the plan)
 *   purchase_order.updated         a draft's header changed
 *   purchase_order.lines_changed   a draft's lines were added, changed or removed
 *   purchase_order.sent            the order went to the supplier: PDF stored, confirm link made, mail queued
 *   purchase_order.link_sent       a new confirm link went to the supplier (the live ones stopped working)
 *   purchase_order.cancelled       the order was cancelled (a sent one: its links stopped working, the supplier is told)
 */
const live = { permission: 'purchasing.view', fields: ['purchaseOrderId', 'number'] } as const
const base = { purchaseOrderId: z.uuid(), number: z.string().min(1).max(40) }

export const events = [
  defineEvent({
    type: 'purchase_order.created',
    context: 'purchasing',
    description: 'A draft purchase order was made, by hand or from the lines of a plan.',
    payload: z.strictObject({ ...base, partyId: z.uuid(), siteId: z.uuid(), source: z.enum(['OFFICE', 'PLAN']) }),
    live,
  }),
  defineEvent({
    type: 'purchase_order.updated',
    context: 'purchasing',
    description: "A draft purchase order's header changed (contact, dates, terms, notes).",
    payload: z.strictObject({ ...base, fields: z.array(z.string().min(1).max(40)).max(20) }),
    live,
  }),
  defineEvent({
    type: 'purchase_order.lines_changed',
    context: 'purchasing',
    description: "A draft purchase order's lines were added, changed or removed.",
    payload: z.strictObject({ ...base, added: z.number().int().min(0), changed: z.number().int().min(0), removed: z.number().int().min(0), lines: z.number().int().min(0) }),
    live,
  }),
  defineEvent({
    type: 'purchase_order.sent',
    context: 'purchasing',
    description: 'A purchase order was sent to its supplier: its PDF stored, a one-off confirm link made and the mail queued on its thread.',
    payload: z.strictObject({ ...base, revision: z.number().int().min(1), partyId: z.uuid(), documentFileId: z.uuid(), linkId: z.uuid(), outboundId: z.uuid() }),
    live,
  }),
  defineEvent({
    type: 'purchase_order.link_sent',
    context: 'purchasing',
    description: 'A new confirm link of a sent purchase order went to the supplier; the older live ones stopped working.',
    payload: z.strictObject({ ...base, linkId: z.uuid(), revokedLinkIds: z.array(z.uuid()).max(100), outboundId: z.uuid() }),
    live,
  }),
  defineEvent({
    type: 'purchase_order.cancelled',
    context: 'purchasing',
    description: 'A purchase order was cancelled; a sent one stopped its confirm links and the supplier is told.',
    payload: z.strictObject({ ...base, from: z.enum(PURCHASE_ORDER_STATUSES), revokedLinkIds: z.array(z.uuid()).max(100), outboundId: z.uuid().nullable() }),
    live,
  }),
] as const
