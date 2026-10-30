import { z } from 'zod'
import { GARMENT_TRACKINGS, LABEL_REFUSALS } from '@nexus/factory-domain/production/serials/rules'
import type { ApiClient } from '../../../lib/api/client'
import { newIdempotencyKey } from '../../../lib/api/client'
import { floorRead, floorWrite, seg } from '../shared/task-api'

/**
 * The garment labels' calls at the final operation (SCR-096; apps/factory-api modules/production/serials, platform/print):
 * what a scanned code names (a work order's traveller, a bundle ticket, a garment's serial), one work order's labels —
 * per colour and size what is finished, labelled and still to label, the certificate gate on the day, the label
 * printers, the label of one size as it prints — the print (one size, or all), the reprint with a reason (a size's
 * batch labels, or one serial), and each print job's state with Retry. Every answer is checked against its shape (zod;
 * unknown fields are dropped). Online only: garment labels never queue (each print is logged by the office at once).
 * No money and no person's name in any answer.
 */

export const TRACKINGS = GARMENT_TRACKINGS
export type Tracking = (typeof GARMENT_TRACKINGS)[number]
export type RefusalCode = (typeof LABEL_REFUSALS)[number]

const refusal = z.object({ code: z.string(), message: z.string(), fix: z.string(), workOrderSizeId: z.string().nullable() })
export type Refusal = z.infer<typeof refusal>

const cell = z.object({
  workOrderSizeId: z.string(),
  colourwayId: z.string(),
  colourwayCode: z.string(),
  colourwayName: z.string(),
  size: z.string(),
  quantity: z.number(),
  finished: z.number().nullable(),
  labelled: z.number(),
  reprinted: z.number(),
  toLabel: z.number(),
  overLabelled: z.number(),
})
export type Cell = z.infer<typeof cell>

const graphic = z
  .union([
    z.object({ kind: z.literal('CE'), notifiedBodyNumber: z.string().nullable() }),
    z.object({ kind: z.literal('PICTOGRAM'), pictogram: z.string(), standardCode: z.string().nullable(), ppeClass: z.string().nullable() }),
    z.object({ kind: z.literal('CARE'), symbols: z.array(z.object({ code: z.string(), mark: z.string(), words: z.string() })) }),
    z.object({ kind: z.literal('BARCODE'), value: z.string().nullable() }),
  ])
  .nullable()

export const renderedLabelSchema = z.object({
  template: z.object({ id: z.string(), code: z.string(), revision: z.number(), status: z.string(), name: z.string() }),
  sample: z.boolean(),
  banner: z.array(z.string()),
  preset: z.string(),
  languages: z.array(z.string()),
  blocks: z.array(
    z.object({
      field: z.string(),
      value: z.string().nullable(),
      lines: z.array(z.object({ text: z.string(), language: z.string().nullable() })),
      graphic,
      placeholder: z.boolean(),
    }),
  ),
  fit: z.object({ widthMm: z.string(), heightMm: z.string(), fits: z.boolean() }).nullable(),
  printable: z.boolean(),
})
export type RenderedLabel = z.infer<typeof renderedLabelSchema>

export const labelsViewSchema = z.object({
  workOrder: z.object({ id: z.string(), number: z.string(), batchNumber: z.string().nullable(), status: z.string(), siteId: z.string(), releasedAt: z.string().nullable(), style: z.object({ id: z.string(), code: z.string(), name: z.string() }) }),
  tracking: z.enum(GARMENT_TRACKINGS),
  label: z.object({ id: z.string(), code: z.string(), revision: z.number(), status: z.string(), widthMm: z.string(), heightMm: z.string() }).nullable(),
  finalOperation: z.object({ id: z.string(), seq: z.number(), code: z.string(), name: z.string() }).nullable(),
  date: z.string(),
  blocked: refusal.nullable(),
  cells: z.array(
    cell.extend({
      gate: z.object({
        outcome: z.enum(['covered', 'not_required', 'refused']),
        certificate: z.object({ id: z.string(), number: z.string(), standard: z.string(), ppeClass: z.string().nullable(), validTo: z.string() }).nullable(),
        words: z.string(),
      }),
      printable: z.boolean(),
      refusal: refusal.nullable(),
    }),
  ),
  printers: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), labelWidthMm: z.number().nullable(), labelHeightMm: z.number().nullable(), holdsLabel: z.boolean() })),
  preview: renderedLabelSchema.nullable(),
})
export type LabelsView = z.infer<typeof labelsViewSchema>
export type ViewCell = LabelsView['cells'][number]
export type LabelPrinter = LabelsView['printers'][number]

const serialSchema = z.object({ id: z.string(), serial: z.string(), status: z.string(), workOrderSizeId: z.string(), releaseId: z.string().nullable(), shipmentLineId: z.string().nullable() })
export type SerialRef = z.infer<typeof serialSchema>

export const scanSchema = z.object({
  scanned: z.string(),
  kind: z.enum(['BUNDLE', 'SERIAL', 'WORK_ORDER']),
  workOrderId: z.string(),
  number: z.string(),
  workOrderSizeId: z.string().nullable(),
  bundle: z.object({ id: z.string(), code: z.string(), status: z.string() }).nullable(),
  serial: serialSchema.nullable(),
})
export type ScanAnswer = z.infer<typeof scanSchema>

export const JOB_STATUSES = ['QUEUED', 'SENT', 'PRINTED', 'FAILED'] as const
export type JobStatus = (typeof JOB_STATUSES)[number]
export const printJobSchema = z.object({ id: z.string(), status: z.enum(JOB_STATUSES), lastError: z.string().nullable(), copies: z.number(), version: z.number() })
export type PrintJob = z.infer<typeof printJobSchema>
const jobAnswer = z.object({ job: printJobSchema })

const printedLine = z.object({
  entryId: z.string(),
  workOrderSizeId: z.string(),
  colourwayCode: z.string(),
  size: z.string(),
  count: z.number(),
  batchNumber: z.string(),
  serials: z.array(z.object({ id: z.string(), serial: z.string(), job: printJobSchema.nullable(), problem: z.string().nullable() })),
  job: printJobSchema.nullable(),
  problem: z.string().nullable(),
})
export type PrintedLine = z.infer<typeof printedLine>

const printAnswer = z.object({ printerId: z.string(), printed: z.array(printedLine), refused: z.array(refusal), cells: z.array(cell), replayed: z.boolean() })
export type PrintAnswer = z.infer<typeof printAnswer>
const reprintCellAnswer = z.object({ printerId: z.string(), reprinted: printedLine, cells: z.array(cell), replayed: z.boolean() })
export type ReprintCellAnswer = z.infer<typeof reprintCellAnswer>
const reprintSerialAnswer = z.object({ printerId: z.string(), reprinted: printedLine, replayed: z.boolean() })
export type ReprintSerialAnswer = z.infer<typeof reprintSerialAnswer>

export const freshKey = (): string => newIdempotencyKey()
const base = (workOrderId: string) => `/production/serials/work-orders/${seg(workOrderId)}`

// ---- reads ---------------------------------------------------------------------------------------------------------------

/** A scanned or typed code: a work order's traveller (its number), a bundle ticket or a garment's serial. */
export const scanCode = (api: ApiClient, code: string) => floorRead(api, '/production/serials/scan', { query: { code }, schema: scanSchema })

/** One work order's labels, with the label of `cellId` as it prints. */
export const readLabels = (api: ApiClient, workOrderId: string, cellId: string | null) => floorRead(api, base(workOrderId), { query: { cellId: cellId ?? undefined }, schema: labelsViewSchema })

export const readJob = (api: ApiClient, jobId: string) => floorRead(api, `/print/jobs/${seg(jobId)}`, { schema: jobAnswer })

// ---- writes (each keeps its Idempotency-Key when it is sent again) -----------------------------------------------------------

/** Print one size (its finished garments without a label), or every size (`cells` null: "Print all"). */
export const printLabels = (api: ApiClient, workOrderId: string, body: { cells: { workOrderSizeId: string }[] | null; printerId: string | null }, key: string) =>
  floorWrite(api, 'POST', `${base(workOrderId)}/labels`, { body: { ...(body.cells ? { cells: body.cells } : {}), ...(body.printerId ? { printerId: body.printerId } : {}) }, schema: printAnswer, idempotencyKey: key })

/** A BATCH size's labels again, with the reason (never more than were printed). */
export const reprintCell = (api: ApiClient, workOrderId: string, body: { workOrderSizeId: string; count: number; reason: string; printerId: string | null }, key: string) =>
  floorWrite(api, 'POST', `${base(workOrderId)}/reprint`, { body: { workOrderSizeId: body.workOrderSizeId, count: body.count, reason: body.reason, ...(body.printerId ? { printerId: body.printerId } : {}) }, schema: reprintCellAnswer, idempotencyKey: key })

/** One serial's label again (the same serial), with the reason. */
export const reprintSerial = (api: ApiClient, serialId: string, body: { reason: string; printerId: string | null }, key: string) =>
  floorWrite(api, 'POST', `/production/serials/${seg(serialId)}/reprint`, { body: { reason: body.reason, ...(body.printerId ? { printerId: body.printerId } : {}) }, schema: reprintSerialAnswer, idempotencyKey: key })

export const retryJob = (api: ApiClient, job: Pick<PrintJob, 'id' | 'version'>) => floorWrite(api, 'POST', `/print/jobs/${seg(job.id)}/retry`, { body: { version: job.version }, schema: jobAnswer })
