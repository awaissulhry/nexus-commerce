import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'
import { newIdempotencyKey } from '../../../lib/api/client'

/**
 * Every call of Production › Reports (SCR-240) and of Floor now's Lines (SCR-073, design production.floor fn-lines), with
 * the answer's shape checked (zod; unknown fields are dropped). The shapes mirror apps/factory-api
 * modules/production/reports/contract.ts; the enum lists mirror factory-domain production/reports (reports.vitest.test.ts
 * holds them equal). Garments, minutes and percents only: no money, and no person of the floor anywhere.
 */

export const LANE_KINDS = ['LINE', 'WORK_CENTRE'] as const
export type LaneKind = (typeof LANE_KINDS)[number]
export const LINE_STATES = ['RUNNING', 'WAITING', 'NO_WORK'] as const
export type LineState = (typeof LINE_STATES)[number]
export const REPORT_LOCALES = ['it', 'en'] as const
export type ReportLocale = (typeof REPORT_LOCALES)[number]
export const MACHINE_DOWN = ['DOWN', 'UNDER_MAINTENANCE', 'DO_NOT_USE'] as const
export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const
export const DAILY_REPORT_KEY = 'production.daily'

const site = z.object({ id: z.string(), code: z.string(), name: z.string() })
const style = z.object({ id: z.string(), code: z.string(), name: z.string() })
const figures = { good: z.number(), scrap: z.number(), rework: z.number() }

export const laneSchema = z.object({
  kind: z.enum(LANE_KINDS),
  id: z.string(),
  code: z.string(),
  name: z.string(),
  ...figures,
  earnedMinutes: z.string().nullable(),
  availableMinutes: z.string().nullable(),
  efficiencyPct: z.string().nullable(),
  people: z.number().nullable(),
  workingMinutes: z.number().nullable(),
  rows: z.array(z.object({ style, size: z.string(), ...figures })),
})
export type DailyLane = z.infer<typeof laneSchema>

export const dailySchema = z.object({
  site: site.extend({ timeZone: z.string() }),
  sites: z.array(site),
  day: z.string(),
  today: z.string(),
  previousWorkingDay: z.string().nullable(),
  nextDay: z.string().nullable(),
  workingDay: z.boolean(),
  asOf: z.string(),
  lanes: z.array(laneSchema),
  totals: z.object(figures),
})
export type DailyReport = z.infer<typeof dailySchema>

export const lineCardSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  site: z.object({ id: z.string(), code: z.string() }),
  state: z.enum(LINE_STATES),
  lastScanAt: z.string().nullable(),
  workOrders: z.array(z.object({ id: z.string(), number: z.string(), status: z.string(), style })),
  plannedToday: z.number().nullable(),
  plan: z.object({ number: z.number() }).nullable(),
  output: z.number(),
  outputPct: z.number().nullable(),
  bottleneck: z.object({ workOrderId: z.string(), workOrderNumber: z.string(), operationId: z.string(), seq: z.number(), code: z.string(), name: z.string(), waiting: z.number() }).nullable(),
  stations: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), signedIn: z.boolean(), machinesDown: z.array(z.object({ assetNumber: z.string(), status: z.enum(MACHINE_DOWN) })) })),
})
export type LineCard = z.infer<typeof lineCardSchema>

export const linesSchema = z.object({
  asOf: z.string(),
  sites: z.array(site.extend({ timeZone: z.string(), today: z.string() })),
  lines: z.array(lineCardSchema),
})
export type LinesOverview = z.infer<typeof linesSchema>

export const subscriptionSchema = z.object({
  id: z.string(),
  reportKey: z.string(),
  user: z.object({ id: z.string(), name: z.string() }),
  mine: z.boolean(),
  site: site.nullable(),
  sendTime: z.string(),
  weekdays: z.array(z.number()),
  locale: z.enum(REPORT_LOCALES),
  active: z.boolean(),
  lastSentAt: z.string().nullable(),
  version: z.number(),
})
export type Subscription = z.infer<typeof subscriptionSchema>

const subscriptionsSchema = z.object({ subscriptions: z.array(subscriptionSchema) })
const recipientsSchema = z.object({ people: z.array(z.object({ id: z.string(), name: z.string(), me: z.boolean(), subscribed: z.boolean() })) })
export type Recipient = z.infer<typeof recipientsSchema>['people'][number]

export function getDaily(api: ApiClient, query: { siteId?: string | null; date?: string | null }, signal?: AbortSignal): Promise<DailyReport> {
  return api.get('/production/reports/daily', { query: { siteId: query.siteId ?? undefined, date: query.date ?? undefined }, schema: dailySchema, signal })
}

export function getLines(api: ApiClient, siteId?: string | null, signal?: AbortSignal): Promise<LinesOverview> {
  return api.get('/production/reports/lines', { query: { siteId: siteId ?? undefined }, schema: linesSchema, signal })
}

export function listSubscriptions(api: ApiClient, siteId?: string | null): Promise<Subscription[]> {
  return api.get('/production/reports/subscriptions', { query: { siteId: siteId ?? undefined }, schema: subscriptionsSchema }).then((answer) => answer.subscriptions)
}

export function listRecipients(api: ApiClient, siteId: string): Promise<Recipient[]> {
  return api.get('/production/reports/recipients', { query: { siteId }, schema: recipientsSchema }).then((answer) => answer.people)
}

export interface SubscribeBody {
  readonly siteId: string
  /** Absent: me alone. */
  readonly recipients?: readonly string[]
  readonly sendTime: string
  readonly weekdays: readonly number[]
  /** null: each person's own language. */
  readonly locale: ReportLocale | null
}

export function subscribe(api: ApiClient, body: SubscribeBody, idempotencyKey = newIdempotencyKey()): Promise<Subscription[]> {
  return api.post('/production/reports/subscriptions', { body: { reportKey: DAILY_REPORT_KEY, ...body }, schema: subscriptionsSchema, idempotencyKey }).then((answer) => answer.subscriptions)
}

export function changeSubscription(api: ApiClient, id: string, body: { version: number; active?: boolean; sendTime?: string; weekdays?: readonly number[]; locale?: ReportLocale }, idempotencyKey = newIdempotencyKey()): Promise<Subscription> {
  return api
    .request('PATCH', `/production/reports/subscriptions/${encodeURIComponent(id)}`, { body, schema: z.object({ subscription: subscriptionSchema }), idempotencyKey })
    .then((answer) => answer.subscription)
}
