import { InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { fromMinorUnits } from '@nexus/factory-domain/core/money'
import { composeDocument } from '@nexus/factory-domain/documents/compose'
import { isDocumentLanguage } from '@nexus/factory-domain/documents/model'
import { fatturaPaInputOf, invoiceCopyOf, type BillTo, type IssuedInvoice, type StoredLine } from '@nexus/factory-domain/invoicing/document'
import { buildFatturaPa } from '@nexus/factory-domain/invoicing/fatturapa/build'
import type { FatturaPaSeller } from '@nexus/factory-domain/invoicing/fatturapa/types'
import { INVOICES_ISSUE } from '@nexus/factory-domain/invoicing/permissions'
import { command, type CommandCaller } from '../../core/command'
import { ApiError } from '../../core/errors'
import { companyLegalOf, documentFileName } from '../../platform/documents/documents'
import { renderDocumentPdf } from '../../platform/documents/pdf'
import type { EventHandler } from '../../platform/outbox/dispatch'
import { defineHandler } from '../../platform/outbox/dispatch'
import { putGeneratedFile, recordGeneratedFile, type PreparedGeneratedFile } from '../../platform/files/files'
import { processFiles, type FilesRuntime } from '../../platform/files/service'
import { paymentTermsOf, purchaseOrdersOf, storedLineOf } from './facts'
import { invoiceDetail, officeInvoice, readInvoice, readLines, type InvoiceDetail, type Reader } from './store'

/**
 * The files of an issued invoice (B-W1-28 steps b and c; FIN-057: the XML is the invoice, the PDF a courtesy copy; DM
 * 17.6.2014 and c.c. art. 2220: kept ten years, FISCAL_ARCHIVE): built from the frozen invoice alone (its seller and
 * billTo snapshots, lines, number and date), so a retry makes the same XML. The bytes go to the store first
 * (platform/files putGeneratedFile, outside any transaction), then ONE attach command records the StoredFile rows and
 * names them on the invoice (xmlFileId, pdfFileId: each named once, the …_money_guards trigger). Idempotent: an invoice
 * that names both does nothing; two runs at once queue on the invoice's row and the second names nothing new (its
 * objects stay unnamed in the store, as for any failed generated file).
 */

/** The issued invoice as both documents print it, read from its rows. */
export async function issuedInvoiceOf(db: Reader, invoiceId: string): Promise<{ issued: IssuedInvoice; companyId: string; language: string; xmlFileId: string | null; pdfFileId: string | null } | null> {
  const invoice = await readInvoice(db, invoiceId)
  if (!invoice) return null
  if (invoice.status === 'DRAFT' || invoice.number === null || invoice.issueDate === null || invoice.seller === null) throw new InvalidStateError('The invoice is a draft: its files are made when it is issued.')
  const lines = await readLines(db, invoice.id)
  const ddtIds = [...new Set(lines.flatMap((line) => (line.ddtId ? [line.ddtId] : [])))]
  const ddts = ddtIds.length > 0 ? await db.ddt.findMany({ where: { id: { in: ddtIds } }, select: { id: true, number: true, documentDate: true }, orderBy: [{ documentDate: 'asc' }, { number: 'asc' }] }) : []
  const depositIds = [...new Set(lines.flatMap((line) => (line.depositInvoiceId ? [line.depositInvoiceId] : [])))]
  const deposits = depositIds.length > 0 ? await db.invoice.findMany({ where: { id: { in: depositIds } }, select: { id: true, number: true, issueDate: true } }) : []
  const order = invoice.salesOrderId ? await db.salesOrder.findUnique({ where: { id: invoice.salesOrderId }, select: { number: true, orderDate: true } }) : null
  const credits = invoice.creditOfId ? await db.invoice.findUnique({ where: { id: invoice.creditOfId }, select: { number: true, issueDate: true } }) : null
  const party = await db.party.findUnique({ where: { id: invoice.buyerPartyId }, select: { language: true } })
  const day = (value: Date): string => value.toISOString().slice(0, 10)
  const storedLines: StoredLine[] = lines.map((line) => {
    const ddt = ddts.find((entry) => entry.id === line.ddtId)
    const deposit = deposits.find((entry) => entry.id === line.depositInvoiceId)
    return {
      ...storedLineOf(line),
      ddtNumber: ddt?.number ?? null,
      deposit: deposit && deposit.number && deposit.issueDate ? { number: deposit.number, issueDate: day(deposit.issueDate) } : null,
    }
  })
  const issued: IssuedInvoice = {
    id: invoice.id,
    docType: invoice.docType,
    number: invoice.number,
    issueDate: day(invoice.issueDate),
    currency: invoice.currency,
    priceBasis: invoice.priceBasis,
    seller: invoice.seller as unknown as FatturaPaSeller,
    billTo: invoice.billTo as unknown as BillTo,
    lines: storedLines,
    netTotal: invoice.netTotal,
    vatTotal: invoice.vatTotal,
    grossTotal: invoice.grossTotal,
    vatSummary: invoice.vatSummary as unknown as IssuedInvoice['vatSummary'],
    stampDutyAmount: invoice.stampDutyAmount,
    causale: invoice.causale,
    purchaseOrders: purchaseOrdersOf(invoice.documentRefs),
    ddts: ddts.map((ddt) => ({ number: ddt.number, date: day(ddt.documentDate) })),
    credits: credits && credits.number && credits.issueDate ? { number: credits.number, issueDate: day(credits.issueDate) } : null,
    salesOrder: order ? { number: order.number, date: day(order.orderDate) } : null,
    paymentTerms: paymentTermsOf(invoice.paymentTerms),
  }
  return { issued, companyId: invoice.companyId, language: party?.language ?? 'it', xmlFileId: invoice.xmlFileId, pdfFileId: invoice.pdfFileId }
}

/**
 * Makes and names the issued invoice's XML and PDF when they are missing (b + c). The caller is an office session that
 * may issue it, or the worker's system context. Returns the two file ids.
 */
export async function makeInvoiceFiles(runtime: FilesRuntime, caller: CommandCaller, invoiceId: string, causationId?: string): Promise<{ xmlFileId: string; pdfFileId: string }> {
  const found = await caller.withClient((client) => issuedInvoiceOf(client, invoiceId))
  if (!found) throw new NotFoundError('Invoice not found.')
  if (found.xmlFileId && found.pdfFileId) return { xmlFileId: found.xmlFileId, pdfFileId: found.pdfFileId }
  const { issued, companyId } = found
  const doc = buildFatturaPa(fatturaPaInputOf(issued))
  if (doc.totals.total.toFixed(2) !== fromMinorUnits(issued.grossTotal, issued.currency).toFixed(2)) {
    throw new ApiError('internal_error', `The XML of invoice ${issued.number} does not total what the invoice says; its files are not made.`)
  }
  const language = isDocumentLanguage(found.language) ? found.language : 'it'
  const company = await companyLegalOf(caller, companyId)
  const composed = composeDocument({ ...invoiceCopyOf(issued, language), company, sample: false })
  const pdf = await renderDocumentPdf(composed)
  const base = { companyId, recordType: 'Invoice', recordId: issued.id, kind: 'FISCAL_ARCHIVE' as const }
  const xmlFile: PreparedGeneratedFile | null = found.xmlFileId ? null : await putGeneratedFile(runtime, caller, { ...base, originalName: doc.fileName, contentType: 'application/xml', body: Buffer.from(doc.xml, 'utf8') })
  const pdfFile: PreparedGeneratedFile | null = found.pdfFileId ? null : await putGeneratedFile(runtime, caller, { ...base, originalName: documentFileName(composed), contentType: 'application/pdf', body: pdf })
  const { result } = await command(
    caller,
    { name: 'invoices.attachFiles', input: { invoiceId, xml: xmlFile?.sha256 ?? null, pdf: pdfFile?.sha256 ?? null }, record: { type: 'Invoice', id: invoiceId }, ...(causationId ? { causationId } : {}) },
    async (tools) => {
      const current = (await readInvoice(tools.tx, invoiceId))!
      const details = { documentType: issued.docType, number: issued.number }
      const xmlFileId = current.xmlFileId ?? (xmlFile ? (await recordGeneratedFile(tools, xmlFile, { details: { ...details, file: 'FatturaPA XML' } })).id : null)
      const pdfFileId = current.pdfFileId ?? (pdfFile ? (await recordGeneratedFile(tools, pdfFile, { details: { ...details, file: 'courtesy copy', layout: composed.layout } })).id : null)
      if (!xmlFileId || !pdfFileId) throw new ApiError('internal_error', 'An invoice file was not made.')
      if (xmlFileId !== current.xmlFileId || pdfFileId !== current.pdfFileId) {
        await tools.tx.invoice.update({ where: { id: invoiceId }, data: { xmlFileId, pdfFileId }, select: { id: true } })
        tools.emit({ type: 'invoice.files_attached', subject: invoiceId, companyId, payload: { invoiceId, xmlFileId, pdfFileId } })
      }
      tools.audit({ recordType: 'Invoice', recordId: invoiceId, companyId, before: { xmlFileId: current.xmlFileId, pdfFileId: current.pdfFileId }, after: { xmlFileId, pdfFileId, fileName: doc.fileName } })
      return { xmlFileId, pdfFileId }
    },
  )
  return result
}

/** invoices.issue: makes the files of an issued invoice whose XML or PDF is missing ("Make the files"). Idempotent. */
export async function makeFilesRoute(files: FilesRuntime, caller: CommandCaller, invoiceId: string): Promise<{ invoice: InvoiceDetail }> {
  const invoice = await officeInvoice(caller, invoiceId, INVOICES_ISSUE)
  if (invoice.status === 'DRAFT') throw new InvalidStateError('The invoice is a draft: its files are made when it is issued.')
  await makeInvoiceFiles(files, caller, invoice.id)
  return { invoice: await caller.withClient(async (client) => invoiceDetail(client, (await readInvoice(client, invoice.id))!)) }
}

/**
 * The worker's invoicing.files handler: on invoice.issued, makes the files the issuing request could not (a store that
 * did not answer, a crash between the steps), as the event's tenant's system caller. Does nothing when they exist; a
 * failure throws, so the queue tries again with backoff. Listed in background.ts HANDLERS.
 */
export function invoiceFilesHandler(options: { readonly files?: () => FilesRuntime } = {}): EventHandler {
  return defineHandler({
    name: 'invoicing.files',
    events: ['invoice.issued'],
    attempts: 10,
    async handle(event, { caller }) {
      const { invoiceId } = event.payload as { invoiceId: string }
      await makeInvoiceFiles((options.files ?? processFiles)(), caller, invoiceId, event.eventId)
    },
  })
}

