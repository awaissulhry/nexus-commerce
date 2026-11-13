import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'

/**
 * Every call of Sales › Reports (SCR-250, B-W2b-348), with the answer's shape checked (zod; unknown fields are dropped, so a new
 * API field never breaks the page). The shapes mirror apps/factory-api modules/insights/sales-reports/contract.ts; the lists
 * mirror factory-domain insights/sales-reports/rules (reports.vitest.test.ts holds them equal). Amounts are minor units of their
 * currency and come only with the price grain (the API drops them otherwise: every amount field is optional here). Nothing names
 * a person.
 */

export const INTAKE_BUCKETS = ['week', 'month'] as const
export type IntakeBucket = (typeof INTAKE_BUCKETS)[number]
export const INTAKE_SPLITS = ['none', 'customer', 'style', 'season'] as const
export type IntakeSplit = (typeof INTAKE_SPLITS)[number]
export const BACKLOG_GROUPS = ['customer', 'style'] as const
export type BacklogGroup = (typeof BACKLOG_GROUPS)[number]
export const BACKLOG_HORIZONS = ['late', 'thisWeek', 'next4', 'later', 'none'] as const
export type BacklogHorizon = (typeof BACKLOG_HORIZONS)[number]
export const BACKLOG_WEEK_KINDS = ['EARLIER', 'WEEK', 'LATER', 'NONE'] as const
export const RETURN_GROUPS = ['reason', 'style', 'size', 'colour', 'customer'] as const
export type ReturnGroup = (typeof RETURN_GROUPS)[number]
/** Group keys that are not a record (the API's NO_KEY and FEES_KEY). */
export const NO_KEY = 'none'
export const FEES_KEY = 'fees'

const ref = z.object({ id: z.string(), code: z.string(), name: z.string() })
export type Ref = z.infer<typeof ref>
const head = { company: ref.nullable(), from: z.string(), to: z.string(), today: z.string(), asOf: z.string() }
const sight = z.object({ orders: z.boolean(), quotes: z.boolean(), returns: z.boolean(), values: z.boolean() })
export type Sight = z.infer<typeof sight>

/** The price grain's fields (absent without it). */
const values = {
  byCurrency: z.array(z.object({ currency: z.string(), value: z.number().optional() })).default([]),
  value: z.number().nullable().optional(),
  currency: z.string().nullable(),
  mixedCurrencies: z.boolean(),
}
export type ValueFigures = z.infer<z.ZodObject<typeof values>>
const intakeFigures = z.object({ orders: z.number(), pieces: z.number(), ...values })
export type IntakeFigures = z.infer<typeof intakeFigures>
const backlogFigures = z.object({ orders: z.number(), lines: z.number(), pieces: z.number(), late: z.number(), ...values })
export type BacklogFigures = z.infer<typeof backlogFigures>
const returnFigures = z.object({ returns: z.number(), lines: z.number(), pieces: z.number(), ...values })
export type ReturnFigures = z.infer<typeof returnFigures>
const speed = {
  answered: z.number(),
  medianAnswerMinutes: z.number().nullable(),
  fromInquiries: z.number(),
  accepted: z.number(),
  declined: z.number(),
  expired: z.number(),
  winRatePct: z.string().nullable(),
  medianDecisionHours: z.number().nullable(),
}

// ---- the headline ----------------------------------------------------------------------------------------------------------

const headlineSchema = z.object({
  ...head,
  sight,
  companyCurrency: z.string().nullable(),
  intake: intakeFigures.nullable(),
  backlog: backlogFigures.nullable(),
  quotes: z.object(speed).nullable(),
  returns: z.object({ returns: z.number(), pieces: z.number(), shipped: z.number().nullable(), returnRatePct: z.string().nullable() }).nullable(),
  complete: z.boolean(),
})
export type Headline = z.infer<typeof headlineSchema>

// ---- order intake ----------------------------------------------------------------------------------------------------------

const intakeSchema = z.object({
  ...head,
  sight,
  by: z.enum(INTAKE_BUCKETS),
  split: z.enum(INTAKE_SPLITS),
  companyCurrency: z.string().nullable(),
  all: intakeFigures,
  buckets: z.array(z.object({ key: z.string(), from: z.string(), to: z.string(), figures: intakeFigures })),
  groups: z.array(z.object({ key: z.string(), code: z.string().nullable(), name: z.string().nullable(), figures: intakeFigures, buckets: z.array(z.object({ key: z.string(), figures: intakeFigures })) })),
  more: z.number(),
  orders: z.array(
    z.object({
      id: z.string(),
      number: z.string(),
      status: z.string(),
      customer: ref,
      bookedOn: z.string(),
      orderDate: z.string(),
      splitOff: z.boolean(),
      season: ref.nullable(),
      bucket: z.string(),
      pieces: z.number(),
      value: z.number().optional(),
      currency: z.string(),
      styles: z.array(z.object({ key: z.string(), pieces: z.number(), value: z.number().optional() })),
    }),
  ),
  complete: z.boolean(),
})
export type Intake = z.infer<typeof intakeSchema>
export type IntakeOrder = Intake['orders'][number]
export type IntakeGroupRow = Intake['groups'][number]

// ---- backlog ---------------------------------------------------------------------------------------------------------------

const backlogSchema = z.object({
  company: ref.nullable(),
  today: z.string(),
  asOf: z.string(),
  sight,
  by: z.enum(BACKLOG_GROUPS),
  companyCurrency: z.string().nullable(),
  all: backlogFigures,
  weeks: z.array(z.object({ key: z.string(), kind: z.enum(BACKLOG_WEEK_KINDS), from: z.string().nullable(), to: z.string().nullable(), past: z.boolean(), current: z.boolean(), figures: backlogFigures })),
  groups: z.array(z.object({ key: z.string(), code: z.string(), name: z.string(), figures: backlogFigures, horizons: z.object({ late: z.number(), thisWeek: z.number(), next4: z.number(), later: z.number(), none: z.number() }) })),
  more: z.number(),
  lines: z.array(
    z.object({
      orderId: z.string(),
      number: z.string(),
      status: z.string(),
      lineId: z.string(),
      seq: z.number(),
      customer: ref,
      style: ref,
      colourway: z.object({ code: z.string(), name: z.string() }),
      size: z.string().nullable(),
      open: z.number(),
      promise: z.string().nullable(),
      promiseSource: z.enum(['RECORD', 'TYPED']).nullable(),
      week: z.string(),
      horizon: z.enum(BACKLOG_HORIZONS),
      value: z.number().optional(),
      currency: z.string(),
    }),
  ),
  complete: z.boolean(),
})
export type Backlog = z.infer<typeof backlogSchema>
export type BacklogWeek = Backlog['weeks'][number]
export type BacklogLine = Backlog['lines'][number]

// ---- returns ---------------------------------------------------------------------------------------------------------------

const named = z.object({ key: z.string(), code: z.string().nullable(), name: z.string().nullable(), figures: returnFigures })
export type ReturnNamed = z.infer<typeof named>
const returnsSchema = z.object({
  ...head,
  sight,
  companyCurrency: z.string().nullable(),
  all: returnFigures,
  shipped: z.number().nullable(),
  returnRatePct: z.string().nullable(),
  reasons: z.array(z.object({ key: z.string(), words: z.object({ it: z.string(), en: z.string() }).nullable(), figures: returnFigures })),
  styles: z.array(named),
  colours: z.array(named),
  sizes: z.array(named),
  customers: z.array(named),
  heatmap: z.object({ styles: z.array(z.object({ key: z.string(), code: z.string(), name: z.string() })), sizes: z.array(z.string()), cells: z.array(z.array(z.number().nullable())) }),
  lines: z.array(
    z.object({
      returnId: z.string(),
      number: z.string(),
      status: z.string(),
      lineId: z.string(),
      seq: z.number(),
      requestedOn: z.string(),
      reason: z.string(),
      style: ref.nullable(),
      colour: z.object({ code: z.string(), name: z.string() }).nullable(),
      size: z.string().nullable(),
      customer: ref,
      pieces: z.number(),
      credited: z.number().nullable().optional(),
      currency: z.string().nullable(),
    }),
  ),
  complete: z.boolean(),
})
export type Returns = z.infer<typeof returnsSchema>
export type ReturnLineRow = Returns['lines'][number]

// ---- quote speed (Sales › Quotes) -------------------------------------------------------------------------------------------

export const quoteSpeedSchema = z.object({ ...head, sight, companyCurrency: z.string().nullable(), ...speed, won: z.object(values), complete: z.boolean() })
export type QuoteSpeed = z.infer<typeof quoteSpeedSchema>

// ---- the calls ---------------------------------------------------------------------------------------------------------------

export interface PeriodScope {
  readonly from: string | null
  readonly to: string | null
}
export const periodQuery = (scope: PeriodScope): Record<string, string> => ({ ...(scope.from ? { from: scope.from } : {}), ...(scope.to ? { to: scope.to } : {}) })

/** GET /sales/reports/headline — the period in five numbers (sec strip). */
export const getHeadline = (api: ApiClient, scope: PeriodScope, signal?: AbortSignal) => api.get('/sales/reports/headline', { query: periodQuery(scope), schema: headlineSchema, signal })

/** GET /sales/reports/intake — the orders booked by week or month, split by customer, style or season (sec intake). */
export const getIntake = (api: ApiClient, scope: PeriodScope, by: IntakeBucket, split: IntakeSplit, signal?: AbortSignal) => api.get('/sales/reports/intake', { query: { ...periodQuery(scope), by, split }, schema: intakeSchema, signal })

/** GET /sales/reports/backlog — confirmed, not shipped, by promise week, by customer or style (sec backlog; no period: now). */
export const getBacklog = (api: ApiClient, by: BacklogGroup, signal?: AbortSignal) => api.get('/sales/reports/backlog', { query: { by }, schema: backlogSchema, signal })

/** GET /sales/reports/returns — the return lines of the period by reason, style, size, colour, customer (sec returns). */
export const getReturns = (api: ApiClient, scope: PeriodScope, signal?: AbortSignal) => api.get('/sales/reports/returns', { query: periodQuery(scope), schema: returnsSchema, signal })

/** GET /sales/reports/quote-speed — how fast we answer and how often we win (Sales › Quotes sec quotes.speed; quotes.view). */
export const getQuoteSpeed = (api: ApiClient, scope: PeriodScope, signal?: AbortSignal) => api.get('/sales/reports/quote-speed', { query: periodQuery(scope), schema: quoteSpeedSchema, signal })
