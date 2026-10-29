import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { GARMENT_SERIAL_STATUSES, GARMENT_TRACKINGS, LABEL_LOG_KINDS, LABEL_REFUSALS, MAX_BATCH_LABELS, MAX_SERIALS_AT_ONCE, REASON_MAX, REASON_MIN } from '@nexus/factory-domain/production/serials/rules'
import { WORK_ORDER_STATUSES } from '@nexus/factory-domain/production/work-orders/machine'
import { renderedLabelView } from '../../compliance/labels/contract'
import { printJobView } from '../../../platform/print/contract'

/**
 * Batch or serial at the final operation and the garment labels (B-W1-44; MES-076, PRD-348, QHS-051, PRD-331; A2 SCR-096,
 * SCR-072). Counts are garments (whole numbers). No field carries money or names a person: the floor and the office see
 * the same figures; the label log says FLOOR or OFFICE and the device. A refusal by a label rule is a 409 whose first
 * issue path is `refusal/<CODE>` (factory-domain production/serials/rules LABEL_REFUSALS), then `fix`, then the other
 * cells' refusals as `cells/<workOrderSizeId>/<CODE>`.
 */

const status = z.enum(WORK_ORDER_STATUSES)
const reason = () => z.string().trim().min(REASON_MIN).max(REASON_MAX)
const refusal = output({ code: z.enum(LABEL_REFUSALS), message: z.string(), fix: z.string(), workOrderSizeId: id().nullable() })
const jobState = z.enum(['QUEUED', 'SENT', 'PRINTED', 'FAILED'])
const job = output({ jobId: id(), printerId: id(), scanId: z.string().nullable(), copies: z.number().int(), status: jobState, lastError: z.string().nullable(), createdAt: instant() })

const cell = output({
  workOrderSizeId: id(),
  colourwayId: id(),
  colourwayCode: z.string(),
  colourwayName: z.string(),
  size: z.string(),
  quantity: z.number().int(),
  /** Good garments at the final operation; null: the routing has no scanned operation. */
  finished: z.number().int().nullable(),
  /** BATCH: labels printed (reprints apart); SERIAL: live (not VOID) serials. */
  labelled: z.number().int(),
  /** Labels printed again. */
  reprinted: z.number().int(),
  /** Finished garments without a label yet. */
  toLabel: z.number().int(),
  /** Labels above what is finished now (an undo or correction at the final operation after the print). */
  overLabelled: z.number().int(),
})

const serial = output({
  id: id(),
  /** The tenant's SERIAL scannable id printed on the label. */
  serial: z.string(),
  status: z.enum(GARMENT_SERIAL_STATUSES),
  workOrderId: id(),
  workOrderSizeId: id(),
  releaseId: id().nullable(),
  shipmentLineId: id().nullable(),
  voidedAt: instant().nullable(),
  voidReason: z.string().nullable(),
  /** The bundle its garment came in (genealogy: the bundle's cut log entries and hides). */
  bundle: output({ id: id(), code: z.string() }).nullable(),
  version: z.number().int(),
  createdAt: instant(),
  /** Its labels' print jobs, newest first; null where not shown (no print.view, or a write's answer). */
  jobs: z.array(job).nullable(),
})

const queued = { job: printJobView.nullable(), problem: z.string().nullable() }
const printedLine = output({
  entryId: id(),
  workOrderSizeId: id(),
  colourwayCode: z.string(),
  size: z.string(),
  count: z.number().int(),
  batchNumber: z.string(),
  /** SERIAL: the serials given (or printed again), each with its own print job. */
  serials: z.array(output({ id: id(), serial: z.string(), bundleId: id().nullable(), ...queued })),
  /** BATCH: the one job of `count` copies (SERIAL: null, see each serial). */
  ...queued,
})

const workOrderParams = input({ workOrderId: id() })
const serialParams = input({ serialId: id() })
/** The label printer; absent: the site's only ACTIVE label printer whose stock holds the label. */
const printerId = id().optional()

export const labelsViewContract = defineContract({
  params: workOrderParams,
  querystring: input({ cellId: id().optional() }),
  response: {
    200: output({
      workOrder: output({ id: id(), number: z.string(), batchNumber: z.string().nullable(), status, siteId: id(), releasedAt: instant().nullable(), style: output({ id: id(), code: z.string(), name: z.string() }) }),
      tracking: z.enum(GARMENT_TRACKINGS),
      /** The label template frozen at the release. */
      label: output({ id: id(), code: z.string(), revision: z.number().int(), status: z.string(), widthMm: z.string(), heightMm: z.string() }).nullable(),
      finalOperation: output({ id: id(), seq: z.number().int(), code: z.string(), name: z.string() }).nullable(),
      /** The day the certificate gate is asked for. */
      date: businessDate(),
      blocked: refusal.nullable(),
      cells: z.array(
        cell.extend({
          gate: output({
            outcome: z.enum(['covered', 'not_required', 'refused']),
            certificate: output({ id: id(), number: z.string(), standard: z.string(), ppeClass: z.string().nullable(), validTo: businessDate() }).nullable(),
            words: z.string(),
          }),
          /** Its label prints today (the gate and every other label rule). */
          printable: z.boolean(),
          refusal: refusal.nullable(),
        }),
      ),
      printers: z.array(output({ id: id(), code: z.string(), name: z.string(), labelWidthMm: z.number().int().nullable(), labelHeightMm: z.number().int().nullable(), holdsLabel: z.boolean() })),
      /** The label of `cellId` as it prints (a SERIAL style: with a stand-in serial of the longest form). */
      preview: renderedLabelView.nullable(),
    }),
  },
})

export const scanContract = defineContract({
  querystring: input({ code: z.string().trim().min(1).max(60) }),
  response: {
    200: output({
      scanned: z.string(),
      kind: z.enum(['BUNDLE', 'SERIAL', 'WORK_ORDER']),
      workOrderId: id(),
      number: z.string(),
      /** The cell of the bundle or serial; null for a work order number. */
      workOrderSizeId: id().nullable(),
      bundle: output({ id: id(), code: z.string(), status: z.enum(['ACTIVE', 'VOID']) }).nullable(),
      serial: serial.nullable(),
    }),
  },
})

const printAnswer = output({
  workOrder: output({ id: id(), number: z.string(), status, batchNumber: z.string() }),
  tracking: z.enum(GARMENT_TRACKINGS),
  printerId: id(),
  printed: z.array(printedLine),
  /** The sizes the certificate gate (or another label rule) refused today, in its words: they printed nothing. */
  refused: z.array(refusal),
  /** Each cell after the print. */
  cells: z.array(cell),
  /** The answer to a repeated Idempotency-Key: nothing was given now (the labels are the same jobs). */
  replayed: z.boolean(),
})

export const printLabelsContract = defineContract({
  params: workOrderParams,
  body: input({
    /** Per cell, with a count (default: all its finished garments without a label); absent: "Print all". */
    cells: z
      .array(input({ workOrderSizeId: id(), count: z.number().int().min(1).max(Math.max(MAX_BATCH_LABELS, MAX_SERIALS_AT_ONCE)).optional() }))
      .min(1)
      .max(60)
      .optional(),
    printerId,
  }),
  response: { 200: printAnswer, 201: printAnswer },
})

const reprintCellAnswer = output({ workOrder: output({ id: id(), number: z.string(), status, batchNumber: z.string() }), printerId: id(), reprinted: printedLine, cells: z.array(cell), replayed: z.boolean() })

export const reprintCellContract = defineContract({
  params: workOrderParams,
  body: input({ workOrderSizeId: id(), count: z.number().int().min(1).max(MAX_BATCH_LABELS), reason: reason(), printerId }),
  response: { 200: reprintCellAnswer, 201: reprintCellAnswer },
})

const reprintSerialAnswer = output({ serial, printerId: id(), reprinted: printedLine, replayed: z.boolean() })

export const reprintSerialContract = defineContract({
  params: serialParams,
  body: input({ reason: reason(), printerId }),
  response: { 200: reprintSerialAnswer, 201: reprintSerialAnswer },
})

const voidAnswer = output({ serial, cell, replayed: z.boolean() })

export const voidSerialContract = defineContract({
  params: serialParams,
  body: input({ reason: reason() }),
  response: { 200: voidAnswer, 201: voidAnswer },
})

export const workOrderSerialsContract = defineContract({
  params: workOrderParams,
  response: {
    200: output({
      workOrder: output({ id: id(), number: z.string(), batchNumber: z.string().nullable(), status, siteId: id() }),
      tracking: z.enum(GARMENT_TRACKINGS),
      /** BATCH: each cell's label jobs; null without print.view. */
      cells: z.array(cell.extend({ jobs: z.array(job).nullable() })),
      serials: z.array(serial),
      /** Every print and reprint, newest first. */
      log: z.array(
        output({
          entryId: id(),
          kind: z.enum(LABEL_LOG_KINDS),
          tracking: z.enum(GARMENT_TRACKINGS),
          workOrderSizeId: id(),
          colourwayCode: z.string(),
          size: z.string(),
          quantity: z.number().int(),
          batchNumber: z.string().nullable(),
          serials: z.array(z.string()),
          reason: z.string().nullable(),
          printerId: id().nullable(),
          postedBy: z.enum(['FLOOR', 'OFFICE', 'SYSTEM']),
          deviceId: id().nullable(),
          at: instant(),
        }),
      ),
    }),
  },
})
