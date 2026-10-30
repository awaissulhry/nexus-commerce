import { ConflictError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { FatturaPaReadError, readFatturaPa } from '@nexus/factory-domain/payables/fatturapa'
import type { CommandCaller } from '../../core/command'
import { processFiles } from '../../platform/files/service'
import { officeInvoice } from './store'

/**
 * The invoice as received (design finance.payables, new tab "Supplier invoice as received (XML view / PDF)": check the
 * original beside the match). The XML SDI delivered is read from the file store here (one files.read gateway call) and
 * answered whole, with what it names read from it; the XML holds the prices, so it travels with the cost grain only.
 * The PDF (the supplier's own, attached to the XML, or the typed invoice's copy) is downloaded with the files routes.
 */

const MAX_XML_BYTES = 8 * 1_048_576

export async function invoiceXml(caller: CommandCaller, invoiceId: string) {
  const { invoice } = await officeInvoice(caller, invoiceId)
  if (!invoice.xmlFileId) throw new NotFoundError(invoice.source === 'SDI' ? 'The XML of this invoice is not stored yet.' : 'A typed invoice has no XML: open its PDF.')
  const file = await caller.withClient((client) => client.storedFile.findUnique({ where: { id: invoice.xmlFileId! }, select: { id: true, originalName: true, status: true, storeAccountId: true, storageKey: true } }))
  if (!file || file.status !== 'AVAILABLE') throw new ConflictError('The XML of this invoice is not available in the file store.')
  const body = await processFiles().storage.read(caller, file.storeAccountId, file.storageKey, MAX_XML_BYTES)
  if (!body) throw new ConflictError('The XML of this invoice is missing from the file store.')
  const xml = body.toString('utf8')
  let read = null
  try {
    const parsed = readFatturaPa(xml)
    read = {
      format: parsed.format,
      supplier: { vatNumber: parsed.supplier.vatNumber, fiscalCode: parsed.supplier.fiscalCode, name: parsed.supplier.name },
      buyer: { vatNumber: parsed.buyer.vatNumber, fiscalCode: parsed.buyer.fiscalCode, name: parsed.buyer.name },
      documents: parsed.documents.map((document) => ({
        docType: document.docType,
        number: document.number,
        issueDate: document.issueDate,
        causale: [...document.causale],
        orders: document.orders.map((order) => ({ document: order.document, date: order.date, lines: [...order.lines] })),
        ddts: document.ddts.map((ddt) => ({ number: ddt.number, date: ddt.date, lines: [...ddt.lines] })),
        lines: document.lines.length,
        attachments: document.attachments.map((attachment) => attachment.name),
      })),
    }
  } catch (error) {
    if (!(error instanceof FatturaPaReadError)) throw error
  }
  return { fileName: file.originalName, fileId: file.id, xml: asMoney('cost', xml), read }
}
