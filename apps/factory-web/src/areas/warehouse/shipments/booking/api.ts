import { z } from 'zod'
import { TRACKING_STATUSES } from '@nexus/factory-domain/shipping/labels/tracking'
import { MANUAL_EVENT_STATUSES, OWN_TRANSPORT_MODES, OWN_TRANSPORT_REFUSALS, TRANSPORT_ARRANGEMENTS } from '@nexus/factory-domain/shipping/own-transport/rules'
import { LABEL_JOB_KINDS, REPRINT_REFUSALS } from '@nexus/factory-domain/shipping/reprint/rules'
import { SHIPMENT_STATUSES } from '@nexus/factory-domain/shipping/shipments'
import { CHECK_CODES } from '@nexus/factory-domain/shipping/validate/rules'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * The Carrier & label tab in depth (apps/factory-api modules/shipping own-transport, validate, reprint): who carries the
 * goods — a carrier through Sendcloud, a carrier booked by hand with its typed tracking number, our own van, the customer
 * collecting (B-W2b-390, LOG-122) — and the statuses typed for them; every parcel checked against its carrier's rules before
 * a label is bought (LOG-045); each parcel's label jobs and a reprint with a reason (B-W2b-391, LOG-027). The API's English
 * `message` / `words` are not drawn: the screen says the codes.
 */

const allowance = z.object({ allowed: z.boolean(), refusal: z.object({ code: z.enum(OWN_TRANSPORT_REFUSALS) }).nullable() })

export const transportSchema = z.object({
  shipment: z.object({
    id: z.string(),
    number: z.string(),
    status: z.enum(SHIPMENT_STATUSES),
    version: z.number(),
    transportBy: z.enum(['CARRIER', 'SENDER', 'RECIPIENT']),
    carrierCode: z.string().nullable(),
    carrierName: z.string().nullable(),
    serviceCode: z.string().nullable(),
    manualTrackingNumber: z.string().nullable(),
    ddtRequired: z.boolean(),
    shippedAt: z.string().nullable(),
    deliveredAt: z.string().nullable(),
    returnedAt: z.string().nullable(),
  }),
  arrangement: z.enum(TRANSPORT_ARRANGEMENTS),
  ddt: z.object({ id: z.string(), number: z.string() }).nullable(),
  labels: z.object({ carrier: z.number(), test: z.number() }),
  may: z.object({ arrange: allowance, track: allowance, status: allowance }),
  events: z.array(z.object({ id: z.string(), status: z.enum(TRACKING_STATUSES), description: z.string().nullable(), location: z.string().nullable(), occurredAt: z.string(), recordedAt: z.string() })),
})
export type Transport = z.infer<typeof transportSchema>
export type Arrangement = Transport['arrangement']
export type TransportMode = (typeof OWN_TRANSPORT_MODES)[number]
export type ManualStatus = (typeof MANUAL_EVENT_STATUSES)[number]

const base = (shipmentId: string) => `/shipping/shipments/${encodeURIComponent(shipmentId)}`

export const readTransport = (api: ApiClient, shipmentId: string): Promise<Transport> => api.get(`${base(shipmentId)}/own-transport`, { schema: transportSchema })

export function arrangeTransport(api: ApiClient, shipmentId: string, body: { version: number; mode: TransportMode; carrierName?: string | null; trackingNumber?: string | null }, idempotencyKey: string): Promise<Transport> {
  return api.request('PUT', `${base(shipmentId)}/own-transport`, { body, schema: transportSchema, idempotencyKey })
}

export function typeTrackingNumber(api: ApiClient, shipmentId: string, body: { version: number; trackingNumber: string | null }, idempotencyKey: string): Promise<Transport> {
  return api.request('PUT', `${base(shipmentId)}/own-transport/tracking`, { body, schema: transportSchema, idempotencyKey })
}

export function typeStatus(api: ApiClient, shipmentId: string, body: { version: number; status: ManualStatus; occurredAt?: string; description?: string | null; location?: string | null }, idempotencyKey: string): Promise<Transport> {
  return api.post(`${base(shipmentId)}/own-transport/events`, { body, schema: transportSchema.extend({ recorded: z.object({ eventId: z.string(), moved: z.enum(['DELIVERED', 'RETURNED']).nullable() }) }), idempotencyKey })
}

// ---- the check before printing (LOG-045) -----------------------------------------------------------------------------------------

const problemSchema = z.object({ code: z.enum(CHECK_CODES), parcelSeq: z.number().nullable(), path: z.string(), params: z.record(z.string(), z.union([z.string(), z.number()])) })
export type CheckProblem = z.infer<typeof problemSchema>

export const checkSchema = z.object({
  testMode: z.boolean(),
  applies: z.boolean(),
  notApplying: z.enum(['OWN_VAN', 'CUSTOMER_COLLECTS', 'MANUAL_CARRIER']).nullable(),
  carrier: z.object({ code: z.string().nullable(), name: z.string(), ruleKept: z.boolean() }),
  printable: z.boolean(),
  problems: z.array(problemSchema),
  parcels: z.array(z.object({ parcelId: z.string(), seq: z.number(), labelled: z.boolean(), ok: z.boolean(), problems: z.array(problemSchema) })),
})
export type LabelCheck = z.infer<typeof checkSchema>

export const checkLabels = (api: ApiClient, shipmentId: string): Promise<LabelCheck> => api.get(`${base(shipmentId)}/labels/check`, { schema: checkSchema })

// ---- the label jobs and a reprint with a reason (LOG-027) ------------------------------------------------------------------------

const jobSchema = z.object({
  jobId: z.string(),
  kind: z.enum(LABEL_JOB_KINDS),
  test: z.boolean(),
  scanId: z.string().nullable(),
  status: z.enum(['QUEUED', 'SENT', 'PRINTED', 'FAILED']),
  printer: z.object({ id: z.string(), code: z.string(), name: z.string() }),
  copies: z.number(),
  createdAt: z.string(),
  reprintOfId: z.string().nullable(),
  reason: z.string().nullable(),
  requestedBy: z.object({ by: z.enum(['OFFICE', 'FLOOR', 'SYSTEM']), name: z.string().nullable(), device: z.string().nullable(), hidden: z.boolean() }),
  reprintable: z.boolean(),
  refusal: z.object({ code: z.enum(REPRINT_REFUSALS) }).nullable(),
})
export type LabelJob = z.infer<typeof jobSchema>

export const labelJobsSchema = z.object({
  shipmentId: z.string(),
  number: z.string(),
  status: z.string(),
  parcels: z.array(z.object({ parcelId: z.string(), seq: z.number(), trackingNumber: z.string().nullable(), jobs: z.array(jobSchema) })),
})
export type LabelJobs = z.infer<typeof labelJobsSchema>

export const readLabelJobs = (api: ApiClient, shipmentId: string): Promise<LabelJobs> => api.get(`${base(shipmentId)}/label-jobs`, { schema: labelJobsSchema })

const reprintedSchema = z.object({ reason: z.string(), jobs: z.array(z.object({ jobId: z.string(), reprintOfId: z.string(), seq: z.number(), kind: z.enum(LABEL_JOB_KINDS), test: z.boolean() })) })
export type Reprinted = z.infer<typeof reprintedSchema>

export function reprintLabels(api: ApiClient, shipmentId: string, body: { jobIds: string[]; reason: string }, idempotencyKey: string): Promise<Reprinted> {
  return api.post(`${base(shipmentId)}/label-jobs/reprint`, { body, schema: reprintedSchema, idempotencyKey })
}
