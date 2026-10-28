import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * The compliance module's events (plan A1 §3.4; QHS-103, QHS-105, PRD-283). apps/factory-api's
 * modules/compliance/certificates emits them from the scheduler's daily `compliance.certificateExpiry` cron:
 * `compliance.certificate_expiring` once per warning threshold (90, 30 and 7 days before the last valid day) and
 * `compliance.certificate_expired` when a certificate past its last valid day is marked EXPIRED (from then on the
 * certificate gate refuses every garment it covered). The expiry alerts to people (QHS-105, W2a) consume them.
 */
const day = () => z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

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
] as const
