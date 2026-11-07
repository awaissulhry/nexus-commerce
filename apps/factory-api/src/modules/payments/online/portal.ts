import type { FastifyRequest } from 'fastify'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { PORTAL_PAYMENTS_PAY, PORTAL_PAYMENTS_VIEW } from '@nexus/factory-domain/payments/online/permissions'
import { LIVE_INTENT_STATUSES, type IntentMethod, type IntentTarget, type OnlineLocale } from '@nexus/factory-domain/payments/online/rules'
import { daysBetween, firstOpenDueDate } from '@nexus/factory-domain/receivables/ledger'
import { movementLabel, statementDocument } from '@nexus/factory-domain/receivables/documents'
import { actorOf, requireContext } from '../../../core/context'
import { companyLegalOf } from '../../../platform/documents/documents'
import { renderDocumentPdf } from '../../../platform/documents/pdf'
import { systemCallerOf } from '../../../platform/files/files'
import { portalSessionOf, type PortalSession } from '../../../platform/auth/portal/authenticator'
import { addressOf } from '../../receivables/pdf'
import { statementData } from '../../receivables/statement'
import { openInvoices } from '../../receivables/store'
import { processPayments } from './runtime'
import { startIntent, type PayerOrigin, type StartedPayment } from './start'
import { cardOffer, INTENT_COLUMNS, intentView, paymentAccountFor, readIntent, type IntentRow, type Reader } from './store'

/**
 * Invoices and payment in the customer portal (B-W2b-185; FIN-118, FIN-123; design portal.customer.documents "To pay" with
 * its pop-up "Pay invoice …" and the statement in a new tab; SCR-186 is its screen). For the customer's Finance and Admin
 * (portal.payments.view / .pay, the price grain): the portal's company and the person's party only.
 *
 *   GET  /portal/payments/open-items       the open invoices (due date, days late, what is open, the SDI state, the PDF and
 *                                          XML files) and open deposit requests, oldest first, with the latest online payment
 *                                          of each; totals per currency; card and SEPA offered or not (bank transfer always)
 *   GET  /portal/payments/statement        the statement of account (B-W2a-55's ledger: opening, invoices, credit notes,
 *                                          payments, refunds, the running balance, what is open at its end)
 *   GET  /portal/payments/statement/pdf    the same as a PDF (the company's letterhead), inline, stored nowhere
 *   POST /portal/payments/intents          pay an open invoice or deposit request by card or SEPA (./start.ts), as this person
 *   GET  /portal/payments/intents/:id      how a payment of the party stands
 * The ledger reads what the partner role cannot (credit notes' sums, refunds, the company's bank) in the tenant's system
 * scope, for the session's party and company only; the payment's own rows the person may read (Payment, PaymentIntent of
 * the party) are its party's anyway.
 */

const localeOf = (session: PortalSession): OnlineLocale => (session.person.locale === 'en' ? 'en' : 'it')

function mayPay(request: FastifyRequest, session: PortalSession): boolean {
  if (session.preview) return false
  const actor = actorOf(requireContext(request))
  return can(actor, PORTAL_PAYMENTS_PAY, { companyId: session.company.id, partyId: session.partyId }) && heldGrains(actor).has('price')
}

/** The latest intent of each target (a payment under way first). */
function latestByTarget(rows: readonly IntentRow[]): Map<string, IntentRow> {
  const latest = new Map<string, IntentRow>()
  const rank = (row: IntentRow) => ((LIVE_INTENT_STATUSES as readonly string[]).includes(row.status) ? 1 : 0)
  for (const row of rows) {
    const key = (row.invoiceId ?? row.depositRequestId)!
    const held = latest.get(key)
    if (!held || rank(row) > rank(held) || (rank(row) === rank(held) && row.createdAt > held.createdAt)) latest.set(key, row)
  }
  return latest
}

export async function portalOpenItems(request: FastifyRequest, now: Date) {
  const session = portalSessionOf(request)
  const locale = localeOf(session)
  const today = businessDate(now)
  const system = systemCallerOf(request)(session.tenantId)
  const scope = { companyId: session.company.id, partyId: session.partyId }
  const pays = mayPay(request, session)
  const runtime = processPayments()
  const read = await system.withClient(async (db) => {
    const invoices = await openInvoices(db, { ...scope, asOf: today })
    const files = invoices.length === 0 ? [] : await db.invoice.findMany({ where: { id: { in: invoices.map((row) => row.id) } }, select: { id: true, status: true, pdfFileId: true, xmlFileId: true } })
    const requests = await db.depositRequest.findMany({ where: { ...scope, status: 'OPEN' }, select: { id: true, amount: true, currency: true, dueDate: true, orderId: true, quoteVersionId: true }, orderBy: [{ dueDate: 'asc' }, { id: 'asc' }] })
    const deposits = []
    for (const row of requests) {
      const allocated = (await db.paymentAllocation.aggregate({ where: { depositRequestId: row.id }, _sum: { amount: true } }))._sum.amount ?? 0
      const order = row.orderId ? await db.salesOrder.findUnique({ where: { id: row.orderId }, select: { number: true } }) : null
      const version = row.quoteVersionId ? await db.quoteVersion.findUnique({ where: { id: row.quoteVersionId }, select: { revision: true, quote: { select: { number: true } } } }) : null
      const quoteDocument = version ? `${version.quote.number} v${version.revision}` : null
      if (row.amount - allocated > 0) deposits.push({ ...row, open: row.amount - allocated, orderNumber: order?.number ?? null, quoteDocument })
    }
    const ids = [...invoices.map((row) => row.id), ...deposits.map((row) => row.id)]
    const intents = ids.length === 0 ? [] : await db.paymentIntent.findMany({ where: { OR: [{ invoiceId: { in: ids } }, { depositRequestId: { in: ids } }] }, select: INTENT_COLUMNS })
    const card = cardOffer(await paymentAccountFor(db, scope.companyId, runtime.environment), locale)
    return { invoices, files, deposits, intents: latestByTarget(intents), card }
  })
  const totals = new Map<string, { open: number; overdue: number }>()
  const add = (currency: string, open: number, late: boolean) => {
    const entry = totals.get(currency) ?? { open: 0, overdue: 0 }
    entry.open += open
    if (late) entry.overdue += open
    totals.set(currency, entry)
  }
  const invoices = read.invoices.map((row) => {
    const dueDate = firstOpenDueDate(row.instalments) ?? row.issueDate
    const open = row.instalments.reduce((sum, entry) => sum + entry.open, 0)
    const daysLate = Math.max(0, daysBetween(dueDate, today))
    add(row.currency, open, daysLate > 0)
    const file = read.files.find((entry) => entry.id === row.id)
    const intent = read.intents.get(row.id)
    return {
      invoiceId: row.id,
      number: row.number,
      docType: row.docType,
      issueDate: row.issueDate,
      dueDate,
      dueDateKnown: row.dueDateKnown,
      daysLate,
      total: asMoney('price', row.gross),
      open: asMoney('price', open),
      currency: row.currency,
      sdiStatus: file?.status ?? 'ISSUED',
      pdfFileId: file?.pdfFileId ?? null,
      xmlFileId: file?.xmlFileId ?? null,
      payment: intent ? intentView(intent, locale) : null,
      canPay: pays && read.card.available && row.currency === 'EUR',
    }
  })
  const deposits = read.deposits.map((row) => {
    const dueDate = businessDate(row.dueDate, 'UTC')
    const daysLate = Math.max(0, daysBetween(dueDate, today))
    add(row.currency, row.open, daysLate > 0)
    const of = row.orderNumber ?? row.quoteDocument
    const intent = read.intents.get(row.id)
    return {
      depositRequestId: row.id,
      label: { it: of ? `Acconto per ${row.orderNumber ? "l'ordine" : "l'offerta"} ${of}` : 'Acconto', en: of ? `Deposit for ${row.orderNumber ? 'order' : 'quote'} ${of}` : 'Deposit' },
      orderNumber: row.orderNumber,
      quoteDocument: row.quoteDocument,
      dueDate,
      daysLate,
      total: asMoney('price', row.amount),
      open: asMoney('price', row.open),
      currency: row.currency,
      payment: intent ? intentView(intent, locale) : null,
      canPay: pays && read.card.available && row.currency === 'EUR',
    }
  })
  return {
    asOf: today,
    invoices,
    deposits,
    byCurrency: [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, entry]) => ({ currency, open: asMoney('price', entry.open), overdue: asMoney('price', entry.overdue) })),
    counts: { invoices: invoices.length, overdue: invoices.filter((row) => row.daysLate > 0).length + deposits.filter((row) => row.daysLate > 0).length, deposits: deposits.length },
    card: read.card,
    mayPay: pays,
    live: { events: ['partner_task.opened', 'partner_task.closed'] },
  }
}

/** How many open invoices the person's party has, and how many are late (Home's counts), or null without the right. */
export async function openInvoiceCounts(request: FastifyRequest, now: Date): Promise<{ readonly toPay: number; readonly overdue: number } | null> {
  const session = portalSessionOf(request)
  const actor = actorOf(requireContext(request))
  if (!can(actor, PORTAL_PAYMENTS_VIEW, { companyId: session.company.id, partyId: session.partyId }) || !heldGrains(actor).has('price')) return null
  const today = businessDate(now)
  const invoices = await systemCallerOf(request)(session.tenantId).withClient((db) => openInvoices(db, { companyId: session.company.id, partyId: session.partyId, asOf: today }))
  return { toPay: invoices.length, overdue: invoices.filter((row) => (firstOpenDueDate(row.instalments) ?? row.issueDate) < today).length }
}

interface StatementQuery {
  readonly from?: BusinessDate | undefined
  readonly to?: BusinessDate | undefined
  readonly currency?: string | undefined
  readonly language?: OnlineLocale | undefined
}

async function statementOfSession(request: FastifyRequest, query: StatementQuery) {
  const session = portalSessionOf(request)
  const system = systemCallerOf(request)(session.tenantId)
  const data = await system.withClient((db) => statementData(db, { companyId: session.company.id, partyId: session.partyId }, query))
  return { session, system, data, language: query.language ?? localeOf(session) }
}

export async function portalStatement(request: FastifyRequest, query: StatementQuery) {
  const { data, language } = await statementOfSession(request, query)
  const { statement } = data
  return {
    company: { name: data.company.legalName },
    customer: { code: data.customer.code, name: data.customer.legalName },
    currency: data.currency,
    currencies: [...data.currencies],
    from: statement.from,
    to: statement.to,
    opening: asMoney('price', statement.opening),
    closing: asMoney('price', statement.closing),
    totals: asMoney('price', { ...statement.totals }),
    lines: statement.lines.map((line) => ({
      kind: line.kind,
      date: line.date,
      recordType: line.recordType,
      recordId: line.recordId,
      reference: line.reference,
      docType: line.docType,
      dueDate: line.dueDate,
      label: movementLabel(line, language),
      debit: asMoney('price', line.debit),
      credit: asMoney('price', line.credit),
      balance: asMoney('price', line.balance),
    })),
    openItems: data.openItems.map((invoice) => {
      const dueDate = firstOpenDueDate(invoice.instalments) ?? invoice.issueDate
      return { invoiceId: invoice.id, number: invoice.number, dueDate, open: asMoney('price', invoice.instalments.reduce((sum, entry) => sum + entry.open, 0)), daysLate: Math.max(0, daysBetween(dueDate, statement.to)) }
    }),
  }
}

export async function portalStatementPdf(request: FastifyRequest, query: StatementQuery, now: Date): Promise<{ readonly pdf: Buffer; readonly fileName: string }> {
  const { system, data, language } = await statementOfSession(request, query)
  const company = await companyLegalOf(system, data.company.id)
  const composed = statementDocument({
    language,
    company,
    customer: { name: data.customer.legalName, code: data.customer.code, address: addressOf(data.customer.address), vatNumber: data.customer.vatNumber },
    currency: data.currency,
    statement: data.statement,
    open: data.ageing,
    printedOn: businessDate(now),
    note: null,
  })
  return { pdf: await renderDocumentPdf(composed), fileName: `${composed.meta.title.replace(/[\\/]/g, '-')}.pdf` }
}

export async function portalStart(request: FastifyRequest, body: { readonly invoiceId?: string; readonly depositRequestId?: string; readonly method: IntentMethod }): Promise<StartedPayment> {
  const session = portalSessionOf(request)
  if (session.preview) throw new ForbiddenError('A preview of the portal does not pay.')
  if (!mayPay(request, session)) throw new ForbiddenError()
  const target: IntentTarget = body.invoiceId ? 'INVOICE' : 'DEPOSIT_REQUEST'
  const origin: PayerOrigin = { tenantId: session.tenantId, partyId: session.partyId, companyId: session.company.id, linkId: null, personId: session.userId, locale: localeOf(session) }
  return startIntent(request, origin, target, (body.invoiceId ?? body.depositRequestId)!, body.method)
}

export async function portalIntent(request: FastifyRequest, intentId: string) {
  const session = portalSessionOf(request)
  // The party's own intents only: the partner role's row-level security reads them, never another party's.
  const own = await request.withClient((client: Reader) => client.paymentIntent.findUnique({ where: { id: intentId }, select: { id: true, companyId: true } }))
  if (!own || own.companyId !== session.company.id) throw new NotFoundError('Payment not found.')
  const row = await systemCallerOf(request)(session.tenantId).withClient((db) => readIntent(db, intentId))
  if (!row || row.partyId !== session.partyId) throw new NotFoundError('Payment not found.')
  return { intent: intentView(row, localeOf(session)) }
}
