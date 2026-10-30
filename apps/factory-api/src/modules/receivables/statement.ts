import { ForbiddenError, InvalidStateError, ValidationError } from '@nexus/factory-domain/core/errors'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import type { SendStatementBody, StatementQuery } from '@nexus/factory-domain/receivables/contracts'
import { statementDocument, movementLabel } from '@nexus/factory-domain/receivables/documents'
import {
  addToAgeing,
  bucketOf,
  daysBetween,
  defaultStatementFrom,
  emptyAgeing,
  firstOpenDueDate,
  instalmentsOf,
  MAX_STATEMENT_DAYS,
  statementOf,
  type AgeingTotals,
  type Movement,
  type Statement,
} from '@nexus/factory-domain/receivables/ledger'
import { RECEIVABLES_STATEMENTS_SEND, RECEIVABLES_VIEW } from '@nexus/factory-domain/receivables/permissions'
import { reminderLanguageOf } from '@nexus/factory-domain/receivables/wording'
import type { CommandCaller } from '../../core/command'
import { companyLegalOf } from '../../platform/documents/documents'
import { renderDocumentPdf } from '../../platform/documents/pdf'
import { sendEmail } from '../../platform/email-out/outbound'
import { putGeneratedFile, recordGeneratedFile } from '../../platform/files/files'
import { processFiles } from '../../platform/files/service'
import { addressOf } from './pdf'
import { assertMay, holdsPrice, invoiceContactsOf, officeContextOf, openInvoices, receivablesCommand, senderOf, today, type CustomerScope, type OpenInvoiceRow, type Reader } from './store'

/**
 * The customer ledger and its statement (B-W2a-55; FIN-109; design finance.receivables pop-up "statement": "Opening
 * balance + invoices − payments − credits = running balance · Print or send statement", new tab "Statement (PDF)"). For
 * one customer in one company and one currency (receivables.view over the company AND the customer):
 *
 *   GET  /receivables/customers/:partyId/statement        the period's movements with the running balance, what is open
 *                                                         at its end (per invoice, aged), the reminders sent
 *   GET  …/statement/pdf                                   the same as a PDF (the company's letterhead), inline, stored
 *                                                         nowhere; needs the price grain (every figure is a price)
 *   POST …/statement/send                                  receivables.statements.send: the PDF stored on the customer's
 *                                                         record (DOCUMENT, shared with the customer) and e-mailed to its
 *                                                         invoice contacts from the company's address (FAKE locally),
 *                                                         in ONE command; customer_statement.sent
 * The ledger rules are factory-domain receivables/ledger: issued invoices (TD01, TD24, TD02) debit, credit notes (TD04)
 * and payments received credit, refunds paid debit; a draft, a voided payment or an unpaid refund are no money.
 */

const day = (value: Date) => businessDate(value, 'UTC')

export interface StatementData {
  readonly company: { id: string; code: string; legalName: string; currency: string }
  readonly customer: { id: string; code: string; legalName: string; language: string; vatNumber: string | null; address: unknown }
  readonly currency: string
  readonly currencies: readonly string[]
  readonly statement: Statement
  readonly openItems: readonly OpenInvoiceRow[]
  readonly ageing: AgeingTotals
  readonly remindersSent: number
  readonly recipients: readonly { name: string; email: string }[]
}

function periodOf(query: { from?: BusinessDate | undefined; to?: BusinessDate | undefined }): { from: BusinessDate; to: BusinessDate } {
  const to = query.to ?? today()
  const from = query.from ?? defaultStatementFrom(to)
  if (from > to) throw new ValidationError('The period ends before it starts.', [{ path: 'query/from', message: 'The first day comes before the last.' }])
  if (daysBetween(from, to) > MAX_STATEMENT_DAYS) throw new ValidationError('The period is too long.', [{ path: 'query/from', message: `A statement covers at most ${MAX_STATEMENT_DAYS} days; ask for it in parts.` }])
  return { from, to }
}

/** The customer's ledger for the period (as of its last day). */
export async function statementData(db: Reader, scope: CustomerScope, query: { from?: BusinessDate | undefined; to?: BusinessDate | undefined; currency?: string | undefined }): Promise<StatementData> {
  const { from, to } = periodOf(query)
  const end = new Date(`${to}T00:00:00.000Z`)
  const company = await db.company.findUniqueOrThrow({ where: { id: scope.companyId }, select: { id: true, code: true, legalName: true, currency: true } })
  const party = await db.party.findUniqueOrThrow({ where: { id: scope.partyId }, select: { id: true, code: true, legalName: true, language: true } })
  // The bill-to address and the VAT number in force (the newest identity), as the documents print them.
  const address = await db.partyAddress.findFirst({ where: { partyId: scope.partyId, status: 'ACTIVE' }, orderBy: [{ isDefaultBillTo: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }], select: { line1: true, line2: true, postalCode: true, city: true, province: true, country: true } })
  const identity = await db.partyTaxIdentity.findFirst({ where: { partyId: scope.partyId }, orderBy: [{ validFrom: 'desc' }, { createdAt: 'desc' }], select: { vatNumber: true, country: true } })
  const invoices = await db.invoice.findMany({
    where: { companyId: scope.companyId, buyerPartyId: scope.partyId, status: { not: 'DRAFT' }, docType: { in: ['TD01', 'TD02', 'TD04', 'TD24'] }, issueDate: { lte: end } },
    select: { id: true, number: true, docType: true, issueDate: true, currency: true, grossTotal: true, paymentTerms: true },
  })
  const payments = await db.payment.findMany({ where: { companyId: scope.companyId, partyId: scope.partyId, status: 'RECEIVED', receivedOn: { lte: end } }, select: { id: true, receivedOn: true, currency: true, amount: true, externalRef: true } })
  const refunds = await db.refund.findMany({ where: { companyId: scope.companyId, partyId: scope.partyId, status: 'PAID', paidOn: { lte: end } }, select: { id: true, paidOn: true, currency: true, amount: true, externalRef: true } })
  const currencies = [...new Set([...invoices, ...payments, ...refunds].map((row) => row.currency))].sort()
  const currency = query.currency ?? (currencies.includes(company.currency) || currencies.length === 0 ? company.currency : currencies[0]!)
  const movements: Movement[] = [
    ...invoices
      .filter((row) => row.currency === currency && row.issueDate)
      .map((row) => {
        const issued = day(row.issueDate!)
        return {
          kind: row.docType === 'TD04' ? ('CREDIT_NOTE' as const) : ('INVOICE' as const),
          date: issued,
          recordType: 'Invoice' as const,
          recordId: row.id,
          reference: row.number,
          docType: row.docType,
          dueDate: row.docType === 'TD01' || row.docType === 'TD24' ? (instalmentsOf(row.paymentTerms, row.grossTotal, issued).instalments[0]?.dueDate ?? null) : null,
          amount: row.grossTotal,
        }
      }),
    ...payments.filter((row) => row.currency === currency).map((row) => ({ kind: 'PAYMENT' as const, date: day(row.receivedOn), recordType: 'Payment' as const, recordId: row.id, reference: row.externalRef, docType: null, dueDate: null, amount: row.amount })),
    ...refunds.filter((row) => row.currency === currency && row.paidOn).map((row) => ({ kind: 'REFUND' as const, date: day(row.paidOn!), recordType: 'Refund' as const, recordId: row.id, reference: row.externalRef, docType: null, dueDate: null, amount: row.amount })),
  ].filter((movement) => movement.amount > 0)
  const statement = statementOf(movements, from, to)
  const openItems = (await openInvoices(db, { companyId: scope.companyId, partyId: scope.partyId, asOf: to })).filter((invoice) => invoice.currency === currency)
  const ageing = openItems.reduce((totals, invoice) => addToAgeing(totals, invoice.instalments, to), emptyAgeing())
  const remindersSent = await db.paymentReminder.count({ where: { companyId: scope.companyId, partyId: scope.partyId, status: 'SENT' } })
  const vat = identity?.vatNumber ? (/^[A-Z]{2}/.test(identity.vatNumber) ? identity.vatNumber : `${identity.country}${identity.vatNumber}`) : null
  return {
    company,
    customer: { id: party.id, code: party.code, legalName: party.legalName, language: party.language, vatNumber: vat, address },
    currency,
    currencies: currencies.filter((entry) => entry !== currency),
    statement,
    openItems,
    ageing,
    remindersSent,
    recipients: await invoiceContactsOf(db, scope.partyId),
  }
}

function statementView(data: StatementData, language: 'it' | 'en') {
  const { statement } = data
  return {
    company: { id: data.company.id, code: data.company.code, name: data.company.legalName },
    customer: { id: data.customer.id, code: data.customer.code, name: data.customer.legalName, language: data.customer.language },
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
      return {
        invoiceId: invoice.id,
        number: invoice.number,
        docType: invoice.docType,
        issueDate: invoice.issueDate,
        dueDate,
        dueDateKnown: invoice.dueDateKnown,
        open: asMoney('price', invoice.instalments.reduce((sum, entry) => sum + entry.open, 0)),
        bucket: bucketOf(dueDate, statement.to),
        daysLate: Math.max(0, daysBetween(dueDate, statement.to)),
      }
    }),
    ageing: asMoney('price', { open: data.ageing.open, overdue: data.ageing.overdue, buckets: { ...data.ageing.buckets } }),
    remindersSent: data.remindersSent,
    recipients: [...data.recipients],
  }
}

/** GET /receivables/customers/:partyId/statement (receivables.view). */
export async function getStatement(caller: CommandCaller, partyId: string, query: StatementQuery) {
  const context = officeContextOf(caller)
  const scope = { companyId: query.companyId, partyId }
  assertMay(context, RECEIVABLES_VIEW, RECEIVABLES_VIEW, scope)
  const data = await caller.withClient((db) => statementData(db, scope, query))
  return statementView(data, query.language ?? reminderLanguageOf(data.customer.language))
}

async function statementPdfOf(caller: CommandCaller, data: StatementData, language: 'it' | 'en', note?: string | null) {
  const company = await companyLegalOf(caller, data.company.id)
  const composed = statementDocument({
    language,
    company,
    customer: { name: data.customer.legalName, code: data.customer.code, address: addressOf(data.customer.address), vatNumber: data.customer.vatNumber },
    currency: data.currency,
    statement: data.statement,
    open: data.ageing,
    printedOn: today(),
    note: note ?? null,
  })
  const pdf = await renderDocumentPdf(composed)
  return { pdf, fileName: `${composed.meta.title.replace(/[\\/]/g, '-')}.pdf` }
}

/** GET /receivables/customers/:partyId/statement/pdf (receivables.view + the price grain): inline, stored nowhere. */
export async function statementPdf(caller: CommandCaller, partyId: string, query: StatementQuery) {
  const context = officeContextOf(caller)
  const scope = { companyId: query.companyId, partyId }
  assertMay(context, RECEIVABLES_VIEW, RECEIVABLES_VIEW, scope)
  if (!holdsPrice(context)) throw new ForbiddenError('A statement shows invoice amounts: printing it needs the price grain.')
  const data = await caller.withClient((db) => statementData(db, scope, query))
  return statementPdfOf(caller, data, query.language ?? reminderLanguageOf(data.customer.language))
}

/** POST /receivables/customers/:partyId/statement/send (receivables.statements.send): stored on the customer, e-mailed. */
export async function sendStatement(caller: CommandCaller, partyId: string, body: SendStatementBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const scope = { companyId: body.companyId, partyId }
  assertMay(context, RECEIVABLES_VIEW, RECEIVABLES_STATEMENTS_SEND, scope)
  if (!holdsPrice(context)) throw new ForbiddenError('A statement shows invoice amounts: sending it needs the price grain.')
  const data = await caller.withClient((db) => statementData(db, scope, body))
  const recipients = body.recipients ?? data.recipients.map((contact) => contact.email)
  if (recipients.length === 0) throw new InvalidStateError('Add an active contact of the customer who receives invoices (role Invoices) with an e-mail address, or name the recipients.')
  const language = body.language ?? reminderLanguageOf(data.customer.language)
  const { pdf, fileName } = await statementPdfOf(caller, data, language, body.message)
  const prepared = await putGeneratedFile(processFiles(), caller, {
    companyId: scope.companyId,
    recordType: 'Party',
    recordId: partyId,
    kind: 'DOCUMENT',
    originalName: fileName,
    contentType: 'application/pdf',
    body: pdf,
    visibility: ['OFFICE', 'PARTNER'],
    partyId,
  })
  const { result } = await receivablesCommand(caller, { name: 'receivables.sendStatement', idempotencyKey, input: { partyId, ...body } }, async (tools) => {
    const file = await recordGeneratedFile(tools, prepared, { action: 'receivables.statement', details: { layout: 'STATEMENT/1', from: data.statement.from, to: data.statement.to, currency: data.currency, language } })
    const identity = await tools.tx.emailIdentity.findFirst({ where: { companyId: scope.companyId, kind: 'CONVERSATION', isDefault: true, status: 'ACTIVE' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true } })
    const subject = language === 'it' ? `Estratto conto al ${data.statement.to.split('-').reverse().join('/')} - ${data.company.legalName}` : `Statement of account at ${data.statement.to} - ${data.company.legalName}`
    const text = [
      language === 'it' ? `Gentile ${data.customer.legalName},` : `Dear ${data.customer.legalName},`,
      '',
      language === 'it' ? "le inviamo in allegato l'estratto conto del periodo indicato." : 'please find attached your statement of account for the period.',
      ...(body.message ? ['', body.message] : []),
      '',
      language === 'it' ? 'Cordiali saluti,' : 'Kind regards,',
      data.company.legalName,
    ].join('\n')
    const sent = await sendEmail(tools, { record: { type: 'Party', id: partyId }, sender: await senderOf(tools.tx, context), to: recipients, subject, body: text, attachments: [file.id], identityId: identity?.id ?? null, locale: language })
    tools.audit({ action: 'receivables.sendStatement', recordType: 'Party', recordId: partyId, companyId: scope.companyId, after: { fileId: file.id, outboundId: sent.outbound.id, from: data.statement.from, to: data.statement.to, currency: data.currency, recipients: recipients.length } })
    tools.emit({ type: 'customer_statement.sent', subject: partyId, companyId: scope.companyId, payload: { partyId, fileId: file.id, outboundId: sent.outbound.id, from: data.statement.from, to: data.statement.to } })
    return { fileId: file.id, emailId: sent.outbound.id, to: [...recipients], from: data.statement.from, until: data.statement.to }
  })
  return result
}

