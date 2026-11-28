import { z } from 'zod'
import { ORDER_LIFE } from '@nexus/factory-domain/sales/order-life'
import { newIdempotencyKey, type ApiClient } from '../../../../../lib/api/client'

/**
 * owb-of3 — the office Orders sheet's reads and its few own writes, with the web's own zod schemas (unknown keys dropped; a field
 * the API adds never breaks the page). The read is `GET /sales/orders/sheet` (owb-of1 step 1, FIXED Shape): DRAFT and SENT requests
 * beside the SalesOrders, ONE list, newest change first, pages of at most 100. No price field, for anybody. Restrict is
 * `POST /sales/orders/:id/restrict` (owb-of1 step 4). The draft's own writes are today's office draft routes (`draft/api.ts`,
 * `officeDraftPort`); Delete this draft is today's `DELETE /sales/order-requests/:id?version=` (officeDiscard).
 */

export const SHEET_FILTERS = ['all', 'drafts', 'incoming', 'confirmed', 'production', 'ready', 'shipped', 'delivered', 'withdrawn'] as const
export type SheetFilter = (typeof SHEET_FILTERS)[number]
export const isSheetFilter = (value: string | null | undefined): value is SheetFilter => !!value && (SHEET_FILTERS as readonly string[]).includes(value)

const picture = z.object({ fileId: z.string(), contentType: z.string(), small: z.boolean() }).nullable()
const own = z.object({ columnId: z.string(), name: z.string(), kind: z.enum(['TEXT', 'YES_NO', 'CHOICE', 'NUMBER', 'DATE']), value: z.union([z.string(), z.number(), z.boolean()]).nullable() })
const ask = z.object({ requestId: z.string(), column: z.enum(['product', 'material', 'sizes', 'pieces', 'cancel']), from: z.string(), to: z.string() })

export const sheetLineSchema = z.object({
  id: z.string(),
  seq: z.number(),
  kind: z.enum(['CATALOGUE', 'DESCRIBED', 'CUSTOM']),
  product: z.object({ styleId: z.string(), code: z.string(), name: z.string() }).nullable(),
  text: z.string().nullable(),
  material: z.string().nullable(),
  sizes: z.string().nullable(),
  sizeFileId: z.string().nullable(),
  pieces: z.number(),
  own: z.array(own).default([]),
  asks: z.array(ask).default([]),
})
export type SheetLineRead = z.infer<typeof sheetLineSchema>

export const sheetNewsSchema = z.object({
  unread: z.number(),
  openAsks: z.number(),
  openDetails: z.number(),
  sentAsText: z.boolean(),
  remakeOf: z.object({ id: z.string(), number: z.string() }).nullable(),
  withDesigner: z.boolean(),
  design: z.enum(['WAITS', 'APPROVED', 'CHANGE']).nullable(),
  problems: z.number(),
  late: z.boolean(),
  label: z.enum(['RECEIVED', 'WAITS']).nullable(),
  next: z.enum(['CONFIRM', 'PRINT', 'PRINT_AGAIN', 'SHIP']).nullable(),
  paymentNotices: z.number(),
})
export type SheetNews = z.infer<typeof sheetNewsSchema>

export const sheetRowSchema = z.object({
  kind: z.enum(['ORDER', 'REQUEST']),
  id: z.string(),
  version: z.number(),
  number: z.string().nullable(),
  subject: z.string().nullable(),
  party: z.object({ id: z.string(), code: z.string(), name: z.string() }),
  life: z.enum(ORDER_LIFE),
  wantedFor: z.string().nullable(),
  promised: z.string().nullable(),
  daysLate: z.number().nullable(),
  where: z.object({ stage: z.string().nullable(), health: z.string().nullable(), held: z.boolean() }).nullable(),
  picture,
  news: sheetNewsSchema,
  restricted: z.boolean(),
  customerOnHold: z.boolean(),
  pieces: z.number(),
  may: z.object({ confirm: z.boolean(), deleteDraft: z.boolean(), editLines: z.enum(['DRAFT', 'AMEND']).nullable() }),
  lines: z.array(sheetLineSchema),
})
export type SheetRowRead = z.infer<typeof sheetRowSchema>

export const sheetTilesSchema = z.object({ incoming: z.number(), waitingForPrint: z.number(), inProduction: z.number(), problems: z.number(), late: z.number(), readyToShip: z.number() })
export type SheetTiles = z.infer<typeof sheetTilesSchema>

export const sheetAnswerSchema = z.object({ rows: z.array(sheetRowSchema), tiles: sheetTilesSchema, nextCursor: z.string().nullable() })
export type SheetAnswer = z.infer<typeof sheetAnswerSchema>

export interface SheetQuery {
  readonly life: SheetFilter
  readonly q: string
  readonly partyId: string | null
  readonly cursor: string | null
  readonly limit?: number
}

/** One page of the sheet (at most 100); the filter `withdrawn` is only ever asked for (hidden by default). */
export function readSheet(api: ApiClient, query: SheetQuery, signal?: AbortSignal): Promise<SheetAnswer> {
  return api.get('/sales/orders/sheet', {
    query: { life: query.life === 'all' ? undefined : query.life, q: query.q.trim() || undefined, partyId: query.partyId ?? undefined, cursor: query.cursor ?? undefined, limit: query.limit ?? 50 },
    schema: sheetAnswerSchema,
    signal,
  })
}

/** Restrict on the floor (L6: `orders.manage`): only named workers see the order; `restricted: false` lifts it. */
export function restrictOrder(api: ApiClient, orderId: string, body: { readonly version: number; readonly restricted: boolean }, idempotencyKey: string = newIdempotencyKey()): Promise<unknown> {
  return api.post(`/sales/orders/${encodeURIComponent(orderId)}/restrict`, { body, schema: z.unknown(), idempotencyKey })
}

/** Delete this draft (it was never sent): today's office discard, at the draft's version. */
export function discardDraft(api: ApiClient, requestId: string, version: number, idempotencyKey: string = newIdempotencyKey()): Promise<{ discarded: true }> {
  return api.request('DELETE', `/sales/order-requests/${encodeURIComponent(requestId)}`, { query: { version }, schema: z.object({ discarded: z.literal(true) }), idempotencyKey })
}

/** The most orders one "Give to the designer" takes (the route's own limit). */
export const DESIGNER_ORDERS_MAX = 100

/**
 * owb-of4 extra step — Give to the designer (lead S2's Shape for the server: `POST /sales/orders/designer`, orders.manage): puts the
 * chosen office person on each order through the server's ONE people writer (`putPeopleOnOrder`); a person already on an order is
 * kept, not doubled; the answer counts the orders the person joined.
 */
export function giveToDesigner(api: ApiClient, body: { readonly orderIds: readonly string[]; readonly userId: string }, idempotencyKey: string = newIdempotencyKey()): Promise<{ added: number }> {
  return api.post('/sales/orders/designer', { body: { orderIds: [...body.orderIds], userId: body.userId }, schema: z.object({ added: z.number() }), idempotencyKey })
}
