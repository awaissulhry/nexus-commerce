import { isApiError, issuePath } from '../../../lib/api/errors'
import type { Locale } from '../../../lib/i18n/locales'
import { moneyText } from '../costing/model'
import {
  AGEING_BUCKETS,
  AGEING_FILTERS,
  REMINDER_REFUSALS,
  REMINDER_VIEWS,
  type AgeingBucket,
  type AgeingFilter,
  type AgeingQuery,
  type AgeingRow,
  type AgeingTile,
  type Reminder,
  type ReminderRefusal,
  type ReminderView,
  type StatementQuery,
} from './api'

/**
 * Finance › Receivables & credit (SCR-151) and its statement PDF tab: the pure rules — who may see and do what (the page
 * with receivables.view; every amount with the price grain; approving with receivables.reminders.approve; e-mailing a
 * statement with receivables.statements.send), the page's address (`?bucket=&q=&asOf=&statement=&company=&currency=
 * &reminders=&reminder=`), the tiles and what each filters, the age bar of a customer, the order J / K walks, the API's
 * refusals in this page's words, the CSV of a view and the live events that change it. No fetching, no React: the
 * tests hold them. No person is named in a figure.
 */

export const RECEIVABLES_NAMESPACE = 'finance-receivables'

export interface Phrase {
  readonly key: string
  readonly params?: Record<string, string | number>
}

export interface ReceivablesCan {
  /** The page (GET /receivables/…): receivables.view. */
  readonly view: boolean
  /** Every amount, a reminder's text and the statement's PDF: money.price. */
  readonly price: boolean
  readonly approve: boolean
  readonly manage: boolean
  readonly sendStatements: boolean
  /** A statement line opens its invoice / payment (Finance › Invoices, Payments). */
  readonly invoices: boolean
  readonly payments: boolean
  /** The customer opens its record (Sales › Customers). */
  readonly customers: boolean
}

export function receivablesCanOf(permissions: readonly string[]): ReceivablesCan {
  const held = new Set(permissions)
  return {
    view: held.has('receivables.view'),
    price: held.has('money.price'),
    approve: held.has('receivables.reminders.approve'),
    manage: held.has('receivables.reminders.manage'),
    sendStatements: held.has('receivables.statements.send'),
    invoices: held.has('invoices.view'),
    payments: held.has('payments.view'),
    customers: held.has('parties.view'),
  }
}

// ---- the address ----------------------------------------------------------------------------------------------------------

export interface ReceivablesAddress {
  /** A tile pressed (the API's own `bucket`); null: every customer who owes. */
  readonly bucket: AgeingFilter | null
  /** One customer (from its record's Overdue tile: the API's own `partyId`). */
  readonly party: string | null
  readonly q: string | null
  /** The day the ageing is counted on (Europe/Rome); null: today. */
  readonly asOf: string | null
  /** The customer whose statement is open (pop:statement), with its company and currency. */
  readonly statement: string | null
  readonly company: string | null
  readonly currency: string | null
  /** The reminders shown: to approve (default), waiting, sent, closed, all. */
  readonly reminders: ReminderView
  /** The reminder open in its dialog. */
  readonly reminder: string | null
}

const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CURRENCY = /^[A-Z]{3}$/

export function addressOf(params: { get(name: string): string | null } | null): ReceivablesAddress {
  const pick = (name: string, test: (value: string) => boolean) => {
    const value = params?.get(name) ?? null
    return value && test(value) ? value : null
  }
  const q = params?.get('q')?.trim() ?? ''
  const bucket = pick('bucket', (value) => (AGEING_FILTERS as readonly string[]).includes(value)) as AgeingFilter | null
  const reminders = (pick('reminders', (value) => (REMINDER_VIEWS as readonly string[]).includes(value)) ?? 'toApprove') as ReminderView
  return {
    bucket,
    party: pick('party', (value) => UUID.test(value)),
    q: q.length > 0 ? q.slice(0, 100) : null,
    asOf: pick('asOf', (value) => DAY.test(value)),
    statement: pick('statement', (value) => UUID.test(value)),
    company: pick('company', (value) => UUID.test(value)),
    currency: pick('currency', (value) => CURRENCY.test(value)),
    reminders,
    reminder: pick('reminder', (value) => UUID.test(value)),
  }
}

export function receivablesHref(prefix: string, address: ReceivablesAddress): string {
  const query = new URLSearchParams()
  if (address.bucket) query.set('bucket', address.bucket)
  if (address.party) query.set('party', address.party)
  if (address.q) query.set('q', address.q)
  if (address.asOf) query.set('asOf', address.asOf)
  if (address.statement) query.set('statement', address.statement)
  if (address.statement && address.company) query.set('company', address.company)
  if (address.statement && address.currency) query.set('currency', address.currency)
  if (address.reminders !== 'toApprove') query.set('reminders', address.reminders)
  if (address.reminder) query.set('reminder', address.reminder)
  const qs = query.toString()
  return `${prefix}/finance/receivables${qs ? `?${qs}` : ''}`
}

/** The API's ageing query for the address: 100 customers a page (the API's own filters; Show more with its `next`). */
export const ageingQueryOf = (address: ReceivablesAddress, companyId: string | null, cursor: number | null = null): AgeingQuery => ({
  companyId,
  partyId: address.party,
  asOf: address.asOf,
  q: address.q,
  bucket: address.bucket,
  limit: 100,
  cursor,
})

/** One statement (customer × company × currency): what the address names and J / K walks. */
export interface StatementRef {
  readonly partyId: string
  readonly companyId: string
  readonly currency: string | null
}

export const statementKey = (ref: StatementRef): string => `${ref.companyId}|${ref.partyId}|${ref.currency ?? ''}`
export const rowStatement = (row: Pick<AgeingRow, 'customer' | 'company' | 'currency'>): StatementRef => ({
  partyId: row.customer.id,
  companyId: row.company.id,
  currency: row.currency,
})

export function statementOfAddress(address: ReceivablesAddress, fallbackCompany: string | null): StatementRef | null {
  const companyId = address.company ?? fallbackCompany
  return address.statement && companyId ? { partyId: address.statement, companyId, currency: address.currency } : null
}

/** The statement's period: 1 January of the as-of year → the as-of day (the API's default), unless chosen in the dialog. */
export function statementQueryOf(ref: StatementRef, period: { readonly from: string | null; readonly to: string | null }, asOf: string | null): StatementQuery {
  return {
    companyId: ref.companyId,
    currency: ref.currency,
    from: period.from,
    to: period.to ?? asOf,
  }
}

/** The statement PDF tab (tab:statement-pdf): one or several statements, each `party:company:currency`, and the period. */
export function statementPdfHref(prefix: string, refs: readonly StatementRef[], period: { readonly from?: string | null; readonly to?: string | null } = {}): string {
  const query = new URLSearchParams()
  query.set('for', refs.map((ref) => [ref.partyId, ref.companyId, ref.currency ?? ''].join(':')).join(','))
  if (period.from) query.set('from', period.from)
  if (period.to) query.set('to', period.to)
  return `${prefix}/finance/receivables/statement?${query.toString()}`
}

/** At most this many statements in one PDF tab ("Print N statements"). */
export const MAX_PRINTED_STATEMENTS = 10

export interface StatementPdfAddress {
  readonly refs: readonly StatementRef[]
  readonly from: string | null
  readonly to: string | null
}

export function statementPdfAddressOf(params: { get(name: string): string | null } | null): StatementPdfAddress {
  const refs: StatementRef[] = []
  for (const entry of (params?.get('for') ?? '').split(',')) {
    const [partyId, companyId, currency] = entry.split(':')
    if (partyId && companyId && UUID.test(partyId) && UUID.test(companyId) && !refs.some((ref) => ref.partyId === partyId && ref.companyId === companyId && ref.currency === (currency || null)))
      refs.push({
        partyId,
        companyId,
        currency: currency && CURRENCY.test(currency) ? currency : null,
      })
    if (refs.length === MAX_PRINTED_STATEMENTS) break
  }
  const day = (name: string) => {
    const value = params?.get(name) ?? null
    return value && DAY.test(value) ? value : null
  }
  return { refs, from: day('from'), to: day('to') }
}

// ---- the tiles ---------------------------------------------------------------------------------------------------------

export const TILE_IDS = ['OPEN', 'OVERDUE', 'D1_30', 'D31_60', 'D61_90', 'OVER_90'] as const
export type TileId = (typeof TILE_IDS)[number]

/** What a tile filters the table by: Open shows every customer who owes (no filter), the others the API's bucket. */
export const tileFilter = (tile: TileId): AgeingFilter | null => (tile === 'OPEN' ? null : tile)

/** The tile's amount (null without the price grain or before the read). */
export function tileAmount(tile: AgeingTile | null, id: TileId): number | null {
  if (!tile) return null
  if (id === 'OPEN') return tile.open ?? null
  if (id === 'OVERDUE') return tile.overdue ?? null
  return tile.buckets?.[id] ?? null
}

// ---- a customer's ageing -----------------------------------------------------------------------------------------------

export interface AgeSegment {
  readonly bucket: AgeingBucket
  readonly amount: number
  /** Its share of what the customer owes, in % (one decimal); the segments add up to 100 (the last one takes the rest). */
  readonly pct: number
}

/** A customer's balance split by age, as the bar draws it (design "buckets (BarList)"): only the buckets with money. */
export function ageSegments(buckets: Readonly<Record<AgeingBucket, number>> | undefined): AgeSegment[] {
  if (!buckets) return []
  const total = AGEING_BUCKETS.reduce((sum, bucket) => sum + Math.max(0, buckets[bucket] ?? 0), 0)
  if (total <= 0) return []
  const present = AGEING_BUCKETS.filter((bucket) => (buckets[bucket] ?? 0) > 0)
  let used = 0
  return present.map((bucket, index) => {
    const amount = buckets[bucket]
    const pct = index === present.length - 1 ? Math.round((100 - used) * 10) / 10 : Math.round((amount / total) * 1000) / 10
    used += pct
    return { bucket, amount, pct }
  })
}

/** The tone of an age: not due neutral, 1–30 warning, older danger. */
export const bucketTone = (bucket: AgeingBucket): 'neutral' | 'warning' | 'danger' => (bucket === 'NOT_DUE' ? 'neutral' : bucket === 'D1_30' ? 'warning' : 'danger')

/** "45 days late" / "due" / "not due yet" — the oldest due date in words. */
export function latePhrase(daysLate: number | null, oldestDueDate: string | null): Phrase {
  if (oldestDueDate === null) return { key: 'row.noDue' }
  if (daysLate === null || daysLate <= 0) return { key: 'row.notLate' }
  return { key: 'row.daysLate', params: { count: daysLate } }
}

// ---- reminders ----------------------------------------------------------------------------------------------------------

/** A reminder may be ticked for "Approve and send n" only while the reader may approve it (else the reason, in words). */
export function reminderSelectable(reminder: Pick<Reminder, 'actions' | 'status'>, can: Pick<ReceivablesCan, 'approve'>): Phrase | null {
  if (!can.approve)
    return {
      key: 'held.approve',
      params: { permission: 'receivables.reminders.approve' },
    }
  if (reminder.status !== 'PREPARED') return { key: 'held.notPrepared' }
  return reminder.actions.approve ? null : { key: 'held.notPrepared' }
}

/** The bulk button: "Approve and send n" while the company's reminders are switched on; "Approve n" (they wait) while off. */
export const bulkApprovePhrase = (count: number, switchedOn: boolean): Phrase => ({
  key: switchedOn ? 'bulk.approveSend' : 'bulk.approve',
  params: { count },
})

/** A CALL is approved and sent with what was said; an e-mail or a letter with its text. */
export const needsCallNote = (reminder: Pick<Reminder, 'action'>, sending: boolean): boolean => reminder.action === 'CALL' && sending

/** The level in words: the ladder step's offset ("before due", "7 days late"), else the level number. */
export function stepPhrase(reminder: Pick<Reminder, 'step' | 'level'>): Phrase {
  if (!reminder.step) return { key: 'level.number', params: { level: reminder.level } }
  const days = reminder.step.offsetDays
  if (days < 0) return { key: 'level.beforeDue', params: { count: -days } }
  if (days === 0) return { key: 'level.onDue' }
  return { key: 'level.late', params: { count: days } }
}

/** The reminder refusal an API error carries (`reminder/<CODE>`, `…/<CODE>` in a bulk), or null. */
export function refusalOf(error: unknown): ReminderRefusal | null {
  if (!isApiError(error)) return null
  for (const issue of error.issues) {
    const code = issuePath(issue).split('/').at(-1) ?? ''
    if ((REMINDER_REFUSALS as readonly string[]).includes(code)) return code as ReminderRefusal
  }
  return null
}

/** A bulk approval's refusals (`body/items/<i>/<CODE>`; `…/version`: changed since read): which row, which code. */
export function bulkRefusalsOf(error: unknown): { index: number; code: ReminderRefusal | 'version' }[] {
  if (!isApiError(error)) return []
  const out: { index: number; code: ReminderRefusal | 'version' }[] = []
  for (const issue of error.issues) {
    const match = /^body\/items\/(\d+)\/([A-Za-z_]+)$/.exec(issuePath(issue))
    if (!match) continue
    const code = match[2]!
    if (code === 'version' || (REMINDER_REFUSALS as readonly string[]).includes(code))
      out.push({
        index: Number(match[1]),
        code: code as ReminderRefusal | 'version',
      })
  }
  return out
}

/** The API's error in this page's words (a refusal by its code; else the kind). */
export function readProblem(error: unknown): string {
  const refusal = refusalOf(error)
  if (refusal) return `refusal.${refusal}`
  if (!isApiError(error)) return 'problem.internal'
  // The statement's PDF (printed or e-mailed) is on the company's letterhead: its legal data must be complete (c.c. art. 2250).
  if (error.issues.some((issue) => issuePath(issue).startsWith('company/'))) return 'problem.companyLegal'
  if (error.kind === 'conflict') return 'problem.conflict'
  if (['signed_out', 'forbidden', 'not_found', 'unavailable', 'rate_limited', 'invalid'].includes(error.kind)) return `problem.${error.kind}`
  return 'problem.internal'
}

/** A live event that may change what customers owe or the reminders. */
export const liveTouches = (change: { type: string }): boolean =>
  change.type.startsWith('payment_reminder.') ||
  change.type === 'receivables_settings.changed' ||
  change.type === 'customer_statement.sent' ||
  change.type.startsWith('payment.') ||
  change.type === 'invoice.issued' ||
  change.type.startsWith('refund.')

// ---- CSV ------------------------------------------------------------------------------------------------------------------

export interface CsvWords {
  readonly header: (column: string) => string
}

const plainMinor = (value: number | null | undefined, locale: Locale): string => (value === null || value === undefined ? '' : (value / 100).toFixed(2).replace('.', locale === 'it' ? ',' : '.'))

/** The customers of a view as CSV: amounts only for a person with the price grain (never more than the screen shows). */
export function ageingCsv(rows: readonly AgeingRow[], can: Pick<ReceivablesCan, 'price'>, words: CsvWords, locale: Locale): string {
  const separator = locale === 'it' ? ';' : ','
  const cell = (value: string | number | null | undefined): string => {
    const text = value === null || value === undefined ? '' : String(value)
    return new RegExp(`["\\n${separator}]`).test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const columns = [
    'customerCode',
    'customer',
    'company',
    'currency',
    ...(can.price ? ['open', 'overdue', ...AGEING_BUCKETS] : []),
    'invoices',
    'oldestDueDate',
    'daysLate',
    'lastPaymentOn',
    'remindersSent',
  ]
  const lines = [columns.map((column) => cell(words.header(column))).join(separator)]
  for (const row of rows) {
    lines.push(
      [
        row.customer.code,
        row.customer.name,
        row.company.code,
        row.currency,
        ...(can.price ? [plainMinor(row.open, locale), plainMinor(row.overdue, locale), ...AGEING_BUCKETS.map((bucket) => plainMinor(row.buckets?.[bucket], locale))] : []),
        row.invoices,
        row.oldestDueDate ?? '',
        row.daysLate ?? '',
        row.lastPaymentOn ?? '',
        row.remindersSent,
      ]
        .map(cell)
        .join(separator),
    )
  }
  return `${lines.join('\n')}\n`
}

export { moneyText }
