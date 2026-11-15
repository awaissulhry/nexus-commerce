import type { Issue } from '../core/errors'
import type { MinorUnits } from '../core/money'
import type { BusinessDate } from '../core/time'

/**
 * A B2B customer's own figures against ours (B-W2b-406; FIN-135 "Reconcile with the customer's own figures"; design
 * finance.bank sec:customer-figures "Their figures vs ours: order, payment, balance; differences"; factory-db bank.prisma
 * CustomerStatementFigures), pure. A person types what the customer's statement says as of a day — what it owes per order,
 * the payments it says it made, its balance — and the comparison says, line by line, where our books agree and where they
 * do not:
 *
 *   orders     each of their references is looked for among our documents of that customer: an invoice number, our order
 *              number or their own order reference (letters and digits only, so "FT 2026/00001" is FT-2026-00001; a
 *              reference that holds one of ours as a run of at least 5 characters with a digit counts too). Ours = what is
 *              still open as of the day (an invoice: its open amount; an order: its open invoices together). SAME, DIFFERS,
 *              NOT_FOUND (no document of ours), NOTHING_OPEN (ours, but nothing is open with us), TWICE (the same document
 *              listed again); then what is open with us that they did not list: ONLY_OURS, per order (or per invoice
 *              without one).
 *   payments   each of theirs is looked for among our payments received from that customer up to the day: by the bank
 *              reference (letters and digits), else by the same amount within 5 days. SAME, DIFFERS (the reference found
 *              with another amount), NOT_FOUND; then our payments from the first day they list that they did not: ONLY_OURS.
 *              With no payment of theirs, ours are not listed (the balance still says the whole difference).
 *   balance    theirs − ours (ours = the customer's ledger as of the day: invoices − credit notes − payments + refunds).
 *
 * Every amount is minor units of the figures' currency, a price (the money.price grain). A difference is theirs − ours.
 */

export const MAX_FIGURE_ENTRIES = 500
export const MAX_FIGURE_REFERENCE = 100
export const MAX_FIGURES_NOTE = 2000
/** The database keeps whole amounts of at most 15 digits. */
export const MAX_FIGURE_AMOUNT = 999_999_999_999_999
/** Their payment and ours of the same amount count as one when booked at most this many days apart. */
export const PAYMENT_DAYS_APART = 5
/** A reference of ours found inside theirs counts only from this length (and with a digit). */
export const MIN_REFERENCE_RUN = 5

export interface TheirOrder {
  readonly reference: string
  readonly amount: MinorUnits
}
export interface TheirPayment {
  readonly reference: string
  readonly date: BusinessDate
  readonly amount: MinorUnits
}
/** What the customer's statement says (the database's `figures`). */
export interface TheirFigures {
  readonly orders: readonly TheirOrder[]
  readonly payments: readonly TheirPayment[]
  readonly balance: MinorUnits
}

/** One of our documents the references are looked for in. */
export interface OurInvoice {
  readonly id: string
  readonly number: string
  readonly orderId: string | null
  /** What is open on it as of the day (0 when settled). */
  readonly open: MinorUnits
}
export interface OurOrder {
  readonly id: string
  readonly number: string
  /** The customer's own order reference (its PO number), when it gave one. */
  readonly customerRef: string | null
}
export interface OurPayment {
  readonly id: string
  readonly reference: string
  readonly receivedOn: BusinessDate
  readonly amount: MinorUnits
}
export interface OurBooks {
  /** Every issued invoice of the customer up to the day (TD01, TD24), open or not. */
  readonly invoices: readonly OurInvoice[]
  /** The orders those invoices are of, and every order of the customer its references may name. */
  readonly orders: readonly OurOrder[]
  /** The payments received from the customer up to the day (not voided). */
  readonly payments: readonly OurPayment[]
  /** The customer's balance in our ledger as of the day (what it owes us; below 0 when we owe it). */
  readonly balance: MinorUnits
}

export const LINE_STATES = ['SAME', 'DIFFERS', 'NOT_FOUND', 'NOTHING_OPEN', 'TWICE', 'ONLY_OURS'] as const
export type LineState = (typeof LINE_STATES)[number]

/** How their payment was found among ours. */
export const PAYMENT_FOUND_BY = ['REFERENCE', 'AMOUNT_AND_DAY'] as const
export type PaymentFoundBy = (typeof PAYMENT_FOUND_BY)[number]

export interface OurDocument {
  readonly kind: 'INVOICE' | 'ORDER'
  readonly id: string
  readonly number: string
  /** The open invoices it stands for (an invoice: itself), each with what is open. */
  readonly invoices: readonly { readonly id: string; readonly number: string; readonly open: MinorUnits }[]
  readonly open: MinorUnits
}

export interface OrderLine {
  readonly theirs: TheirOrder | null
  /** Their entry's place in their list (null for a line only we have). */
  readonly index: number | null
  readonly ours: OurDocument | null
  readonly state: LineState
  /** Theirs − ours. */
  readonly difference: MinorUnits
}

export interface PaymentLine {
  readonly theirs: TheirPayment | null
  readonly index: number | null
  readonly ours: OurPayment | null
  readonly foundBy: PaymentFoundBy | null
  readonly state: LineState
  readonly difference: MinorUnits
}

export interface Comparison {
  readonly balance: { readonly theirs: MinorUnits; readonly ours: MinorUnits; readonly difference: MinorUnits; readonly state: 'SAME' | 'DIFFERS' }
  readonly orders: readonly OrderLine[]
  readonly payments: readonly PaymentLine[]
  /** From which day our payments are compared (their first payment's day); null when they list none. */
  readonly paymentsFrom: BusinessDate | null
  /** Lines (and the balance) that do not agree. */
  readonly differences: number
}

/** Letters and digits only, upper case: how references are compared. */
export const foldReference = (value: string): string =>
  value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')

const runnable = (key: string): boolean => key.length >= MIN_REFERENCE_RUN && /[0-9]/.test(key)

/** The key of ours a reference names: equal first, else the longest key of ours it holds as a run. */
function keyOf(reference: string, keys: ReadonlyMap<string, unknown>): string | null {
  const folded = foldReference(reference)
  if (folded === '') return null
  if (keys.has(folded)) return folded
  let best: string | null = null
  for (const key of keys.keys()) {
    if (runnable(key) && folded.includes(key) && (best === null || key.length > best.length)) best = key
  }
  return best
}

const daysApart = (a: BusinessDate, b: BusinessDate): number => Math.abs(Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000))

/** The comparison of their figures with our books (both as of the same day, in the same currency). */
export function compareFigures(theirs: TheirFigures, ours: OurBooks): Comparison {
  // ---- orders: our documents by their keys ----------------------------------------------------------------------------
  const invoicesByOrder = new Map<string, OurInvoice[]>()
  for (const invoice of ours.invoices) if (invoice.orderId) invoicesByOrder.set(invoice.orderId, [...(invoicesByOrder.get(invoice.orderId) ?? []), invoice])
  const orderDocument = (order: OurOrder): OurDocument => {
    const open = (invoicesByOrder.get(order.id) ?? []).filter((invoice) => invoice.open > 0)
    return { kind: 'ORDER', id: order.id, number: order.number, invoices: open.map((invoice) => ({ id: invoice.id, number: invoice.number, open: invoice.open })), open: open.reduce((sum, invoice) => sum + invoice.open, 0) }
  }
  const invoiceDocument = (invoice: OurInvoice): OurDocument => ({ kind: 'INVOICE', id: invoice.id, number: invoice.number, invoices: invoice.open > 0 ? [{ id: invoice.id, number: invoice.number, open: invoice.open }] : [], open: Math.max(0, invoice.open) })
  const keys = new Map<string, () => OurDocument>()
  // Invoice numbers win over order references that fold the same.
  for (const order of ours.orders) {
    const make = () => orderDocument(order)
    for (const ref of [order.number, order.customerRef]) if (ref && foldReference(ref) !== '' && !keys.has(foldReference(ref))) keys.set(foldReference(ref), make)
  }
  for (const invoice of ours.invoices) if (foldReference(invoice.number) !== '') keys.set(foldReference(invoice.number), () => invoiceDocument(invoice))

  const covered = new Set<string>()
  const named = new Set<string>()
  const orders: OrderLine[] = theirs.orders.map((entry, index) => {
    const key = keyOf(entry.reference, keys)
    if (key === null) return { theirs: entry, index, ours: null, state: entry.amount === 0 ? 'SAME' : 'NOT_FOUND', difference: entry.amount }
    const document = keys.get(key)!()
    const seen = `${document.kind}:${document.id}`
    // The same document again, or an invoice already counted under its order (or the other way round).
    if (named.has(seen) || document.invoices.some((invoice) => covered.has(invoice.id))) return { theirs: entry, index, ours: document, state: 'TWICE', difference: entry.amount }
    named.add(seen)
    for (const invoice of document.invoices) covered.add(invoice.id)
    const difference = entry.amount - document.open
    const state: LineState = difference === 0 ? 'SAME' : document.open === 0 ? 'NOTHING_OPEN' : 'DIFFERS'
    return { theirs: entry, index, ours: document, state, difference }
  })
  // What is open with us that they did not list: per order, or per invoice without one.
  const left = ours.invoices.filter((invoice) => invoice.open > 0 && !covered.has(invoice.id))
  const leftOrders = new Map<string, OurInvoice[]>()
  for (const invoice of left) {
    if (invoice.orderId && ours.orders.some((order) => order.id === invoice.orderId)) leftOrders.set(invoice.orderId, [...(leftOrders.get(invoice.orderId) ?? []), invoice])
    else orders.push({ theirs: null, index: null, ours: invoiceDocument(invoice), state: 'ONLY_OURS', difference: -invoice.open })
  }
  for (const [orderId, invoices] of leftOrders) {
    const order = ours.orders.find((entry) => entry.id === orderId)!
    const open = invoices.reduce((sum, invoice) => sum + invoice.open, 0)
    orders.push({ theirs: null, index: null, ours: { kind: 'ORDER', id: order.id, number: order.number, invoices: invoices.map((invoice) => ({ id: invoice.id, number: invoice.number, open: invoice.open })), open }, state: 'ONLY_OURS', difference: -open })
  }

  // ---- payments --------------------------------------------------------------------------------------------------------
  const used = new Set<string>()
  const byReference = new Map<string, OurPayment[]>()
  for (const payment of ours.payments) {
    const folded = foldReference(payment.reference)
    if (folded !== '') byReference.set(folded, [...(byReference.get(folded) ?? []), payment])
  }
  const payments: PaymentLine[] = theirs.payments.map((entry, index) => {
    const key = keyOf(entry.reference, byReference)
    const sameRef = key ? (byReference.get(key) ?? []).filter((payment) => !used.has(payment.id)) : []
    const found = sameRef.find((payment) => payment.amount === entry.amount) ?? sameRef[0] ?? null
    if (found) {
      used.add(found.id)
      const difference = entry.amount - found.amount
      return { theirs: entry, index, ours: found, foundBy: 'REFERENCE', state: difference === 0 ? 'SAME' : 'DIFFERS', difference }
    }
    const near = ours.payments
      .filter((payment) => !used.has(payment.id) && payment.amount === entry.amount && daysApart(payment.receivedOn, entry.date) <= PAYMENT_DAYS_APART)
      .sort((a, b) => daysApart(a.receivedOn, entry.date) - daysApart(b.receivedOn, entry.date))[0]
    if (near) {
      used.add(near.id)
      return { theirs: entry, index, ours: near, foundBy: 'AMOUNT_AND_DAY', state: 'SAME', difference: 0 }
    }
    return { theirs: entry, index, ours: null, foundBy: null, state: 'NOT_FOUND', difference: entry.amount }
  })
  const paymentsFrom = theirs.payments.length === 0 ? null : theirs.payments.map((entry) => entry.date).sort()[0]!
  if (paymentsFrom !== null) {
    for (const payment of [...ours.payments].sort((a, b) => a.receivedOn.localeCompare(b.receivedOn) || a.id.localeCompare(b.id))) {
      if (!used.has(payment.id) && payment.receivedOn >= paymentsFrom) payments.push({ theirs: null, index: null, ours: payment, foundBy: null, state: 'ONLY_OURS', difference: -payment.amount })
    }
  }

  const balanceDifference = theirs.balance - ours.balance
  const differences = [...orders, ...payments].filter((line) => line.state !== 'SAME').length + (balanceDifference === 0 ? 0 : 1)
  return {
    balance: { theirs: theirs.balance, ours: ours.balance, difference: balanceDifference, state: balanceDifference === 0 ? 'SAME' : 'DIFFERS' },
    orders,
    payments,
    paymentsFrom,
    differences,
  }
}

// ---- refusals --------------------------------------------------------------------------------------------------------------

/** Why figures are not kept (issue `figures/<CODE>`, 409), by code; the screens say them in their own words. */
export const FIGURES_REFUSALS = ['NOT_A_CUSTOMER', 'AMOUNT_NEEDED', 'FILE_NOT_READY', 'NOT_A_FIGURES_FILE', 'FILE_USED', 'REFUSED'] as const
export type FiguresRefusal = (typeof FIGURES_REFUSALS)[number]

export const FIGURES_REFUSAL_WORDS: Readonly<Record<FiguresRefusal, string>> = Object.freeze({
  NOT_A_CUSTOMER: 'This party is not a customer: only a customer’s figures are compared with ours.',
  AMOUNT_NEEDED: 'Every order, every payment and the balance need their amount.',
  FILE_NOT_READY: 'The statement’s file is not ready: finish the upload, or upload it again.',
  NOT_A_FIGURES_FILE: 'This file was not uploaded as a customer’s statement of this company.',
  FILE_USED: 'This file is kept with other figures already.',
  REFUSED: 'These figures cannot be kept as typed: check the day, the references and the amounts.',
})

// ---- what a person types --------------------------------------------------------------------------------------------------

/** Words of one line (control characters and runs of spaces folded), or null when nothing is left. */
export function referenceOf(value: string): string | null {
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return text === '' ? null : text
}

/** Why the figures may not be kept as typed (issue paths under `body/`), in English; the screens say them from the paths. */
export function figuresProblems(input: { readonly asOf: BusinessDate; readonly figures: TheirFigures; readonly note?: string | null }, today: BusinessDate): Issue[] {
  const issues: Issue[] = []
  if (input.asOf > today) issues.push({ path: 'body/asOf', message: 'Their figures are as of a day that has come (not after today).' })
  const amount = (value: number, path: string) => {
    if (!Number.isInteger(value) || Math.abs(value) > MAX_FIGURE_AMOUNT) issues.push({ path, message: 'A whole amount in minor units (at most 15 digits).' })
  }
  const reference = (value: string, path: string) => {
    const words = referenceOf(value)
    if (words === null || words !== value || words.length > MAX_FIGURE_REFERENCE) issues.push({ path, message: `A reference of 1 to ${MAX_FIGURE_REFERENCE} characters on one line.` })
  }
  if (input.figures.orders.length > MAX_FIGURE_ENTRIES) issues.push({ path: 'body/figures/orders', message: `At most ${MAX_FIGURE_ENTRIES} orders.` })
  if (input.figures.payments.length > MAX_FIGURE_ENTRIES) issues.push({ path: 'body/figures/payments', message: `At most ${MAX_FIGURE_ENTRIES} payments.` })
  input.figures.orders.forEach((entry, index) => {
    reference(entry.reference, `body/figures/orders/${index}/reference`)
    amount(entry.amount, `body/figures/orders/${index}/amount`)
  })
  input.figures.payments.forEach((entry, index) => {
    reference(entry.reference, `body/figures/payments/${index}/reference`)
    amount(entry.amount, `body/figures/payments/${index}/amount`)
    if (entry.date > input.asOf) issues.push({ path: `body/figures/payments/${index}/date`, message: 'A payment they list comes after the day of their figures.' })
  })
  amount(input.figures.balance, 'body/figures/balance')
  const note = input.note ?? null
  if (note !== null && (note.trim() === '' || note.length > MAX_FIGURES_NOTE)) issues.push({ path: 'body/note', message: `A note of 1 to ${MAX_FIGURES_NOTE} characters.` })
  return issues
}

/** The figures in the database's form (references folded to one line). */
export function figuresOf(figures: TheirFigures): TheirFigures {
  return {
    orders: figures.orders.map((entry) => ({ reference: referenceOf(entry.reference) ?? entry.reference, amount: entry.amount })),
    payments: figures.payments.map((entry) => ({ reference: referenceOf(entry.reference) ?? entry.reference, date: entry.date, amount: entry.amount })),
    balance: figures.balance,
  }
}

/** The figures as the database keeps them, read back (anything else is refused: the guard keeps the form). */
export function figuresFromJson(value: unknown): TheirFigures {
  const json = value as { orders?: unknown; payments?: unknown; balance?: unknown } | null
  const list = (entries: unknown) => (Array.isArray(entries) ? entries : []) as Record<string, unknown>[]
  return {
    orders: list(json?.orders).map((entry) => ({ reference: String(entry.reference), amount: Number(entry.amount) })),
    payments: list(json?.payments).map((entry) => ({ reference: String(entry.reference), date: String(entry.date) as BusinessDate, amount: Number(entry.amount) })),
    balance: Number(json?.balance ?? 0),
  }
}
