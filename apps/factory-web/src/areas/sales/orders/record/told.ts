import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'
import type { CardAsk, CardChange } from '../../../../lib/record-thread/card/model'
import { ASK_STATES } from '../../../../lib/record-thread/card/model'

/**
 * F-SA-244 (sales page plan P5, P8', P21, R2, R7, R8; 14-change-flow §3.1, §4.1, §5.2; 10-order-page §2.3, §2.4 C5; review WP-1,
 * WP-2) — the conversation side of a change on the order page, pure but for its two reads:
 *
 *   GET /sales/orders/:orderId/told/changes          the told lines of every change of the order (newest 50): its system line, the
 *                                                    request it carried out, how many office people were told, when the floor and
 *                                                    the workshops were told — counts and times, never a name, never who read it
 *   GET /sales/orders/:orderId/told?messageId=…      Who was told of ONE change: office people by name and why, the floor and the
 *                                                    workshops by when and which work order (those this reader reaches; the others
 *                                                    counted)
 *
 * From them and the page's own reads (the order's requests, Still to do) the page fills:
 *   the thread     the customer's ask card ("theirs", the request's askMessageId): "Request · waiting on us · Answer…" → "Request ·
 *                  accepted · 2 still to do" → "Request · accepted"; a change's line: "Still to do: 2" → "Done", "Told the floor at
 *                  10:42", "Told the workshop at 10:44", Who was told…
 *   History        "Told: conversation · bell to 6 people · floor note on WO-0311, WO-0312 · workshop notice" (no read counts)
 *   Production     per work order "Told the floor at 10:42"
 *   Overview       People: "Told about changes: 6 people"
 * THE WALL is the API's: a work order this reader does not reach is counted ("1 more work order"), never named; the portal reads
 * none of it (PartnerThread untouched: the customer sees only its ask and our reply).
 */

const workOrderRef = z.object({ id: z.string(), number: z.string() })

export const toldChangeSchema = z.object({
  batchId: z.string(),
  messageId: z.string(),
  occurredAt: z.string(),
  at: z.string(),
  eventType: z.string(),
  requestId: z.string().nullable(),
  people: z.number(),
  floor: z.object({ at: z.string().nullable(), workOrders: z.array(workOrderRef), leftOut: z.number() }),
  workshop: z.object({ at: z.string().nullable(), told: z.number(), waiting: z.number() }),
  // ---- F-OC-302 (B-OC-009): what spoke for the change — its own ids, never a person; a hold's work order named only when this
  // reader reaches it (else counted: `leftOut`); null or absent: a line written before the speaker was kept ----
  speaker: z
    .object({
      kind: z.enum(['REQUEST', 'AMENDED', 'LINES', 'CANCELLED', 'PROMISE', 'WORK_ORDER_CHANGE', 'HOLD', 'ECO']),
      requestId: z.string().optional(),
      amendmentId: z.string().optional(),
      change: z.enum(['CLOSED', 'REOPENED']).optional(),
      lineIds: z.array(z.string()).optional(),
      workOrderChangeId: z.string().optional(),
      from: z.string().nullable().optional(),
      to: z.string().optional(),
      hold: z.object({ placed: z.boolean(), workOrder: workOrderRef.nullable(), leftOut: z.number() }).optional(),
      changeOrder: z.object({ number: z.string() }).nullable().optional(),
    })
    .nullable()
    .optional(),
  // ---- end F-OC-302
})
export type ToldChange = z.infer<typeof toldChangeSchema>

export const toldChangesSchema = z.object({
  order: z.object({ id: z.string(), number: z.string() }),
  people: z.number(),
  changes: z.array(toldChangeSchema),
})
export type ToldChanges = z.infer<typeof toldChangesSchema>

export const TOLD_WHY = ['SUPERVISOR', 'TASK', 'FOLLOWS_ORDER', 'FOLLOWS_WORK_ORDER'] as const

export const whoWasToldSchema = z.object({
  order: z.object({ id: z.string(), number: z.string() }),
  change: z.object({ batchId: z.string(), messageId: z.string(), at: z.string(), requestId: z.string().nullable().optional() }),
  people: z.object({
    count: z.number(),
    groups: z.array(z.object({ why: z.enum(TOLD_WHY), words: z.object({ it: z.string(), en: z.string() }), people: z.array(z.object({ id: z.string(), name: z.string(), workOrder: workOrderRef.nullable() })) })),
  }),
  floor: z.object({ at: z.string().nullable(), workOrders: z.array(workOrderRef), leftOut: z.number() }),
  workshop: z.object({ at: z.string().nullable(), subcontractOrders: z.array(z.object({ id: z.string(), number: z.string(), toldAt: z.string().nullable() })), waiting: z.number(), leftOut: z.number() }),
})
export type WhoWasTold = z.infer<typeof whoWasToldSchema>

export const readToldChanges = (api: ApiClient, orderId: string, signal?: AbortSignal): Promise<ToldChanges> =>
  api.get(`/sales/orders/${encodeURIComponent(orderId)}/told/changes`, { schema: toldChangesSchema, ...(signal ? { signal } : {}) })

export const readWhoWasTold = (api: ApiClient, orderId: string, messageId: string, signal?: AbortSignal): Promise<WhoWasTold> =>
  api.get(`/sales/orders/${encodeURIComponent(orderId)}/told`, { query: { messageId }, schema: whoWasToldSchema, ...(signal ? { signal } : {}) })

// ---- the thread's cards -------------------------------------------------------------------------------------------------------

/** What the page knows of a request (the order's requests read, every state). */
export interface AskRequest {
  readonly id: string
  readonly status: string
  readonly askMessageId?: string | null | undefined
  readonly waitingOn: 'US' | 'CUSTOMER' | null
  readonly may: { readonly accept: boolean; readonly refuse: boolean; readonly counter: boolean }
}

/** One Still to do row as the production read gives it: the request it carries out (null: the office's own change). */
export interface StillOf {
  readonly requestId: string | null
}

const isAskState = (status: string): status is CardAsk['state'] => (ASK_STATES as readonly string[]).includes(status)

/**
 * The customer's asks by their message: each request that names its own message (asked after B-SA-048), its status now, the Still
 * to do rows it left (counted only once the page has read Still to do; else 0 — nothing claimed beyond "accepted"), and whether this
 * reader may answer it now (it waits on us and the reader's team answers its kind: `waitsForMe`).
 */
export function askFactsOf(requests: readonly AskRequest[], still: readonly StillOf[]): Map<string, CardAsk> {
  const out = new Map<string, CardAsk>()
  for (const request of requests) {
    if (!request.askMessageId || !isAskState(request.status)) continue
    const answer = request.status === 'OPEN' && request.waitingOn === 'US' && (request.may.accept || request.may.refuse || request.may.counter)
    out.set(request.askMessageId, { requestId: request.id, state: request.status, stillToDo: still.filter((row) => row.requestId === request.id).length, answer })
  }
  return out
}

/**
 * Each change's line by its message: its live Still to do (the rows of the request it carried out; an office change: the rows of no
 * request — null when the page has not read Still to do: the card claims nothing), when the floor and the first workshop were told.
 */
export function changeFactsOf(changes: readonly ToldChange[], still: readonly StillOf[] | null): Map<string, CardChange> {
  const out = new Map<string, CardChange>()
  for (const change of changes) {
    const stillToDo = still === null ? null : still.filter((row) => row.requestId === change.requestId).length
    out.set(change.messageId, { stillToDo, floorAt: change.floor.at, workshopAt: change.workshop.at })
  }
  return out
}

// ---- History, Production, Overview ------------------------------------------------------------------------------------------

/** An amendment's change is the told line of an amendment within this long of it (the handler writes its line a moment later). */
export const NEAR_MS = 10 * 60_000

/**
 * The told line of a History row: a request answered or withdrawn by the request it carried out; an amendment of the office's own by
 * the amendment's change nearest its time (≤ 10 min). Null: none (asked only, a confirmation, or told before the change kept one).
 */
export function toldOfHistory(entry: { readonly kind: string; readonly at: string; readonly requestId?: string | null }, changes: readonly ToldChange[]): ToldChange | null {
  if (entry.kind === 'requestAnswered' && entry.requestId) return changes.find((change) => change.requestId === entry.requestId) ?? null
  if (entry.kind !== 'amendment') return null
  const at = Date.parse(entry.at)
  if (Number.isNaN(at)) return null
  let best: { change: ToldChange; gap: number } | null = null
  for (const change of changes) {
    if (change.requestId !== null || change.eventType !== 'sales_order.amended') continue
    const gap = Math.abs(Date.parse(change.occurredAt) - at)
    if (Number.isNaN(gap) || gap > NEAR_MS) continue
    if (!best || gap < best.gap) best = { change, gap }
  }
  return best?.change ?? null
}

/**
 * History's Told line in parts (the view joins them with " · "): the conversation, the bell to N people, the floor note on the work
 * orders this reader reaches ("1 more work order" for the others), the workshop notice. Who TOLD, never who read it (R2).
 */
export function toldParts(change: ToldChange): { readonly key: string; readonly params?: Record<string, string | number> }[] {
  const parts: { key: string; params?: Record<string, string | number> }[] = [{ key: 'told.conversation' }]
  if (change.people > 0) parts.push({ key: 'told.bell', params: { count: change.people } })
  const numbers = change.floor.workOrders.map((workOrder) => workOrder.number)
  if (numbers.length > 0) parts.push({ key: 'told.floorOn', params: { workOrders: numbers.join(', ') } })
  if (change.floor.leftOut > 0) parts.push({ key: numbers.length > 0 ? 'told.floorMore' : 'told.floorOther', params: { count: change.floor.leftOut } })
  if (change.workshop.told > 0) parts.push({ key: 'told.workshop' })
  return parts
}

/** When the floor of a work order was last told about a change of this order (its newest floor note), or null: never. */
export function floorToldAt(changes: readonly ToldChange[], workOrderId: string): string | null {
  let newest: string | null = null
  for (const change of changes) {
    if (!change.floor.at || !change.floor.workOrders.some((workOrder) => workOrder.id === workOrderId)) continue
    if (newest === null || change.floor.at > newest) newest = change.floor.at
  }
  return newest
}
