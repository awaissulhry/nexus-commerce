import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * The receivables' events (plan A1 §3.4; B-W2a-55; FIN-109, FIN-110, FIN-111). apps/factory-api modules/receivables emits
 * them in the commands that prepare, change, approve, send, skip and cancel a payment reminder, change the settings and
 * send a statement. Ids, levels, kinds and counts only: never an amount, a text or an address. Live on the screens of the
 * people who hold receivables.view for the company (design finance.receivables: "Reminders to approve (n)" and the
 * ageing follow them).
 *
 *   payment_reminder.prepared   the ladder (on its timer) or a person prepared a reminder: it waits for a person
 *   payment_reminder.changed    its text or language was edited while it waited
 *   payment_reminder.approved   a person approved it (it is sent now, or once the company's reminders are switched on)
 *   payment_reminder.sent       it went out: the e-mail queued (FAKE locally), the letter printed, the call recorded
 *   payment_reminder.skipped    a person skipped it with a reason (that level is not sent for its invoices)
 *   payment_reminder.cancelled  cancelled by a person, or by the ladder because what it asks changed (paid, credited)
 *   receivables_settings.changed  the ladder, the late-payment rule or the Owner's switch of a company (or the tenant)
 *   customer_statement.sent     a customer was e-mailed its statement of account
 *   interest_rate.recorded      B-W2b-21: finance recorded a half-year's reference rate for statutory late-payment interest
 *   interest_rate.changed       B-W2b-21: a half-year's reference rate was corrected (the rate, the points, the source)
 */
const action = z.enum(['EMAIL', 'LETTER', 'CALL'])
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const live = { permission: 'receivables.view' as const, fields: ['reminderId', 'partyId', 'level'] }

export const events = [
  defineEvent({
    type: 'payment_reminder.prepared',
    context: 'receivables',
    description: 'A payment reminder was prepared (by the ladder or by a person): it waits for a person to approve it.',
    payload: z.strictObject({ reminderId: z.uuid(), partyId: z.uuid(), level: z.number().int().min(1), action, invoices: z.number().int().min(1), byHand: z.boolean() }),
    live,
  }),
  defineEvent({
    type: 'payment_reminder.changed',
    context: 'receivables',
    description: "A waiting payment reminder's text or language was edited.",
    payload: z.strictObject({ reminderId: z.uuid(), partyId: z.uuid(), level: z.number().int().min(1) }),
    live,
  }),
  defineEvent({
    type: 'payment_reminder.approved',
    context: 'receivables',
    description: 'A person approved a payment reminder.',
    payload: z.strictObject({ reminderId: z.uuid(), partyId: z.uuid(), level: z.number().int().min(1), sending: z.boolean() }),
    live,
  }),
  defineEvent({
    type: 'payment_reminder.sent',
    context: 'receivables',
    description: 'An approved payment reminder went out: the e-mail queued, the letter printed or the call recorded.',
    payload: z.strictObject({ reminderId: z.uuid(), partyId: z.uuid(), level: z.number().int().min(1), action, outboundId: z.uuid().nullable(), fileId: z.uuid().nullable() }),
    live,
  }),
  defineEvent({
    type: 'payment_reminder.skipped',
    context: 'receivables',
    description: 'A person skipped a payment reminder with a reason.',
    payload: z.strictObject({ reminderId: z.uuid(), partyId: z.uuid(), level: z.number().int().min(1) }),
    live,
  }),
  defineEvent({
    type: 'payment_reminder.cancelled',
    context: 'receivables',
    description: 'A payment reminder was cancelled by a person, or by the ladder because what it asks changed.',
    payload: z.strictObject({ reminderId: z.uuid(), partyId: z.uuid(), level: z.number().int().min(1), bySystem: z.boolean() }),
    live,
  }),
  defineEvent({
    type: 'receivables_settings.changed',
    context: 'receivables',
    description: "A company's (or the tenant's) receivables settings changed: the reminder ladder, the late-payment rule or the Owner's switch.",
    payload: z.strictObject({ settingsId: z.uuid(), companyId: z.uuid().nullable(), steps: z.number().int().min(0).max(10), remindersEnabled: z.boolean(), switched: z.boolean() }),
    live: { permission: 'receivables.view', fields: ['settingsId', 'companyId', 'remindersEnabled'] },
  }),
  defineEvent({
    type: 'customer_statement.sent',
    context: 'receivables',
    description: 'A customer was e-mailed its statement of account (the PDF on its record).',
    payload: z.strictObject({ partyId: z.uuid(), fileId: z.uuid(), outboundId: z.uuid(), from: day, to: day }),
    live: { permission: 'receivables.view', fields: ['partyId', 'from', 'to'] },
  }),
  // B-W2b-21 (D.Lgs. 231/2002 art. 5): the half-year reference rates statutory interest is computed from; tenant-wide.
  defineEvent({
    type: 'interest_rate.recorded',
    context: 'receivables',
    description: "A half-year's reference rate for statutory late-payment interest was recorded (with where it was published).",
    payload: z.strictObject({ rateId: z.uuid(), halfYearStart: day }),
    live: { permission: 'receivables.view', fields: ['rateId', 'halfYearStart'] },
  }),
  defineEvent({
    type: 'interest_rate.changed',
    context: 'receivables',
    description: "A half-year's reference rate for statutory late-payment interest was corrected.",
    payload: z.strictObject({ rateId: z.uuid(), halfYearStart: day }),
    live: { permission: 'receivables.view', fields: ['rateId', 'halfYearStart'] },
  }),
] as const
