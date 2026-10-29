import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { LABEL_LANGUAGES } from '@nexus/factory-domain/labels/model'
import { BUNDLE_REFUSALS, MAX_BUNDLE_SIZE, MAX_BUNDLES_PER_MAKE } from '@nexus/factory-domain/production/bundles/rules'
import { WORK_ORDER_KINDS, WORK_ORDER_STATUSES } from '@nexus/factory-domain/production/work-orders/machine'
import { labelBody, printJobView } from '../../../platform/print/contract'

/**
 * Bundles and bundle tickets (B-W1-41; MES-065, MES-066, MES-068, MES-073, MES-184; A2 SCR-095, SCR-072). Quantities
 * are garments (whole numbers); a part bundle counts pieces of its part, one per garment. No field carries money or a
 * person: the floor and the office see the same figures. A refusal by a bundle rule is a 409 whose issue path is
 * `refusal/<CODE>` (factory-domain production/bundles/rules BUNDLE_REFUSALS).
 */

const status = z.enum(WORK_ORDER_STATUSES)
const size = () => z.number().int().min(1).max(MAX_BUNDLE_SIZE)
const style = output({ id: id(), code: z.string(), name: z.string() })
const refusal = output({ code: z.enum(BUNDLE_REFUSALS), message: z.string() })

const cell = output({
  workOrderSizeId: id(),
  colourwayCode: z.string(),
  size: z.string(),
  quantity: z.number().int(),
  /** Whole garments cut (every part cut from hides). */
  cut: z.number().int().nullable(),
  /** Garments in ACTIVE bundles of whole garments. */
  bundled: z.number().int(),
  /** Whole garments cut and not yet in a bundle. */
  toBundle: z.number().int(),
  /** The BOM's parts: pieces cut, in bundles (whole and of the part), still to bundle as a part bundle. */
  parts: z.array(output({ part: z.string(), pieces: z.number().int(), bundled: z.number().int(), toBundle: z.number().int() })),
})

const bundle = output({
  id: id(),
  /** The current ticket's code (a BUNDLE scannable id). */
  code: z.string(),
  /** The codes of its earlier tickets, oldest first: a scan of one is refused. */
  replacedCodes: z.array(z.string()),
  workOrderId: id(),
  workOrderSizeId: id(),
  colourwayCode: z.string(),
  size: z.string(),
  /** A part bundle's part; null: whole garments. */
  part: z.string().nullable(),
  quantity: z.number().int(),
  status: z.enum(['ACTIVE', 'VOID']),
  voidedAt: instant().nullable(),
  voidReason: z.string().nullable(),
  /** The cut log entries its pieces come from (genealogy). */
  cutLogIds: z.array(id()),
  deviceId: id().nullable(),
  /** The floor queue's id of the event that made it (A1 §3.8), or null. */
  clientEventId: z.string().nullable(),
  version: z.number().int(),
  createdAt: instant(),
})

const operation = output({ seq: z.number().int(), code: z.string(), name: z.string() })

const ticket = output({
  code: z.string(),
  language: z.enum(LABEL_LANGUAGES),
  maker: z.string().nullable(),
  workOrder: output({ number: z.string(), batchNumber: z.string().nullable() }),
  style: output({ code: z.string(), name: z.string() }),
  colourway: output({ code: z.string(), name: z.string() }),
  size: z.string(),
  quantity: z.number().int(),
  part: z.string().nullable(),
  operations: z.array(operation).readonly(),
})

const ticketAnswer = output({
  bundleId: id(),
  code: z.string(),
  ticket,
  /** The BUNDLE label for the browser's PDF (POST /print/labels/pdf) when no label printer prints it. */
  label: labelBody,
  /** The queued print job (ZPL), or null: see `problem`. */
  job: printJobView.nullable(),
  problem: z.string().nullable(),
})

const printing = {
  /** The label printer; null: the tickets print as PDF; absent: the station's (MES-184), else the site's only ACTIVE one. */
  printerId: id().nullable().optional(),
  language: z.enum(LABEL_LANGUAGES).optional(),
}

const workOrderParams = input({ workOrderId: id() })
const bundleParams = input({ bundleId: id() })

export const bundleWorkOrdersContract = defineContract({
  querystring: input({
    /** A scanned or typed work order number (the traveller): that work order even when nothing waits. */
    number: z.string().trim().min(1).max(60).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(30),
  }),
  response: {
    200: output({
      workOrders: z.array(
        output({
          id: id(),
          number: z.string(),
          batchNumber: z.string().nullable(),
          status,
          siteId: id(),
          dueDate: businessDate().nullable(),
          priority: z.number().int(),
          style,
          /** Whole garments cut and not yet in bundles, over the cells. */
          toBundle: z.number().int(),
          cells: z.array(cell),
        }),
      ),
    }),
  },
})

export const bundlesViewContract = defineContract({
  params: workOrderParams,
  querystring: input({ bundleSize: z.coerce.number().int().min(1).max(MAX_BUNDLE_SIZE).optional() }),
  response: {
    200: output({
      workOrder: output({ id: id(), number: z.string(), batchNumber: z.string().nullable(), status, kind: z.enum(WORK_ORDER_KINDS), companyId: id(), siteId: id(), dueDate: businessDate().nullable(), open: z.boolean(), style }),
      /** The target size of the proposal (asked, else the site's standard bundle size; 1 for a made-to-measure unit). */
      bundleSize: z.number().int(),
      /** The site's standard bundle size (production settings; MES-065). */
      standardBundleSize: z.number().int(),
      singlePiece: z.boolean(),
      /** With the proposed bundles of what each cell still has to bundle. */
      cells: z.array(cell.extend({ proposal: z.array(z.number().int()) })),
      bundles: z.array(bundle.extend({ scans: z.number().int() })),
      operations: z.array(operation.extend({ id: id(), scanRequired: z.boolean() })),
      printers: z.array(output({ id: id(), code: z.string(), name: z.string() })),
      /** The floor device's station's label printer (MES-184), or null. */
      stationPrinterId: id().nullable(),
      /** Where the tickets go when the make names no printer (the station's, else the site's only one); null: name one. */
      defaultPrinterId: id().nullable(),
    }),
  },
})

const ask = input({
  workOrderSizeId: id(),
  /** A part bundle of one of the cell's parts; absent or null: whole garments. */
  part: z.string().trim().min(1).max(80).nullish(),
  /** Garments to bundle (default: all the cell still has to bundle). */
  quantity: z.number().int().min(1).max(10_000).optional(),
  /** The bundles' own quantities, in order (instead of a size). */
  quantities: z.array(size()).min(1).max(MAX_BUNDLES_PER_MAKE).optional(),
  bundleSize: size().optional(),
})

const makeAnswer = output({
  workOrder: output({ id: id(), number: z.string(), status }),
  singlePiece: z.boolean(),
  bundles: z.array(bundle),
  tickets: z.array(ticketAnswer),
  /** Each cell's counts after the bundles. */
  cells: z.array(cell),
  /** The answer to a repeated Idempotency-Key: nothing was made now (the tickets are the same jobs). */
  replayed: z.boolean(),
})

export const makeBundlesContract = defineContract({
  params: workOrderParams,
  body: input({
    /** Per cell (and part); absent: every cell's whole garments cut and not yet in bundles ("all cut, not bundled"). */
    cells: z.array(ask).min(1).max(60).optional(),
    /** The target size (default: the site's standard bundle size; a made-to-measure work order: 1). */
    bundleSize: size().optional(),
    /**
     * The floor queue's id for this event (A1 §3.8; unique in the tenant): the make is then ONE bundle, and a resend
     * under any key answers the bundle it made (200, replayed).
     */
    clientEventId: z.string().trim().min(1).max(80).optional(),
    ...printing,
  }),
  response: { 200: makeAnswer, 201: makeAnswer },
})

export const scanBundleContract = defineContract({
  querystring: input({ code: z.string().trim().min(1).max(60) }),
  response: {
    200: output({
      /** The code as read (canonical when it is a scannable id). */
      scanned: z.string(),
      /** Why this code takes the bundle no more (REPLACED: an old ticket, with the new code; VOIDED), or null. */
      refusal: refusal.nullable(),
      bundle: bundle.extend({ scans: z.number().int() }),
      workOrder: output({ id: id(), number: z.string(), batchNumber: z.string().nullable(), status, siteId: id(), style }),
      operations: z.array(operation.extend({ id: id(), scanRequired: z.boolean(), done: z.boolean() })),
      ticket,
    }),
  },
})

const reprintAnswer = output({ bundle, replacedCode: z.string(), ticket: ticketAnswer, replayed: z.boolean() })

export const reprintBundleContract = defineContract({
  params: bundleParams,
  body: input({
    /** Why: lost, damaged, unreadable … (the reprint's row keeps it: BundleReprint.reason). */
    reason: z.string().trim().min(3).max(200),
    ...printing,
  }),
  response: { 200: reprintAnswer, 201: reprintAnswer },
})

const voidAnswer = output({ bundle, cell, replayed: z.boolean() })

export const voidBundleContract = defineContract({
  params: bundleParams,
  body: input({ reason: z.string().trim().min(3).max(200) }),
  response: { 200: voidAnswer, 201: voidAnswer },
})

export const workOrderBundlesContract = defineContract({
  params: workOrderParams,
  response: {
    200: output({
      workOrder: output({ id: id(), number: z.string(), status, siteId: id() }),
      cells: z.array(cell),
      bundles: z.array(
        bundle.extend({
          scans: z.number().int(),
          /** The operations (seq) it is done at: a standing report. */
          doneAt: z.array(z.number().int()),
          /** Its newest scan: when, at which operation and station (never who). */
          lastScan: output({ at: instant(), operation: output({ seq: z.number().int(), code: z.string() }), station: output({ id: id(), code: z.string(), name: z.string() }).nullable() }).nullable(),
          /** Genealogy: the hides (and lots) of its cut log entries. */
          hides: z.array(output({ hideId: id(), code: z.string(), lotId: id(), lotCode: z.string() })),
          /** Its tickets' print jobs, newest first; null without print.view. */
          tickets: z
            .array(output({ jobId: id(), printerId: id(), scanId: z.string().nullable(), status: z.enum(['QUEUED', 'SENT', 'PRINTED', 'FAILED']), lastError: z.string().nullable(), createdAt: instant() }))
            .nullable(),
          /** Its tickets printed again, oldest first: the new code, the one it replaced, why, where (never who). */
          reprints: z.array(
            output({ code: z.string(), replacedCode: z.string(), reason: z.string(), printerId: id().nullable(), postedBy: z.enum(['FLOOR', 'OFFICE']), at: instant() }),
          ),
        }),
      ),
    }),
  },
})
