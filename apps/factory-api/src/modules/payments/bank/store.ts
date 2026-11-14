import type { Prisma } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { PAYMENTS_BANK_VIEW } from '@nexus/factory-domain/payments/bank/permissions'
import { planLine, differenceOf } from '@nexus/factory-domain/payments/matching/accept'
import { MATCH_CONFIDENCE_WORDS, MATCH_REASON_WORDS, type MatchConfidence, type MatchReason, type OpenItem } from '@nexus/factory-domain/payments/matching/match'
import { WRITE_OFF_REFUSAL_WORDS } from '@nexus/factory-domain/payments/write-offs/write-offs'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { officeContextOf, type Reader } from '../store'

/**
 * The bank's reads (B-W2b-393; factory-db bank.prisma BankAccount, BankStatement, BankLine, BankMatch): who may see a
 * company's bank (can() over the company: a line has no party until it is matched), the columns, and the views — every
 * amount marked with the price grain, reasons and confidence as codes with their words.
 */

/** The office caller over a company's bank: 404 when it may not see it, 403 when it may see but not do `permission`. */
export function bankAccess(caller: CommandCaller, companyId: string, permission: Permission = PAYMENTS_BANK_VIEW): OfficeContext {
  const context = officeContextOf(caller)
  if (!can(actorOf(context), PAYMENTS_BANK_VIEW, { companyId })) throw new NotFoundError('Company not found.')
  if (!can(actorOf(context), permission, { companyId })) throw new ForbiddenError()
  return context
}

const day = (value: Date | null): string | null => (value ? value.toISOString().slice(0, 10) : null)

export const LINE_COLUMNS = {
  id: true,
  companyId: true,
  bankAccountId: true,
  statementId: true,
  bookedOn: true,
  valueOn: true,
  amount: true,
  currency: true,
  bankReference: true,
  referenceText: true,
  counterpartyName: true,
  counterpartyIban: true,
  createdAt: true,
} as const satisfies Prisma.BankLineSelect
export type LineRow = Prisma.BankLineGetPayload<{ select: typeof LINE_COLUMNS }>

export const MATCH_COLUMNS = {
  id: true,
  version: true,
  bankLineId: true,
  partyId: true,
  invoiceIds: true,
  depositRequestIds: true,
  paymentId: true,
  supplierInvoiceId: true,
  confidence: true,
  reasons: true,
  acceptedAt: true,
  acceptedById: true,
  reversedAt: true,
  reversedById: true,
  reverseReason: true,
  createdAt: true,
} as const satisfies Prisma.BankMatchSelect
export type MatchRow = Prisma.BankMatchGetPayload<{ select: typeof MATCH_COLUMNS }>

/** A live acceptance: accepted and not reversed. */
export const isLive = (row: Pick<MatchRow, 'acceptedAt' | 'reversedAt'>): boolean => row.acceptedAt !== null && row.reversedAt === null

const CONFIDENCE_ORDER: Readonly<Record<MatchConfidence, number>> = { HIGH: 0, MEDIUM: 1, LOW: 2 }

/** What the views need beside the rows: names, numbers, what is open now, the tolerance. */
export interface MatchContext {
  readonly parties: ReadonlyMap<string, { readonly code: string; readonly legalName: string }>
  readonly invoices: ReadonlyMap<string, { readonly number: string | null; readonly docType: string }>
  readonly requests: ReadonlyMap<string, { readonly orderNumber: string | null }>
  readonly payments: ReadonlyMap<string, { readonly externalRef: string; readonly receivedOn: Date; readonly status: string }>
  readonly supplierInvoices: ReadonlyMap<string, { readonly number: string; readonly status: string }>
  /** What is open now on the items the suggestions name. */
  readonly open: ReadonlyMap<string, OpenItem>
  readonly tolerance: number | null
}

/** The names and numbers the matches name (a few reads, whatever their count). */
export async function matchContext(db: Reader, matches: readonly MatchRow[], open: readonly OpenItem[], tolerance: number | null): Promise<MatchContext> {
  const partyIds = [...new Set(matches.map((row) => row.partyId))]
  const invoiceIds = [...new Set(matches.flatMap((row) => row.invoiceIds))]
  const requestIds = [...new Set(matches.flatMap((row) => row.depositRequestIds))]
  const paymentIds = [...new Set(matches.flatMap((row) => (row.paymentId ? [row.paymentId] : [])))]
  const supplierIds = [...new Set(matches.flatMap((row) => (row.supplierInvoiceId ? [row.supplierInvoiceId] : [])))]
  const parties = partyIds.length === 0 ? [] : await db.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, code: true, legalName: true } })
  const invoices = invoiceIds.length === 0 ? [] : await db.invoice.findMany({ where: { id: { in: invoiceIds } }, select: { id: true, number: true, docType: true } })
  const requests = requestIds.length === 0 ? [] : await db.depositRequest.findMany({ where: { id: { in: requestIds } }, select: { id: true, order: { select: { number: true } } } })
  const payments = paymentIds.length === 0 ? [] : await db.payment.findMany({ where: { id: { in: paymentIds } }, select: { id: true, externalRef: true, receivedOn: true, status: true } })
  const suppliers = supplierIds.length === 0 ? [] : await db.supplierInvoice.findMany({ where: { id: { in: supplierIds } }, select: { id: true, number: true, status: true } })
  return {
    parties: new Map(parties.map((row) => [row.id, { code: row.code, legalName: row.legalName }])),
    invoices: new Map(invoices.map((row) => [row.id, { number: row.number, docType: row.docType }])),
    requests: new Map(requests.map((row) => [row.id, { orderNumber: row.order?.number ?? null }])),
    payments: new Map(payments.map((row) => [row.id, { externalRef: row.externalRef, receivedOn: row.receivedOn, status: row.status }])),
    supplierInvoices: new Map(suppliers.map((row) => [row.id, { number: row.number, status: row.status }])),
    open: new Map(open.map((item) => [item.id, item])),
    tolerance,
  }
}

const reasonView = (code: MatchReason) => ({ code, words: MATCH_REASON_WORDS[code] })

/** One match as the screens show it; `line` for what accepting a suggestion would leave. */
export function matchView(row: MatchRow, line: Pick<LineRow, 'amount' | 'currency'>, context: MatchContext) {
  const items = [
    ...row.invoiceIds.map((id) => ({ kind: 'INVOICE' as const, id, number: context.invoices.get(id)?.number ?? null, docType: context.invoices.get(id)?.docType ?? null, open: context.open.get(id)?.open ?? 0 })),
    ...row.depositRequestIds.map((id) => ({ kind: 'DEPOSIT_REQUEST' as const, id, number: context.requests.get(id)?.orderNumber ?? null, docType: null, open: context.open.get(id)?.open ?? 0 })),
  ]
  // What accepting it now leaves (money in with items, a suggestion): the leftover or the item left short.
  let difference = null
  let stale = false
  if (row.acceptedAt === null && items.length > 0 && line.amount > 0) {
    const plan = planLine(line.amount, items.map((item, index) => ({ kind: item.kind, id: item.id, open: item.open, label: item.number ?? item.kind, path: `items/${index}` })), line.currency)
    const found = differenceOf(plan, context.tolerance)
    // An item it names has nothing left to pay (paid meanwhile): the next look removes it; it cannot be accepted.
    stale = plan.issues.length > 0
    if (!stale && found.kind !== null) difference = { kind: found.kind, amount: asMoney('price', found.amount), writable: found.refusal === null, refusal: found.refusal === null ? null : { code: found.refusal, words: WRITE_OFF_REFUSAL_WORDS[found.refusal] } }
  }
  const payment = row.paymentId ? context.payments.get(row.paymentId) : undefined
  const supplier = row.supplierInvoiceId ? context.supplierInvoices.get(row.supplierInvoiceId) : undefined
  return {
    id: row.id,
    version: row.version,
    partyId: row.partyId,
    party: context.parties.get(row.partyId) ?? { code: '', legalName: '' },
    confidence: row.confidence,
    confidenceWords: MATCH_CONFIDENCE_WORDS[row.confidence],
    reasons: row.reasons.map(reasonView),
    chosenByPerson: row.reasons.includes('CHOSEN_BY_PERSON'),
    items: items.map((item) => ({ kind: item.kind, id: item.id, number: item.number, docType: item.docType, openAmount: asMoney('price', item.open) })),
    paymentId: row.paymentId,
    payment: payment ? { externalRef: payment.externalRef, receivedOn: day(payment.receivedOn)!, status: payment.status } : null,
    supplierInvoiceId: row.supplierInvoiceId,
    supplierInvoice: supplier ? { number: supplier.number, status: supplier.status } : null,
    difference,
    stale,
    acceptedAt: row.acceptedAt ? toUtcIso(row.acceptedAt) : null,
    acceptedById: row.acceptedById,
    reversedAt: row.reversedAt ? toUtcIso(row.reversedAt) : null,
    reversedById: row.reversedById,
    reverseReason: row.reverseReason,
  }
}

/** A line with its live acceptance, its suggestions (surest first) and its earlier acceptances taken back. */
export function lineView(line: LineRow, matches: readonly MatchRow[], context: MatchContext, today: string) {
  const mine = matches.filter((row) => row.bankLineId === line.id)
  const accepted = mine.find(isLive) ?? null
  const suggestions = accepted ? [] : mine.filter((row) => row.acceptedAt === null).sort((a, b) => CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence] || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
  const booked = day(line.bookedOn)!
  return {
    id: line.id,
    companyId: line.companyId,
    bankAccountId: line.bankAccountId,
    statementId: line.statementId,
    bookedOn: booked,
    valueOn: day(line.valueOn),
    amount: asMoney('price', line.amount),
    currency: line.currency,
    direction: line.amount > 0 ? ('IN' as const) : ('OUT' as const),
    bankReference: line.bankReference,
    referenceText: line.referenceText,
    counterpartyName: line.counterpartyName,
    counterpartyIban: line.counterpartyIban,
    state: accepted ? ('MATCHED' as const) : ('TO_MATCH' as const),
    /** Days since it was booked (Rome days). */
    ageDays: Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${booked}T00:00:00Z`)) / 86_400_000)),
    accepted: accepted ? matchView(accepted, line, context) : null,
    suggestions: suggestions.map((row) => matchView(row, line, context)),
    reversed: mine.filter((row) => row.reversedAt !== null).map((row) => matchView(row, line, context)),
  }
}
