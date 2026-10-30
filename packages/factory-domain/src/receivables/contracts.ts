import { z } from 'zod'
import { businessDate, id, input, instant, output } from '../core/contracts'
import { MAX_ADDRESS_LENGTH, MAX_RECIPIENTS } from '../email/rules'
import { money } from '../money/marked'
import { LATE_INTEREST_MODES, MAX_LADDER_STEPS, MAX_OFFSET_DAYS, MIN_OFFSET_DAYS, REMINDER_ACTIONS, SWITCH_BLOCKERS, TEMPLATE_KEY } from './ladder'
import { AGEING_BUCKETS, MOVEMENT_KINDS } from './ledger'
import { HELD_REASONS, MAX_BULK_REMINDERS, MAX_REMINDER_TEXT, REMINDER_STATUSES } from './reminders'
import { REMINDER_TEMPLATES } from './wording'

/**
 * The contracts of receivables (B-W2a-55; FIN-109, FIN-110, FIN-111; design finance.receivables, SCR-151: the tiles "What
 * customers owe", the grid "By customer", the pop-up "statement" and its PDF, "Reminders to approve", the settings the
 * ladder reads). Every amount is marked with the price grain and dropped for a caller without it; a reminder's text names
 * amounts, so it is marked too. Words are English (the screens translate by the codes).
 */

const text = (max: number) => z.string().trim().min(1).max(max)
const version = () => z.number().int().min(1)
const amount = () => money.price(z.number().int())
const buckets = () => money.price(output(Object.fromEntries(AGEING_BUCKETS.map((bucket) => [bucket, z.number().int()])) as Record<(typeof AGEING_BUCKETS)[number], z.ZodNumber>))
const words = output({ en: z.string(), it: z.string() })
const personRef = output({ id: id(), name: z.string().nullable() })
const companyRef = output({ id: id(), code: z.string(), name: z.string() })
const customerRef = output({ id: id(), code: z.string(), name: z.string() })
const language = z.enum(['it', 'en'])

// ---- the ageing (What customers owe, By customer) -------------------------------------------------------------------------

export const AGEING_FILTERS = ['OVERDUE', ...AGEING_BUCKETS] as const

export const ageingQuery = input({
  companyId: id().optional(),
  partyId: id().optional(),
  /** The day the ageing is counted on (default today, Europe/Rome). */
  asOf: businessDate().optional(),
  /** The customer's code or name. */
  q: z.string().trim().min(1).max(100).optional(),
  /** A tile clicked: only the customers with money in that bucket (OVERDUE: any late one). */
  bucket: z.enum(AGEING_FILTERS).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  /** The row to start from (the `next` of the page before). */
  cursor: z.coerce.number().int().min(0).optional(),
})
export type AgeingQuery = z.infer<typeof ageingQuery>

export const ageingTile = output({ currency: z.string(), customers: z.number().int(), invoices: z.number().int(), open: amount(), overdue: amount(), buckets: buckets() })

export const ageingRow = output({
  company: companyRef,
  customer: customerRef,
  currency: z.string(),
  open: amount(),
  overdue: amount(),
  buckets: buckets(),
  invoices: z.number().int(),
  /** The oldest due date among what is open, and how late it is (null: not late). */
  oldestDueDate: businessDate().nullable(),
  daysLate: z.number().int().nullable(),
  lastPaymentOn: businessDate().nullable(),
  remindersSent: z.number().int(),
  lastReminderAt: instant().nullable(),
  /** Prepared or approved, waiting. */
  remindersWaiting: z.number().int(),
  /** W2b (credit limits): always null in W2a. */
  creditLimitUsed: z.null(),
})

export const ageingAnswer = output({
  asOf: businessDate(),
  readAt: instant(),
  tiles: z.array(ageingTile),
  customers: z.array(ageingRow),
  /** How many customers match (every page). */
  count: z.number().int(),
  next: z.number().int().nullable(),
  bucketWords: output(Object.fromEntries(AGEING_BUCKETS.map((bucket) => [bucket, words])) as Record<(typeof AGEING_BUCKETS)[number], typeof words>),
})

// ---- the customer's ledger and statement -------------------------------------------------------------------------------------

export const customerParams = input({ partyId: id() })

export const statementQuery = input({
  companyId: id(),
  from: businessDate().optional(),
  to: businessDate().optional(),
  /** One statement per currency (default: the company's, else the one the customer was invoiced in). */
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  language: language.optional(),
})
export type StatementQuery = z.infer<typeof statementQuery>

export const statementLineView = output({
  kind: z.enum(MOVEMENT_KINDS),
  date: businessDate(),
  recordType: z.enum(['Invoice', 'Payment', 'Refund']),
  recordId: id(),
  reference: z.string().nullable(),
  docType: z.string().nullable(),
  dueDate: businessDate().nullable(),
  label: z.string(),
  debit: amount(),
  credit: amount(),
  balance: amount(),
})

export const openItemView = output({
  invoiceId: id(),
  number: z.string(),
  docType: z.string(),
  issueDate: businessDate(),
  dueDate: businessDate(),
  dueDateKnown: z.boolean(),
  open: amount(),
  bucket: z.enum(AGEING_BUCKETS),
  daysLate: z.number().int(),
})

export const statementAnswer = output({
  company: companyRef,
  customer: customerRef.extend({ language: z.string() }),
  currency: z.string(),
  /** Other currencies the customer has movements in (each its own statement). */
  currencies: z.array(z.string()),
  from: businessDate(),
  to: businessDate(),
  opening: amount(),
  closing: amount(),
  totals: money.price(output({ invoiced: z.number().int(), credited: z.number().int(), paid: z.number().int(), refunded: z.number().int() })),
  lines: z.array(statementLineView),
  openItems: z.array(openItemView),
  ageing: money.price(output({ open: z.number().int(), overdue: z.number().int(), buckets: output(Object.fromEntries(AGEING_BUCKETS.map((bucket) => [bucket, z.number().int()])) as Record<(typeof AGEING_BUCKETS)[number], z.ZodNumber>) })),
  remindersSent: z.number().int(),
  /** The INVOICES contacts a statement or reminder e-mail goes to. */
  recipients: z.array(output({ name: z.string(), email: z.string() })),
})

export const sendStatementBody = input({
  companyId: id(),
  from: businessDate().optional(),
  to: businessDate().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  language: language.optional(),
  /** Default: the customer's active contacts that receive invoices. */
  recipients: z.array(z.string().max(MAX_ADDRESS_LENGTH)).min(1).max(MAX_RECIPIENTS).optional(),
  message: z.string().trim().max(2000).optional(),
})
export type SendStatementBody = z.infer<typeof sendStatementBody>

export const sentStatementAnswer = output({ fileId: id(), emailId: id(), to: z.array(z.string()), from: businessDate(), until: businessDate() })

// ---- the settings ---------------------------------------------------------------------------------------------------------

export const settingsQuery = input({ companyId: id().optional() })

export const stepInput = input({
  offsetDays: z.number().int().min(MIN_OFFSET_DAYS).max(MAX_OFFSET_DAYS),
  action: z.enum(REMINDER_ACTIONS),
  template: z.string().regex(TEMPLATE_KEY).nullable().optional(),
})

export const settingsBody = input({
  /** null: the tenant-wide settings (a grant over every company). */
  companyId: id().nullable(),
  /** The row's version; absent when the company has no row of its own yet (it is made from the tenant's). */
  version: version().optional(),
  ladder: z.array(stepInput).max(MAX_LADDER_STEPS),
  lateInterestMode: z.enum(LATE_INTEREST_MODES),
  lateInterestAgreedPct: z.string().regex(/^\d{1,3}(\.\d{1,4})?$/).nullable().optional(),
  recoveryChargeAmount: money.price(z.number().int().min(0).nullable()),
  minimumAmount: money.price(z.number().int().min(0).nullable()),
})
export type SettingsBody = z.infer<typeof settingsBody>

export const switchBody = input({ companyId: id().nullable(), on: z.boolean(), version: version().optional() })
export type SwitchBody = z.infer<typeof switchBody>

export const stepView = output({ level: z.number().int(), offsetDays: z.number().int(), action: z.enum(REMINDER_ACTIONS), template: z.string().nullable(), words })

export const settingsView = output({
  id: id(),
  companyId: id().nullable(),
  version: z.number().int(),
  remindersEnabled: z.boolean(),
  ladder: z.array(stepView),
  lateInterestMode: z.enum(LATE_INTEREST_MODES),
  lateInterestAgreedPct: z.string().nullable(),
  recoveryChargeAmount: money.price(z.number().int().nullable()),
  minimumAmount: money.price(z.number().int().nullable()),
  updatedAt: instant(),
})

export const settingsAnswer = output({
  companyId: id().nullable(),
  /** Which row holds: the company's own, the tenant-wide one, or none (no reminder is prepared). */
  source: z.enum(['COMPANY', 'TENANT', 'NONE']),
  effective: settingsView.nullable(),
  company: settingsView.nullable(),
  tenant: settingsView.nullable(),
  switch: output({ on: z.boolean(), words: z.string(), blockers: z.array(output({ code: z.enum(Object.keys(SWITCH_BLOCKERS) as [keyof typeof SWITCH_BLOCKERS]), words: z.string() })), mayChange: z.boolean() }),
  interest: output({ mode: z.enum(LATE_INTEREST_MODES), words: z.string() }),
  wording: output({ toConfirm: z.literal(true), words: z.string(), templates: z.array(output({ key: z.enum(REMINDER_TEMPLATES), words })) }),
  mayManage: z.boolean(),
})

// ---- reminders ------------------------------------------------------------------------------------------------------------

export const REMINDER_VIEWS = ['toApprove', 'waiting', 'sent', 'closed', 'all'] as const

export const remindersQuery = input({
  companyId: id().optional(),
  partyId: id().optional(),
  /** toApprove: PREPARED (default) · waiting: APPROVED, not sent · sent · closed: skipped or cancelled · all. */
  view: z.enum(REMINDER_VIEWS).default('toApprove'),
  level: z.coerce.number().int().min(1).max(MAX_LADDER_STEPS).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: id().optional(),
})
export type RemindersQuery = z.infer<typeof remindersQuery>

export const reminderParams = input({ reminderId: id() })

export const prepareBody = input({
  companyId: id(),
  partyId: id(),
  /** The invoices to remind (default: every open one of the customer, or those of `salesOrderId`). */
  invoiceIds: z.array(id()).min(1).max(MAX_BULK_REMINDERS).optional(),
  /** The order whose open invoices are reminded (its payment schedule's "Send reminder"). */
  salesOrderId: id().optional(),
})
export type PrepareBody = z.infer<typeof prepareBody>

export const editBody = input({
  version: version(),
  subject: z.string().trim().min(1).max(MAX_REMINDER_TEXT.subject).optional(),
  body: z.string().trim().min(1).max(MAX_REMINDER_TEXT.body).optional(),
  /** Another language: the text is written again from its template unless a subject and body are given. */
  language: language.optional(),
})
export type EditBody = z.infer<typeof editBody>

export const approveBody = input({
  version: version(),
  /** The final text, when edited at approval. */
  subject: z.string().trim().min(1).max(MAX_REMINDER_TEXT.subject).optional(),
  body: z.string().trim().min(1).max(MAX_REMINDER_TEXT.body).optional(),
  /** Send it at once (refused as a whole while the company's reminders are switched off). */
  send: z.boolean().default(false),
  /** A CALL sent at once: what was said. */
  callNote: text(MAX_REMINDER_TEXT.callNote).optional(),
})
export type ApproveBody = z.infer<typeof approveBody>

export const sendBody = input({ version: version(), callNote: text(MAX_REMINDER_TEXT.callNote).optional() })
export type SendBody = z.infer<typeof sendBody>

export const reasonBody = input({ version: version(), reason: text(MAX_REMINDER_TEXT.reason) })
export type ReasonBody = z.infer<typeof reasonBody>

export const bulkApproveBody = input({
  items: z.array(input({ id: id(), version: version() })).min(1).max(MAX_BULK_REMINDERS),
  send: z.boolean().default(false),
})
export type BulkApproveBody = z.infer<typeof bulkApproveBody>

export const reminderInvoiceView = output({ id: id(), number: z.string().nullable(), issueDate: businessDate().nullable(), dueDate: businessDate().nullable(), openNow: amount() })

export const reminderView = output({
  id: id(),
  company: companyRef,
  customer: customerRef,
  level: z.number().int(),
  /** The ladder step in words ("7 days late"); null when the ladder has no such level any more. */
  step: output({ offsetDays: z.number().int(), words }).nullable(),
  action: z.enum(REMINDER_ACTIONS),
  status: z.enum(REMINDER_STATUSES),
  byHand: z.boolean(),
  invoices: z.array(reminderInvoiceView),
  amountDue: money.price(z.number().int()),
  interestAmount: money.price(z.number().int().nullable()),
  currency: z.string(),
  oldestDueDate: businessDate(),
  language: z.string(),
  /** The text names amounts: only with the price grain. */
  text: money.price(output({ subject: z.string().nullable(), body: z.string().nullable() })),
  held: z.array(output({ code: z.enum(Object.keys(HELD_REASONS) as [keyof typeof HELD_REASONS]), words: z.string() })),
  preparedAt: instant(),
  preparedBy: personRef.nullable(),
  approvedAt: instant().nullable(),
  approvedBy: personRef.nullable(),
  sentAt: instant().nullable(),
  callNote: z.string().nullable(),
  skippedAt: instant().nullable(),
  skippedBy: personRef.nullable(),
  skipReason: z.string().nullable(),
  cancelledAt: instant().nullable(),
  cancelReason: z.string().nullable(),
  /** The e-mail it went out as (its delivery state), or the printed letter. */
  email: output({ id: id(), status: z.string(), to: z.array(z.string()) }).nullable(),
  letterFileId: id().nullable(),
  /** What the reader may do with it now. */
  actions: output({ edit: z.boolean(), approve: z.boolean(), send: z.boolean(), skip: z.boolean(), cancel: z.boolean() }),
  version: z.number().int(),
})

export const remindersAnswer = output({
  reminders: z.array(reminderView),
  counts: output({ toApprove: z.number().int(), waiting: z.number().int(), sent30Days: z.number().int() }),
  nextCursor: id().nullable(),
})

export const reminderCountsAnswer = output({ toApprove: z.number().int(), waiting: z.number().int(), sent30Days: z.number().int() })

export const reminderAnswer = output({ reminder: reminderView })

export const bulkApproveAnswer = output({ reminders: z.array(reminderView) })

