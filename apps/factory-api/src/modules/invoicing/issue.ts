import { dayWords } from '@nexus/factory-domain/accounting/periods'
import { DomainError, InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import type { IssueProblem } from '@nexus/factory-domain/invoicing/checks'
import { seriesKindsFor, type InvoiceDocType } from '@nexus/factory-domain/invoicing/invoices'
import { INVOICES_ISSUE } from '@nexus/factory-domain/invoicing/permissions'
import type { NumberKind } from '@nexus/factory-domain/numbering/kinds'
import { formatNumber } from '@nexus/factory-domain/numbering/format'
import type { Prisma } from '@nexus/factory-db'
import { command, type CommandCaller, type CommandTools } from '../../core/command'
import { serverClock } from '../../core/time'
import { allocateNumber } from '../../platform/numbering/allocate'
import type { FilesRuntime } from '../../platform/files/service'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { refundDueAfter } from '@nexus/factory-domain/invoicing/credit-note/credit-note'
import { hardLockOn } from '../accounting/period-guard'
import { lockAll, lockMoney } from '../payments/locks'
import { lockInvoicing } from './from-shipment/locks'
import { ordersOfInvoices, settleOrders } from './from-shipment/settlement'
import { creditedInvoiceOf } from './from-shipment/store'
import { reviewIssue } from './facts'
import { makeInvoiceFiles } from './invoice-files'
import { invoiceDetail, officeInvoice, readInvoice, readLines, type InvoiceDetail, type Reader } from './store'

/**
 * Issuing an invoice (B-W1-28 invoice core; A2 SCR-081 "Check and issue"; FIN-057, FIN-061, FIN-085; DPR 633/1972
 * art. 21 c.2: numbers in sequence, without a gap, never twice). Three steps, the first one atomic:
 *
 *   (a) the ISSUE command, on the Invoice (its version bump locks its row): the locks of the DDTs its lines bill
 *       (B-W1-51, from-shipment/locks.ts), the money locks of what it is about (a TD02's deposit request, a TD04's
 *       credited invoice, the TD02s it deducts; payments/locks.ts), the checks before issue
 *       again under them, the number (allocateNumber: the series row locked; a rollback consumes no number), then the
 *       number fields, the seller and buyer as issued (with the VIES proof), the party key and invoice.issued, in one
 *       transaction. The …_money_guards triggers check it all again for every login.
 *   (b) outside any transaction: the FatturaPA XML (it needs the number) and the PDF courtesy copy, put in the store;
 *   (c) the ATTACH command: the two StoredFile rows (FISCAL_ARCHIVE) and xmlFileId/pdfFileId (invoice-files.ts).
 * When (b) or (c) fails the invoice stays ISSUED with its files pending (the answer says so): POST …/files makes them,
 * and the worker's invoicing.files handler does on invoice.issued. Nothing can be sent to SDI without the XML (B-W1-50;
 * the database refuses it too).
 */

/** The series kind that numbers this type for the company: the first kind it has an ACTIVE series of. */
export async function seriesKindFor(db: Reader, companyId: string, docType: InvoiceDocType): Promise<NumberKind | null> {
  for (const kind of seriesKindsFor(docType)) {
    if (await db.numberSeries.findFirst({ where: { companyId, kind, status: 'ACTIVE' }, select: { id: true } })) return kind
  }
  return null
}

const noSeries = (docType: InvoiceDocType): IssueProblem => ({
  code: 'SERIES',
  path: 'numbering',
  message: `This company has no active ${docType === 'TD02' ? 'deposit invoice or invoice' : docType === 'TD04' ? 'credit note or invoice' : 'invoice'} number series: an admin sets it up under numbering.`,
})

/** A 409 that lists every problem (A2 SCR-081: each check with where to fix it). */
export function refusal(problems: readonly IssueProblem[]): DomainError {
  const first = problems[0]!
  return new DomainError('conflict', problems.length === 1 ? first.message : `This invoice cannot be issued yet: ${problems.length} things to fix. ${first.message}`, problems.map((problem) => ({ path: problem.path, message: problem.message })))
}

const yearOf = (date: BusinessDate): number => Number.parseInt(date.slice(0, 4), 10)
const dateValue = (date: BusinessDate): Date => new Date(`${date}T00:00:00.000Z`)

/**
 * Inside a command that holds the invoice's row (a version bump, or a draft it made): issues it, dated today in
 * Europe/Rome. Refuses (409) what the checks refuse, with every problem.
 */
export async function issueInCommand(tools: CommandTools, invoiceId: string): Promise<{ invoiceId: string; number: string; issueDate: BusinessDate }> {
  const { tx, context, now } = tools
  const invoice = await readInvoice(tx, invoiceId)
  if (!invoice) throw new NotFoundError('Invoice not found.')
  if (invoice.status !== 'DRAFT') throw new InvalidStateError(`The invoice is ${invoice.status} already, number ${invoice.number}.`)
  // The lines of a draft cannot change under its row's lock. The DDTs they bill first (B-W1-51: what other invoices bill
  // of them is read under these), then the money locks in the triggers' order (target, then the series): the sums below
  // are read under them.
  const lines = await readLines(tx, invoice.id)
  await lockInvoicing(tx, context, 'ddt', lines.flatMap((line) => (line.ddtId ? [line.ddtId] : [])))
  if (invoice.docType === 'TD02' && invoice.depositRequestId) await lockMoney(tx, context, 'deposit', invoice.depositRequestId)
  if (invoice.docType === 'TD04' && invoice.creditOfId) await lockMoney(tx, context, 'invoice', invoice.creditOfId)
  await lockAll(tx, context, 'invoice', lines.flatMap((line) => (line.depositInvoiceId ? [line.depositInvoiceId] : [])))

  const date = businessDate(now)
  const review = await reviewIssue(tx, invoice, lines, date, now)
  const kind = await seriesKindFor(tx, invoice.companyId, invoice.docType)
  // B-W2a-F1: today inside a HARD period lock of the company is a problem of the issue (409 in words, no number taken),
  // before the database's Invoice_period_lock refuses it.
  const locked = await hardLockOn(tx, context, [{ companyId: invoice.companyId, day: date, refused: `the invoice is not issued today (${dayWords(date)})`, path: 'issueDate' }])
  const problems = [...review.problems, ...(kind === null ? [noSeries(invoice.docType)] : []), ...(locked ? [{ code: 'PERIOD_LOCKED', path: 'issueDate', message: locked.words }] : [])]
  if (problems.length > 0 || kind === null || !review.seller || !review.billTo) throw refusal(problems)

  // B-W1-51: a credit note on what is paid leaves a refund due (W2b), recorded on the audit row and by invoice.refund_due.
  const credited = invoice.docType === 'TD04' && invoice.creditOfId ? await creditedInvoiceOf(tx, invoice.creditOfId, invoice.id) : null
  const refundDue = credited ? refundDueAfter(credited, invoice.grossTotal) : 0
  const number = await allocateNumber(tools, { companyId: invoice.companyId, kind }, { type: 'Invoice', id: invoice.id, date })
  await tx.invoice.update({
    where: { id: invoice.id },
    data: {
      status: 'ISSUED',
      numberSeriesId: number.seriesId,
      number: number.formatted,
      year: yearOf(number.documentDate),
      issueDate: dateValue(number.documentDate),
      issuedAt: now,
      issuedById: context.audience === 'office' ? context.actorId : null,
      seller: review.seller as unknown as Prisma.InputJsonValue,
      billTo: review.billTo as unknown as Prisma.InputJsonValue,
      partyId: invoice.buyerPartyId,
    },
    select: { id: true },
  })
  tools.audit({
    action: 'invoices.issue',
    recordType: 'Invoice',
    recordId: invoice.id,
    companyId: invoice.companyId,
    before: { status: 'DRAFT' },
    after: {
      status: 'ISSUED',
      docType: invoice.docType,
      number: number.formatted,
      issueDate: number.documentDate,
      series: `${kind}/${number.code}`,
      viesCheckId: review.party?.viesProof?.checkId ?? null,
      ...(credited ? { creditOfId: credited.id, refundDue: markMoney('price', refundDue) } : {}),
    },
  })
  tools.emit({
    type: 'invoice.issued',
    subject: invoice.id,
    companyId: invoice.companyId,
    payload: { invoiceId: invoice.id, docType: invoice.docType, number: number.formatted, issueDate: number.documentDate, partyId: invoice.buyerPartyId, depositRequestId: invoice.depositRequestId },
  })
  if (credited && refundDue > 0) tools.emit({ type: 'invoice.refund_due', subject: invoice.id, companyId: invoice.companyId, payload: { invoiceId: invoice.id, creditOfId: credited.id, partyId: invoice.buyerPartyId } })
  // B-W1-51: the orders it is about (a new invoice or a credit note unsettles a settled one), announced at the end.
  await settleOrders(tools, await ordersOfInvoices(tx, [invoice.id]))
  return { invoiceId: invoice.id, number: number.formatted, issueDate: number.documentDate }
}

/** The checks before issue now, and the number the series would give next (a preview: the number is taken at issue). */
export async function issueChecks(caller: CommandCaller, invoiceId: string): Promise<{ ready: boolean; problems: IssueProblem[]; numberPreview: string | null; issueDate: string }> {
  const invoice = await officeInvoice(caller, invoiceId)
  if (invoice.status !== 'DRAFT') throw new InvalidStateError(`The invoice is ${invoice.status}, number ${invoice.number}: it is issued.`)
  const now = serverClock.now()
  const date = businessDate(now)
  return caller.withClient(async (client) => {
    const lines = await readLines(client, invoice.id)
    const review = await reviewIssue(client, invoice, lines, date, now)
    const kind = await seriesKindFor(client, invoice.companyId, invoice.docType)
    const problems = [...review.problems, ...(kind === null ? [noSeries(invoice.docType)] : [])]
    return { ready: problems.length === 0, problems, numberPreview: kind ? await numberPreview(client, invoice.companyId, kind, date) : null, issueDate: date }
  })
}

/** The next number of the company's series of a kind for the year of `date`, read without a lock (a preview). */
export async function numberPreview(db: Reader, companyId: string, kind: NumberKind, date: BusinessDate): Promise<string | null> {
  const rows = await db.numberSeries.findMany({ where: { companyId, kind, status: 'ACTIVE' }, select: { scopeKey: true, nextValue: true, pattern: true, reset: true }, orderBy: { scopeKey: 'desc' } })
  const year = date.slice(0, 4)
  const row = rows.find((series) => series.reset === 'NEVER' || series.scopeKey === year) ?? rows[0]
  if (!row) return null
  const value = row.reset === 'YEARLY' && row.scopeKey !== year ? 1 : row.nextValue
  return formatNumber(row.pattern, { value, year: yearOf(date) })
}

export interface IssueAnswer {
  readonly invoice: InvoiceDetail
  /** The XML or the PDF is not stored yet: the worker makes them (or POST /invoicing/invoices/:id/files). */
  readonly filesPending: boolean
  readonly filesProblem: string | null
}

/** After an issue: makes the files (b + c); a failure leaves them pending and says why, the issue stands. */
export async function filesAfterIssue(files: FilesRuntime, caller: CommandCaller, invoiceId: string): Promise<{ filesPending: boolean; filesProblem: string | null }> {
  try {
    await makeInvoiceFiles(files, caller, invoiceId)
    return { filesPending: false, filesProblem: null }
  } catch (error) {
    const message = error instanceof DomainError ? error.message : 'The files could not be made now.'
    return { filesPending: true, filesProblem: `The invoice is issued; its XML and PDF are not stored yet (${message}) The system makes them shortly, or use "Make the files".` }
  }
}

/**
 * invoices.issue (step-up): issues a draft (a), then makes its files (b, c). The checks run first, without a lock, for
 * a quick 409 with every problem; the command runs them again under its locks.
 */
export async function issueInvoice(files: FilesRuntime, caller: CommandCaller, invoiceId: string, body: { version?: number | undefined }, idempotencyKey: string | undefined, stepUp: () => void): Promise<IssueAnswer> {
  const invoice = await officeInvoice(caller, invoiceId, INVOICES_ISSUE)
  stepUp()
  if (invoice.status === 'DRAFT') {
    const now = serverClock.now()
    const review = await caller.withClient(async (client) => {
      const lines = await readLines(client, invoice.id)
      const checked = await reviewIssue(client, invoice, lines, businessDate(now), now)
      const kind = await seriesKindFor(client, invoice.companyId, invoice.docType)
      return [...checked.problems, ...(kind === null ? [noSeries(invoice.docType)] : [])]
    })
    if (review.length > 0) throw refusal(review)
  }
  await command(caller, { name: 'invoices.issue', idempotencyKey, input: { invoiceId, ...body }, record: { type: 'Invoice', id: invoice.id, ...(body.version === undefined ? {} : { expectedVersion: body.version }) } }, (tools) => issueInCommand(tools, invoice.id))
  const outcome = await filesAfterIssue(files, caller, invoice.id)
  const detail = await caller.withClient(async (client) => invoiceDetail(client, (await readInvoice(client, invoice.id))!))
  return { invoice: detail, ...outcome }
}

