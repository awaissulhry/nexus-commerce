import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { fromMinorUnits } from '@nexus/factory-domain/core/money'
import { composeDocument } from '@nexus/factory-domain/documents/compose'
import { isDocumentLanguage } from '@nexus/factory-domain/documents/model'
import { fatturaPaInputOf, invoiceCopyOf } from '@nexus/factory-domain/invoicing/document'
import { buildFatturaPa } from '@nexus/factory-domain/invoicing/fatturapa/build'
import type { CommandCaller } from '../../../core/command'
import { ApiError } from '../../../core/errors'
import { companyLegalOf, documentFileName } from '../../../platform/documents/documents'
import { renderDocumentPdf } from '../../../platform/documents/pdf'
import { putGeneratedFile, type PreparedGeneratedFile } from '../../../platform/files/files'
import type { FilesRuntime } from '../../../platform/files/service'
import { issuedInvoiceOf } from '../invoice-files'

/**
 * The files of a send (B-W1-50), beside the invoicing module's makeInvoiceFiles (invoice-files.ts: the files made once,
 * at issue).
 *
 *   prepareCorrectedFiles   the variant for a REJECTED invoice: the XML and the PDF built again from the corrected rows
 *                           (same number and date; the XML's ProgressivoInvio = the new send's), put in the store
 *                           outside any transaction; the send command names them on the invoice (the …_money_guards
 *                           trigger lets a REJECTED invoice change its files) and sends that XML. The rejected XML
 *                           stays a StoredFile of the invoice and of its send (FISCAL_ARCHIVE: kept ten years).
 *   readXml                 the bytes of a stored XML (files.read through the gateway), for a send of the XML as issued.
 */

/** Large enough for any FatturaPA of 500 lines; SDI takes at most 5 MB per file. */
const MAX_XML_BYTES = 5 * 1024 * 1024

export interface PreparedSendFiles {
  readonly xml: PreparedGeneratedFile
  readonly pdf: PreparedGeneratedFile
  readonly xmlText: string
  /** The XML's SDI file name (its ProgressivoInvio). */
  readonly fileName: string
}

/** Builds and puts the corrected XML (with `progressive`) and PDF of a rejected invoice; nothing is written to the database. */
export async function prepareCorrectedFiles(runtime: FilesRuntime, caller: CommandCaller, invoiceId: string, progressive: string): Promise<PreparedSendFiles> {
  const found = await caller.withClient((client) => issuedInvoiceOf(client, invoiceId))
  if (!found) throw new NotFoundError('Invoice not found.')
  const { issued, companyId } = found
  const doc = buildFatturaPa({ ...fatturaPaInputOf(issued), transmission: { progressive } })
  if (doc.totals.total.toFixed(2) !== fromMinorUnits(issued.grossTotal, issued.currency).toFixed(2)) {
    throw new ApiError('internal_error', `The corrected XML of invoice ${issued.number} does not total what the invoice says; it is not sent.`)
  }
  const language = isDocumentLanguage(found.language) ? found.language : 'it'
  const composed = composeDocument({ ...invoiceCopyOf(issued, language), company: await companyLegalOf(caller, companyId), sample: false })
  const base = { companyId, recordType: 'Invoice', recordId: issued.id, kind: 'FISCAL_ARCHIVE' as const }
  const xml = await putGeneratedFile(runtime, caller, { ...base, originalName: doc.fileName, contentType: 'application/xml', body: Buffer.from(doc.xml, 'utf8') })
  const pdf = await putGeneratedFile(runtime, caller, { ...base, originalName: documentFileName(composed), contentType: 'application/pdf', body: await renderDocumentPdf(composed) })
  return { xml, pdf, xmlText: doc.xml, fileName: doc.fileName }
}

/** The bytes of a stored XML file of the invoice, as UTF-8 text; null when the store has no object for it. */
export async function readXml(runtime: FilesRuntime, caller: CommandCaller, fileId: string): Promise<string | null> {
  const file = await caller.withClient((client) => client.storedFile.findUnique({ where: { id: fileId }, select: { storeAccountId: true, storageKey: true, status: true } }))
  if (!file || file.status !== 'AVAILABLE') return null
  const bytes = await runtime.storage.read(caller, file.storeAccountId, file.storageKey, MAX_XML_BYTES)
  return bytes === null ? null : bytes.toString('utf8')
}
