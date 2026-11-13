import { z } from 'zod'
import { defineEvent } from '../events/define'
import { SALES_ORDER_PRIORITY_LEVELS } from '../sales/orders-depth/rules'
import { SEASON_CHANGES } from '../sales/seasons/rules'

/**
 * Orders in depth (B-W2b-303; SAL-201, SAL-205, SAL-207, SAL-208, SAL-215, SAL-277). apps/factory-api's modules/sales/
 * orders-depth, seasons and order-import emit them in the command that makes the change. Their own module folder (the event
 * guard wants src/<module>/events.ts): the code is factory-domain sales/orders-depth, sales/seasons and sales/order-import.
 * A new order (a part split off, a row group imported) is W1's `sales_order.created`; an order that waited and goes on is
 * W1's `sales_order.status_changed` {from: PENDING_APPROVAL, to: CONFIRMED} (B-W2b-294's handler carries its schedule then);
 * a no cancels it with W1's event too.
 *
 *   sales_order.priority_changed     its priority level (and urgent reason) or W1's number within the level changed
 *   sales_order.season_changed       it names another season (or none)
 *   sales_order.split                parts of it became orders of their own (their ids; the order's amendment)
 *   sales_order.confirmation_made    a new version of its confirmation PDF was kept
 *   sales_order.confirmation_sent    a confirmation version was mailed to the customer on its thread
 *   quote.season_changed             a quote's draft version names another season (or none)
 *   season.changed                   a company's season was made, changed, closed or reopened
 *
 * Reach the office's order screens (orders.view) or quote screens (quotes.view): ids, numbers, what changed; never a price.
 */

const order = { permission: 'orders.view', fields: ['orderId', 'number'] } as const

export const events = [
  defineEvent({
    type: 'sales_order.priority_changed',
    context: 'orders-depth',
    description: "A sales order's priority level, its urgent reason or its number within the level changed.",
    payload: z.strictObject({ orderId: z.uuid(), number: z.string(), from: z.enum(SALES_ORDER_PRIORITY_LEVELS), to: z.enum(SALES_ORDER_PRIORITY_LEVELS), priority: z.number().int(), urgent: z.boolean() }),
    live: order,
  }),
  defineEvent({
    type: 'sales_order.season_changed',
    context: 'orders-depth',
    description: 'A sales order names another season of its company, or none.',
    payload: z.strictObject({ orderId: z.uuid(), number: z.string(), seasonId: z.uuid().nullable(), code: z.string().nullable() }),
    live: order,
  }),
  defineEvent({
    type: 'sales_order.split',
    context: 'orders-depth',
    description: 'Parts of a sales order became orders of their own (each with its lines, deliveries and ship-to); the order keeps the rest.',
    payload: z.strictObject({ orderId: z.uuid(), number: z.string(), newOrderIds: z.array(z.uuid()), newNumbers: z.array(z.string()), amendmentId: z.uuid(), revision: z.number().int() }),
    live: order,
  }),
  defineEvent({
    type: 'sales_order.confirmation_made',
    context: 'orders-depth',
    description: "A new version of a sales order's confirmation PDF was kept.",
    payload: z.strictObject({ orderId: z.uuid(), number: z.string(), version: z.number().int(), generatedDocumentId: z.uuid(), fileId: z.uuid() }),
    live: order,
  }),
  defineEvent({
    type: 'sales_order.confirmation_sent',
    context: 'orders-depth',
    description: "A version of a sales order's confirmation was mailed to the customer on the order's thread.",
    payload: z.strictObject({ orderId: z.uuid(), number: z.string(), version: z.number().int(), outboundId: z.uuid() }),
    live: order,
  }),
  defineEvent({
    type: 'quote.season_changed',
    context: 'orders-depth',
    description: "A quote's draft version names another season of its company, or none.",
    payload: z.strictObject({ quoteId: z.uuid(), versionId: z.uuid(), number: z.string(), seasonId: z.uuid().nullable(), code: z.string().nullable() }),
    live: { permission: 'quotes.view', fields: ['quoteId', 'versionId', 'number'] },
  }),
  defineEvent({
    type: 'season.changed',
    context: 'orders-depth',
    description: "A company's season was made, changed, closed or reopened.",
    payload: z.strictObject({ seasonId: z.uuid(), companyId: z.uuid(), code: z.string(), change: z.enum(SEASON_CHANGES) }),
    live: { permission: 'orders.view', fields: ['seasonId', 'companyId', 'code', 'change'] },
  }),
] as const
