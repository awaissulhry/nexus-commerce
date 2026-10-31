import { z } from 'zod'
import { defineEvent } from '../events/define'
import { CHANGE_KINDS, REVIEW_STATUSES } from './type-changes/rules'

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
 *
 * The PPE register (B-W1-43, modules/compliance/register; Reg. (EU) 2016/425 art. 8(4), 8(8)) emits
 * `compliance.register_entry_opened` (a person's entry, or one another step opened: B-W1-45's reversal of garments that
 * already left), `compliance.register_entry_changed` (edited, the corrective action done, distributors informed, the
 * authority told) and `compliance.register_entry_closed`. The W2a notification centre alerts the owner and
 * quality on a risk (`risk` YES). Live on the PPE register (SCR-113) for compliance.register.view.
 *
 * W2a (B-W2a-66; QHS-105, PRD-283, PRD-285; Reg. (EU) 2016/425 Annex V 7.2), modules/compliance/renewals and
 * modules/compliance/type-changes: `compliance.renewal_started` (the renewal task made on the certificate),
 * `compliance.renewal_applied` (the day the application for review went to the notified body, typed in: nothing is sent),
 * `compliance.certificate_renewed` (the registered successor linked: the old certificate leaves the expiry alerts),
 * `compliance.type_change_found` (a released revision changes what a covering certificate's type examination saw: a
 * review opened, the revision's class label held) and `compliance.type_change_decided` (told, approved, refused, not
 * needed). Ids, numbers, days and kinds only; live for compliance.certificates.view.
 */
const day = () => z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const labelTemplate = {
  templateId: z.uuid(),
  code: z.string(),
  revision: z.number().int().min(1),
  styleId: z.uuid().nullable(),
}
const labelLive = { permission: 'compliance.certificates.view', fields: ['templateId', 'code', 'revision'] } as const
const registerEntry = {
  entryId: z.uuid(),
  reference: z.string(),
  kind: z.enum(['COMPLAINT', 'NON_CONFORMITY', 'RECALL']),
  styleId: z.uuid(),
  risk: z.enum(['NO', 'ASSESSING', 'YES']),
}
const registerLive = { permission: 'compliance.register.view', fields: ['entryId', 'reference', 'risk'] } as const
// B-W2a-66
const renewalLive = { permission: 'compliance.certificates.view', fields: ['certificateId', 'number'] } as const
const typeChange = { reviewId: z.uuid(), styleId: z.uuid(), revisionId: z.uuid(), revision: z.number().int().min(1), certificateId: z.uuid() }
const typeChangeLive = { permission: 'compliance.certificates.view', fields: ['reviewId', 'styleId', 'revisionId', 'certificateId'] } as const

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
  defineEvent({
    type: 'compliance.register_entry_opened',
    context: 'compliance',
    description: 'A complaint, a non-conformity or a recall was recorded in the PPE register (Reg. (EU) 2016/425 art. 8(4)), by a person or by another step (a release reversal of garments that already left).',
    payload: z.strictObject({
      ...registerEntry,
      sourceType: z.string().nullable(),
      sourceId: z.uuid().nullable(),
      shippedGoods: z.boolean(),
    }),
    live: registerLive,
  }),
  defineEvent({
    type: 'compliance.register_entry_changed',
    context: 'compliance',
    description: 'An open PPE register entry changed: edited (the risk assessment among it), its corrective action done, the distributors informed, or the authority told. A note on its thread is thread.message_posted.',
    payload: z.strictObject({
      ...registerEntry,
      change: z.enum(['EDITED', 'ACTION_COMPLETED', 'DISTRIBUTORS_INFORMED', 'AUTHORITY_NOTIFIED']),
      previousRisk: z.enum(['NO', 'ASSESSING', 'YES']),
    }),
    live: registerLive,
  }),
  defineEvent({
    type: 'compliance.register_entry_closed',
    context: 'compliance',
    description: 'A PPE register entry was closed with its reason, its corrective action done and its duties met; it never changes again.',
    payload: z.strictObject({ ...registerEntry, shippedGoods: z.boolean() }),
    live: registerLive,
  }),
  // B-W2a-66: certificate renewals and changes to an approved type.
  defineEvent({
    type: 'compliance.renewal_started',
    context: 'compliance',
    description: "A certificate's renewal was started: its task with the usual steps was made on the certificate (the notified body's own list wins).",
    payload: z.strictObject({ certificateId: z.uuid(), number: z.string(), taskId: z.uuid(), windowOpens: day(), windowCloses: day() }),
    live: renewalLive,
  }),
  defineEvent({
    type: 'compliance.renewal_applied',
    context: 'compliance',
    description: 'The day the application for the review of a certificate went to its notified body was recorded (nothing is sent from the factory).',
    payload: z.strictObject({ certificateId: z.uuid(), number: z.string(), appliedOn: day(), inWindow: z.boolean() }),
    live: renewalLive,
  }),
  defineEvent({
    type: 'compliance.certificate_renewed',
    context: 'compliance',
    description: 'A registered certificate was linked as the renewal (successor) of an older one of the same holder: the older one is no longer warned about.',
    payload: z.strictObject({ certificateId: z.uuid(), number: z.string(), successorId: z.uuid(), successorNumber: z.string() }),
    live: renewalLive,
  }),
  defineEvent({
    type: 'compliance.type_change_found',
    context: 'compliance',
    description: "A released style revision changes the approved type of a certificate that covers the style (outer leather, thickness, protector, seams, lining): a review was opened and the revision's class label is held.",
    payload: z.strictObject({ ...typeChange, comparedRevisionId: z.uuid().nullable(), kinds: z.array(z.enum(CHANGE_KINDS)).min(1) }),
    live: typeChangeLive,
  }),
  defineEvent({
    type: 'compliance.type_change_decided',
    context: 'compliance',
    description: 'A change to an approved type moved: the notified body was told, it answered (approved or refused), or compliance decided it needs no notification.',
    payload: z.strictObject({ ...typeChange, status: z.enum(REVIEW_STATUSES), previousStatus: z.enum(REVIEW_STATUSES) }),
    live: typeChangeLive,
  }),
] as const
