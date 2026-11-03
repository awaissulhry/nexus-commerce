import { z } from 'zod'
import { defineEvent } from '../events/define'
import { RECORD_KINDS, TRIGGER_EVENTS } from '../quality/triggers/rules'

/**
 * Inspection triggers (B-W2b-101; QHS-010, QHS-011; design quality.plans "When inspections are created"). apps/factory-api's
 * modules/quality/triggers emits them: the rule commands, and the worker's handler `quality.inspectionTriggers` in the
 * system command that opens a record. Its own module folder: the quality events file is other steps' (as quality-plans).
 *
 *   inspection_trigger.changed           a rule was added, changed, switched off or on, or deleted, or the company's
 *                                        rules were put in a new order (no rule id then)
 *   inspection_trigger.inspection_opened a rule opened an incoming inspection (a lot, a workshop's receipt) or an in-process
 *                                        check (a bundle at an operation) by itself
 *
 * The first reaches "When inspections are created" (quality.triggers.view). The second reaches the office's inspection
 * screens and the site's benches (quality.inspections.view, which the floor holds): a new inspection to do. Ids, codes,
 * numbers and kinds only, never a person.
 */

export const TRIGGER_CHANGES = ['CREATED', 'EDITED', 'SWITCHED_OFF', 'SWITCHED_ON', 'DELETED', 'REORDERED'] as const
export type TriggerChange = (typeof TRIGGER_CHANGES)[number]

export const events = [
  defineEvent({
    type: 'inspection_trigger.changed',
    context: 'quality-triggers',
    description: "A rule of \"When inspections are created\" was added, changed, switched off or on, or deleted, or the company's rules were put in a new order.",
    payload: z.strictObject({
      companyId: z.uuid(),
      /** Null when the whole list was reordered. */
      triggerId: z.uuid().nullable(),
      change: z.enum(TRIGGER_CHANGES),
      event: z.enum(TRIGGER_EVENTS).nullable(),
    }),
    live: { permission: 'quality.triggers.view', fields: ['companyId', 'triggerId', 'change', 'event'] },
  }),
  defineEvent({
    type: 'inspection_trigger.inspection_opened',
    context: 'quality-triggers',
    description: 'A rule opened an inspection by itself: an incoming inspection of a lot or of a workshop\'s receipt, or an in-process check of a bundle at an operation.',
    payload: z.strictObject({
      triggerId: z.uuid(),
      event: z.enum(TRIGGER_EVENTS),
      recordType: z.enum(['IncomingInspection', 'InProcessCheck']),
      recordId: z.uuid(),
      kind: z.enum(RECORD_KINDS),
      /** The incoming inspection's number; an in-process check has none. */
      inspectionNumber: z.string().nullable(),
      planId: z.uuid(),
      planVersionId: z.uuid(),
      lotId: z.uuid().nullable(),
      workOrderId: z.uuid().nullable(),
      bundleId: z.uuid().nullable(),
    }),
    live: { permission: 'quality.inspections.view', floor: 'quality.inspections.view', fields: ['recordType', 'recordId', 'kind', 'inspectionNumber', 'workOrderId', 'lotId'] },
  }),
] as const
