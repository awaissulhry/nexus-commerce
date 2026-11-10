import { z } from 'zod'
import { defineEvent } from '../events/define'
import { ARTWORK_STATUSES, SPOIL_KINDS } from '../compliance/label-artwork/rules'

/**
 * Label artwork and the label reconciliation's events (B-W2b-259; the code is factory-domain compliance/label-artwork). A
 * module folder of its own, as compliance-techfiles (the event guard wants `src/<module>/events.ts`). apps/factory-api's
 * modules/compliance/label-artwork emits them in the command that makes the change. The label lines in the BOM emit W1's
 * `style.bom_changed`.
 *
 *   label_artwork.changed        a label revision's artwork version was added (DRAFT), approved by a second person (the one
 *                                approved before retired with it), retired, or removed while a draft
 *   label_reconciliation.logged  labels of a work order's size were logged spoiled or returned (Log spoiled labels)
 *
 * Ids, numbers, codes, kinds and counts only: no words a person typed, no person.
 */
export const events = [
  defineEvent({
    type: 'label_artwork.changed',
    context: 'compliance-label-artwork',
    description: "A label revision's artwork version was added, approved by a second person, retired, or removed while a draft.",
    payload: z.strictObject({
      templateId: z.uuid(),
      code: z.string(),
      revision: z.number().int(),
      artworkId: z.uuid(),
      versionNo: z.number().int(),
      status: z.enum(ARTWORK_STATUSES).nullable(),
      change: z.enum(['ADDED', 'APPROVED', 'RETIRED', 'REMOVED']),
      /** APPROVED: the version it replaced (retired in the same change). */
      replacedId: z.uuid().nullable(),
    }),
    live: { permission: 'compliance.certificates.view', fields: ['templateId', 'code', 'revision', 'artworkId', 'versionNo', 'status', 'change'] },
  }),
  defineEvent({
    type: 'label_reconciliation.logged',
    context: 'compliance-label-artwork',
    description: "Labels of a work order's size were logged spoiled or returned.",
    payload: z.strictObject({
      workOrderId: z.uuid(),
      number: z.string(),
      workOrderSizeId: z.uuid(),
      kind: z.enum(SPOIL_KINDS),
      quantity: z.number().int(),
      /** The size's difference after it (0: balanced). */
      difference: z.number().int(),
      postedBy: z.enum(['FLOOR', 'OFFICE']),
    }),
    live: { permission: 'workorders.view', fields: ['workOrderId', 'number', 'workOrderSizeId', 'kind', 'quantity', 'difference'] },
  }),
] as const
