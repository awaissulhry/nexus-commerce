import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../api/client'
import { ownColumnSchema, ownColumnsListSchema, ownValueSchema, recordOwnColumnsSchema, type OwnColumn, type OwnColumnKind, type OwnValue, type RecordOwnColumns } from './schema'

/**
 * owb-po3 (owb-po-server § Shape "OWN COLUMNS") — the own-columns commands through ONE port with its door: the portal's
 * `/portal/own-columns`, `/portal/order-requests/:id/own-columns`, `/portal/sales-orders/:id/own-columns`, `/portal/own-values`; the
 * office's twins `/sales/own-columns?partyId=`, `/sales/order-requests/:id/own-columns`, `/sales/orders/:id/own-columns`,
 * `/sales/own-values` (same bodies and answers; `orders.manage` over that customer). Answers are parsed with this web's own zod.
 * A view never calls it: the host's container does and hands the views their model (the `od/api-port.ts` pattern).
 */

export type LinesDoor = 'portal' | 'office'
export type OwnLineRef = { readonly kind: 'REQUEST_LINE' | 'ORDER_LINE'; readonly id: string }

export interface OwnColumnsPort {
  list(signal?: AbortSignal): Promise<OwnColumn[]>
  create(body: { name: string; kind: OwnColumnKind; choices?: string[] }, idempotencyKey?: string): Promise<OwnColumn>
  close(columnId: string, version: number, idempotencyKey?: string): Promise<OwnColumn>
  /** A draft's columns (≤ 8, in order): answers the draft's record — the host parses it with its own record schema. */
  useOnRequest<R>(requestId: string, body: { version: number; columnIds: string[]; dropValues?: boolean }, schema: z.ZodType<R>, idempotencyKey?: string): Promise<R>
  useOnOrder(orderId: string, body: { columnIds: string[]; dropValues?: boolean }, idempotencyKey?: string): Promise<RecordOwnColumns>
  putValue(body: { line: OwnLineRef; columnId: string; value: OwnValue['value']; version?: number }, idempotencyKey?: string): Promise<OwnValue>
}

const base = (door: LinesDoor) => (door === 'portal' ? '/portal' : '/sales')

/** The own-columns port of a door; the office names the customer (`partyId`) for the list and a new column. */
export function ownColumnsPort(api: ApiClient, door: LinesDoor, partyId?: string | null): OwnColumnsPort {
  const root = base(door)
  const party = door === 'office' && partyId ? { partyId } : {}
  return {
    list: async (signal) => (await api.get(`${root}/own-columns`, { query: party, schema: ownColumnsListSchema, signal })).columns,
    create: (body, idempotencyKey = newIdempotencyKey()) => api.post(`${root}/own-columns`, { body: { ...party, ...body }, schema: ownColumnSchema, idempotencyKey }),
    close: (columnId, version, idempotencyKey = newIdempotencyKey()) => api.post(`${root}/own-columns/${encodeURIComponent(columnId)}/close`, { body: { version }, schema: ownColumnSchema, idempotencyKey }),
    useOnRequest: (requestId, body, schema, idempotencyKey = newIdempotencyKey()) =>
      api.request('PUT', `${root}/order-requests/${encodeURIComponent(requestId)}/own-columns`, { body, schema, idempotencyKey }),
    useOnOrder: async (orderId, body, idempotencyKey = newIdempotencyKey()) =>
      (await api.request('PUT', `${root}/${door === 'portal' ? 'sales-orders' : 'orders'}/${encodeURIComponent(orderId)}/own-columns`, { body, schema: z.object({ ownColumns: recordOwnColumnsSchema }), idempotencyKey })).ownColumns,
    putValue: (body, idempotencyKey = newIdempotencyKey()) => api.request('PUT', `${root}/own-values`, { body, schema: ownValueSchema, idempotencyKey }),
  }
}
