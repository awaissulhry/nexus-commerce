import { z } from 'zod'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { PURCHASE_ORDER_STATUSES } from '@nexus/factory-domain/purchasing/orders'
import type { SampleLineKind } from '@nexus/factory-domain/purchasing/sample-orders/rules'
import { SAMPLE_KINDS, SAMPLE_STAGES } from '@nexus/factory-domain/sales/samples/rules'
import type { ApiClient } from '../../../lib/api/client'

/**
 * Every call of Purchasing › Sourcing & claims › RFQs & sourcing (SCR-222; B-W2b-347 on the API of the same step, apps/factory-api
 * modules/purchasing/sample-orders): the sample and development orders, what New sample order offers, the draft it makes, and
 * the sample order PDF's address (a new tab, the browser's own GET through this app's /api). Each answer's shape is checked (zod
 * mirrors of the API's contracts; unknown fields are dropped). The value is the cost grain: absent for a person without it (the
 * column is then not drawn, never a "—"). The API's English is never shown: the screen says its own words from the codes.
 */

const seg = (value: string) => encodeURIComponent(value)
const ref = z.object({ id: z.string(), code: z.string(), name: z.string() })
const uom = z.enum(UOMS)

export const roundSchema = z.object({ id: z.string(), number: z.string(), kind: z.enum(SAMPLE_KINDS), roundNo: z.number(), stage: z.enum(SAMPLE_STAGES) })
export type RoundRef = z.infer<typeof roundSchema>

export const sampleRowSchema = z.object({
  id: z.string(),
  number: z.string(),
  companyId: z.string(),
  siteId: z.string(),
  partyId: z.string(),
  supplierName: z.string(),
  status: z.enum(PURCHASE_ORDER_STATUSES),
  revision: z.number(),
  currency: z.string(),
  orderDate: z.string(),
  requestedDate: z.string().nullable(),
  style: ref.nullable(),
  round: roundSchema.nullable(),
  items: z.array(z.object({ code: z.string(), name: z.string(), kind: z.string(), description: z.string().nullable() })),
  lineCount: z.number(),
  /** The cost grain: absent without it. */
  netAmount: z.number().optional(),
  sentAt: z.string().nullable(),
  updatedAt: z.string(),
  version: z.number(),
})
export type SampleRow = z.infer<typeof sampleRowSchema>

const listAnswer = z.object({ orders: z.array(sampleRowSchema), nextCursor: z.string().nullable(), readAt: z.string() })
export type ListAnswer = z.infer<typeof listAnswer>

export interface ListQuery {
  /** The page's company (`/w/<company>`): its sample orders only. */
  readonly companyId: string | null
  readonly rows: 'OPEN' | 'ALL'
  readonly status: string | null
  readonly q: string
  readonly cursor?: string | null
}

/** GET /purchasing/sample-orders: the sample orders this person reaches, newest first (pages of 50). */
export const listSampleOrders = (api: ApiClient, query: ListQuery) =>
  api.get('/purchasing/sample-orders', {
    query: { ...(query.companyId ? { companyId: query.companyId } : {}), rows: query.rows, ...(query.status ? { status: query.status } : {}), ...(query.q.trim() ? { q: query.q.trim() } : {}), ...(query.cursor ? { cursor: query.cursor } : {}), limit: 50 },
    schema: listAnswer,
  })

const materialSchema = z.object({ id: z.string(), code: z.string(), name: z.string(), kind: z.string(), baseUom: uom, purchaseUom: uom, units: z.array(uom), colours: z.array(ref) })
export type MaterialChoice = z.infer<typeof materialSchema>

export const choicesSchema = z.object({
  sites: z.array(ref),
  defaultSiteId: z.string().nullable(),
  suppliers: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), currency: z.string(), language: z.string() })),
  styles: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), lifecycle: z.string(), rounds: z.array(roundSchema) })),
  materials: z.array(materialSchema),
  complete: z.boolean(),
})
export type Choices = z.infer<typeof choicesSchema>

/** GET /purchasing/sample-orders/choices: what the dialog offers for the company (purchasing.manage). */
export const readChoices = (api: ApiClient, companyId: string) => api.get('/purchasing/sample-orders/choices', { query: { companyId }, schema: choicesSchema })

export interface CreateBody {
  readonly companyId: string
  readonly siteId: string
  readonly partyId: string
  readonly developmentStyleId: string
  readonly sampleRoundId: string | null
  readonly requestedDate: string | null
  readonly note: string | null
  readonly lines: readonly { what: SampleLineKind; itemId: string; itemColourId: string | null; quantity: string; uom: string; needDate: string; description: string | null }[]
}

/** POST /purchasing/sample-orders: the draft (kind SAMPLE) with its lines, in one call. */
export const createSampleOrder = async (api: ApiClient, body: CreateBody, idempotencyKey: string) =>
  (await api.post('/purchasing/sample-orders', { body, schema: z.object({ order: sampleRowSchema }), idempotencyKey })).order

/** The sample order PDF for a new tab: the draft as the supplier would get it, or the PDF as sent (the cost grain). */
export const pdfHref = (id: string): string => `/api/purchasing/sample-orders/${seg(id)}/pdf`

/** The PO record a row opens (W1's, which says it is a sample order). */
export const recordHref = (prefix: string, id: string): string => `${prefix}/purchasing/orders/${seg(id)}`
