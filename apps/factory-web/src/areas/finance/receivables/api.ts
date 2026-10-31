import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'

/**
 * Every call of Finance › Receivables & credit (SCR-151, design finance.receivables; B-W2a-55's API) with the answer's
 * shape checked (zod; unknown fields are dropped). The shapes mirror factory-domain receivables/contracts.ts; the enum
 * lists mirror factory-domain (receivables.vitest.test.ts holds them equal). Every amount is a price: the API drops it
 * for a person without money.price, so each money field is optional (absent, never zero) and the screen draws no
 * column for it then; a reminder's text names amounts, so it is dropped too. Words in the answers are English: the
 * screen speaks by the codes.
 */

export const AGEING_BUCKETS = ['NOT_DUE', 'D1_30', 'D31_60', 'D61_90', 'OVER_90'] as const
export type AgeingBucket = (typeof AGEING_BUCKETS)[number]
/** A tile clicked: only the customers with money in that bucket (OVERDUE: any late one). */
export const AGEING_FILTERS = ['OVERDUE', ...AGEING_BUCKETS] as const
export type AgeingFilter = (typeof AGEING_FILTERS)[number]
export const MOVEMENT_KINDS = ['INVOICE', 'CREDIT_NOTE', 'PAYMENT', 'REFUND'] as const
export const REMINDER_ACTIONS = ['EMAIL', 'LETTER', 'CALL'] as const
export type ReminderAction = (typeof REMINDER_ACTIONS)[number]
export const REMINDER_STATUSES = ['PREPARED', 'APPROVED', 'SENT', 'SKIPPED', 'CANCELLED'] as const
export type ReminderStatus = (typeof REMINDER_STATUSES)[number]
export const REMINDER_VIEWS = ['toApprove', 'waiting', 'sent', 'closed', 'all'] as const
export type ReminderView = (typeof REMINDER_VIEWS)[number]
/** Warnings on a reminder (approval is not blocked by them). */
export const HELD_REASONS = ['UNPLACED_PAYMENT', 'CREDIT_NOTE_DRAFT', 'CHANGED', 'NO_CONTACT', 'SWITCHED_OFF', 'DEPOSIT_TO_CARRY'] as const
export type HeldReason = (typeof HELD_REASONS)[number]
/** The API's refusals of a reminder move (409 at `reminder/<CODE>`, or `body/items/<i>/<CODE>` in a bulk approval). */
export const REMINDER_REFUSALS = [
  'NOT_PREPARED',
  'NOT_APPROVED',
  'FINAL',
  'SWITCHED_OFF',
  'NO_CONTACT',
  'CHANGED',
  'NO_TEXT',
  'CALL_NOTE',
  'OPEN_AT_LEVEL',
  'NOTHING_OPEN',
  'NO_LADDER',
  'NOT_A_CALL',
] as const
export type ReminderRefusal = (typeof REMINDER_REFUSALS)[number]
export const SWITCH_BLOCKERS = ['NO_LADDER', 'INTEREST_UNDECIDED'] as const
export const LATE_INTEREST_MODES = ['UNDECIDED', 'NONE', 'STATUTORY', 'AGREED'] as const
/** At most this many reminders in one "Approve and send n". */
export const MAX_BULK_REMINDERS = 50
export const MAX_REMINDER_TEXT = {
  subject: 200,
  body: 8000,
  reason: 1000,
  callNote: 2000,
} as const

/** A figure of the price grain: absent for a person without it. */
const price = <T extends z.ZodTypeAny>(schema: T) => schema.optional()
const words = z.object({ en: z.string(), it: z.string() })
const named = z.object({ id: z.string(), code: z.string(), name: z.string() })
const person = z.object({ id: z.string(), name: z.string().nullable() })
const bucketAmounts = z.object(Object.fromEntries(AGEING_BUCKETS.map((bucket) => [bucket, z.number()])) as Record<AgeingBucket, z.ZodNumber>)

export const ageingTileSchema = z.object({
  currency: z.string(),
  customers: z.number(),
  invoices: z.number(),
  open: price(z.number()),
  overdue: price(z.number()),
  buckets: price(bucketAmounts),
})
export type AgeingTile = z.infer<typeof ageingTileSchema>

export const ageingRowSchema = z.object({
  company: named,
  customer: named,
  currency: z.string(),
  open: price(z.number()),
  overdue: price(z.number()),
  buckets: price(bucketAmounts),
  invoices: z.number(),
  oldestDueDate: z.string().nullable(),
  daysLate: z.number().nullable(),
  lastPaymentOn: z.string().nullable(),
  remindersSent: z.number(),
  lastReminderAt: z.string().nullable(),
  remindersWaiting: z.number(),
  creditLimitUsed: z.null(),
})
export type AgeingRow = z.infer<typeof ageingRowSchema>

export const ageingSchema = z.object({
  asOf: z.string(),
  readAt: z.string(),
  tiles: z.array(ageingTileSchema),
  customers: z.array(ageingRowSchema),
  count: z.number(),
  next: z.number().nullable(),
})
export type Ageing = z.infer<typeof ageingSchema>

export const statementLineSchema = z.object({
  kind: z.enum(MOVEMENT_KINDS),
  date: z.string(),
  recordType: z.enum(['Invoice', 'Payment', 'Refund']),
  recordId: z.string(),
  reference: z.string().nullable(),
  docType: z.string().nullable(),
  dueDate: z.string().nullable(),
  label: z.string(),
  debit: price(z.number()),
  credit: price(z.number()),
  balance: price(z.number()),
})
export type StatementLine = z.infer<typeof statementLineSchema>

export const openItemSchema = z.object({
  invoiceId: z.string(),
  number: z.string(),
  docType: z.string(),
  issueDate: z.string(),
  dueDate: z.string(),
  dueDateKnown: z.boolean(),
  open: price(z.number()),
  bucket: z.enum(AGEING_BUCKETS),
  daysLate: z.number(),
})
export type OpenItem = z.infer<typeof openItemSchema>

export const statementSchema = z.object({
  company: named,
  customer: named.extend({ language: z.string() }),
  currency: z.string(),
  currencies: z.array(z.string()),
  from: z.string(),
  to: z.string(),
  opening: price(z.number()),
  closing: price(z.number()),
  totals: price(
    z.object({
      invoiced: z.number(),
      credited: z.number(),
      paid: z.number(),
      refunded: z.number(),
    }),
  ),
  lines: z.array(statementLineSchema),
  openItems: z.array(openItemSchema),
  ageing: price(z.object({ open: z.number(), overdue: z.number(), buckets: bucketAmounts })),
  remindersSent: z.number(),
  recipients: z.array(z.object({ name: z.string(), email: z.string() })),
})
export type Statement = z.infer<typeof statementSchema>

export const sentStatementSchema = z.object({
  fileId: z.string(),
  emailId: z.string(),
  to: z.array(z.string()),
  from: z.string(),
  until: z.string(),
})
export type SentStatement = z.infer<typeof sentStatementSchema>

export const reminderSchema = z.object({
  id: z.string(),
  company: named,
  customer: named,
  level: z.number(),
  step: z.object({ offsetDays: z.number(), words }).nullable(),
  action: z.enum(REMINDER_ACTIONS),
  status: z.enum(REMINDER_STATUSES),
  byHand: z.boolean(),
  invoices: z.array(
    z.object({
      id: z.string(),
      number: z.string().nullable(),
      issueDate: z.string().nullable(),
      dueDate: z.string().nullable(),
      openNow: price(z.number()),
    }),
  ),
  amountDue: price(z.number()),
  interestAmount: price(z.number().nullable()),
  currency: z.string(),
  oldestDueDate: z.string(),
  language: z.string(),
  text: price(z.object({ subject: z.string().nullable(), body: z.string().nullable() })),
  held: z.array(z.object({ code: z.enum(HELD_REASONS), words: z.string() })),
  preparedAt: z.string(),
  preparedBy: person.nullable(),
  approvedAt: z.string().nullable(),
  approvedBy: person.nullable(),
  sentAt: z.string().nullable(),
  callNote: z.string().nullable(),
  skippedAt: z.string().nullable(),
  skippedBy: person.nullable(),
  skipReason: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  email: z.object({ id: z.string(), status: z.string(), to: z.array(z.string()) }).nullable(),
  letterFileId: z.string().nullable(),
  actions: z.object({
    edit: z.boolean(),
    approve: z.boolean(),
    send: z.boolean(),
    skip: z.boolean(),
    cancel: z.boolean(),
  }),
  version: z.number(),
})
export type Reminder = z.infer<typeof reminderSchema>

export const reminderCountsSchema = z.object({
  toApprove: z.number(),
  waiting: z.number(),
  sent30Days: z.number(),
})
export type ReminderCounts = z.infer<typeof reminderCountsSchema>

export const remindersSchema = z.object({
  reminders: z.array(reminderSchema),
  counts: reminderCountsSchema,
  nextCursor: z.string().nullable(),
})
export type Reminders = z.infer<typeof remindersSchema>

const oneReminder = z.object({ reminder: reminderSchema })

/** What the reminders section needs of the settings: the Owner's switch (on: "Approve and send"; off: approve only, in words). */
export const settingsSchema = z.object({
  companyId: z.string().nullable(),
  source: z.enum(['COMPANY', 'TENANT', 'NONE']),
  switch: z.object({
    on: z.boolean(),
    words: z.string(),
    blockers: z.array(z.object({ code: z.enum(SWITCH_BLOCKERS), words: z.string() })),
    mayChange: z.boolean(),
  }),
  interest: z.object({ mode: z.enum(LATE_INTEREST_MODES), words: z.string() }),
  wording: z.object({ toConfirm: z.literal(true), words: z.string() }),
  mayManage: z.boolean(),
})
export type ReceivablesSettings = z.infer<typeof settingsSchema>

const clean = (query: Readonly<Record<string, string | number | null | undefined>>) =>
  Object.fromEntries(Object.entries(query).filter(([, value]) => value !== null && value !== undefined && value !== ''))

export interface AgeingQuery {
  readonly companyId?: string | null
  readonly partyId?: string | null
  readonly asOf?: string | null
  readonly q?: string | null
  readonly bucket?: AgeingFilter | null
  readonly limit?: number
  readonly cursor?: number | null
}

/** GET /receivables/ageing: the tiles per currency over every matching customer, and a page of customers by age. */
export function getAgeing(api: ApiClient, query: AgeingQuery, signal?: AbortSignal): Promise<Ageing> {
  return api.get('/receivables/ageing', {
    query: clean({
      companyId: query.companyId,
      partyId: query.partyId,
      asOf: query.asOf,
      q: query.q,
      bucket: query.bucket,
      limit: query.limit ?? 100,
      cursor: query.cursor,
    }),
    schema: ageingSchema,
    signal,
  })
}

export interface StatementQuery {
  readonly companyId: string
  readonly from?: string | null
  readonly to?: string | null
  readonly currency?: string | null
  readonly language?: 'it' | 'en' | null
}

const statementPath = (partyId: string) => `/receivables/customers/${encodeURIComponent(partyId)}/statement`
const statementQuery = (query: StatementQuery) =>
  clean({
    companyId: query.companyId,
    from: query.from,
    to: query.to,
    currency: query.currency,
    language: query.language,
  })

/** GET /receivables/customers/:partyId/statement: the period's movements with the running balance and what is open. */
export function getStatement(api: ApiClient, partyId: string, query: StatementQuery, signal?: AbortSignal): Promise<Statement> {
  return api.get(statementPath(partyId), {
    query: statementQuery(query),
    schema: statementSchema,
    signal,
  })
}

/** GET …/statement/pdf: the statement as a PDF on the company's letterhead (made on request, stored nowhere; price grain). */
export function statementPdf(api: ApiClient, partyId: string, query: StatementQuery, signal?: AbortSignal): Promise<Uint8Array> {
  return api.bytes(`${statementPath(partyId)}/pdf`, {
    query: statementQuery(query),
    signal,
  })
}

/** POST …/statement/send: the PDF stored on the customer's record and e-mailed to its invoice contacts (ONE command). */
export function sendStatement(api: ApiClient, partyId: string, body: StatementQuery & { readonly message?: string | null }, idempotencyKey: string = newIdempotencyKey()): Promise<SentStatement> {
  const { companyId, from, to, currency, language, message } = body
  return api.post(`${statementPath(partyId)}/send`, {
    body: clean({
      companyId,
      from,
      to,
      currency,
      language,
      message: message?.trim() || null,
    }),
    schema: sentStatementSchema,
    idempotencyKey,
  })
}

/** GET /receivables/reminders/counts: the header's "Reminders to approve (n)". */
export function getReminderCounts(api: ApiClient, companyId: string | null, signal?: AbortSignal): Promise<ReminderCounts> {
  return api.get('/receivables/reminders/counts', {
    query: clean({ companyId }),
    schema: reminderCountsSchema,
    signal,
  })
}

/** GET /receivables/reminders: a page of reminders of one view (default: to approve), oldest prepared first as the API orders them. */
export function listReminders(
  api: ApiClient,
  query: {
    readonly companyId?: string | null
    readonly partyId?: string | null
    readonly view?: ReminderView
    readonly cursor?: string | null
    readonly limit?: number
  },
  signal?: AbortSignal,
): Promise<Reminders> {
  return api.get('/receivables/reminders', {
    query: clean({
      companyId: query.companyId,
      partyId: query.partyId,
      view: query.view ?? 'toApprove',
      cursor: query.cursor,
      limit: query.limit ?? 50,
    }),
    schema: remindersSchema,
    signal,
  })
}

const reminderPath = (id: string) => `/receivables/reminders/${encodeURIComponent(id)}`

/** GET /receivables/reminders/:id: one reminder with its invoices, text, warnings and what the reader may do. */
export async function getReminder(api: ApiClient, id: string, signal?: AbortSignal): Promise<Reminder> {
  return (await api.get(reminderPath(id), { schema: oneReminder, signal })).reminder
}

/** PATCH /receivables/reminders/:id: "Edit text" while it waits for approval (another language writes it again). */
export async function editReminder(
  api: ApiClient,
  id: string,
  body: {
    readonly version: number
    readonly subject?: string
    readonly body?: string
    readonly language?: 'it' | 'en'
  },
): Promise<Reminder> {
  return (
    await api.request('PATCH', reminderPath(id), {
      body,
      schema: oneReminder,
      idempotencyKey: newIdempotencyKey(),
    })
  ).reminder
}

/** POST /receivables/reminders/:id/approve: a person approves (and, while switched on, sends) one reminder. */
export async function approveReminder(
  api: ApiClient,
  id: string,
  body: {
    readonly version: number
    readonly send: boolean
    readonly subject?: string
    readonly body?: string
    readonly callNote?: string
  },
): Promise<Reminder> {
  return (
    await api.post(`${reminderPath(id)}/approve`, {
      body,
      schema: oneReminder,
      idempotencyKey: newIdempotencyKey(),
    })
  ).reminder
}

/** POST /receivables/reminders/approve: "Approve and send n" — up to 50 at once, all or none. */
export async function approveReminders(api: ApiClient, items: readonly { readonly id: string; readonly version: number }[], send: boolean): Promise<Reminder[]> {
  return (
    await api.post('/receivables/reminders/approve', {
      body: { items, send },
      schema: z.object({ reminders: z.array(reminderSchema) }),
      idempotencyKey: newIdempotencyKey(),
    })
  ).reminders
}

/** POST /receivables/reminders/:id/send: an approved reminder goes out (only while switched on). */
export async function sendReminder(api: ApiClient, id: string, body: { readonly version: number; readonly callNote?: string }): Promise<Reminder> {
  return (
    await api.post(`${reminderPath(id)}/send`, {
      body,
      schema: oneReminder,
      idempotencyKey: newIdempotencyKey(),
    })
  ).reminder
}

/** POST /receivables/reminders/:id/skip: "Skip with reason" (a person decided; the invoice counts as reminded at its level). */
export async function skipReminder(api: ApiClient, id: string, body: { readonly version: number; readonly reason: string }): Promise<Reminder> {
  return (
    await api.post(`${reminderPath(id)}/skip`, {
      body,
      schema: oneReminder,
      idempotencyKey: newIdempotencyKey(),
    })
  ).reminder
}

/** POST /receivables/reminders/:id/cancel: "Cancel reminder" with a reason (one that asks what is no longer due: the ladder prepares it again). */
export async function cancelReminder(api: ApiClient, id: string, body: { readonly version: number; readonly reason: string }): Promise<Reminder> {
  return (await api.post(`${reminderPath(id)}/cancel`, { body, schema: oneReminder, idempotencyKey: newIdempotencyKey() })).reminder
}

/** GET /receivables/settings: the switch (on or off, in words) the reminders section shows. */
export function getReceivablesSettings(api: ApiClient, companyId: string | null, signal?: AbortSignal): Promise<ReceivablesSettings> {
  return api.get('/receivables/settings', {
    query: clean({ companyId }),
    schema: settingsSchema,
    signal,
  })
}
