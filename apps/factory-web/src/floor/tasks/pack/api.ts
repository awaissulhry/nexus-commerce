import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'
import { newIdempotencyKey } from '../../../lib/api/client'
import { floorRead, floorWrite, seg } from '../shared/task-api'

/**
 * The packing bench's calls (SCR-098; apps/factory-api modules/shipping/packing and labels, production/serials' scan
 * lookup, platform/print): the site's shipments to pack, one shipment as a packer sees it (lines, cartons, the office's
 * documents — never a customer, an order or an address: the floor reads none), cartons, garments into cartons (a line
 * of a cell, or a serial), packed ⇄ unpacked, the carrier labels with their print state, the office's DDT and packing
 * list on the station's printer, and the print jobs. Every answer is checked against its shape (unknown fields are
 * dropped). Packing is not in the floor's offline queue: every write needs the network. No money anywhere.
 */

const instant = z.string()
const transportBy = z.enum(['SENDER', 'RECIPIENT', 'CARRIER'])
const shipmentStatus = z.enum(['DRAFT', 'PACKED', 'SHIPPED', 'DELIVERED', 'RETURNED', 'CANCELLED'])

export const packingRowSchema = z.object({
  id: z.string(),
  number: z.string(),
  status: shipmentStatus,
  version: z.number(),
  siteId: z.string(),
  transportBy,
  carrierCode: z.string().nullable(),
  lines: z.number(),
  garments: z.number(),
  parcels: z.number(),
  packedAt: instant.nullable(),
  createdAt: instant,
})
export type PackingRow = z.infer<typeof packingRowSchema>
const queueAnswer = z.object({ shipments: z.array(packingRowSchema) })

export const packLineSchema = z.object({
  id: z.string(),
  version: z.number(),
  parcelId: z.string().nullable(),
  workOrderId: z.string(),
  workOrderNumber: z.string(),
  batchNumber: z.string().nullable(),
  workOrderSizeId: z.string(),
  styleCode: z.string(),
  styleName: z.string(),
  colourwayCode: z.string(),
  colourwayName: z.string(),
  size: z.string(),
  quantity: z.number(),
  serialTracked: z.boolean(),
  serials: z.array(z.object({ id: z.string(), serial: z.string() })),
})
export type PackLine = z.infer<typeof packLineSchema>

export const packParcelSchema = z.object({
  id: z.string(),
  version: z.number(),
  seq: z.number(),
  grossWeightKg: z.string().nullable(),
  lengthCm: z.string().nullable(),
  widthCm: z.string().nullable(),
  heightCm: z.string().nullable(),
  trackingNumber: z.string().nullable(),
  labelledAt: instant.nullable(),
  garments: z.number(),
})
export type PackParcel = z.infer<typeof packParcelSchema>

export const packingSchema = z.object({
  id: z.string(),
  number: z.string(),
  status: shipmentStatus,
  version: z.number(),
  siteId: z.string(),
  transportBy,
  carrierCode: z.string().nullable(),
  serviceCode: z.string().nullable(),
  packedAt: instant.nullable(),
  lines: z.array(packLineSchema),
  parcels: z.array(packParcelSchema),
  garments: z.number(),
  documents: z
    .object({
      ddt: z.object({ id: z.string(), number: z.string(), documentDate: z.string(), fileId: z.string().nullable() }).nullable(),
      packingList: z.object({ fileId: z.string(), createdAt: instant }).nullable(),
    })
    .default({ ddt: null, packingList: null }),
  settings: z.object({ cutOffTime: z.string().nullable(), labelPrinterId: z.string().nullable(), documentPrinterId: z.string().nullable() }).nullable(),
})
export type Packing = z.infer<typeof packingSchema>
const packingAnswer = z.object({ shipment: packingSchema })
const parcelAnswer = z.object({ shipment: packingSchema, parcelId: z.string() })

export const labelsSchema = z.object({
  labelPrinterId: z.string().nullable(),
  toLabel: z.number(),
  cutOff: z.object({ time: z.string(), at: instant, passed: z.boolean() }).nullable(),
  parcels: z.array(
    z.object({
      parcelId: z.string(),
      seq: z.number(),
      trackingNumber: z.string().nullable(),
      labelledAt: instant.nullable(),
      print: z.object({ jobId: z.string(), status: z.string(), createdAt: instant }).nullable(),
    }),
  ),
})
export type Labels = z.infer<typeof labelsSchema>

export const JOB_STATUSES = ['QUEUED', 'SENT', 'PRINTED', 'FAILED'] as const
export type JobStatus = (typeof JOB_STATUSES)[number]
export const printJobSchema = z.object({ id: z.string(), status: z.enum(JOB_STATUSES), lastError: z.string().nullable(), copies: z.number(), version: z.number() })
export type PrintJob = z.infer<typeof printJobSchema>
const jobAnswer = z.object({ job: printJobSchema })

const labelsPrintAnswer = z.object({ jobs: z.array(z.object({ jobId: z.string(), parcelId: z.string(), seq: z.number(), status: z.string() })) })
export type LabelsPrinted = z.infer<typeof labelsPrintAnswer>
const documentsPrintAnswer = z.object({ jobs: z.array(z.object({ jobId: z.string(), document: z.enum(['DDT', 'PACKING_LIST']), status: z.string() })) })
export type DocumentsPrinted = z.infer<typeof documentsPrintAnswer>

/** What a scanned serial is (production/serials' lookup): its cell, its state, the shipment line it is packed on. */
export const serialScanSchema = z.object({
  kind: z.enum(['BUNDLE', 'SERIAL', 'WORK_ORDER']),
  workOrderSizeId: z.string().nullable(),
  serial: z.object({ id: z.string(), serial: z.string(), status: z.string(), workOrderSizeId: z.string(), shipmentLineId: z.string().nullable() }).nullable(),
})
export type SerialScan = z.infer<typeof serialScanSchema>

export const freshKey = (): string => newIdempotencyKey()
const base = (shipmentId: string) => `/shipping/packing/${seg(shipmentId)}`

// ---- reads ---------------------------------------------------------------------------------------------------------------

export const listPacking = (api: ApiClient) => floorRead(api, '/shipping/packing', { schema: queueAnswer })

export const readPacking = (api: ApiClient, shipmentId: string) => floorRead(api, base(shipmentId), { schema: packingAnswer })

export const readLabels = (api: ApiClient, shipmentId: string) => floorRead(api, `/shipping/shipments/${seg(shipmentId)}/labels`, { schema: labelsSchema })

export const readJob = (api: ApiClient, jobId: string) => floorRead(api, `/print/jobs/${seg(jobId)}`, { schema: jobAnswer })

export const lookupSerial = (api: ApiClient, code: string) => floorRead(api, '/production/serials/scan', { query: { code }, schema: serialScanSchema })

// ---- writes (each keeps its Idempotency-Key when it is sent again) -----------------------------------------------------------

export const addParcel = (api: ApiClient, shipmentId: string, version: number, key = freshKey()) => floorWrite(api, 'POST', `${base(shipmentId)}/parcels`, { body: { version }, schema: parcelAnswer, idempotencyKey: key })

export const weighParcel = (api: ApiClient, shipmentId: string, parcelId: string, body: { version: number; grossWeightKg: string | null }, key = freshKey()) =>
  floorWrite(api, 'PATCH', `${base(shipmentId)}/parcels/${seg(parcelId)}`, { body, schema: packingAnswer, idempotencyKey: key })

export const removeParcel = (api: ApiClient, shipmentId: string, parcelId: string, version: number, key = freshKey()) =>
  floorWrite(api, 'DELETE', `${base(shipmentId)}/parcels/${seg(parcelId)}?version=${version}`, { schema: packingAnswer, idempotencyKey: key })

export const placeLine = (api: ApiClient, shipmentId: string, lineId: string, body: { version: number; parcelId: string | null; quantity?: number }, key = freshKey()) =>
  floorWrite(api, 'PUT', `${base(shipmentId)}/lines/${seg(lineId)}/parcel`, { body, schema: packingAnswer, idempotencyKey: key })

export const packSerial = (api: ApiClient, shipmentId: string, body: { version: number; serial: string; parcelId?: string }, key = freshKey()) =>
  floorWrite(api, 'POST', `${base(shipmentId)}/serials`, { body, schema: packingAnswer, idempotencyKey: key })

export const markPacked = (api: ApiClient, shipmentId: string, version: number, key = freshKey()) => floorWrite(api, 'POST', `${base(shipmentId)}/pack`, { body: { version }, schema: packingAnswer, idempotencyKey: key })

export const markUnpacked = (api: ApiClient, shipmentId: string, version: number, key = freshKey()) => floorWrite(api, 'POST', `${base(shipmentId)}/unpack`, { body: { version }, schema: packingAnswer, idempotencyKey: key })

export const printLabels = (api: ApiClient, shipmentId: string, key = freshKey()) => floorWrite(api, 'POST', `/shipping/shipments/${seg(shipmentId)}/labels/print`, { body: {}, schema: labelsPrintAnswer, idempotencyKey: key })

export const printDocuments = (api: ApiClient, shipmentId: string, key = freshKey()) => floorWrite(api, 'POST', `${base(shipmentId)}/documents/print`, { body: {}, schema: documentsPrintAnswer, idempotencyKey: key })

export const retryJob = (api: ApiClient, job: Pick<PrintJob, 'id' | 'version'>) => floorWrite(api, 'POST', `/print/jobs/${seg(job.id)}/retry`, { body: { version: job.version }, schema: jobAnswer })
