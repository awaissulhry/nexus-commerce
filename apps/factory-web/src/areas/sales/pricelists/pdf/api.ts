import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'

/**
 * The price list PDF kept for mail (B-W2b-380, XF6:01; the API's modules/sales/pricelists/pdf-store.ts): the kept PDFs of a
 * version (GeneratedDocument PRICE_LIST, a file of the version), keep one, and mail the newest showing the version as it is to
 * one of the list's customers (a copy of that same file on the customer goes attached; FAKE locally). Each write has its own
 * Idempotency-Key.
 */

const enc = encodeURIComponent
const pdfPath = (listId: string, versionId: string) => `/sales/price-lists/${enc(listId)}/versions/${enc(versionId)}/pdf`

export const keptPdfSchema = z.object({
  listId: z.string(),
  versionId: z.string(),
  revision: z.number(),
  /** The newest still shows the version as it is (null: none kept). */
  upToDate: z.boolean().nullable(),
  needsCompany: z.boolean(),
  pdfs: z.array(z.object({ id: z.string(), version: z.number(), number: z.string().nullable(), language: z.string(), companyId: z.string(), fileId: z.string(), createdAt: z.string(), createdBy: z.string().nullable() })),
})
export type KeptPdfs = z.infer<typeof keptPdfSchema>
export type PdfLanguage = 'it' | 'en'

export function readKeptPdfs(api: ApiClient, listId: string, versionId: string, signal?: AbortSignal): Promise<KeptPdfs> {
  return api.get(pdfPath(listId, versionId), { schema: z.object({ pdf: keptPdfSchema }), signal }).then((answer) => answer.pdf)
}

export function keepPdf(api: ApiClient, listId: string, versionId: string, body: { language: PdfLanguage; companyId?: string | null }): Promise<{ made: boolean; version: number; fileId: string; pdf: KeptPdfs }> {
  return api.post(pdfPath(listId, versionId), { body, schema: z.object({ made: z.boolean(), version: z.number(), fileId: z.string(), pdf: keptPdfSchema }), idempotencyKey: newIdempotencyKey() })
}

export interface SendPdfBody {
  partyId: string
  to?: string[]
  cc?: string[]
  subject?: string | null
  message?: string | null
  language: PdfLanguage
}

export function sendPdf(api: ApiClient, listId: string, versionId: string, body: SendPdfBody): Promise<{ version: number; made: boolean; fileId: string; copyId: string; outboundId: string; pdf: KeptPdfs }> {
  return api.post(`${pdfPath(listId, versionId)}/send`, { body, schema: z.object({ version: z.number(), made: z.boolean(), fileId: z.string(), copyId: z.string(), outboundId: z.string(), threadId: z.string(), pdf: keptPdfSchema }), idempotencyKey: newIdempotencyKey() })
}
