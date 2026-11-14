import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * The events of the work order close (B-W2b-411; MES-012, MES-013, FIN-034; apps/factory-api modules/production/work-orders
 * close.ts and modules/costing/close). Context `work-order-close`, its own module folder (the production and costing events
 * files are earlier steps'). The work order's status change is `workorder.status_changed` as before, and the entries the
 * close posts or reverses are `work_order_cost.posted`; this one says what happened to the close itself, so the work
 * order's screens and costing refetch it with their viewer's grains: ids and states only, never a figure.
 *
 *   work_order_close.changed   a work order was closed (settled: its variance split and closing entry written, while the
 *                              company's figures for the accountant are on), undone by the person who closed it within a
 *                              few seconds, or reopened later with a reason
 */

/** What happened to a close. */
export const CLOSE_CHANGES = ['closed', 'undone', 'reopened'] as const

export const events = [
  defineEvent({
    type: 'work_order_close.changed',
    context: 'work-order-close',
    description: 'A work order was closed (its cost settled while the figures for the accountant are on), undone by the person who closed it within a few seconds, or reopened with a reason.',
    payload: z.strictObject({ closeId: z.uuid(), workOrderId: z.uuid(), number: z.string(), change: z.enum(CLOSE_CHANGES), settled: z.boolean(), beyond: z.boolean() }),
    live: { permission: 'workorders.view', fields: ['closeId', 'workOrderId', 'number', 'change', 'settled'] },
  }),
] as const
