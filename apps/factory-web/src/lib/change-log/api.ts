import { z } from 'zod'
import { ORDER_LIFE } from '@nexus/factory-domain/sales/order-life'
import type { ApiClient } from '../api/client'
import type { LogPage, LogRow, LogValue } from './model'

/**
 * owb-b4 w4.4 (owb-b23 "Shapes": GET …/log?cursor=&limit=) — the order log's four doors and its answer, parsed with this web's OWN zod
 * so the part never waits for the server's types: the fields the part needs are required; the rest have a safe default (no icon: a
 * plain dot; no subject: the order; no value: none; no reason: none). A value of a kind this web does not know reads as none, a face
 * or subject kind it does not know stays a string (drawn neutrally, never a name).
 */

const lifeSchema = z.enum(ORDER_LIFE)
const valueSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('LIFE'), life: lifeSchema }),
  z.object({ kind: z.literal('DEPT'), no: z.number().int() }),
  z.object({ kind: z.literal('DATE'), date: z.string() }),
  z.object({ kind: z.literal('TEXT'), text: z.string() }),
  z.object({ kind: z.literal('COUNT'), n: z.number() }),
  z.object({ kind: z.literal('PICTURE'), fileId: z.string().nullable() }),
])
/** A value, or null: absent, null, or a kind this web does not know. */
const maybeValue = valueSchema.nullable().optional().catch(null).transform((value): LogValue | null => value ?? null)

const rowSchema = z.object({
  id: z.string(),
  at: z.string(),
  who: z.object({ face: z.string(), name: z.string().nullable().optional().default(null), departmentNo: z.number().int().nullable().optional().default(null) }),
  action: z.string(),
  icon: z.string().optional().default(''),
  subject: z.object({ kind: z.string(), label: z.string().nullable().optional().default(null) }).optional().default({ kind: 'ORDER', label: null }),
  from: maybeValue,
  to: maybeValue,
  reason: z.string().nullable().optional().default(null),
})
export const orderLogAnswerSchema = z.object({ rows: z.array(rowSchema), nextCursor: z.string().nullable().optional().default(null) })

/** How many rows one page asks for. */
export const LOG_PAGE = 50

/** The four doors (owb-b23 b3.1; S1 ask 23:36): the office's order and request, the customer's order and request. */
export function orderLogPath(door: 'office' | 'portal', record: 'order' | 'request', id: string): string {
  const key = encodeURIComponent(id)
  if (door === 'office') return record === 'order' ? `/sales/orders/${key}/log` : `/sales/order-requests/${key}/log`
  return record === 'order' ? `/portal/sales-orders/${key}/log` : `/portal/order-requests/${key}/log`
}

/** One page of the log (the host's own client and door); `cursor` null: the first page. */
export async function readOrderLog(api: ApiClient, path: string, cursor: string | null, signal?: AbortSignal, limit = LOG_PAGE): Promise<LogPage> {
  const answer = await api.get(path, { query: { cursor: cursor ?? undefined, limit }, schema: orderLogAnswerSchema, signal })
  return { rows: answer.rows as LogRow[], nextCursor: answer.nextCursor }
}

/** The read port the part's hook takes. */
export type ReadOrderLog = (cursor: string | null, signal: AbortSignal) => Promise<LogPage>

/** The read port over the host's client and door: `orderLogReader(api, orderLogPath('office', 'order', id))`. */
export const orderLogReader =
  (api: ApiClient, path: string): ReadOrderLog =>
  (cursor, signal) =>
    readOrderLog(api, path, cursor, signal)
