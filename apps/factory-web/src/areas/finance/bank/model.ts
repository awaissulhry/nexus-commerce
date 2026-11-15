import { isApiError, issuePath } from '../../../lib/api/errors'
import { IMPORT_REFUSALS, LINE_VIEWS, STATEMENT_REFUSALS, WRITE_OFF_REFUSALS, type BankFormat, type BankLine, type BankMatch, type FiguresEntries, type ImportPlan, type LineCounts, type LineView, type MatchConfidence, type StatementColumn } from './api'
import type { FiguresAnswer } from '@nexus/factory-domain/receivables-figures/contracts'

/**
 * Finance › Bank (B-W2b-406; design finance.bank, SCR-152) — the pure rules of the page: who may do what, the page's
 * address (the tiles are saved filters), what holds an action and why, the import's steps, the customer's figures as typed,
 * the API's refusals in this page's words (never the API's English), the CSV of the lines in view.
 */

export const BANK_NAMESPACE = 'finance-bank'
export const BANK_NAMESPACES = [BANK_NAMESPACE, 'finance', 'lists'] as const

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

/** A message key of this page's catalogue with its values. */
export interface Phrase {
  readonly key: string
  readonly params?: Record<string, string | number>
}

// ---- who may do what -------------------------------------------------------------------------------------------------------------

export interface BankCan {
  readonly view: boolean
  readonly import: boolean
  readonly upload: boolean
  readonly match: boolean
  readonly record: boolean
  readonly void: boolean
  readonly writeOff: boolean
  readonly price: boolean
  readonly payments: boolean
  readonly parties: boolean
  readonly receivables: boolean
  readonly figures: boolean
  readonly filesRead: boolean
}

export function bankCanOf(permissions: readonly string[]): BankCan {
  const held = new Set(permissions)
  return {
    view: held.has('payments.bank.view'),
    import: held.has('payments.bank.import'),
    upload: held.has('files.upload'),
    match: held.has('payments.bank.match'),
    record: held.has('payments.record'),
    void: held.has('payments.void'),
    writeOff: held.has('payments.writeOff'),
    price: held.has('money.price'),
    payments: held.has('payments.view'),
    parties: held.has('parties.view'),
    receivables: held.has('receivables.view'),
    figures: held.has('receivables.theirFigures.manage'),
    filesRead: held.has('files.read'),
  }
}

// ---- the page's address ----------------------------------------------------------------------------------------------------------

export interface BankAddress {
  /** The lines shown (a tile or Lines ▾); TO_MATCH by default. */
  readonly view: LineView
  /** One statement's lines in place of a view (from a payment's Bank line card: "Open the statement"). */
  readonly statement: string | null
  /** The line open in the match panel. */
  readonly line: string | null
  /** Import a bank statement (the band's primary). */
  readonly importing: boolean
  /** Their figures vs ours: `new` (record), or the figures open (their comparison). */
  readonly figures: string | null
  /** The open figures' correction. */
  readonly correct: boolean
}

export const EMPTY_ADDRESS: BankAddress = { view: 'TO_MATCH', statement: null, line: null, importing: false, figures: null, correct: false }

export function addressOf(params: { get(name: string): string | null } | null): BankAddress {
  if (!params) return EMPTY_ADDRESS
  const view = params.get('view')
  const id = (name: string) => {
    const value = params.get(name)
    return value && /^[0-9a-f-]{36}$/i.test(value) ? value : null
  }
  const figures = params.get('figures')
  return {
    view: (LINE_VIEWS as readonly string[]).includes(view ?? '') ? (view as LineView) : 'TO_MATCH',
    statement: id('statement'),
    line: id('line'),
    importing: params.get('import') === '1',
    figures: figures === 'new' ? 'new' : id('figures'),
    correct: params.get('correct') === '1' && id('figures') !== null,
  }
}

export function bankHref(prefix: string, address: BankAddress): string {
  const query = new URLSearchParams()
  if (address.statement) query.set('statement', address.statement)
  else if (address.view !== 'TO_MATCH') query.set('view', address.view)
  if (address.line) query.set('line', address.line)
  if (address.importing) query.set('import', '1')
  if (address.figures) query.set('figures', address.figures)
  if (address.correct && address.figures && address.figures !== 'new') query.set('correct', '1')
  const text = query.toString()
  return `${prefix}/finance/bank${text ? `?${text}` : ''}`
}

/** A payment's record (the design's new tab "Payment record": ⌘-click on a matched line). */
export const paymentHref = (prefix: string, paymentId: string): string => `${prefix}/finance/payments/${encodeURIComponent(paymentId)}`
export const invoiceHref = (prefix: string, invoiceId: string): string => `${prefix}/finance/invoices/${encodeURIComponent(invoiceId)}`
export const supplierInvoiceHref = (prefix: string, invoiceId: string): string => `${prefix}/finance/payables/${encodeURIComponent(invoiceId)}`
export const orderHref = (prefix: string, orderId: string): string => `${prefix}/sales/orders/${encodeURIComponent(orderId)}`

// ---- the tiles (saved filters) ---------------------------------------------------------------------------------------------------

export const TILE_VIEWS = ['TO_MATCH', 'SURE', 'OLD'] as const satisfies readonly LineView[]
export type TileView = (typeof TILE_VIEWS)[number]

export function tilesOf(counts: LineCounts | null): Array<{ id: TileView; count: number | null }> {
  return [
    { id: 'TO_MATCH', count: counts?.toMatch ?? null },
    { id: 'SURE', count: counts?.sureMatches ?? null },
    { id: 'OLD', count: counts?.unmatchedOverDays ?? null },
  ]
}

// ---- lines, suggestions and what holds an action ---------------------------------------------------------------------------------

export const CONFIDENCE_TONE: Record<MatchConfidence, Tone> = { HIGH: 'success', MEDIUM: 'warning', LOW: 'neutral' }

/** The suggestion a line offers first: the surest that can still be accepted (the API sends them surest first). */
export const bestOf = (line: Pick<BankLine, 'suggestions'>): BankMatch | null => line.suggestions.find((match) => !match.stale) ?? null

/** Whether accepting this suggestion records a payment (money in placed on invoices or deposit requests). */
export const recordsPayment = (line: Pick<BankLine, 'direction'>, match: Pick<BankMatch, 'items'>): boolean => line.direction === 'IN' && match.items.length > 0

/** Why a suggestion may not be accepted now (null: it may). */
export function acceptHeld(line: Pick<BankLine, 'direction' | 'state' | 'currency'>, match: Pick<BankMatch, 'items' | 'stale'>, can: BankCan): Phrase | null {
  if (!can.match) return { key: 'held.match' }
  if (line.state === 'MATCHED') return { key: 'held.matched' }
  if (match.stale) return { key: 'held.stale' }
  if (recordsPayment(line, match) && !can.record) return { key: 'held.record' }
  if (recordsPayment(line, match) && line.currency !== 'EUR') return { key: 'held.currency', params: { currency: line.currency } }
  return null
}

/** Why a person may not choose the items (or split the line) themselves (null: they may). */
export function chooseHeld(line: Pick<BankLine, 'direction' | 'state' | 'currency'>, can: BankCan): Phrase | null {
  if (!can.match) return { key: 'held.match' }
  if (line.state === 'MATCHED') return { key: 'held.matched' }
  if (line.direction === 'OUT') return { key: 'held.chooseOut' }
  if (!can.record) return { key: 'held.record' }
  if (!can.parties) return { key: 'held.parties' }
  if (!can.price) return { key: 'held.price' }
  if (line.currency !== 'EUR') return { key: 'held.currency', params: { currency: line.currency } }
  return null
}

/** "Leave unmatched" (design): a line cannot be set aside yet — no column says so (B-W2b-393's schema need). */
export const LEAVE_HELD: Phrase = { key: 'held.leave' }

/** Why an acceptance may not be taken back (null: it may). */
export function reverseHeld(line: Pick<BankLine, 'accepted'>, can: BankCan): Phrase | null {
  if (!line.accepted) return { key: 'held.notMatched' }
  if (!can.match) return { key: 'held.match' }
  if (line.accepted.paymentId && line.accepted.items.length > 0 && !can.void) return { key: 'held.void' }
  return null
}

/** The sure matches that may be accepted together (one per line; at most 50 a time: the API's limit). */
export const MAX_ACCEPT_TOGETHER = 50
export function sureOf(lines: readonly BankLine[], can: BankCan): Array<{ line: BankLine; match: BankMatch }> {
  const sure: Array<{ line: BankLine; match: BankMatch }> = []
  for (const line of lines) {
    const match = bestOf(line)
    if (match && match.confidence === 'HIGH' && acceptHeld(line, match, can) === null) sure.push({ line, match })
  }
  return sure.slice(0, MAX_ACCEPT_TOGETHER)
}

/** The next line in the list after (or before) the one open, for J / K; null at an end. */
export function stepLine(lines: readonly Pick<BankLine, 'id'>[], current: string | null, by: 1 | -1): string | null {
  if (lines.length === 0) return null
  const at = current ? lines.findIndex((line) => line.id === current) : -1
  if (at < 0) return lines[by === 1 ? 0 : lines.length - 1]!.id
  const next = at + by
  return next >= 0 && next < lines.length ? lines[next]!.id : null
}

/** An IBAN with all but its country and last four characters hidden (`IT** **** **** 7002`); never drawn whole. */
export function maskIban(iban: string | null | undefined): string {
  const text = (iban ?? '').replace(/\s/g, '').toUpperCase()
  if (text.length < 8) return text === '' ? '' : '****'
  return `${text.slice(0, 2)}** **** **** ${text.slice(-4)}`
}

// ---- the API's refusals in this page's words -------------------------------------------------------------------------------------

export function readProblem(error: unknown): string {
  if (!isApiError(error)) return 'problem.read.internal'
  if (['signed_out', 'forbidden', 'not_found', 'unavailable', 'rate_limited'].includes(error.kind)) return `problem.read.${error.kind}`
  return 'problem.read.internal'
}

const has = (list: readonly string[], code: string) => list.includes(code)

/** A month the write falls in is soft-locked: send it again with a reason (accounting's override). */
export const softLocked = (error: unknown): boolean => isApiError(error) && error.issues.some((issue) => issuePath(issue) === 'period/SOFT_LOCKED')

/** A refused write in this page's words: each refusal it names (in order, once), else the kind of failure. */
export function writeProblem(error: unknown): Phrase[] {
  if (!isApiError(error)) return [{ key: 'problem.write.internal' }]
  const phrases: Phrase[] = []
  const add = (phrase: Phrase) => {
    if (!phrases.some((known) => known.key === phrase.key)) phrases.push(phrase)
  }
  for (const issue of error.issues) {
    const path = issuePath(issue)
    const [head, code] = path.split('/')
    if (head === 'import' && code) add(has(IMPORT_REFUSALS, code) ? { key: `import.refusal.${code}` } : { key: 'import.refusal.other' })
    else if (head === 'file' && code) add(has(STATEMENT_REFUSALS, code) ? { key: `import.file.${code}` } : { key: 'import.file.sheet' })
    else if (head === 'writeOff' && code) add(has(WRITE_OFF_REFUSALS, code) ? { key: `writeOff.refusal.${code}` } : { key: 'writeOff.refusal.other' })
    else if (path === 'line/RECORDED_ALREADY') add({ key: 'match.refusal.recorded' })
    else if (path === 'period/SOFT_LOCKED') add({ key: 'period.soft' })
    else if (path === 'period/HARD_LOCKED') add({ key: 'period.hard' })
    else if (head === 'figures' && code) add({ key: `figures.refusal.${code}` })
    else if (path.endsWith('/version') || path === 'version' || path === 'matchId') add({ key: 'problem.write.moved' })
    else if (/^(body\/)?items\/\d+/.test(path)) add({ key: 'match.refusal.items' })
    else if (/^body\/matches\/\d+/.test(path)) add({ key: 'match.refusal.together' })
    else if (path.startsWith('body/figures') || path === 'body/asOf' || path === 'body/note') add({ key: figuresFieldKey(path) })
  }
  if (phrases.length > 0) return phrases
  if (error.kind === 'conflict') return [{ key: 'problem.write.state' }]
  if (error.kind === 'invalid') return [{ key: 'problem.write.invalid' }]
  if (['signed_out', 'forbidden', 'not_found', 'rate_limited', 'unavailable', 'step_up'].includes(error.kind)) return [{ key: `problem.write.${error.kind}` }]
  return [{ key: 'problem.write.internal' }]
}

/** A field of the figures the API refused, by its path: the message key that says what is wrong. */
export function figuresFieldKey(path: string): string {
  if (path === 'body/asOf') return 'figures.problem.asOf'
  if (path === 'body/note') return 'figures.problem.note'
  if (path.endsWith('/reference')) return 'figures.problem.reference'
  if (path.endsWith('/date')) return 'figures.problem.date'
  if (path.endsWith('/amount') || path.endsWith('/balance')) return 'figures.problem.amount'
  return 'figures.problem.other'
}

// ---- importing a statement -------------------------------------------------------------------------------------------------------

export type ImportStep = 'file' | 'reading' | 'mapping' | 'review' | 'importing' | 'done'

/** The format a file's name says (factory-domain payments/bank/import formatOfName), or null. */
export function formatOfName(name: string, extensions: Readonly<Record<BankFormat, readonly string[]>>): BankFormat | null {
  const lower = name.trim().toLowerCase()
  for (const [format, endings] of Object.entries(extensions) as [BankFormat, readonly string[]][]) if (endings.some((ending) => lower.endsWith(ending))) return format
  return null
}

export const isSheet = (format: BankFormat | null): boolean => format === 'CSV' || format === 'XLSX'

/** The column each header is mapped to now (the dry run's answer), for the mapping step. */
export function mappingOf(plan: Pick<ImportPlan, 'mapping'>): Record<string, StatementColumn | null> {
  const mapping: Record<string, StatementColumn | null> = {}
  for (const header of plan.mapping?.headers ?? []) mapping[header] = null
  for (const column of plan.mapping?.columns ?? []) mapping[column.header] = column.column as StatementColumn
  return mapping
}

/** What a sheet's mapping still lacks: the booking day, and the amount (or money in and money out). */
export function mappingMissing(mapping: Readonly<Record<string, StatementColumn | null>>): Phrase[] {
  const columns = new Set(Object.values(mapping).filter((value): value is StatementColumn => value !== null))
  const missing: Phrase[] = []
  if (!columns.has('bookedOn')) missing.push({ key: 'import.mapping.needDay' })
  if (!columns.has('amount') && !(columns.has('moneyIn') && columns.has('moneyOut'))) missing.push({ key: 'import.mapping.needAmount' })
  const used = Object.values(mapping).filter((value): value is StatementColumn => value !== null)
  if (new Set(used).size !== used.length) missing.push({ key: 'import.mapping.twice' })
  return missing
}

/** Why "Import n lines" waits (null: it may run). */
export function importHeld(plan: ImportPlan | null, skipErrors: boolean, can: BankCan, busy: boolean): Phrase | null {
  if (!can.import) return { key: 'held.import' }
  if (!can.upload) return { key: 'held.upload' }
  if (!plan) return { key: 'held.dryRunFirst' }
  if (busy) return { key: 'held.busy' }
  if (!plan.ready) return { key: 'import.mapping.incomplete' }
  if (plan.counts.new === 0) return { key: 'import.refusal.NOTHING_NEW' }
  if (plan.counts.error > 0 && !skipErrors) return { key: 'held.skipErrors', params: { count: plan.counts.error } }
  return null
}

// ---- their figures as typed ------------------------------------------------------------------------------------------------------

export interface OrderDraft {
  reference: string
  amount: string
}
export interface PaymentDraft {
  reference: string
  date: string
  amount: string
}
export interface FiguresDraft {
  partyId: string | null
  partyLabel: string
  asOf: string
  balance: string
  orders: OrderDraft[]
  payments: PaymentDraft[]
  note: string
  /** The statement's file chosen (its name; the file itself is the container's). */
  fileName: string | null
}

export const emptyFigures = (today: string): FiguresDraft => ({ partyId: null, partyLabel: '', asOf: today, balance: '', orders: [{ reference: '', amount: '' }], payments: [], note: '', fileName: null })

/** A typed amount in either language's way, signed ("-1.250,50", "1250.50", "0"): minor units, or null when it is not one. */
export function parseSignedAmount(text: string): number | null {
  const trimmed = text.trim().replace(/\s/g, '').replace(/€/g, '').replace(/^−/, '-')
  if (trimmed === '') return null
  const negative = trimmed.startsWith('-') || (trimmed.startsWith('(') && trimmed.endsWith(')'))
  const digits = trimmed.replace(/^[-(]/, '').replace(/\)$/, '')
  const normalised = /,\d{1,2}$/.test(digits) ? digits.replace(/\./g, '').replace(',', '.') : digits.replace(/,/g, '')
  if (!/^\d{1,13}(\.\d{1,2})?$/.test(normalised)) return null
  const minor = Math.round(Number(normalised) * 100)
  return negative ? -minor : minor
}

/** Minor units as a person types them back (`1250,50` in Italian). */
export const amountText = (minor: number, locale: string): string => (minor / 100).toFixed(2).replace('.', locale === 'it' ? ',' : '.')

/** The typed figures' problems, by field (`orders.0.amount`), as message keys; empty when they may be sent. */
export function figuresDraftProblems(draft: FiguresDraft, today: string, isNew: boolean): Record<string, string> {
  const problems: Record<string, string> = {}
  if (isNew && !draft.partyId) problems.party = 'figures.problem.party'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.asOf)) problems.asOf = 'figures.problem.asOfMissing'
  else if (draft.asOf > today) problems.asOf = 'figures.problem.asOf'
  if (parseSignedAmount(draft.balance) === null) problems.balance = 'figures.problem.amount'
  const reference = (value: string) => value.trim() !== '' && value.trim().length <= 100
  draft.orders.forEach((entry, index) => {
    if (entry.reference.trim() === '' && entry.amount.trim() === '') return
    if (!reference(entry.reference)) problems[`orders.${index}.reference`] = 'figures.problem.reference'
    if (parseSignedAmount(entry.amount) === null) problems[`orders.${index}.amount`] = 'figures.problem.amount'
  })
  draft.payments.forEach((entry, index) => {
    if (entry.reference.trim() === '' && entry.amount.trim() === '' && entry.date === '') return
    if (!reference(entry.reference)) problems[`payments.${index}.reference`] = 'figures.problem.reference'
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) problems[`payments.${index}.date`] = 'figures.problem.dateMissing'
    else if (/^\d{4}-\d{2}-\d{2}$/.test(draft.asOf) && entry.date > draft.asOf) problems[`payments.${index}.date`] = 'figures.problem.date'
    if (parseSignedAmount(entry.amount) === null) problems[`payments.${index}.amount`] = 'figures.problem.amount'
  })
  if (draft.note.length > 2000) problems.note = 'figures.problem.note'
  return problems
}

/** The typed figures as the API takes them (blank rows left out); null while a problem stands. */
export function entriesOf(draft: FiguresDraft, today: string, isNew: boolean): FiguresEntries | null {
  if (Object.keys(figuresDraftProblems(draft, today, isNew)).length > 0) return null
  return {
    orders: draft.orders.filter((entry) => entry.reference.trim() !== '' || entry.amount.trim() !== '').map((entry) => ({ reference: entry.reference.trim().replace(/\s+/g, ' '), amount: parseSignedAmount(entry.amount)! })),
    payments: draft.payments.filter((entry) => entry.reference.trim() !== '' || entry.amount.trim() !== '' || entry.date !== '').map((entry) => ({ reference: entry.reference.trim().replace(/\s+/g, ' '), date: entry.date, amount: parseSignedAmount(entry.amount)! })),
    balance: parseSignedAmount(draft.balance)!,
  }
}

/** The figures read back as a draft (to correct a typing mistake): their entries in the order they were typed. */
export function draftOf(answer: FiguresAnswer, locale: string): FiguresDraft {
  const theirs = <T extends { index: number | null }>(lines: readonly T[]) => lines.filter((line) => line.index !== null).sort((a, b) => a.index! - b.index!)
  return {
    partyId: answer.figures.customer.id,
    partyLabel: `${answer.figures.customer.name} (${answer.figures.customer.code})`,
    asOf: answer.figures.asOf,
    balance: answer.comparison.balance.theirs === undefined ? '' : amountText(answer.comparison.balance.theirs, locale),
    orders: theirs(answer.comparison.orders).map((line) => ({ reference: line.reference ?? '', amount: line.theirs === undefined ? '' : amountText(line.theirs, locale) })),
    payments: theirs(answer.comparison.payments).map((line) => ({ reference: line.reference ?? '', date: line.date ?? '', amount: line.theirs === undefined ? '' : amountText(line.theirs, locale) })),
    note: answer.figures.note ?? '',
    fileName: answer.figures.file?.name ?? null,
  }
}

/** Day in either way a statement prints it (`10/11/2026`, `2026-11-10`): YYYY-MM-DD, or '' when it is not one. */
export function pastedDay(text: string): string {
  const value = text.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  const match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(value)
  return match ? `${match[3]}-${match[2]!.padStart(2, '0')}-${match[1]!.padStart(2, '0')}` : ''
}

/**
 * Rows pasted from the customer's spreadsheet (one per line; tab or semicolon between cells): orders are "reference ·
 * amount", payments "reference · day · amount" (the day may come first). A header row whose amount is not a number is left
 * out. Each row keeps the amount as it was written (checked like a typed one).
 */
export function pastedRows(text: string, kind: 'orders' | 'payments'): Array<OrderDraft | PaymentDraft> {
  const rows: Array<OrderDraft | PaymentDraft> = []
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === '') continue
    const cells = raw.split(raw.includes('\t') ? '\t' : ';').map((cell) => cell.trim())
    const amount = cells[cells.length - 1] ?? ''
    if (parseSignedAmount(amount) === null) continue
    if (kind === 'orders') rows.push({ reference: cells.slice(0, -1).join(' ').trim(), amount })
    else {
      const dayAt = cells.findIndex((cell, index) => index < cells.length - 1 && pastedDay(cell) !== '')
      const date = dayAt >= 0 ? pastedDay(cells[dayAt]!) : ''
      rows.push({ reference: cells.filter((_, index) => index !== dayAt && index !== cells.length - 1).join(' ').trim(), date, amount })
    }
  }
  return rows
}

// ---- live and export -------------------------------------------------------------------------------------------------------------

/** A live event that changes the lines or their suggestions (design page.live: a payment placed drops paid items). */
export const linesTouched = (change: { type: string }): boolean =>
  change.type.startsWith('bank_') || change.type.startsWith('payment.') || change.type === 'invoice.issued' || change.type.startsWith('deposit_request.')

/** A live event that changes their figures vs ours (theirs recorded or corrected; our books moved). */
export const figuresTouched = (change: { type: string }): boolean => change.type === 'customer_figures.changed' || change.type.startsWith('payment.') || change.type === 'invoice.issued'

const cell = (value: string): string => (/[;"\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)

/** The lines chosen as CSV (`;`, the amount only with the price grain; the payer's IBAN masked). */
export function linesCsv(lines: readonly BankLine[], price: boolean, words: { header: (key: string) => string; state: (line: BankLine) => string; confidence: (line: BankLine) => string; amount: (minor: number) => string }): string {
  const headers = ['booked', 'value', ...(price ? ['amount'] : []), 'currency', 'reference', 'bankReference', 'payer', 'payerIban', 'state', 'confidence', 'party']
  const rows = lines.map((line) => {
    const match = line.accepted ?? bestOf(line)
    return [
      line.bookedOn,
      line.valueOn ?? '',
      ...(price ? [line.amount === undefined ? '' : words.amount(line.amount)] : []),
      line.currency,
      line.referenceText ?? '',
      line.bankReference ?? '',
      line.counterpartyName ?? '',
      maskIban(line.counterpartyIban),
      words.state(line),
      match ? words.confidence(line) : '',
      match ? `${match.party.legalName} (${match.party.code})` : '',
    ]
  })
  return `﻿${[headers.map((key) => words.header(key)), ...rows].map((row) => row.map(cell).join(';')).join('\r\n')}\r\n`
}
