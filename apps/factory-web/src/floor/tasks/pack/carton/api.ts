import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'
import { floorRead, floorWrite, seg, taskProblemOf, type TaskOutcome } from '../../shared/task-api'

/**
 * Scan into the carton's calls (B-W2b-387 on B-W2b-384's API, apps/factory-api modules/shipping/cartons): the bench (the
 * size grid ordered against packed, the cartons with their contents, the open carton, the packaging to choose and the
 * suggested one, the hold in force, what packing still needs), one garment scanned in (or queued offline as the floor-sync
 * kind `shipping.carton.scan` under the same client id), one taken out, Close carton (it prints the marks), the marks
 * printed again or made as a PDF here. Every answer is checked against its shape. Never money, a customer or an address.
 */

const instant = z.string()
const PACKAGING_KINDS = ['CARTON', 'BOX', 'PALLET', 'POLYBAG', 'HANGER'] as const
export const BENCH_PROBLEMS = ['NOT_SCANNED', 'SERIALS_NOT_IN_CARTONS', 'CARTON_OPEN', 'MARKS_NOT_PRINTED'] as const
export type BenchProblem = (typeof BENCH_PROBLEMS)[number]

const contentSchema = z.object({
  id: z.string(),
  shipmentLineId: z.string(),
  cellId: z.string(),
  styleCode: z.string(),
  styleName: z.string(),
  colourwayCode: z.string(),
  colourwayName: z.string(),
  size: z.string(),
  quantity: z.number(),
  workOrderNumber: z.string(),
  batchNumber: z.string().nullable(),
  serials: z.array(z.object({ id: z.string(), serial: z.string(), packedAt: instant.nullable() })),
})
export type BenchContent = z.infer<typeof contentSchema>

const cartonSchema = z.object({
  id: z.string(),
  version: z.number(),
  seq: z.number(),
  closed: z.boolean(),
  cartonNumber: z.number().nullable(),
  cartonCount: z.number().nullable(),
  marksPrintedAt: instant.nullable(),
  marksCurrent: z.boolean(),
  labelled: z.boolean(),
  packagingType: z.object({ id: z.string(), name: z.string(), kind: z.enum(PACKAGING_KINDS) }).nullable(),
  grossWeightKg: z.string().nullable(),
  netWeightKg: z.string().nullable(),
  garments: z.number(),
  contents: z.array(contentSchema),
})
export type BenchCarton = z.infer<typeof cartonSchema>

const packagingSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(PACKAGING_KINDS),
  innerLengthCm: z.string().nullable(),
  innerWidthCm: z.string().nullable(),
  innerHeightCm: z.string().nullable(),
  tareKg: z.string().nullable(),
  maxWeightKg: z.string().nullable(),
})
export type BenchPackaging = z.infer<typeof packagingSchema>

export const benchSchema = z.object({
  shipment: z.object({ id: z.string(), number: z.string(), status: z.string(), version: z.number() }),
  hold: z.object({ reason: z.string(), placedAt: instant }).nullable(),
  grid: z.array(
    z.object({
      styleCode: z.string(),
      styleName: z.string(),
      colourwayCode: z.string(),
      colourwayName: z.string(),
      serialTracked: z.boolean(),
      batchNumbers: z.array(z.string()),
      sizes: z.array(z.object({ size: z.string(), cellIds: z.array(z.string()), ordered: z.number(), packed: z.number() })),
    }),
  ),
  cartons: z.array(cartonSchema),
  openCartonId: z.string().nullable(),
  packagingTypes: z.array(packagingSchema),
  suggestedPackagingTypeId: z.string().nullable(),
  problems: z.array(z.enum(BENCH_PROBLEMS)),
})
export type Bench = z.infer<typeof benchSchema>

const scanAnswer = z.object({
  scan: z.object({ kind: z.enum(['SERIAL', 'SKU', 'BATCH']), cellId: z.string(), parcelId: z.string(), cartonSeq: z.number(), serialId: z.string().nullable(), newCarton: z.boolean() }),
  bench: benchSchema,
})
export type ScanAnswer = z.infer<typeof scanAnswer>

const takeOutAnswer = z.object({ takenOut: z.object({ parcelId: z.string(), cartonSeq: z.number(), cellId: z.string(), reopened: z.boolean() }), bench: benchSchema })
export type TakeOutAnswer = z.infer<typeof takeOutAnswer>

const closeAnswer = z.object({
  closed: z.object({ parcelId: z.string(), cartonNumber: z.number(), cartonCount: z.number(), packagingTypeId: z.string(), garments: z.number(), warnings: z.array(z.string()) }),
  marks: z.object({ printed: z.boolean(), jobIds: z.array(z.string()), problem: z.object({ code: z.string(), message: z.string() }).nullable() }),
  bench: benchSchema,
})
export type CloseAnswer = z.infer<typeof closeAnswer>

const marksAnswer = z.object({ jobs: z.array(z.object({ jobId: z.string(), parcelId: z.string() })) })
export type MarksAnswer = z.infer<typeof marksAnswer>

const base = (shipmentId: string) => `/shipping/packing/${seg(shipmentId)}`

export const readBench = (api: ApiClient, shipmentId: string) => floorRead(api, `${base(shipmentId)}/cartons`, { schema: benchSchema })

/** What a scan sends: the same body online and in the queue (the queue adds the tablet's time), so a resend is one scan. */
export interface ScanBody {
  readonly code: string
  /** The cell tapped on the size grid (a batch label names no size). */
  readonly cellId?: string
}

/** One garment into the bench's open carton (else a new one). `key`: the floor's step key of the action's client id. */
export const scanInto = (api: ApiClient, shipmentId: string, body: ScanBody, key: string) => floorWrite(api, 'POST', `${base(shipmentId)}/scan`, { body, schema: scanAnswer, idempotencyKey: key })

export const takeOut = (api: ApiClient, shipmentId: string, parcelId: string, body: { code: string; cellId?: string }, key: string) =>
  floorWrite(api, 'POST', `${base(shipmentId)}/cartons/${seg(parcelId)}/take-out`, { body, schema: takeOutAnswer, idempotencyKey: key })

export const closeCarton = (api: ApiClient, shipmentId: string, parcelId: string, body: { version: number; packagingTypeId?: string; grossWeightKg: string }, key: string) =>
  floorWrite(api, 'POST', `${base(shipmentId)}/cartons/${seg(parcelId)}/close`, { body, schema: closeAnswer, idempotencyKey: key })

/** The marks of the closed cartons whose marks are not current (or those named), on the station's label printer. */
export const printMarks = (api: ApiClient, shipmentId: string, parcelIds: readonly string[] | null, key: string) =>
  floorWrite(api, 'POST', `${base(shipmentId)}/cartons/marks/print`, { body: parcelIds && parcelIds.length > 0 ? { parcelIds } : {}, schema: marksAnswer, idempotencyKey: key })

/** The same marks as one PDF, made here (recorded as printed): its bytes, or the problem. */
export async function marksPdf(api: ApiClient, shipmentId: string, parcelIds: readonly string[], key: string): Promise<TaskOutcome<Uint8Array>> {
  try {
    await api.get('/auth/csrf')
    return { ok: true, value: await api.bytes(`${base(shipmentId)}/cartons/marks/pdf`, { method: 'POST', body: { parcelIds }, idempotencyKey: key }) }
  } catch (error) {
    return { ok: false, problem: taskProblemOf(error) }
  }
}
