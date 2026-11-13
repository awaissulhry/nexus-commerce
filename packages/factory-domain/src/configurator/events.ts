import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * The configurator on an order line (B-W2b-340; SAL-133, SAL-139). apps/factory-api's modules/sales/configurator emits it in
 * the command that makes the change. Its own module folder (the event guard wants src/<module>/events.ts): the code is
 * factory-domain sales/configurator. A quote line's options are W1's `quote.lines_changed` {change: 'changed'}.
 *
 *   sales_order.options_changed    the options chosen on an order line changed (CHOSEN: by the office on the line), or the
 *                                  accepted quote's options were copied to an order that waited for a yes (COPIED)
 *
 * Reach the office's order screens (orders.view): ids, the number, what changed; never a price.
 */

export const events = [
  defineEvent({
    type: 'sales_order.options_changed',
    context: 'configurator',
    description: 'The options chosen on a sales order line changed (values, a panel colour, the leather, a typed text), or its quote line options were copied to it; a work order made afterwards takes them.',
    payload: z.strictObject({ orderId: z.uuid(), number: z.string(), lineIds: z.array(z.uuid()), change: z.enum(['CHOSEN', 'COPIED']) }),
    live: { permission: 'orders.view', fields: ['orderId', 'number', 'change'] },
  }),
]
