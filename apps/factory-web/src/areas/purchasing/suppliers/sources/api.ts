import { z } from 'zod'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { PURCHASE_ORDER_STATUSES } from '@nexus/factory-domain/purchasing/orders'
import { SOURCE_PREFERENCES, SOURCE_STATUSES } from '@nexus/factory-domain/purchasing/sources/sources'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * Approved sources (B-W2a-10; SCM-005): every call of a supplier's Items & prices tab (SCR-057) and a material's Supplier
 * prices (SCR-048), with the answer's shape checked (zod; unknown fields are dropped). The shapes mirror apps/factory-api
 * modules/purchasing/supplier-items/contract.ts; the enum lists are factory-domain's. Prices are the cost grain: absent
 * for a person without it (the screens then draw no price column, never a "—"). Each write names the version read.
 */

const uom = z.enum(UOMS)
export type SourceUom = (typeof UOMS)[number]
export const PREFERENCES = SOURCE_PREFERENCES
export type Preference = (typeof SOURCE_PREFERENCES)[number]
export type SourceStatus = (typeof SOURCE_STATUSES)[number]

export const sourceSchema = z.object({
  id: z.string(),
  companyId: z.string().nullable(),
  company: z.object({ code: z.string(), name: z.string() }).nullable(),
  partyId: z.string(),
  supplier: z.object({ code: z.string(), name: z.string(), status: z.string() }),
  itemId: z.string(),
  item: z.object({ code: z.string(), name: z.string(), kind: z.string(), status: z.string(), baseUom: uom, purchaseUom: uom }),
  itemColourId: z.string().nullable(),
  colour: z.object({ code: z.string(), name: z.string() }).nullable(),
  supplierArticleCode: z.string().nullable(),
  supplierColourCode: z.string().nullable(),
  description: z.string().nullable(),
  purchaseUom: uom,
  purchaseFactor: z.string(),
  baseUom: uom,
  unitUsable: z.boolean(),
  unitPrice: z.string().nullable().optional(),
  currency: z.string(),
  minOrderQty: z.string().nullable(),
  orderMultiple: z.string().nullable(),
  leadTimeDays: z.number().nullable(),
  supplierLeadTimeDays: z.number().nullable(),
  preference: z.enum(SOURCE_PREFERENCES),
  status: z.enum(SOURCE_STATUSES),
  note: z.string().nullable(),
  lastPurchase: z
    .object({
      purchaseOrderId: z.string(),
      number: z.string(),
      status: z.enum(PURCHASE_ORDER_STATUSES),
      orderDate: z.string(),
      quantity: z.string(),
      uom,
      unitPrice: z.string().optional(),
      currency: z.string(),
    })
    .nullable(),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  createdById: z.string().nullable(),
})
export type Source = z.infer<typeof sourceSchema>

const oneSchema = z.object({ item: sourceSchema, demoted: z.object({ id: z.string(), partyId: z.string(), supplierName: z.string() }).nullable() })
export type SourceAnswer = z.infer<typeof oneSchema>
const listSchema = z.object({ items: z.array(sourceSchema), nextCursor: z.string().nullable() })
export type SourcePage = z.infer<typeof listSchema>

export interface SourceQuery {
  partyId?: string
  itemId?: string
  itemColourId?: string
  companyId?: string
  status?: SourceStatus | 'ALL'
  q?: string
  cursor?: string | null
  limit?: number
}

export function listSources(api: ApiClient, query: SourceQuery, signal?: AbortSignal): Promise<SourcePage> {
  return api.get('/purchasing/supplier-items', {
    query: {
      partyId: query.partyId,
      itemId: query.itemId,
      itemColourId: query.itemColourId,
      companyId: query.companyId,
      status: query.status && query.status !== 'ACTIVE' ? query.status : undefined,
      q: query.q?.trim() || undefined,
      cursor: query.cursor ?? undefined,
      limit: query.limit ?? 100,
    },
    schema: listSchema,
    signal,
  })
}

const sourceUrl = (id: string) => `/purchasing/supplier-items/${encodeURIComponent(id)}`

export async function getSource(api: ApiClient, id: string, signal?: AbortSignal): Promise<Source> {
  return (await api.get(sourceUrl(id), { schema: z.object({ item: sourceSchema }), signal })).item
}

/** The fields a source keeps (a PATCH sends one of them, with the version read). */
export interface SourceFields {
  supplierArticleCode?: string | null
  supplierColourCode?: string | null
  description?: string | null
  purchaseUom?: SourceUom
  unitPrice?: string | null
  currency?: string
  minOrderQty?: string | null
  orderMultiple?: string | null
  leadTimeDays?: number | null
  preference?: Preference
  note?: string | null
}

export interface NewSource extends SourceFields {
  /** null: every company of the tenant (a role over every company). */
  companyId: string | null
  partyId: string
  itemId: string
  itemColourId?: string | null
}

export function createSource(api: ApiClient, body: NewSource, idempotencyKey: string): Promise<SourceAnswer> {
  return api.post('/purchasing/supplier-items', { body, schema: oneSchema, idempotencyKey })
}

export function updateSource(api: ApiClient, id: string, version: number, fields: SourceFields): Promise<SourceAnswer> {
  return api.request('PATCH', sourceUrl(id), { body: { version, ...fields }, schema: oneSchema })
}

export function archiveSource(api: ApiClient, id: string, version: number, reason: string | null, idempotencyKey: string): Promise<SourceAnswer> {
  return api.post(`${sourceUrl(id)}/archive`, { body: { version, ...(reason?.trim() ? { reason: reason.trim() } : {}) }, schema: oneSchema, idempotencyKey })
}

export function restoreSource(api: ApiClient, id: string, version: number, idempotencyKey: string): Promise<SourceAnswer> {
  return api.post(`${sourceUrl(id)}/restore`, { body: { version }, schema: oneSchema, idempotencyKey })
}
