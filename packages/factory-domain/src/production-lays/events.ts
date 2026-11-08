import { z } from 'zod'
import { defineEvent } from '../events/define'
import { CUT_ORDER_KINDS, CUT_ORDER_STATUSES, LAY_STATUSES } from '../production/cutorders/rules'

/**
 * Lays at the table and the reconciliation of a cut order (B-W2b-116; MES-038, MES-039, MES-045, MES-046; design floor.fabriccut
 * "Spread the lay", "Count the plies at both ends", "Fabric used", production.cutting pop "Reconcile cut"). apps/factory-api's
 * modules/production/lays emits them in the commands that make the change. In a module folder of its own (as
 * production-cutorders): production/events.ts is other steps'.
 *
 *   lay.changed              a lay was started on the table, a roll spread on it, corrected or taken off, its plies counted at
 *                            both ends, or it went back to spreading (a roll added after the count)
 *   cut_consumption.changed  a lay's fabric used was confirmed (its fabric issued to the work orders) or corrected
 *   cut_order.reconciled     a cut order was reconciled: each line's garments cut against ordered
 *
 * The first two reach the Cutting page (production.cutting.view) and the site's cutting tablets (production.cut); the third the
 * office only. Ids, numbers, states and counts: no person, no money, no words a person typed.
 */

const live = { permission: 'production.cutting.view', floor: 'production.cut', fields: ['cutOrderId', 'number', 'layId', 'change'] } as const

export const LAY_CHANGES = ['SPREAD_STARTED', 'ROLL_SPREAD', 'ROLL_CHANGED', 'ROLL_UNDONE', 'COUNTED', 'BACK_TO_SPREADING'] as const
export type LayChange = (typeof LAY_CHANGES)[number]
export const CONSUMPTION_CHANGES = ['CONFIRMED', 'CORRECTED'] as const
export type ConsumptionChange = (typeof CONSUMPTION_CHANGES)[number]

export const events = [
  defineEvent({
    type: 'lay.changed',
    context: 'production-lays',
    description: 'A lay was started on the cutting table, a roll spread on it, corrected or taken off, its plies counted at both ends, or it went back to spreading.',
    payload: z.strictObject({
      layId: z.uuid(),
      cutOrderId: z.uuid(),
      number: z.string(),
      seq: z.number().int().min(1),
      status: z.enum(LAY_STATUSES),
      change: z.enum(LAY_CHANGES),
      /** Plies its rolls gave after the change. */
      plies: z.number().int().min(0),
      /** The rolls the change was about. */
      rollIds: z.array(z.uuid()),
    }),
    live,
  }),
  defineEvent({
    type: 'cut_consumption.changed',
    context: 'production-lays',
    description: "A lay's fabric used was confirmed at cut finish (its fabric issued to the work orders) or corrected.",
    payload: z.strictObject({
      consumptionId: z.uuid(),
      layId: z.uuid(),
      cutOrderId: z.uuid(),
      number: z.string(),
      change: z.enum(CONSUMPTION_CHANGES),
      /** The work orders its fabric was issued to (CONFIRMED), and the stock moves. */
      workOrderIds: z.array(z.uuid()),
      moveIds: z.array(z.uuid()),
    }),
    live,
  }),
  defineEvent({
    type: 'cut_order.reconciled',
    context: 'production-lays',
    description: 'A cut order was reconciled: each line has its garments cut against ordered.',
    payload: z.strictObject({
      cutOrderId: z.uuid(),
      number: z.string(),
      kind: z.enum(CUT_ORDER_KINDS),
      status: z.enum(CUT_ORDER_STATUSES),
      workOrderIds: z.array(z.uuid()),
      /** Lines reconciled now, and of them those whose cut differs from what they ordered. */
      lines: z.number().int().min(0),
      variances: z.number().int().min(0),
      garmentsOrdered: z.number().int().min(0),
      garmentsCut: z.number().int().min(0),
    }),
    live: { permission: 'production.cutting.view', fields: ['cutOrderId', 'number', 'status'] },
  }),
] as const
