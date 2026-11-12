import { z } from 'zod'
import { defineEvent } from '../events/define'
import { PPE_TEXT_KINDS } from '../compliance/ppe-texts/rules'

/**
 * The PPE text approvals' event (B-W2b-288, follow-up FU2:01; GATE-PPE-TEXTS; the code is factory-domain
 * compliance/ppe-texts). A module folder of its own, as compliance-declarations and compliance-user-information (the event
 * guard wants `src/<module>/events.ts`). apps/factory-api's modules/compliance/ppe-texts emits it in the command that records
 * or withdraws an approval: Rules & markets › Templates reads its rows again, and the declarations, the user information and
 * the labels' rule checks read their gate again.
 *
 *   compliance_ppe_texts.approval_changed   a PPE consultant's yes to a template was recorded (RECORDED) or withdrawn
 *                                           (WITHDRAWN)
 *
 * Ids, codes and the languages only: never the consultant's name or the reason a person typed. Live for
 * compliance.certificates.view (who reads the approvals and the generated texts).
 */
export const events = [
  defineEvent({
    type: 'compliance_ppe_texts.approval_changed',
    context: 'compliance-ppe-texts',
    description: "A PPE consultant's yes to a template of generated PPE texts (the declaration, the user information, a label's class warnings) was recorded or withdrawn.",
    payload: z.strictObject({
      approvalId: z.uuid(),
      companyId: z.uuid().nullable(),
      templateKind: z.enum(PPE_TEXT_KINDS),
      templateKey: z.string().min(1).max(80),
      templateVersion: z.number().int().min(1),
      languages: z.array(z.string().regex(/^[a-z]{2,3}$/)),
      change: z.enum(['RECORDED', 'WITHDRAWN']),
    }),
    live: { permission: 'compliance.certificates.view', fields: ['approvalId', 'templateKind', 'templateKey', 'templateVersion', 'change'] },
  }),
] as const
