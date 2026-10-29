import { z } from 'zod'
import { DOCUMENT_KINDS, NUMBER_RESETS } from '@nexus/factory-domain/numbering/kinds'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'

/**
 * Documents & numbering's calls (B-W0-28, SCR-014): the number series (platform/numbering: list, create, a new start,
 * move past a number, close, and the numbers a series issued with its gap proof) and the address of a company's sample
 * document (platform/documents `GET /documents/sample`, a PDF opened in a new tab: a GET needs no CSRF and the company
 * is in the query). Each JSON answer is checked against its shape. Mirrors apps/factory-api numbering/contract.ts.
 */

export const SERIES_STATUSES = ['ACTIVE', 'CLOSED'] as const
export type SeriesStatus = (typeof SERIES_STATUSES)[number]
/** A series numbers a document (the scan-id kinds have no series: platform/numbering contract.ts). */
export type NumberKind = (typeof DOCUMENT_KINDS)[number]
export type NumberReset = (typeof NUMBER_RESETS)[number]

export const seriesSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  kind: z.enum(DOCUMENT_KINDS),
  code: z.string(),
  scopeKey: z.string(),
  year: z.number().nullable(),
  reset: z.enum(NUMBER_RESETS),
  pattern: z.string(),
  fiscal: z.boolean(),
  startValue: z.number(),
  nextValue: z.number(),
  nextNumber: z.string().nullable(),
  lastIssuedDate: z.string().nullable(),
  status: z.enum(SERIES_STATUSES),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Series = z.infer<typeof seriesSchema>

export const allocationSchema = z.object({
  value: z.number(),
  formatted: z.string(),
  documentDate: z.string(),
  recordType: z.string(),
  recordId: z.string(),
  allocatedAt: z.string(),
  allocatedByName: z.string().nullable(),
})
export type Allocation = z.infer<typeof allocationSchema>

export const proofSchema = z.object({
  count: z.number(),
  first: z.number().nullable(),
  last: z.number().nullable(),
  firstFormatted: z.string().nullable(),
  lastFormatted: z.string().nullable(),
  lastDocumentDate: z.string().nullable(),
  skipped: z.array(z.object({ from: z.number(), to: z.number() })),
  moreSkipped: z.boolean(),
})
export type SeriesProof = z.infer<typeof proofSchema>

const one = z.object({ series: seriesSchema })
const allocationsAnswer = z.object({ series: seriesSchema, summary: proofSchema, allocations: z.array(allocationSchema) })
export type AllocationsAnswer = z.infer<typeof allocationsAnswer>

const path = (seriesId: string, rest = '') => `/numbering/series/${encodeURIComponent(seriesId)}${rest}`

export const listSeries = (api: ApiClient, companyId?: string) =>
  api.get('/numbering/series', { query: { companyId }, schema: z.object({ series: z.array(seriesSchema) }) }).then((answer) => answer.series)

export interface NewSeriesBody {
  companyId: string
  kind: NumberKind
  code?: string
  reset?: NumberReset
  year?: number
  pattern?: string
  startValue?: number
}
export const createSeries = (api: ApiClient, body: NewSeriesBody, idempotencyKey: string = newIdempotencyKey()) =>
  api.post('/numbering/series', { body, idempotencyKey, schema: one }).then((answer) => answer.series)

export const setSeriesStart = (api: ApiClient, seriesId: string, body: { startValue: number; version: number }) =>
  api.request('PUT', path(seriesId, '/start'), { body, schema: one }).then((answer) => answer.series)

export const advanceSeries = (api: ApiClient, seriesId: string, body: { pastValue: number; reason: string; lastIssuedDate?: string; version: number }) =>
  api.post(path(seriesId, '/advance'), { body, schema: one }).then((answer) => answer.series)

export const closeSeries = (api: ApiClient, seriesId: string, body: { version: number; reason?: string }) =>
  api.post(path(seriesId, '/close'), { body, schema: one }).then((answer) => answer.series)

export const seriesAllocations = (api: ApiClient, seriesId: string, limit = 50) => api.get(path(seriesId, '/allocations'), { query: { limit }, schema: allocationsAnswer })

/** platform/documents DOCUMENT_TYPES and DOCUMENT_LANGUAGES (the fixed layouts and their languages). */
export const DOCUMENT_TYPES = ['QUOTE', 'PURCHASE_ORDER', 'DDT', 'INVOICE_COPY', 'PACKING_LIST'] as const
export type DocumentType = (typeof DOCUMENT_TYPES)[number]
export const DOCUMENT_LANGUAGES = ['it', 'en'] as const
export type DocumentLanguage = (typeof DOCUMENT_LANGUAGES)[number]

/** The address of a company's sample document (a PDF; the browser opens it through this app's `/api`). */
export const sampleHref = (companyId: string, type: DocumentType, language: DocumentLanguage) =>
  `/api/documents/sample?${new URLSearchParams({ companyId, type, language }).toString()}`
