import { z } from 'zod'
import type { ApiClient } from '../../../../../lib/api/client'
import { newIdempotencyKey } from '../../../../../lib/api/client'

/**
 * "E-mail me this" for any report (B-W2b-435; follow-up DG1:01): GET /reports/subscriptions?reportKey, PUT|DELETE
 * /reports/:key/subscription — checked by their schemas. The shapes mirror apps/factory-api modules/insights/digest/contract.ts.
 */

export const subscriptionSchema = z.object({
  id: z.string(),
  reportKey: z.string(),
  filters: z.record(z.string(), z.string()),
  siteId: z.string().nullable(),
  sendTime: z.string(),
  timeZone: z.string(),
  weekdays: z.array(z.number()),
  locale: z.enum(['it', 'en']),
  active: z.boolean(),
  lastSentAt: z.string().nullable(),
  nextAt: z.string().nullable(),
  version: z.number(),
})
export type ReportSubscription = z.infer<typeof subscriptionSchema>

export interface SubscribeBody {
  readonly sendTime: string
  readonly weekdays: readonly number[]
  readonly locale: 'it' | 'en'
  readonly filters: Readonly<Record<string, string | null>>
  readonly active: boolean
  readonly version: number
}

/** My e-mail of one report, or null. */
export async function getMine(api: ApiClient, reportKey: string, signal?: AbortSignal): Promise<ReportSubscription | null> {
  const answer = await api.get('/reports/subscriptions', { query: { reportKey }, schema: z.object({ asOf: z.string(), subscriptions: z.array(subscriptionSchema) }), signal })
  return answer.subscriptions[0] ?? null
}

export async function subscribe(api: ApiClient, reportKey: string, body: SubscribeBody): Promise<ReportSubscription> {
  const answer = await api.request('PUT', `/reports/${encodeURIComponent(reportKey)}/subscription`, { body, schema: z.object({ subscription: subscriptionSchema }), idempotencyKey: newIdempotencyKey() })
  return answer.subscription
}

export async function unsubscribe(api: ApiClient, reportKey: string, version: number): Promise<void> {
  await api.request('DELETE', `/reports/${encodeURIComponent(reportKey)}/subscription`, { query: { version }, schema: z.object({ removed: z.boolean() }), idempotencyKey: newIdempotencyKey() })
}
