import type { FastifyRequest } from 'fastify'
import { DomainError, type Issue } from '@nexus/factory-domain/core/errors'
import { composeDocument } from '@nexus/factory-domain/documents/compose'
import { legalProblems } from '@nexus/factory-domain/documents/legal'
import { quoteDocument } from '@nexus/factory-domain/sales/quotes/document'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { companyLegalOf, documentFileName } from '../../../platform/documents/documents'
import { renderDocumentPdf } from '../../../platform/documents/pdf'
import { readSendFacts } from './send'
import { officeQuote, readCurrentVersion } from './store'

/**
 * The quote's PDF before it is sent (B-W1-24 part 2; the design's Send dialog "PDF preview of the version that will be
 * frozen" and the Documents tab's draft preview; GAP-008): the current version as the customer would get it today —
 * the same CustomerQuote, layout and letterhead as the send (send.ts), in the language asked — with the "sample"
 * banner, rendered in memory and stored nowhere. quotes.view over the quote's company and customer; the PDF carries the
 * customer's prices only (never a cost or margin: the customer's document has none).
 *
 * It needs what the document prints: the bill-to and ship-to addresses and the validity; without them a 409 says which
 * is missing, in the send's words. A version already sent has its frozen PDF (GET …/versions): this shows the CURRENT
 * version, which is the sent one until a new version is made.
 */

/** The PDF shown in the page (a new tab opens it too): inline, with the document's own file name. */
export function inlineDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `inline; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

const PREVIEW_NEEDS = new Set(['NO_BILL_TO', 'NO_SHIP_TO', 'NO_VALIDITY', 'BILL_TO_INCOMPLETE', 'SHIP_TO_INCOMPLETE', 'COMPANY_LEGAL'])

export async function previewQuotePdf(request: FastifyRequest, quoteId: string, language: 'it' | 'en' | undefined): Promise<{ pdf: Buffer; fileName: string }> {
  const caller: CommandCaller = request
  const quote = await officeQuote(caller, quoteId)
  const now = serverClock.now()
  const company = await companyLegalOf(caller, quote.companyId)
  const companyLegal = legalProblems(company)
  const version = await caller.withClient((client) => readCurrentVersion(client, quote))
  const shown = language ?? (version.language === 'en' ? 'en' : 'it')
  const facts = await caller.withClient((client) => readSendFacts(client, quote, now, companyLegal, { language: shown }))
  const missing: Issue[] = facts.checks.checks.filter((check) => check.severity === 'BLOCKS' && PREVIEW_NEEDS.has(check.code)).map((check) => ({ path: check.path, message: check.message }))
  if (!facts.customer || companyLegal.length > 0) {
    const issues = missing.length > 0 ? missing : companyLegal.length > 0 ? [...companyLegal] : [{ path: 'quote', message: 'The quote needs its bill-to and ship-to addresses and a validity before its PDF can be made.' }]
    throw new DomainError('conflict', `The PDF cannot be made yet. ${issues.map((issue) => issue.message).join(' ')}`, issues)
  }
  const composed = composeDocument({ ...quoteDocument(facts.customer), company, sample: true })
  return { pdf: await renderDocumentPdf(composed), fileName: documentFileName(composed) }
}
