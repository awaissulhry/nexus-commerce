import { z } from 'zod'
import { defineEvent } from '../events/define'
import { CERTIFICATE_STATUSES } from '../compliance/certificates/rules'

/**
 * Certificates in depth: events (B-W2b-255; the code is factory-domain compliance/certificates-depth). A module folder of
 * its own, as compliance-rules and textile-rules (the event guard wants `src/<module>/events.ts`).
 * apps/factory-api's modules/compliance/certificates-depth emits them in the command that makes the change.
 *
 *   certificates_depth.notified_body_changed   a body of the notified body directory was added, edited, archived or
 *                                              restored (PRD-286)
 *   certificates_depth.certificate_detailed    a certificate got (or, while a draft, changed or lost) its directory body,
 *                                              its performance levels, its base certificate (own-brand), or a bought-in
 *                                              part's supplier on its coverage (PRD-286, PRD-287, PRD-290, QHS-106)
 *
 * Live for compliance.certificates.view (the register, the record and the Notified bodies pop-up re-read). Ids, numbers,
 * kinds and states only: no words a person typed.
 */
const live = { permission: 'compliance.certificates.view' } as const

export const events = [
  defineEvent({
    type: 'certificates_depth.notified_body_changed',
    context: 'certificates-depth',
    description: 'A notified body of the directory was added, edited, archived or restored.',
    payload: z.strictObject({
      bodyId: z.uuid(),
      number: z.string(),
      status: z.enum(['ACTIVE', 'ARCHIVED']),
      change: z.enum(['CREATED', 'EDITED', 'ARCHIVED', 'RESTORED']),
    }),
    live: { ...live, fields: ['bodyId', 'number', 'status', 'change'] },
  }),
  defineEvent({
    type: 'certificates_depth.certificate_detailed',
    context: 'certificates-depth',
    description: "A certificate got its directory notified body, its performance levels, its base certificate, or a bought-in part's supplier on its coverage.",
    payload: z.strictObject({
      certificateId: z.uuid(),
      number: z.string(),
      status: z.enum(CERTIFICATE_STATUSES),
      detail: z.enum(['NOTIFIED_BODY', 'LEVELS', 'BASE', 'SUPPLIER']),
    }),
    live: { ...live, fields: ['certificateId', 'number', 'status', 'detail'] },
  }),
]
