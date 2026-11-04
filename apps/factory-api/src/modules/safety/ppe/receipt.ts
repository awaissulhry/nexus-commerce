import { createHash } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import { newId } from '@nexus/factory-domain/core/ids'
import { legalFooter, legalLines, legalName } from '@nexus/factory-domain/documents/legal'
import type { CompanyLegal, DocumentLanguage } from '@nexus/factory-domain/documents/model'
import { SAFETY_PPE_ISSUE } from '@nexus/factory-domain/safety/ppe/permissions'
import { ppeReceipt, receiptFingerprintText, type ReceiptInput } from '@nexus/factory-domain/safety/ppe/receipt'
import { PPE_REFUSALS, RECEIPT_STATEMENT } from '@nexus/factory-domain/safety/ppe/rules'
import { command } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { companyLegalOf } from '../../../platform/documents/documents'
import { putGeneratedFile, recordGeneratedFile, type PreparedGeneratedFile } from '../../../platform/files/files'
import type { FilesRuntime } from '../../../platform/files/service'
import { renderDiscrepancyReport } from '../../inventory/receipts/report'
import { assertMayWriteAt, officeOf, refuse } from '../organisation/access'
import { readableReceipt, signedLanguage } from './issues'
import { RECEIPT_KIND, RECORD_ISSUE, type ReceiptView } from './store'

/**
 * The PPE receipt as a PDF (B-W2b-134; QHS-261; design plant.ppe new tab "Receipt (PDF) — Per issue, signed", "Print
 * receipts"), office only:
 *
 *   GET  /safety/ppe/receipts/:receiptId/pdf?language=   made in memory, stored nowhere, with the preview banner (safety.view):
 *                                                        the person, the site, when, who handed it over, how it was signed,
 *                                                        each line with its void mark
 *   POST /safety/ppe/receipts/:receiptId/pdf {language?} keep it (safety.ppe.issue) for a receipt signed with badge and PIN (a
 *                                                        paper receipt is its own signed scan: PAPER_RECEIPT): the same
 *                                                        contents give the newest back, else the PDF goes to the store first
 *                                                        and ONE command writes its file and the GeneratedDocument
 *                                                        PPE_RECEIPT of the receipt (its first row)
 * The tablet's command keeps nothing (the floor writes no file); the receipt's legal record is its rows and their SHA-256.
 */

function contentsOf(receipt: ReceiptView, company: CompanyLegal, language: DocumentLanguage): Omit<ReceiptInput, 'createdAt' | 'sample'> {
  const signed = signedLanguage(receipt)
  return {
    language,
    company: { name: legalName(company, language), lines: legalLines(company, language), legal: legalFooter(company, language) },
    site: receipt.site,
    person: { name: receipt.employee.name, employeeCode: receipt.employee.employeeCode },
    issuedAt: receipt.issuedAt,
    handedOverBy: receipt.issuedBy.name,
    method: receipt.method,
    state: receipt.state,
    signature: receipt.signature
      ? { worker: receipt.signature.worker ?? receipt.employee.name, device: receipt.signature.device?.name ?? '-', sha256: receipt.signature.sha256, statement: RECEIPT_STATEMENT[signed ?? language] }
      : null,
    scan: receipt.scan?.name ?? null,
    lines: receipt.lines.map((line) => ({ code: line.item.code, name: line.item.name, size: line.size, quantity: line.quantity, reason: line.reason, voided: line.voided ? { at: line.voided.at, reason: line.voided.reason } : null })),
  }
}

/** GET /safety/ppe/receipts/:receiptId/pdf. */
export async function previewReceipt(request: FastifyRequest, receiptId: string, query: { readonly language?: DocumentLanguage | undefined }) {
  const context = officeOf(request)
  const receipt = await readableReceipt(request, context, receiptId)
  const company = await companyLegalOf(request, receipt.companyId)
  const document = ppeReceipt({ ...contentsOf(receipt, company, query.language ?? 'it'), createdAt: serverClock.now().toISOString(), sample: true })
  return { pdf: await renderDiscrepancyReport(document), fileName: document.fileName }
}

/** POST /safety/ppe/receipts/:receiptId/pdf. */
export async function keepReceipt(files: FilesRuntime, request: FastifyRequest, receiptId: string, options: { readonly language?: DocumentLanguage | undefined; readonly idempotencyKey?: string | undefined }) {
  const context = officeOf(request)
  const receipt = await readableReceipt(request, context, receiptId)
  assertMayWriteAt(context, SAFETY_PPE_ISSUE, receipt, 'A receipt is kept by a role that records receipts (safety.ppe.issue).')
  if (receipt.method !== 'FLOOR_PIN') refuse('PAPER_RECEIPT', PPE_REFUSALS.PAPER_RECEIPT)
  const language = options.language ?? 'it'
  const company = await companyLegalOf(request, receipt.companyId)
  const contents = contentsOf(receipt, company, language)
  const fingerprint = createHash('sha256').update(receiptFingerprintText(contents)).digest('hex')
  const kept = await request.withClient((client) => client.generatedDocument.findFirst({ where: { recordType: RECORD_ISSUE, recordId: receipt.id, kind: RECEIPT_KIND }, orderBy: { version: 'desc' }, select: { fingerprint: true, language: true } }))
  let prepared: PreparedGeneratedFile | null = null
  if (!(kept && kept.fingerprint === fingerprint && kept.language === language)) {
    const document = ppeReceipt({ ...contents, createdAt: serverClock.now().toISOString(), sample: false })
    prepared = await putGeneratedFile(files, request, {
      companyId: receipt.companyId,
      recordType: RECORD_ISSUE,
      recordId: receipt.id,
      kind: 'DOCUMENT',
      originalName: document.fileName,
      contentType: 'application/pdf',
      body: await renderDiscrepancyReport(document),
      visibility: ['OFFICE'],
    })
  }
  const { result, replayed } = await command(request, { name: 'safety.keepPpeReceipt', idempotencyKey: options.idempotencyKey, input: { receiptId: receipt.id, language } }, async (tools) => {
    const { tx, now } = tools
    const scope = { companyId: receipt.companyId, siteId: receipt.siteId }
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.ppe-receipt', ${receipt.id}::text), 0))`
    const last = await tx.generatedDocument.findFirst({ where: { recordType: RECORD_ISSUE, recordId: receipt.id, kind: RECEIPT_KIND }, orderBy: { version: 'desc' }, select: { id: true, version: true, fingerprint: true, language: true, fileId: true, createdAt: true } })
    if (last && last.fingerprint === fingerprint && last.language === language) {
      tools.audit({ action: 'safety.keepPpeReceipt', recordType: RECORD_ISSUE, recordId: receipt.id, ...scope, after: { generatedDocumentId: last.id, version: last.version, unchanged: true } })
      return { document: { id: last.id, version: last.version, language: last.language, fileId: last.fileId, createdAt: last.createdAt.toISOString() }, made: false }
    }
    if (!prepared) refuse('CHANGED', 'The receipt changed meanwhile: keep it again.')
    const fileId = (await recordGeneratedFile(tools, prepared!, { details: { documentType: RECEIPT_KIND, language } })).id
    const id = newId()
    const next = (last?.version ?? 0) + 1
    await tx.generatedDocument.create({ data: { id, ...scope, recordType: RECORD_ISSUE, recordId: receipt.id, kind: RECEIPT_KIND, version: next, fingerprint, language, number: null, fileId, createdAt: now, createdById: context.actorId }, select: { id: true } })
    tools.audit({ action: 'safety.keepPpeReceipt', recordType: RECORD_ISSUE, recordId: receipt.id, ...scope, after: { generatedDocumentId: id, version: next, language, fileId, fingerprint, sha256: receipt.signature?.sha256 ?? null } })
    return { document: { id, version: next, language, fileId, createdAt: now.toISOString() }, made: true }
  })
  return { ...result, replayed }
}
