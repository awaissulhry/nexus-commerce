import { z } from 'zod'
import { SCAN_ID_KINDS } from '@nexus/factory-domain/numbering/kinds'
import type { ApiClient } from '../../lib/api/client'
import { newIdempotencyKey } from '../../lib/api/client'

/**
 * The queue's calls to the floor sync (apps/factory-api platform/floor-sync): send the queue, read the person's refused
 * actions, discard one. Each answer is checked against its shape. Every unsafe call first makes sure the CSRF
 * double-submit cookie exists, and carries a fresh Idempotency-Key.
 */

const refusal = z.object({ id: z.string().nullable(), code: z.string(), message: z.string(), fix: z.string(), final: z.boolean() })
const result = z.object({ type: z.string(), id: z.string() })
const block = z.object({ id: z.string(), kind: z.enum(SCAN_ID_KINDS), fromRef: z.number(), toRef: z.number(), highestUsedRef: z.number().nullable(), status: z.enum(['ACTIVE', 'CLOSED']) })

export const syncAnswer = z.object({
  serverTime: z.string(),
  clock: z.object({ deviceSentAt: z.string(), skewSeconds: z.number(), off: z.boolean(), flagged: z.boolean() }).nullable(),
  events: z.array(
    z.object({
      clientEventId: z.string(),
      seq: z.number(),
      kind: z.string(),
      status: z.enum(['accepted', 'duplicate', 'refused', 'waiting']),
      serverTime: z.string().nullable(),
      result: result.nullable(),
      refusal: refusal.nullable(),
    }),
  ),
  blocks: z.object({ scanTag: z.string(), blocks: z.array(block) }).nullable(),
})
export type SyncAnswer = z.infer<typeof syncAnswer>

const summary = z.object({
  code: z.string().nullable().optional(),
  good: z.number().optional(),
  scrap: z.number().optional(),
  rework: z.number().optional(),
  quantity: z.number().optional(),
  sets: z.number().optional(),
  workOrderId: z.string().optional(),
  target: z.string().nullable().optional(),
})
export type Summary = z.infer<typeof summary>

const refusedRow = z.object({
  id: z.string(),
  clientEventId: z.string(),
  kind: z.string(),
  deviceSeq: z.number(),
  code: z.string(),
  message: z.string(),
  fix: z.string(),
  final: z.boolean(),
  summary,
  deviceTime: z.string().nullable(),
  serverTime: z.string(),
  status: z.enum(['OPEN', 'RESOLVED', 'DISCARDED']),
})
export type RefusedRow = z.infer<typeof refusedRow>

export const mineAnswer = z.object({
  serverTime: z.string(),
  lastRecordedAt: z.string().nullable(),
  subject: z.enum(['WORKER', 'STATION']),
  refused: z.array(refusedRow),
  othersRefused: z.number(),
})
export type MineAnswer = z.infer<typeof mineAnswer>

const csrf = (api: ApiClient) => api.get('/auth/csrf')

export interface SentEvent {
  readonly clientEventId: string
  readonly seq: number
  readonly kind: string
  readonly occurredAt: string
  readonly workerId: string
  readonly payload: Readonly<Record<string, unknown>>
}

export async function sendQueue(api: ApiClient, body: { sentAt: string; events: readonly SentEvent[]; blocks?: readonly { kind: string; remaining: number }[] }): Promise<SyncAnswer> {
  await csrf(api)
  return api.post('/floor/sync', { body, idempotencyKey: newIdempotencyKey(), schema: syncAnswer })
}

export function fetchMine(api: ApiClient): Promise<MineAnswer> {
  return api.get('/floor/sync', { schema: mineAnswer })
}

export async function discardRefused(api: ApiClient, refusedId: string): Promise<RefusedRow> {
  await csrf(api)
  const answer = await api.post(`/floor/sync/refused/${encodeURIComponent(refusedId)}/discard`, { body: {}, idempotencyKey: newIdempotencyKey(), schema: z.object({ refused: refusedRow }) })
  return answer.refused
}
