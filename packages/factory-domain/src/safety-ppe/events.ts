import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * PPE for workers (B-W2b-134; QHS-259, QHS-260, QHS-261; design plant.ppe "live: ppe.issued (floor) → Issues and Gaps").
 * apps/factory-api's modules/safety/ppe emits them in the commands that make the change. Their own module folder (the safety
 * events file is B-W2b-120's), as safety-risk and safety-rolesheets.
 *
 *   ppe_item.changed     a PPE item of a company's catalogue was added, changed, archived or restored.
 *   ppe.issued           PPE was handed to a person: one receipt (its lines), signed with badge and PIN on the floor or on
 *                        paper in the office. The PPE page's Issues and Gaps read again.
 *   ppe_issue.voided     a wrong issue line was voided (the receipt stays, marked void).
 *
 * Reach the safety pages of the office (safety.view over the record's company and site): ids, counts, kinds and states only;
 * never a name, a size, a cost or a reason typed by a person; never the floor.
 */

const live = (fields: readonly string[]) => ({ permission: 'safety.view', fields }) as const

export const PPE_ITEM_CHANGES = ['ADDED', 'EDITED', 'ARCHIVED', 'RESTORED'] as const

export const events = [
  defineEvent({
    type: 'ppe_item.changed',
    context: 'safety-ppe',
    description: "A PPE item of a company's catalogue was added, changed, archived or restored.",
    payload: z.strictObject({ ppeItemId: z.uuid(), change: z.enum(PPE_ITEM_CHANGES) }),
    live: live(['ppeItemId', 'change']),
  }),
  defineEvent({
    type: 'ppe.issued',
    context: 'safety-ppe',
    description: 'PPE was handed to a person: one receipt with its lines, signed with badge and PIN on the floor or on paper in the office.',
    payload: z.strictObject({
      receiptId: z.uuid(),
      employeeId: z.uuid(),
      issueIds: z.array(z.uuid()).min(1),
      /** Units handed over on the receipt (all lines). */
      units: z.number().int().min(1),
      method: z.enum(['FLOOR_PIN', 'PAPER']),
      via: z.enum(['FLOOR', 'OFFICE']),
    }),
    live: live(['receiptId', 'employeeId', 'via']),
  }),
  defineEvent({
    type: 'ppe_issue.voided',
    context: 'safety-ppe',
    description: 'A wrong PPE issue line was voided with the reason; its receipt stays, marked void.',
    payload: z.strictObject({ issueId: z.uuid(), voidId: z.uuid(), receiptId: z.uuid(), employeeId: z.uuid() }),
    live: live(['issueId', 'receiptId', 'employeeId']),
  }),
] as const
