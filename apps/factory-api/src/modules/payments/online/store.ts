import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { openOnDeposit, openOnInvoice } from '@nexus/factory-domain/payments/payments'
import { failureWords, pickAccount, unavailableWords, type AccountRefusal, type IntentMethod, type IntentStatus, type IntentTarget, type OnlineLocale, type StartRefusal } from '@nexus/factory-domain/payments/online/rules'
import { instalmentsOf, firstOpenDueDate, openInstalments } from '@nexus/factory-domain/receivables/ledger'
import { quoteDocumentNumber } from '@nexus/factory-domain/sales/quotes/document'
import type { CommandTx } from '../../../core/command'

/**
 * Paying online, the reads (B-W2b-185): the intent's columns and views, what a deposit request or an invoice still asks
 * (its open amount, due date, label), and the payment account a company's card payments use. Every amount is marked with
 * the price grain.
 */

export type Reader = FactoryClient | CommandTx

export const INTENT_COLUMNS = {
  id: true,
  companyId: true,
  partyId: true,
  depositRequestId: true,
  invoiceId: true,
  method: true,
  amount: true,
  currency: true,
  providerAccountId: true,
  providerRef: true,
  status: true,
  failureCode: true,
  finishedAt: true,
  paymentId: true,
  linkId: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
} as const satisfies Prisma.PaymentIntentSelect
export type IntentRow = Prisma.PaymentIntentGetPayload<{ select: typeof INTENT_COLUMNS }>

export const targetOf = (row: Pick<IntentRow, 'invoiceId' | 'depositRequestId'>): { readonly target: IntentTarget; readonly targetId: string } =>
  row.invoiceId ? { target: 'INVOICE', targetId: row.invoiceId } : { target: 'DEPOSIT_REQUEST', targetId: row.depositRequestId! }

export async function readIntent(db: Reader, intentId: string): Promise<IntentRow | null> {
  if (!isUuid(intentId)) return null
  return db.paymentIntent.findUnique({ where: { id: intentId }, select: INTENT_COLUMNS })
}

/** What the customer (link or portal) sees of an intent: never the provider account, never who in the office did what. */
export function intentView(row: IntentRow, locale: OnlineLocale) {
  return {
    id: row.id,
    ...targetOf(row),
    method: row.method as IntentMethod,
    amount: asMoney('price', row.amount),
    currency: row.currency,
    status: row.status as IntentStatus,
    providerRef: row.providerRef,
    failureCode: row.failureCode,
    /** The provider's reason in our words (FAILED). */
    failure: row.status === 'FAILED' ? failureWords(row.failureCode, locale) : null,
    finishedAt: row.finishedAt ? toUtcIso(row.finishedAt) : null,
    paymentId: row.paymentId,
    createdAt: toUtcIso(row.createdAt),
  }
}
export type IntentView = ReturnType<typeof intentView>

/** The office's view adds where it started (a link or the portal person). */
export const officeIntentView = (row: IntentRow) => ({ ...intentView(row, 'en'), linkId: row.linkId, startedById: row.createdById, providerAccountId: row.providerAccountId, version: row.version })

// ---- what a target still asks --------------------------------------------------------------------------------------

export interface TargetFacts {
  readonly target: IntentTarget
  readonly id: string
  readonly companyId: string
  readonly partyId: string
  readonly currency: string
  /** The deposit request's amount, the invoice's gross total. */
  readonly total: number
  /** What is still open on it now. */
  readonly open: number
  /** Paid (allocated) and credited so far. */
  readonly settled: number
  /** "Invoice FT-2026-00012", "Deposit for order SO-2026-0007". */
  readonly label: { readonly it: string; readonly en: string }
  readonly number: string | null
  readonly orderNumber: string | null
  readonly quoteDocument: string | null
  readonly issueDate: string | null
  /** The first open instalment's due date (invoice), the request's due date (deposit). */
  readonly dueDate: string | null
  readonly docType: string | null
  readonly status: string
  /** The IBAN the invoice's payment terms name (bank transfer), when it names one. */
  readonly iban: string | null
  /** The deposit request's fields its bank instructions need. */
  readonly deposit: { readonly amount: number; readonly currency: string; readonly dueDate: Date; readonly kind: string; readonly fiscalDocument: string; readonly fiscalRule: string; readonly orderId: string | null; readonly createdById: string | null } | null
  readonly issuedById: string | null
  /** Why it cannot be paid online now (null: it can, while `open` > 0). */
  readonly refusal: StartRefusal | null
}

const day = (value: Date | null): string | null => (value ? businessDate(value, 'UTC') : null)

/** A deposit request or an issued invoice, as paying it online needs it; null when it is not there (or not the reader's). */
export async function targetFacts(db: Reader, target: IntentTarget, id: string): Promise<TargetFacts | null> {
  if (!isUuid(id)) return null
  if (target === 'DEPOSIT_REQUEST') {
    const row = await db.depositRequest.findUnique({ where: { id }, select: { id: true, companyId: true, partyId: true, currency: true, amount: true, dueDate: true, status: true, kind: true, fiscalDocument: true, fiscalRule: true, orderId: true, quoteVersionId: true, createdById: true } })
    if (!row) return null
    const allocated = (await db.paymentAllocation.aggregate({ where: { depositRequestId: row.id }, _sum: { amount: true } }))._sum.amount ?? 0
    const order = row.orderId ? await db.salesOrder.findUnique({ where: { id: row.orderId }, select: { number: true } }) : null
    const version = row.quoteVersionId ? await db.quoteVersion.findUnique({ where: { id: row.quoteVersionId }, select: { revision: true, quoteId: true } }) : null
    const quote = version ? await db.quote.findUnique({ where: { id: version.quoteId }, select: { number: true } }) : null
    const quoteDocument = version && quote ? quoteDocumentNumber(quote.number, version.revision) : null
    const of = order?.number ?? quoteDocument
    const open = row.status === 'OPEN' ? openOnDeposit(row.amount, allocated) : 0
    return {
      target,
      id: row.id,
      companyId: row.companyId,
      partyId: row.partyId,
      currency: row.currency,
      total: row.amount,
      open,
      settled: allocated,
      label: { it: of ? `Acconto per ${order ? "l'ordine" : "l'offerta"} ${of}` : 'Acconto', en: of ? `Deposit for ${order ? 'order' : 'quote'} ${of}` : 'Deposit' },
      number: null,
      orderNumber: order?.number ?? null,
      quoteDocument,
      issueDate: null,
      dueDate: day(row.dueDate),
      docType: null,
      status: row.status,
      iban: null,
      deposit: { amount: row.amount, currency: row.currency, dueDate: row.dueDate, kind: row.kind, fiscalDocument: row.fiscalDocument, fiscalRule: row.fiscalRule, orderId: row.orderId, createdById: row.createdById },
      issuedById: null,
      refusal: row.status !== 'OPEN' || open <= 0 ? 'NOT_OPEN' : row.currency !== 'EUR' ? 'CURRENCY' : null,
    }
  }
  const row = await db.invoice.findUnique({ where: { id }, select: { id: true, companyId: true, buyerPartyId: true, currency: true, grossTotal: true, status: true, docType: true, number: true, issueDate: true, paymentTerms: true, issuedById: true, salesOrder: { select: { number: true } } } })
  if (!row || row.status === 'DRAFT') return null
  const credited = (await db.invoice.aggregate({ where: { creditOfId: row.id, docType: 'TD04', status: { not: 'DRAFT' } }, _sum: { grossTotal: true } }))._sum.grossTotal ?? 0
  const allocated = (await db.paymentAllocation.aggregate({ where: { invoiceId: row.id }, _sum: { amount: true } }))._sum.amount ?? 0
  const issueDate = day(row.issueDate)
  const payable = row.docType === 'TD01' || row.docType === 'TD24'
  const open = payable && row.status !== 'REJECTED' ? openOnInvoice(row.grossTotal, credited, allocated) : 0
  const { instalments } = instalmentsOf(row.paymentTerms, row.grossTotal, issueDate ?? businessDate(new Date()))
  const dueDate = firstOpenDueDate(openInstalments(instalments, credited + allocated)) ?? instalments[0]?.dueDate ?? issueDate
  const number = row.number ?? ''
  return {
    target,
    id: row.id,
    companyId: row.companyId,
    partyId: row.buyerPartyId,
    currency: row.currency,
    total: row.grossTotal,
    open,
    settled: credited + allocated,
    label: { it: `Fattura ${number}`, en: `Invoice ${number}` },
    number: row.number,
    orderNumber: row.salesOrder?.number ?? null,
    quoteDocument: null,
    issueDate,
    dueDate,
    docType: row.docType,
    status: row.status,
    iban: ibanOf(row.paymentTerms),
    deposit: null,
    issuedById: row.issuedById,
    refusal: !payable ? 'NOT_PAYABLE' : row.status === 'REJECTED' || open <= 0 ? 'NOT_OPEN' : row.currency !== 'EUR' ? 'CURRENCY' : null,
  }
}

function ibanOf(terms: unknown): string | null {
  const installments = terms && typeof terms === 'object' ? (terms as { installments?: unknown }).installments : null
  if (!Array.isArray(installments)) return null
  for (const entry of installments) {
    const iban = entry && typeof entry === 'object' ? (entry as { iban?: unknown }).iban : null
    if (typeof iban === 'string' && iban.trim() !== '') return iban.trim()
  }
  return null
}

// ---- the payment account ---------------------------------------------------------------------------------------------

export interface PaymentAccount {
  readonly id: string
  readonly provider: string
  readonly mode: string
  /** Stripe's publishable key, when the account's settings name it (not a secret: the page loads Stripe's fields with it). */
  readonly publishableKey: string | null
}

/**
 * The account a company's card payments use (read in the tenant's system scope: a link or portal session cannot read
 * IntegrationAccount), or why there is none.
 */
export async function paymentAccountFor(db: Reader, companyId: string, environment: string): Promise<{ readonly account: PaymentAccount | null; readonly refusal: AccountRefusal | 'NO_ACCOUNT' | null }> {
  const rows = await db.integrationAccount.findMany({
    where: { provider: { in: ['PAYMENT_FAKE', 'STRIPE'] }, OR: [{ companyId }, { companyId: null }] },
    select: { id: true, companyId: true, provider: true, mode: true, status: true, createdAt: true, settings: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  const { account, refusal } = pickAccount(rows, companyId, environment)
  if (!account) return { account: null, refusal }
  const settings = account.settings && typeof account.settings === 'object' ? (account.settings as { publishableKey?: unknown }) : {}
  const publishableKey = typeof settings.publishableKey === 'string' && /^pk_(live|test)_[A-Za-z0-9]{8,}$/.test(settings.publishableKey) ? settings.publishableKey : null
  return { account: { id: account.id, provider: account.provider, mode: account.mode, publishableKey }, refusal: null }
}

/** What the page says about paying by card or SEPA: available (which provider, which methods) or why not, in words. */
export function cardOffer(found: Awaited<ReturnType<typeof paymentAccountFor>>, locale: OnlineLocale) {
  if (!found.account) return { available: false as const, methods: [] as IntentMethod[], provider: null, mode: null, publishableKey: null, reason: found.refusal ?? 'NO_ACCOUNT', words: unavailableWords(found.refusal ?? 'NO_ACCOUNT', locale) }
  return { available: true as const, methods: ['CARD', 'SEPA_DEBIT'] as IntentMethod[], provider: found.account.provider, mode: found.account.mode, publishableKey: found.account.publishableKey, reason: null, words: null }
}
