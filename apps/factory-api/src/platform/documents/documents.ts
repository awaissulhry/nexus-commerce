import { z } from 'zod'
import { DOCUMENTS_VIEW } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, type Clock } from '@nexus/factory-domain/core/time'
import { composeDocument, type ComposedDocument } from '@nexus/factory-domain/documents/compose'
import type { CompanyLegal, DocumentInput, DocumentLanguage, DocumentType } from '@nexus/factory-domain/documents/model'
import { sampleDocument } from '@nexus/factory-domain/documents/sample'
import type { CommandCaller } from '../../core/command'
import { actorOf } from '../../core/context'
import { ApiError } from '../../core/errors'
import type { FileView } from '../files/contract'
import { storeGeneratedFile } from '../files/files'
import type { FileAudience } from '../files/rules'
import type { FilesRuntime } from '../files/service'
import { renderDocumentPdf } from './pdf'

/**
 * Company documents as PDF (plan A1 §3.9; GAP-008): the issuing modules' way to print a quote, a purchase order, a DDT
 * or an invoice copy, and the letterhead preview.
 *
 *   storeDocumentPdf   the module's frozen document + the company's legal data, READ FROM ITS COMPANY ROW (never from a
 *                      request) → composeDocument (factory-domain: refuses an incomplete document) → the A4 PDF →
 *                      stored as a StoredFile of the record: DOCUMENT (quote, PO), or FISCAL_ARCHIVE kept ten years for
 *                      the DDT and the invoice copy (files' retention), in one command `documents.render`
 *   samplePdf          the same layouts with a made-up party and lines and a "sample" banner, never stored
 *
 * The issuing module calls storeDocumentPdf from its own flow, after its own permission check (quotes.send, ddt.issue,
 * invoices.issue), with an office caller or its job's system caller; documents.view only guards the preview.
 */

/** Documents kept in the fiscal archive (PLAN §2.8: DDTs and invoice copies; c.c. art. 2220). */
const FISCAL_TYPES: readonly DocumentType[] = ['DDT', 'INVOICE_COPY']

const addressSchema = z.object({
  line1: z.string(),
  line2: z.string().nullish(),
  postalCode: z.string(),
  city: z.string(),
  province: z.string().nullish(),
  country: z.string(),
})

/**
 * The company's legal data for its documents (c.c. art. 2250), read in the caller's scope (row-level security keeps it
 * to the tenant). The single-shareholder and liquidation facts are not on the Company row yet: nothing is printed for
 * them until the company settings keep them.
 */
export async function companyLegalOf(caller: CommandCaller, companyId: string): Promise<CompanyLegal> {
  if (!isUuid(companyId)) throw new NotFoundError('Company not found.')
  const row = await caller.withClient((client) =>
    client.company.findUnique({
      where: { id: companyId },
      select: { legalName: true, tradeName: true, address: true, vatNumber: true, fiscalCode: true, reaOffice: true, reaNumber: true, shareCapital: true, currency: true, pec: true, documentFooter: true },
    }),
  )
  if (!row) throw new NotFoundError('Company not found.')
  const address = addressSchema.safeParse(row.address)
  return {
    legalName: row.legalName,
    tradeName: row.tradeName,
    address: address.success ? address.data : null,
    vatNumber: row.vatNumber,
    fiscalCode: row.fiscalCode,
    reaOffice: row.reaOffice,
    reaNumber: row.reaNumber,
    shareCapital: row.shareCapital === null ? null : row.shareCapital.toFixed(2),
    currency: row.currency,
    pec: row.pec,
    documentFooter: row.documentFooter,
  }
}

/** What an issuing module asks to print: its frozen document without the company, which comes from the Company row. */
export interface DocumentRequest {
  readonly companyId: string
  /** The record the PDF belongs to (`Quote`, `Ddt`, `Invoice`) and its id. */
  readonly recordType: string
  readonly recordId: string
  readonly document: Omit<DocumentInput, 'company' | 'sample'>
  /** Default office only; a DDT for the floor of a site, a quote for a customer's link… (the files module's rules). */
  readonly visibility?: readonly FileAudience[]
  readonly floorSiteId?: string | null
  readonly partyId?: string | null
  readonly idempotencyKey?: string
}

export interface StoredDocument {
  readonly file: FileView
  readonly layout: string
}

/** The file name of a document: its title and number ("Documento di trasporto (DDT) 2026-000143.pdf"). */
export const documentFileName = (composed: ComposedDocument): string => `${composed.meta.title.replace(/[\\/]/g, '-')}.pdf`

/** Renders a module's document with the company's legal data and stores the PDF for its record (see the file's comment). */
export async function storeDocumentPdf(runtime: FilesRuntime, caller: CommandCaller, request: DocumentRequest): Promise<StoredDocument> {
  const company = await companyLegalOf(caller, request.companyId)
  const composed = composeDocument({ ...request.document, company, sample: false })
  const pdf = await renderDocumentPdf(composed)
  const file = await storeGeneratedFile(
    runtime,
    caller,
    {
      companyId: request.companyId,
      recordType: request.recordType,
      recordId: request.recordId,
      kind: FISCAL_TYPES.includes(composed.type) ? 'FISCAL_ARCHIVE' : 'DOCUMENT',
      originalName: documentFileName(composed),
      contentType: 'application/pdf',
      body: pdf,
      visibility: request.visibility,
      floorSiteId: request.floorSiteId,
      partyId: request.partyId,
    },
    {
      commandName: 'documents.render',
      idempotencyKey: request.idempotencyKey,
      details: { documentType: composed.type, number: request.document.number, layout: composed.layout, language: composed.language },
    },
  )
  return { file, layout: composed.layout }
}

/** The letterhead preview: a sample of a layout with the company's real legal data (documents.view on its company). */
export async function samplePdf(caller: CommandCaller, input: { companyId: string; type: DocumentType; language: DocumentLanguage }, clock: Clock): Promise<{ pdf: Buffer; fileName: string }> {
  const context = caller.factoryContext
  if (!context) throw new ApiError('unauthenticated')
  if (!can(actorOf(context), DOCUMENTS_VIEW, { companyId: input.companyId })) throw new ForbiddenError()
  const company = await companyLegalOf(caller, input.companyId)
  const composed = composeDocument(sampleDocument(input.type, input.language, company, businessDate(clock.now())))
  return { pdf: await renderDocumentPdf(composed), fileName: `${composed.title} - ${composed.banner}.pdf` }
}
