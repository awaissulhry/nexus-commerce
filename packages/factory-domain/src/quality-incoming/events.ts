import { z } from 'zod'
import { defineEvent } from '../events/define'
import { NEXT_STEPS } from '../quality/incoming/rules'

/**
 * The incoming inspection of a lot, hide by hide (B-W2b-98; QHS-025, QHS-028, QHS-034, MES-054; design floor.incoming
 * "Live", quality.inspections). apps/factory-api's modules/quality/incoming emits them in the commands that make the
 * change. Its own module folder: the quality events file is other steps' (B-W2b-90, -93 …), as quality-plans (B-W2b-92).
 *
 *   incoming_inspection.opened     an inspection of a lot was opened on its approved plan, with its sample
 *   incoming_inspection.recorded   a hide of the sample recorded, changed or taken out, or the plan checks answered
 *                                  (B-W2b-111: a roll by the 4-point system, a component check, the defect counter)
 *   incoming_inspection.decided    the decision was signed: accepted, rejected and to sort, adding up to the lot
 *   incoming_inspection.cancelled  an open inspection was abandoned, with the reason
 *
 * Reach the office's inspections (quality.incoming.view) and the site's inspection tablets (the same permission, which
 * the floor shares). Ids, numbers, counts and states only: never a person, never money.
 *
 * B-W2b-111: an inspection is of a lot (lotId) or of goods back from a workshop (subcontractReceiptId), exactly one of
 * the two; the other is null. A workshop's goods released or held by the decision also reach the subcontract order's
 * record through `subcontract_order.updated` (purchasing's event).
 */

const live = { permission: 'quality.incoming.view', floor: 'quality.incoming.view', fields: ['incomingInspectionId', 'number', 'lotId', 'subcontractReceiptId'] } as const
/** B-W2b-111: a lot or a workshop's receipt, exactly one of the two. */
const subject = () => ({ lotId: z.uuid().nullable(), subcontractReceiptId: z.uuid().nullable() })
const quantity = () => z.string().regex(/^\d{1,14}(\.\d{1,4})?$/)

export const RECORDED_WHAT = ['HIDE', 'HIDE_REMOVED', 'RESULTS', 'ROLL', 'ROLL_REMOVED', 'COMPONENT', 'COMPONENT_REMOVED', 'COUNTERS'] as const
export type RecordedWhat = (typeof RECORDED_WHAT)[number]

export const events = [
  defineEvent({
    type: 'incoming_inspection.opened',
    context: 'quality-incoming',
    description: 'An incoming inspection of a lot was opened on the approved version of its plan, with the sample to inspect.',
    payload: z.strictObject({
      incomingInspectionId: z.uuid(),
      number: z.string(),
      ...subject(),
      itemId: z.uuid().nullable(),
      planVersionId: z.uuid(),
      lotSize: quantity(),
      uom: z.string(),
      sampleSize: z.number().int().min(1),
      postedBy: z.enum(['FLOOR', 'OFFICE']),
    }),
    live,
  }),
  defineEvent({
    type: 'incoming_inspection.recorded',
    context: 'quality-incoming',
    description: 'A hide of an incoming inspection was recorded, changed or taken out of the sample, or its plan checks were answered.',
    payload: z.strictObject({
      incomingInspectionId: z.uuid(),
      number: z.string(),
      ...subject(),
      what: z.enum(RECORDED_WHAT),
      hideId: z.uuid().nullable(),
      done: z.number().int().min(0),
      sampleSize: z.number().int().min(1),
    }),
    live: { ...live, fields: ['incomingInspectionId', 'number', 'lotId', 'subcontractReceiptId', 'what', 'hideId', 'done'] },
  }),
  defineEvent({
    type: 'incoming_inspection.decided',
    context: 'quality-incoming',
    description: 'The decision of an incoming inspection was signed: accepted, rejected and to sort, adding up to the lot (the lot itself waits for the quality role).',
    payload: z.strictObject({
      incomingInspectionId: z.uuid(),
      number: z.string(),
      ...subject(),
      computedResult: z.enum(['PASS', 'FAIL']),
      accepted: quantity(),
      rejected: quantity(),
      toSort: quantity(),
      uom: z.string(),
      overridden: z.boolean(),
      next: z.enum(NEXT_STEPS),
      postedBy: z.enum(['FLOOR', 'OFFICE']),
    }),
    live: { ...live, fields: ['incomingInspectionId', 'number', 'lotId', 'subcontractReceiptId', 'computedResult', 'next'] },
  }),
  defineEvent({
    type: 'incoming_inspection.cancelled',
    context: 'quality-incoming',
    description: 'An open incoming inspection was abandoned, with the reason.',
    payload: z.strictObject({
      incomingInspectionId: z.uuid(),
      number: z.string(),
      ...subject(),
      postedBy: z.enum(['FLOOR', 'OFFICE']),
    }),
    live,
  }),
] as const
