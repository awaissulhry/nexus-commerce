import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * The compliance module's events (plan A1 §3.4; QHS-103, QHS-105, PRD-283). apps/factory-api's
 * modules/compliance/certificates emits them from the scheduler's daily `compliance.certificateExpiry` cron:
 * `compliance.certificate_expiring` once per warning threshold (90, 30 and 7 days before the last valid day) and
 * `compliance.certificate_expired` when a certificate past its last valid day is marked EXPIRED (from then on the
 * certificate gate refuses every garment it covered). The expiry alerts to people (QHS-105, W2a) consume them.
 *
 * The garment label builder (B-W1-19, modules/compliance/labels) emits `compliance.label_template_saved` when a template
 * revision is created or its draft edited, `compliance.label_template_activated` (frozen from then on),
 * `compliance.label_template_retired` (no new work-order release with it) and `compliance.label_assigned` when a draft
 * style revision names a template (or none). Live on the Labels & marking screens (SCR-053).
 */
const day = () => z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const labelTemplate = {
  templateId: z.uuid(),
  code: z.string(),
  revision: z.number().int().min(1),
  styleId: z.uuid().nullable(),
}
const labelLive = { permission: 'compliance.certificates.view', fields: ['templateId', 'code', 'revision'] } as const

export const events = [
  defineEvent({
    type: 'compliance.certificate_expiring',
    context: 'compliance',
    description: "A valid certificate reached a warning threshold before its last valid day: time to ask the notified body for its renewal.",
    payload: z.strictObject({
      certificateId: z.uuid(),
      number: z.string(),
      standard: z.string(),
      notifiedBodyNumber: z.string(),
      validTo: day(),
      daysLeft: z.number().int().min(0),
      thresholdDays: z.number().int().min(1),
    }),
    live: { permission: 'compliance.certificates.view', fields: ['certificateId', 'number', 'daysLeft'] },
  }),
  defineEvent({
    type: 'compliance.certificate_expired',
    context: 'compliance',
    description: 'A certificate passed its last valid day and was marked EXPIRED: it covers nothing from now on.',
    payload: z.strictObject({
      certificateId: z.uuid(),
      number: z.string(),
      standard: z.string(),
      notifiedBodyNumber: z.string(),
      validTo: day(),
      previousStatus: z.enum(['VALID', 'SUSPENDED']),
    }),
    live: { permission: 'compliance.certificates.view', fields: ['certificateId', 'number'] },
  }),
  defineEvent({
    type: 'compliance.label_template_saved',
    context: 'compliance',
    description: 'A garment label template revision was created (new, copied or a new revision of an active one) or its draft was edited.',
    payload: z.strictObject({ ...labelTemplate, change: z.enum(['CREATED', 'NEW_REVISION', 'UPDATED']), problems: z.number().int().min(0) }),
    live: labelLive,
  }),
  defineEvent({
    type: 'compliance.label_template_activated',
    context: 'compliance',
    description: 'A garment label template revision passed its rule checks and became ACTIVE: it never changes again (Reg. (EU) 2016/425 art. 8(5)(6), art. 17).',
    payload: z.strictObject(labelTemplate),
    live: labelLive,
  }),
  defineEvent({
    type: 'compliance.label_template_retired',
    context: 'compliance',
    description: 'A garment label template revision was retired: no new work order is released with it; released work orders keep it.',
    payload: z.strictObject({ ...labelTemplate, previousStatus: z.enum(['DRAFT', 'ACTIVE']), releasedRevisions: z.number().int().min(0) }),
    live: labelLive,
  }),
  defineEvent({
    type: 'compliance.label_assigned',
    context: 'compliance',
    description: "A draft style revision now names a garment label template (or none): the label its garments will carry once it is released.",
    payload: z.strictObject({
      styleId: z.uuid(),
      styleRevisionId: z.uuid(),
      revision: z.number().int().min(1),
      labelTemplateId: z.uuid().nullable(),
      previousLabelTemplateId: z.uuid().nullable(),
    }),
    live: { permission: 'compliance.certificates.view', fields: ['styleId', 'styleRevisionId', 'labelTemplateId'] },
  }),
] as const
