import { z } from 'zod'
import { TRACKING_EXCEPTION_KINDS } from '@nexus/factory-domain/shipping/exceptions/rules'
import { SHIPMENT_HOLD_REASONS } from '@nexus/factory-domain/shipping/holds/holds'
import { CUT_OFF_SOURCES } from '@nexus/factory-domain/shipping/queue/cutoff'
import { QUEUE_RISKS } from '@nexus/factory-domain/shipping/queue/risk'
import { SEARCH_MATCHES } from '@nexus/factory-domain/shipping/queue/search'
import { SHIPMENT_STATUSES, type ShipmentStatus } from '@nexus/factory-domain/shipping/shipments'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * The shipment queue in depth (B-W2b-386, B-W2b-398; apps/factory-api modules/shipping queue, exceptions): Ship today (a
 * site's day, its carriers' cut-offs, the open shipments due today or before, worst first), At risk of missing the promise
 * (every site the reader sees, and the orders not planned yet), the search by order, tracking number, carton, customer PO
 * or serial (any status, what it matched), and the open tracking problems (the Exceptions tile and view). No money, no
 * person.
 */

const cutOffSchema = z.object({ time: z.string(), at: z.string(), source: z.enum(CUT_OFF_SOURCES), minutesLeft: z.number(), passed: z.boolean() })
export type QueueCutOff = z.infer<typeof cutOffSchema>
const transportBy = z.enum(['CARRIER', 'SENDER', 'RECIPIENT'])

const siteDaySchema = z.object({
  siteId: z.string(),
  code: z.string(),
  name: z.string(),
  timeZone: z.string(),
  today: z.string(),
  open: z.boolean(),
  closed: z.object({ reason: z.string(), name: z.string().nullable() }).nullable(),
  nextWorkingDay: z.string().nullable(),
})
export type SiteDay = z.infer<typeof siteDaySchema>

const queueRowSchema = z.object({
  id: z.string(),
  number: z.string(),
  status: z.enum(SHIPMENT_STATUSES),
  siteId: z.string(),
  salesOrderId: z.string(),
  salesOrderNumber: z.string(),
  customerRef: z.string().nullable(),
  partyCode: z.string(),
  partyName: z.string(),
  carrierKey: z.string(),
  transportBy,
  carrierCode: z.string().nullable(),
  carrierName: z.string().nullable(),
  serviceCode: z.string().nullable(),
  shipTo: z.object({ city: z.string().nullable(), country: z.string().nullable() }),
  splitFromId: z.string().nullable(),
  garments: z.number(),
  parcels: z.number(),
  labelled: z.number(),
  shipBy: z.string().nullable(),
  cutOff: cutOffSchema.nullable(),
  risk: z.enum(QUEUE_RISKS),
  willMiss: z.boolean(),
  held: z.boolean(),
  holdReasons: z.array(z.enum(SHIPMENT_HOLD_REASONS)),
})
export type QueueRow = z.infer<typeof queueRowSchema>
export type QueueRisk = QueueRow['risk']

const carrierCardSchema = z.object({
  key: z.string(),
  transportBy,
  carrierCode: z.string().nullable(),
  carrierName: z.string().nullable(),
  cutOff: cutOffSchema.nullable(),
  shipments: z.number(),
  packed: z.number(),
  toPack: z.number(),
  labelled: z.number(),
  held: z.number(),
  willMiss: z.number(),
  parcels: z.number(),
  garments: z.number(),
})
export type CarrierCard = z.infer<typeof carrierCardSchema>

export const shipTodaySchema = z.object({
  site: siteDaySchema,
  now: z.string(),
  carriers: z.array(carrierCardSchema),
  tiles: z.object({ dueToday: z.number(), toPack: z.number(), packed: z.number(), held: z.number(), atRisk: z.number(), willMiss: z.number(), late: z.number(), notDue: z.number() }),
  shipments: z.array(queueRowSchema),
  truncated: z.boolean(),
})
export type ShipToday = z.infer<typeof shipTodaySchema>

export const atRiskSchema = z.object({
  now: z.string(),
  sites: z.array(siteDaySchema),
  tiles: z.object({ late: z.number(), held: z.number(), missedCutOff: z.number(), atRisk: z.number(), notPlanned: z.number() }),
  shipments: z.array(queueRowSchema),
  notPlanned: z.array(z.object({ salesOrderId: z.string(), number: z.string(), customerRef: z.string().nullable(), partyCode: z.string(), partyName: z.string(), siteId: z.string().nullable(), shipBy: z.string().nullable(), cutOff: cutOffSchema.nullable(), risk: z.enum(QUEUE_RISKS), garments: z.number() })),
})
export type AtRisk = z.infer<typeof atRiskSchema>
export type NotPlanned = AtRisk['notPlanned'][number]

export const shipToday = (api: ApiClient, siteId: string): Promise<ShipToday> => api.get('/shipping/queue/today', { query: { siteId }, schema: shipTodaySchema })
export const atRisk = (api: ApiClient, siteId: string | null): Promise<AtRisk> => api.get('/shipping/queue/at-risk', { query: siteId ? { siteId } : {}, schema: atRiskSchema })

// ---- the search (LOG-120) ---------------------------------------------------------------------------------------------------------

const searchRowSchema = z.object({
  id: z.string(),
  number: z.string(),
  status: z.enum(SHIPMENT_STATUSES),
  siteCode: z.string(),
  salesOrderId: z.string(),
  salesOrderNumber: z.string(),
  customerRef: z.string().nullable(),
  partyName: z.string(),
  transportBy,
  carrierCode: z.string().nullable(),
  carrierName: z.string().nullable(),
  serviceCode: z.string().nullable(),
  trackingNumbers: z.array(z.string()),
  parcels: z.number(),
  garments: z.number(),
  ddtNumber: z.string().nullable(),
  splitFrom: z.object({ id: z.string(), number: z.string() }).nullable(),
  holdReasons: z.array(z.enum(SHIPMENT_HOLD_REASONS)),
  createdAt: z.string(),
  shippedAt: z.string().nullable(),
  deliveredAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  matchedBy: z.array(z.enum(SEARCH_MATCHES)),
  matchedSerials: z.array(z.string()),
})
export type SearchRow = z.infer<typeof searchRowSchema>

export const searchSchema = z.object({ term: z.string().nullable(), notKept: z.array(z.enum(['SSCC'])), shipments: z.array(searchRowSchema), nextCursor: z.string().nullable() })
export type SearchPage = z.infer<typeof searchSchema>

export const searchShipments = (api: ApiClient, query: { q: string; status: ShipmentStatus | null; cursor: string | null }): Promise<SearchPage> =>
  api.get('/shipping/queue/search', { query: { q: query.q, status: query.status ?? undefined, cursor: query.cursor ?? undefined, limit: 50 }, schema: searchSchema })

// ---- tracking problems (the Exceptions tile and view) ----------------------------------------------------------------------------

export const problemsSchema = z.object({
  problems: z.array(z.object({ id: z.string(), kind: z.enum(TRACKING_EXCEPTION_KINDS), raisedAt: z.string(), resolvedAt: z.string().nullable(), shipment: z.object({ id: z.string(), number: z.string(), status: z.string(), siteId: z.string(), carrierName: z.string().nullable(), expectedDeliveryAt: z.string().nullable() }) })),
  truncated: z.boolean(),
})
export type ProblemList = z.infer<typeof problemsSchema>
export type ProblemRow = ProblemList['problems'][number]

export const openProblems = (api: ApiClient): Promise<ProblemList> => api.get('/shipping/tracking-problems', { query: { open: 'true' }, schema: problemsSchema })
