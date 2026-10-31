import { CHARGE_KINDS, type ChargeKind, type Invoice, type InvoiceLine, type LineInput, type QueueDdt } from '../../_shared/api'
import { ddtHeld, lineInputsOf, parsePrice, parseQuantity, PAYABLE, type FinanceAbilities, type Phrase } from '../../_shared/model'
import type { Deferred, DeferredGroup, ReturnCredit, ReturnCreditSkip } from './api'

/**
 * The invoice screens' every-day rules (B-W2a-80; design finance.invoices W2a parts), pure — no fetching, no React; the
 * words are `finance-daily` message keys the views translate:
 *   - the tile "Deferred invoices due by the 15th" (GET /invoicing/deferred counts) and its saved filter on "Shipped, not
 *     invoiced" (`?shipped=deferred`: the DDTs a deferred invoice takes), the month's deferred invoice of a DDT's customer;
 *   - each DDT's countdown by the customer's preset (TD01 = the DDT's date + 12 days; TD24 = the 15th of the next month);
 *   - charge lines (freight, packaging, samples, a fee, another charge) typed on a draft: what is sent back (every line
 *     with its kind: without `chargeKind` the API refuses the whole PUT), the problems of a typed one;
 *   - where an invoice's due dates come from (the customer's or the order's terms, typed here, an advance);
 *   - a customer return's credit notes in words; "carry the credit" and "refund" of an over-paid invoice, held with why.
 */

const phrase = (key: string, params?: Record<string, string | number>): Phrase => (params ? { key, params } : { key })

// ---- the deferred invoices due -------------------------------------------------------------------------------------------

/** The tile: how many deferred invoices are due by the 15th, and how many of them are due within 3 days or late. */
export function deferredTile(deferred: Deferred | null): { value: string; hint: Phrase | null } {
  if (!deferred) return { value: '—', hint: null }
  const { groups, dueSoon, late } = deferred.counts
  if (late > 0) return { value: String(groups), hint: phrase('deferred.tileLate', { count: late }) }
  if (dueSoon > 0) return { value: String(groups), hint: phrase('deferred.tileSoon', { count: dueSoon }) }
  return { value: String(groups), hint: groups > 0 ? phrase('deferred.tileOpen') : null }
}

/** "Shipped, not invoiced" rows: every DDT, or only those a deferred invoice takes (the tile's saved filter). */
export const SHIPPED_VIEWS = ['all', 'deferred'] as const
export type ShippedView = (typeof SHIPPED_VIEWS)[number]
export const shippedViewOf = (params: { get(name: string): string | null } | null): ShippedView => (params?.get('shipped') === 'deferred' ? 'deferred' : 'all')

/** The DDTs the deferred invoices due take (the saved filter's rows). */
export function deferredDdtIds(deferred: Deferred | null): Set<string> {
  return new Set((deferred?.groups ?? []).flatMap((group) => group.ddts.map((ddt) => ddt.ddtId)))
}

/** The deferred invoice (customer × company × month) a DDT belongs to, or null. */
export function groupOf(deferred: Deferred | null, ddtId: string): DeferredGroup | null {
  return deferred?.groups.find((group) => group.ddts.some((ddt) => ddt.ddtId === ddtId)) ?? null
}

/**
 * Why "Deferred invoice of <month>" waits for a group, or null: the right to make drafts, and something of its DDTs left
 * to invoice (everything already in a draft: the draft is the invoice to issue).
 */
export function deferredHeld(group: DeferredGroup, ddts: ReadonlyArray<Pick<QueueDdt, 'ddtId' | 'lines'>>, can: Pick<FinanceAbilities, 'manageInvoices'>): Phrase | null {
  if (!can.manageInvoices) return phrase('deferred.held.noManage')
  const mine = ddts.filter((ddt) => group.ddts.some((entry) => entry.ddtId === ddt.ddtId))
  if (mine.length > 0 && mine.every((ddt) => ddtHeld(ddt) !== null)) return phrase('deferred.held.inDraft')
  return null
}

/** A month (YYYY-MM) in the person's words (`ottobre 2026`, `October 2026`). */
export function monthWords(month: string, locale: 'it' | 'en'): string {
  const [year, number] = month.split('-').map(Number)
  if (!year || !number) return month
  return new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, number - 1, 15)))
}

/**
 * The bulk action's words for the DDTs chosen (design: "Create deferred invoice for 4 DDTs of Customer Gamma"): one customer
 * whose DDTs a deferred invoice takes (several, or a monthly customer) → the deferred words; otherwise "Invoice N DDTs".
 */
export function bulkWords(picked: ReadonlyArray<{ ddtId: string; partyId: string; customer: { legalName: string } }>, deferred: Deferred | null): Phrase {
  const first = picked[0]
  const one = !!first && picked.every((row) => row.partyId === first.partyId)
  const ids = deferredDdtIds(deferred)
  if (one && picked.every((row) => ids.has(row.ddtId))) return phrase('deferred.bulk', { count: picked.length, customer: first.customer.legalName })
  return phrase('deferred.bulkPlain', { count: picked.length })
}

// ---- the countdown by the customer's preset ------------------------------------------------------------------------------

type ShownDeadline = NonNullable<QueueDdt['deadline']>

/**
 * The deadline a DDT counts down to (B-W2a-54: by the customer's preset — TD24 → the 15th of the next month; TD01 → its 12
 * days, then the 15th once they passed), else W1's own rule (its 12 days, the month's once they passed).
 */
export function ddtDeadline(ddt: Pick<QueueDdt, 'immediate' | 'deadline'>, monthDeadline: ShownDeadline | null): ShownDeadline {
  if (ddt.deadline) return ddt.deadline
  return ddt.immediate.state !== 'LATE' || !monthDeadline ? ddt.immediate : monthDeadline
}

/** What a DDT's freight adds to its invoice: an amount (with the price grain), "not decided yet", none, or billed. */
export function freightWords(ddt: Pick<QueueDdt, 'freight'>): { key: string; amount: number | null } | null {
  const freight = ddt.freight
  if (!freight) return null
  if (freight.billed) return { key: 'deferred.freight.billed', amount: null }
  if (freight.amount === undefined) return null
  if (freight.amount === null) return { key: 'deferred.freight.undecided', amount: null }
  if (freight.amount === 0) return null
  return { key: 'deferred.freight.toBill', amount: freight.amount }
}

// ---- charge lines --------------------------------------------------------------------------------------------------------

export { CHARGE_KINDS }
export type { ChargeKind }

/** The charge lines of an invoice (B-W2a-54: freight, packaging, samples, a fee, another charge). */
export const chargeLines = (invoice: Pick<Invoice, 'lines'>): InvoiceLine[] => invoice.lines.filter((line) => line.kind === 'CHARGE')

export interface ChargeDraft {
  kind: ChargeKind | ''
  description: string
  quantity: string
  unitPrice: string
  /** The DDT it belongs to: required on an invoice of several DDTs (FatturaPA: every line names its DDT). */
  ddtId: string
}

/** The DDTs an invoice's lines name (a charge on an invoice of several must name one of them). */
export const ddtsOf = (invoice: Pick<Invoice, 'lines'>): string[] => [...new Set(invoice.lines.map((line) => line.ddtId).filter((id): id is string => !!id))]

/** A new charge's problems as message keys (by field), or none. */
export function chargeProblems(draft: ChargeDraft, ddtCount: number): { kind?: string; description?: string; quantity?: string; unitPrice?: string; ddt?: string } {
  const problems: { kind?: string; description?: string; quantity?: string; unitPrice?: string; ddt?: string } = {}
  if (draft.kind === '') problems.kind = 'charge.problem.kind'
  if (draft.description.trim() === '') problems.description = 'charge.problem.description'
  else if (draft.description.length > 1000) problems.description = 'charge.problem.long'
  if (parseQuantity(draft.quantity) === null) problems.quantity = 'charge.problem.quantity'
  const price = parsePrice(draft.unitPrice)
  if (price === null || Number(price) <= 0) problems.unitPrice = 'charge.problem.price'
  if (ddtCount > 1 && draft.ddtId === '') problems.ddt = 'charge.problem.ddt'
  return problems
}

/**
 * The draft's lines with one charge added: every stored line sent back as it is (a charge with its kind), then the new one
 * — its VAT left to the API (it follows the goods; DPR 633/1972 art. 12 c.1, a setting the accountant confirms).
 */
export function withCharge(invoice: Pick<Invoice, 'lines'>, draft: ChargeDraft): LineInput[] {
  const ddts = ddtsOf(invoice)
  const ddtId = draft.ddtId || (ddts.length === 1 ? ddts[0]! : null)
  return [
    ...lineInputsOf(invoice.lines, []),
    {
      kind: 'CHARGE',
      chargeKind: draft.kind === '' ? 'OTHER' : draft.kind,
      description: draft.description.trim(),
      quantity: parseQuantity(draft.quantity) ?? '1',
      unitPrice: parsePrice(draft.unitPrice) ?? '0',
      discountPct: null,
      ...(ddtId ? { ddtId } : {}),
    },
  ]
}

/** The draft's lines without one charge line (the others sent back as they are). */
export function withoutLine(invoice: Pick<Invoice, 'lines'>, lineId: string): LineInput[] {
  return lineInputsOf(
    invoice.lines.filter((line) => line.id !== lineId),
    [],
  )
}

/** Why a charge cannot be added or removed here, or null: a draft, the right to make drafts, a credit note from a return. */
export function chargeHeld(invoice: Pick<Invoice, 'status' | 'docType' | 'lines'>, can: Pick<FinanceAbilities, 'manageInvoices'>): Phrase | null {
  if (!can.manageInvoices) return phrase('charge.held.noManage')
  if (invoice.status !== 'DRAFT') return phrase('charge.held.issued')
  if (invoice.docType === 'TD02') return phrase('charge.held.deposit')
  if (invoice.lines.some((line) => line.returnLineId)) return phrase('charge.held.fromReturn')
  return null
}

// ---- where the due dates come from ----------------------------------------------------------------------------------------

/** B-W2a-54: Invoice.paymentTerms.source — the library terms (with their code), typed here, or an advance (TP03). */
export function termsSourceOf(invoice: Pick<Invoice, 'paymentTerms'>): Phrase | null {
  const terms = invoice.paymentTerms as { source?: unknown } | null | undefined
  const source = terms?.source
  if (!source || typeof source !== 'object') return null
  const kind = (source as { kind?: unknown }).kind
  if (kind === 'MANUAL') return phrase('terms.source.MANUAL')
  if (kind === 'ADVANCE') return phrase('terms.source.ADVANCE')
  if (kind === 'TERMS') {
    const code = (source as { code?: unknown }).code
    return phrase('terms.source.TERMS', { code: typeof code === 'string' ? code : '—' })
  }
  return null
}

// ---- a customer return's credit notes ------------------------------------------------------------------------------------

export const skipKey = (code: ReturnCreditSkip): string => `returnCredit.skip.${code}`

/** Why "Create the credit notes" of a return waits, or null: the right, and something to credit now. */
export function returnCreditHeld(answer: Pick<ReturnCredit, 'toCredit'> | null, can: Pick<FinanceAbilities, 'manageInvoices'>): Phrase | null {
  if (!can.manageInvoices) return phrase('returnCredit.held.noManage')
  if (!answer) return phrase('returnCredit.held.reading')
  if (answer.toCredit.length === 0) return phrase('returnCredit.held.nothing')
  return null
}

// ---- an over-paid invoice: refund or carry the credit ---------------------------------------------------------------------

/** "Carry to the credit balance" (POST /payments/release-overpayment), held with why, or null. */
export function carryHeld(invoice: Pick<Invoice, 'docType' | 'status' | 'refundDueAmount'>, can: Pick<FinanceAbilities, 'recordPayments'>): Phrase | null {
  if (!can.recordPayments) return phrase('carry.held.noRecord')
  if (!PAYABLE.includes(invoice.docType)) return phrase('carry.held.deposit')
  if ((invoice.refundDueAmount ?? 0) <= 0) return phrase('carry.held.nothing')
  return null
}

/** The note "carry the credit" needs (3 to 500 characters), or its problem. */
export const carryNoteProblem = (note: string): string | null => (note.trim().length < 3 ? 'carry.problem.note' : note.trim().length > 500 ? 'carry.problem.long' : null)

/** Where the Refund dialog opens for a credit note (Finance › Payments, the ONE Refund dialog). */
export const refundHref = (prefix: string, creditNoteId: string): string => `${prefix}/finance/payments?refund=${encodeURIComponent(creditNoteId)}`

/** The readable XML of an issued invoice, in a new tab (design finance.invoices tab:xml). */
export const xmlHref = (prefix: string, invoiceId: string): string => `${prefix}/finance/invoices/${encodeURIComponent(invoiceId)}/xml`
