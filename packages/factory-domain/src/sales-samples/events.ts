import { z } from 'zod'
import { defineEvent } from '../events/define'
import { SAMPLE_KINDS, SAMPLE_STAGES, SHIPMENT_DIRECTIONS } from '../sales/samples/rules'

/**
 * Sample rounds (B-W2b-246; SAL-311, SAL-316, MES-018; the code is factory-domain sales/samples). A module folder of its own, as
 * product-changes (the event guard wants `src/<module>/events.ts`). apps/factory-api's modules/sales/samples emits them in the
 * command that makes the change; a sample work order also emits W1's `workorder.created`.
 *
 *   sample_round.requested   a round was asked for (style, pinned revision, kind and round, customer or internal)
 *   sample_round.changed     its request changed, it moved on the board (by hand, or by its work order or a shipment), it was
 *                            cancelled, or a sample work order was made for it (`workOrderId`)
 *   sample_shipment.changed  a shipment of a round was added, changed, sent, received or removed (the board's card follows)
 *
 * Live on the samples screens for sales.samples.view. Ids, numbers and states only: no person, no money.
 */
export const ROUND_CHANGES = ['UPDATED', 'MOVED', 'CANCELLED', 'WORK_ORDER'] as const
export const SHIPMENT_CHANGES = ['ADDED', 'UPDATED', 'SENT', 'RECEIVED', 'REMOVED'] as const

const live = { permission: 'sales.samples.view' } as const

export const events = [
  defineEvent({
    type: 'sample_round.requested',
    context: 'sales-samples',
    description: 'A sample round was asked for: a proto, fit, salesman, pre-production, CE test or brand sample of a style, made from a pinned revision.',
    payload: z.strictObject({ sampleRoundId: z.uuid(), number: z.string(), styleId: z.uuid(), revisionId: z.uuid(), kind: z.enum(SAMPLE_KINDS), roundNo: z.number().int(), partyId: z.uuid().nullable() }),
    live: { ...live, fields: ['sampleRoundId', 'number', 'styleId', 'kind', 'roundNo'] },
  }),
  defineEvent({
    type: 'sample_round.changed',
    context: 'sales-samples',
    description: 'A sample round changed: its request, its stage on the board (by hand, by its work order or a shipment), cancelled, or a sample work order was made for it.',
    payload: z.strictObject({
      sampleRoundId: z.uuid(),
      number: z.string(),
      styleId: z.uuid(),
      stage: z.enum(SAMPLE_STAGES),
      previousStage: z.enum(SAMPLE_STAGES),
      change: z.enum(ROUND_CHANGES),
      workOrderId: z.uuid().nullable(),
    }),
    live: { ...live, fields: ['sampleRoundId', 'number', 'stage', 'change'] },
  }),
  defineEvent({
    type: 'sample_shipment.changed',
    context: 'sales-samples',
    description: 'A sample shipment was added, changed, sent, received or removed.',
    payload: z.strictObject({ sampleShipmentId: z.uuid(), sampleRoundId: z.uuid(), direction: z.enum(SHIPMENT_DIRECTIONS), change: z.enum(SHIPMENT_CHANGES) }),
    live: { ...live, fields: ['sampleShipmentId', 'sampleRoundId', 'change'] },
  }),
] as const
