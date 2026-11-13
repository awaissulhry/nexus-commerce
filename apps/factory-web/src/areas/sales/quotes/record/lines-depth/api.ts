import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../../../lib/api/client'
import { quoteSchema, type QuoteDetail } from '../../api'

/**
 * The quote record's W2b reads and writes (B-W2b-316 on B-W2b-294's and B-W2b-302's API), through the ONE client. Every
 * answer is checked against its shape; a money field a grain does not reach is absent (never 0). Every write sends the
 * quote's `version` as read and an Idempotency-Key; paste, fill and bulk sizes are asked with `preview: true` first (the
 * review), then the same body without it. The API's English (`words`, `message`, `leftOut[].message`) is never shown:
 * the screens say their own words from codes and facts (model.ts).
 */

const enc = encodeURIComponent
const quotePath = (id: string) => `/sales/quotes/${enc(id)}`

// ---- Warnings (GET /sales/quotes/:quoteId/warnings) ----------------------------------------------------------------------

export const WARNING_SEVERITIES = ['BLOCKS', 'WARNING', 'INFO'] as const
export type WarningSeverity = (typeof WARNING_SEVERITIES)[number]

const warningSchema = z.object({
  code: z.string(),
  severity: z.enum(WARNING_SEVERITIES),
  source: z.enum(['LINE_RULE', 'QUOTE']),
  check: z.string().nullable(),
  message: z.string(),
  lineIds: z.array(z.string()),
  seqs: z.array(z.number()),
  open: z.object({ recordType: z.string(), recordId: z.string(), tab: z.string().nullable() }).nullable(),
  details: z.record(z.string(), z.unknown()).nullable().optional(),
})
export type QuoteWarning = z.infer<typeof warningSchema>
const warningsSchema = z.object({
  quoteId: z.string(),
  versionId: z.string(),
  revision: z.number(),
  counts: z.object({ blocks: z.number(), warnings: z.number(), info: z.number() }),
  warnings: z.array(warningSchema),
})
export type QuoteWarnings = z.infer<typeof warningsSchema>

export function readWarnings(api: ApiClient, quoteId: string, signal?: AbortSignal): Promise<QuoteWarnings> {
  return api.get(`${quotePath(quoteId)}/warnings`, { schema: warningsSchema, signal })
}

// ---- the delivery schedule of a line (GET/PUT …/terms, PUT …/lines/:lineId/deliveries) ----------------------------------

const deliverySchema = z.object({ id: z.string(), deliveryDate: z.string(), sizes: z.record(z.string(), z.number()).nullable(), quantity: z.number(), note: z.string().nullable() })
export type LineDelivery = z.infer<typeof deliverySchema>
const lineScheduleSchema = z.object({
  lineId: z.string(),
  seq: z.number(),
  kind: z.string(),
  label: z.string(),
  quantity: z.number(),
  deliveries: z.array(deliverySchema),
  atPromiseDate: z.record(z.string(), z.number()),
})
export type LineSchedule = z.infer<typeof lineScheduleSchema>

export const termsSchema = z.object({
  quoteId: z.string(),
  versionId: z.string(),
  revision: z.number(),
  status: z.string(),
  editable: z.boolean(),
  language: z.enum(['it', 'en']),
  incoterm: z.string().nullable(),
  incotermPlace: z.string().nullable(),
  shipComplete: z.boolean(),
  acceptanceMode: z.enum(['SIGN', 'PAY', 'SIGN_AND_PAY']),
  depositPct: z.string().nullable(),
  promiseDate: z.string().nullable(),
  customerIncoterm: z.string().nullable(),
  validity: z.object({
    validUntil: z.string().nullable(),
    firmOffer: z.boolean(),
    state: z.enum(['NOT_SENT', 'OPEN', 'ENDS_SOON', 'LAST_DAY', 'ENDED', 'EXPIRED', 'CLOSED']),
    daysLeft: z.number().nullable(),
    reminderOn: z.string().nullable(),
    reminderSentAt: z.string().nullable(),
    expiredAt: z.string().nullable(),
    /** B-W2b-F38: the quote reminder switch of the quote's company (Sales settings; off: no reminder goes). */
    remindersEnabled: z.boolean(),
  }),
  lines: z.array(lineScheduleSchema),
  quoteVersion: z.number(),
  incoterms: z.array(z.object({ code: z.string(), seaOnly: z.boolean() })),
})
export type QuoteTerms = z.infer<typeof termsSchema>

export function readTerms(api: ApiClient, quoteId: string, signal?: AbortSignal): Promise<QuoteTerms> {
  return api.get(`${quotePath(quoteId)}/terms`, { schema: termsSchema, signal })
}

export interface DeliveryInput {
  deliveryDate: string
  sizes?: Record<string, number> | null
  note?: string | null
}

/** A line's whole schedule (none: every piece at the promise date); answers the terms with the quote's new version. */
export function saveDeliveries(api: ApiClient, quote: Pick<QuoteDetail, 'id' | 'version'>, lineId: string, deliveries: readonly DeliveryInput[]): Promise<QuoteTerms> {
  return api.request('PUT', `${quotePath(quote.id)}/lines/${enc(lineId)}/deliveries`, { body: { version: quote.version, deliveries }, schema: termsSchema, idempotencyKey: newIdempotencyKey() })
}

// ---- bulk sizes and fill by a curve (POST …/lines/sizes, …/lines/fill) -------------------------------------------------

const pieces = z.record(z.string(), z.number())
const problemSchema = z.object({ code: z.enum(['GRID', 'SCHEDULE', 'EMPTY', 'LINE']), path: z.string(), message: z.string() })
export type BulkProblem = z.infer<typeof problemSchema>
const lineResultSchema = z.object({
  lineId: z.string(),
  seq: z.number(),
  label: z.string(),
  before: pieces,
  after: pieces,
  moves: z.array(z.object({ size: z.string(), from: z.number(), to: z.number() })),
  pieces: z.object({ before: z.number(), after: z.number() }),
  problems: z.array(problemSchema),
})
export type LineResult = z.infer<typeof lineResultSchema>

export const SIZE_CHANGE_KINDS = ['PERCENT', 'DELTA', 'SET', 'FILL_EMPTY'] as const
export type SizeChangeKind = (typeof SIZE_CHANGE_KINDS)[number]

const sizesAnswerSchema = z.object({
  preview: z.boolean(),
  lines: z.array(lineResultSchema),
  counts: z.object({ lines: z.number(), changing: z.number(), unchanged: z.number(), problems: z.number() }),
  quote: quoteSchema.optional(),
})
export type SizesAnswer = z.infer<typeof sizesAnswerSchema>

export interface SizesBody {
  lineIds: string[]
  change: { kind: SizeChangeKind; pct?: string | null; pieces?: number | null }
  sizes?: string[]
}

export function changeSizes(api: ApiClient, quote: Pick<QuoteDetail, 'id' | 'version'>, body: SizesBody, preview: boolean, idempotencyKey?: string): Promise<SizesAnswer> {
  return api.post(`${quotePath(quote.id)}/lines/sizes`, { body: { version: quote.version, ...body, preview }, schema: sizesAnswerSchema, ...(preview ? {} : { idempotencyKey: idempotencyKey ?? newIdempotencyKey() }) })
}

const fillAnswerSchema = z.object({
  preview: z.boolean(),
  source: z.object({ kind: z.enum(['CURVE', 'PREPACK']), id: z.string(), name: z.string() }),
  lines: z.array(lineResultSchema.extend({ fill: z.object({ leftOut: z.array(z.string()), remainder: z.object({ size: z.string(), pieces: z.number() }).nullable() }).nullable() })),
  counts: z.object({ lines: z.number(), changing: z.number(), problems: z.number() }),
  quote: quoteSchema.optional(),
})
export type FillAnswer = z.infer<typeof fillAnswerSchema>

export function fillLines(api: ApiClient, quote: Pick<QuoteDetail, 'id' | 'version'>, body: { curveId: string; lines: Array<{ lineId: string; pieces: number }> }, preview: boolean, idempotencyKey?: string): Promise<FillAnswer> {
  return api.post(`${quotePath(quote.id)}/lines/fill`, { body: { version: quote.version, ...body, preview }, schema: fillAnswerSchema, ...(preview ? {} : { idempotencyKey: idempotencyKey ?? newIdempotencyKey() }) })
}

// ---- size curves (GET /sales/size-curves) ------------------------------------------------------------------------------

export const curveSchema = z.object({
  id: z.string(),
  companyId: z.string().nullable(),
  company: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
  sizeScale: z.object({ id: z.string(), code: z.string(), name: z.string(), sizes: z.array(z.string()) }),
  name: z.string(),
  shares: z.record(z.string(), z.string()),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  version: z.number(),
  updatedAt: z.string(),
})
export type SizeCurve = z.infer<typeof curveSchema>

export async function listCurves(api: ApiClient, query: { companyId?: string | null; sizeScaleId?: string | null; status?: 'ACTIVE' | 'ARCHIVED' | 'ALL' }, signal?: AbortSignal): Promise<SizeCurve[]> {
  return (await api.get('/sales/size-curves', { query: { companyId: query.companyId ?? undefined, sizeScaleId: query.sizeScaleId ?? undefined, status: query.status ?? 'ACTIVE' }, schema: z.object({ curves: z.array(curveSchema) }), signal })).curves
}

/** A style's size scale and base size (the curve picker reads only that scale's curves). */
export async function styleScaleOf(api: ApiClient, styleId: string, signal?: AbortSignal): Promise<{ id: string; code: string; baseSize: string | null }> {
  const answer = await api.get(`/product/styles/${enc(styleId)}`, { schema: z.object({ style: z.object({ sizeScale: z.object({ id: z.string(), code: z.string() }), baseSize: z.string().nullable() }) }), signal })
  return { id: answer.style.sizeScale.id, code: answer.style.sizeScale.code, baseSize: answer.style.baseSize }
}
