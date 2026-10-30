import { z } from 'zod'
import { CERTIFICATE_STATUSES } from '@nexus/factory-domain/compliance/certificates/rules'
import { WINDOW_PHASES } from '@nexus/factory-domain/compliance/renewals/rules'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'

/**
 * The Renewals tab's contracts (B-W2a-66; QHS-105, PRD-283). Days are YYYY-MM-DD (Europe/Rome), instants UTC ISO. No
 * money, no floor worker: the people named are office users (who started the renewal, the task's assignee).
 */

const status = z.enum(CERTIFICATE_STATUSES)
const version = () => z.number().int().min(1)
const params = input({ certificateId: id() })

const certificateRef = output({ id: id(), number: z.string(), standard: z.string(), status, validFrom: businessDate(), validTo: businessDate() })

const stage = output({
  /** The exception rule (kind CERTIFICATE_EXPIRING) that gives this alert. */
  ruleId: id(),
  name: z.string(),
  daysBefore: z.number().int(),
  workingDays: z.boolean(),
  enabled: z.boolean(),
  builtIn: z.boolean(),
  severity: z.enum(['INFO', 'WARNING', 'CRITICAL']),
  /** Whom it tells (an office role); null: nobody by role. */
  recipientRole: output({ id: id(), name: z.string() }).nullable(),
  /** The day it fires: its timer's, else N calendar days before the last valid day. */
  fireOn: businessDate(),
  timer: output({ id: id(), status: z.enum(['PENDING', 'FIRED', 'CANCELLED']), fireAt: instant(), firedAt: instant().nullable(), cancelReason: z.string().nullable() }).nullable(),
  /** The alert it raised (alerts.view only). */
  alert: output({ id: id(), state: z.enum(['OPEN', 'ACKNOWLEDGED', 'RESOLVED']), raisedAt: instant(), resolvedAt: instant().nullable(), occurrence: z.number().int(), told: z.number().int() }).nullable(),
})

const checklistItem = output({ text: z.string(), done: z.boolean(), doneAt: z.string().nullable(), doneBy: z.string().nullable() })

export const renewalsView = output({
  today: businessDate(),
  certificate: output({
    id: id(),
    number: z.string(),
    status,
    standard: z.string(),
    ppeClass: z.string().nullable(),
    companyId: id().nullable(),
    holderPartyId: id().nullable(),
    notifiedBodyName: z.string(),
    notifiedBodyNumber: z.string(),
    validFrom: businessDate(),
    validTo: businessDate(),
    daysToExpiry: z.number().int(),
    version: z.number().int(),
  }),
  window: output({ opens: businessDate(), closes: businessDate(), phase: z.enum(WINDOW_PHASES) }),
  stages: z.array(stage),
  renewal: output({
    startedAt: instant(),
    startedBy: z.string().nullable(),
    /** The renewal task (null: not visible to the reader, or gone). */
    task: output({ id: id(), title: z.string(), status: z.enum(['OPEN', 'DONE', 'CANCELLED']), dueDate: businessDate().nullable(), assignee: z.string().nullable(), checklist: z.array(checklistItem) }).nullable(),
    taskId: id(),
    appliedOn: businessDate().nullable(),
    reference: z.string().nullable(),
    note: z.string().nullable(),
    inWindow: z.boolean().nullable(),
  }).nullable(),
  successor: certificateRef.nullable(),
  /** The certificate this one renews. */
  renews: certificateRef.nullable(),
  /** Registered certificates of the same holder, valid from a later day, renewing nothing yet (the link's choices). */
  candidates: z.array(certificateRef),
  /** The styles this certificate covers and whether the successor covers them too (once linked). */
  carriedOver: z.array(output({ styleId: id(), code: z.string(), name: z.string(), covered: z.boolean() })).nullable(),
  nextStep: z.enum(['START', 'APPLY', 'LINK', 'RENEWED', 'NONE']),
  log: z.array(output({ at: instant(), action: z.enum(['STARTED', 'APPLIED', 'RENEWED']), by: z.string().nullable(), detail: z.string().nullable() })),
})
export type RenewalsView = z.infer<typeof renewalsView>

const one = { 200: output({ renewals: renewalsView }) }

export const getRenewalsContract = defineContract({ params, response: one })

export const startRenewalContract = defineContract({
  params,
  body: input({
    /** The certificate's version the screen read. */
    version: version(),
    /** Who the renewal task is for; left out: the person starting it; null: nobody yet. */
    assigneeId: id().nullish(),
    /** The language of the task's words (the office's two). */
    language: z.enum(['it', 'en']).default('it'),
  }),
  response: one,
})

export const appliedContract = defineContract({
  params,
  body: input({
    version: version(),
    /** The day the application went to the notified body. */
    appliedOn: businessDate(),
    /** The notified body's reference of the application, if it gave one. */
    reference: z.string().trim().max(100).nullish(),
    note: z.string().trim().max(1000).nullish(),
  }),
  response: one,
})

export const successorContract = defineContract({
  params,
  body: input({ version: version(), successorId: id() }),
  response: one,
})
