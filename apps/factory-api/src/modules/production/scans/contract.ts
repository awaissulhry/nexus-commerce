import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { WORK_CENTRE_KINDS } from '@nexus/factory-domain/product/routing/operations'
import { DEFECT_KINDS, REASON_CODE } from '@nexus/factory-domain/production/scans/reasons'
import { CLIENT_SCAN_ID, MAX_BATCH_ITEMS, SCAN_REFUSALS } from '@nexus/factory-domain/production/scans/rules'
import { WORK_ORDER_STATUSES } from '@nexus/factory-domain/production/work-orders/machine'
import { CORRECTION_STATUSES } from './corrections-store'
import { REFUSED_ACTIONS } from './refusals-store'

/**
 * Operation scans (B-W1-42; MES-069, MES-090, MES-095, MES-096, MES-167, MES-308; A2 SCR-090, SCR-072, SCR-073,
 * SCR-023). Counts are garments (whole numbers). No field carries money; no floor answer names a worker: the floor sees
 * `own` (its own scan) or a station, the office one record's worker by name. A refusal by a scan rule is a 409 whose
 * issues are `refusal/<CODE>` (factory-domain production/scans/rules SCAN_REFUSALS) with its words and `fix` with the
 * one fix; in a batch it is the item's `refusal` (code, words, fix, final).
 */

const status = z.enum(WORK_ORDER_STATUSES)
const kind = z.enum(['REPORT', 'UNDO', 'CORRECTION'])
const count = () => z.number().int().min(0).max(100_000)
const clientScanId = () => z.string().regex(CLIENT_SCAN_ID, 'Expected 8 to 64 letters, digits, dots, colons, underscores or hyphens.')
const defectIn = input({ reason: z.string().regex(REASON_CODE), quantity: z.number().int().min(1).max(100_000) })
const defects = () => z.array(defectIn).max(60).optional()
const defectLine = output({ kind: z.enum(DEFECT_KINDS), reason: z.string(), quantity: z.number().int() })

const operationRef = output({ id: id(), seq: z.number().int(), code: z.string(), name: z.string() })

const scan = output({
  id: id(),
  kind,
  workOrderId: id(),
  bundleId: id(),
  bundleCode: z.string(),
  operation: operationRef,
  /** UNDO, CORRECTION: the scan it voids. */
  correctsId: id().nullable(),
  goodQuantity: z.number().int(),
  scrapQuantity: z.number().int(),
  reworkQuantity: z.number().int(),
  /** The scrap and rework lines: one per reason with its garments. */
  defects: z.array(defectLine),
  /** UNDO and CORRECTION: why; a REPORT at a station of another kind of work: why it was done there. */
  reason: z.string().nullable(),
  stationId: id().nullable(),
  deviceId: id().nullable(),
  clientScanId: z.string(),
  deviceTime: instant().nullable(),
  serverTime: instant(),
  /** A floor REPORT: the last moment its undo is taken (or the next scan on the device, whichever first). */
  undoUntil: instant().nullable(),
})

const request = output({
  id: id(),
  status: z.enum(CORRECTION_STATUSES),
  workOrderId: id(),
  bundleId: id(),
  workOrderOperationId: id(),
  /** The scan it asks to correct. */
  scanId: id(),
  goodQuantity: z.number().int(),
  scrapQuantity: z.number().int(),
  reworkQuantity: z.number().int(),
  defects: z.array(defectLine),
  reason: z.string(),
  stationId: id().nullable(),
  deviceId: id().nullable(),
  clientRequestId: z.string(),
  deviceTime: instant().nullable(),
  serverTime: instant(),
  decidedAt: instant().nullable(),
  decisionNote: z.string().nullable(),
  /** APPROVED: the CORRECTION scan it wrote. */
  correctionScanId: id().nullable(),
})

const refusal = output({ code: z.enum(SCAN_REFUSALS), message: z.string(), fix: z.string(), final: z.boolean() })

const refusalRow = output({
  id: id(),
  deviceId: id(),
  clientScanId: z.string(),
  action: z.enum(REFUSED_ACTIONS),
  code: z.string(),
  message: z.string(),
  fix: z.string(),
  /** False: the queue sends it again by itself. */
  final: z.boolean(),
  workOrderId: id().nullable(),
  bundleId: id().nullable(),
  workOrderOperationId: id().nullable(),
  scanned: z.string().nullable(),
  goodQuantity: z.number().int(),
  scrapQuantity: z.number().int(),
  reworkQuantity: z.number().int(),
  stationId: id().nullable(),
  deviceTime: instant().nullable(),
  serverTime: instant(),
  discardedAt: instant().nullable(),
  /** The scan (or correction request) the same client scan id became when sent again and accepted. */
  resolvedByScanId: id().nullable(),
  resolvedByRequestId: id().nullable(),
})

const reason = output({ kind: z.enum(DEFECT_KINDS), code: z.string(), label: output({ it: z.string(), en: z.string() }), sortOrder: z.number().int() })

const scanAnswer = output({ scan, replayed: z.boolean() })
const requestAnswer = output({ request, replayed: z.boolean() })

const report = {
  /** The scanned ticket's code (current or replaced: an old one is refused with the new code), or the bundle's id. */
  code: z.string().trim().min(1).max(60).optional(),
  bundleId: id().optional(),
  /** The operation; absent: the one this station does next for the bundle (refused when two fit: CHOOSE_OPERATION). */
  workOrderOperationId: id().optional(),
  good: count(),
  /** One line per scrap reason with its garments (reason-first counting). */
  scrap: defects(),
  rework: defects(),
  /** Why a station reports an operation of another kind of work (kept on the scan). */
  kindReason: z.string().trim().min(3).max(200).optional(),
}

const timed = {
  /** The device's id for this action (A1 §3.8), unique per device: a resend is answered, never applied twice. */
  clientScanId: clientScanId(),
  /** When it happened, by the device's clock (kept beside the server's time). */
  occurredAt: instant().optional(),
}

const askBody = {
  good: count(),
  scrap: defects(),
  rework: defects(),
  reason: z.string().trim().min(3).max(300),
}

const scanParams = input({ scanId: id() })
const requestParams = input({ requestId: id() })
const refusalParams = input({ refusalId: id() })
const workOrderParams = input({ workOrderId: id() })

export const reasonsContract = defineContract({ response: { 200: output({ reasons: z.array(reason) }) } })

export const cardContract = defineContract({
  querystring: input({ code: z.string().trim().min(1).max(60) }),
  response: {
    200: output({
      scanned: z.string(),
      /** Why this code takes the bundle no more (REPLACED, VOIDED) or its work order is not open, or null. */
      refusal: output({ code: z.string(), message: z.string() }).nullable(),
      bundle: output({ id: id(), code: z.string(), status: z.enum(['ACTIVE', 'VOID']), quantity: z.number().int(), part: z.string().nullable(), workOrderSizeId: id(), colourwayCode: z.string(), colourwayName: z.string(), size: z.string() }),
      workOrder: output({ id: id(), number: z.string(), batchNumber: z.string().nullable(), status, siteId: id(), style: output({ code: z.string(), name: z.string() }) }),
      station: output({ id: id(), code: z.string(), name: z.string(), kind: z.enum(WORK_CENTRE_KINDS) }).nullable(),
      operations: z.array(
        operationRef.extend({
          scanRequired: z.boolean(),
          workCentreKind: z.enum(WORK_CENTRE_KINDS),
          final: z.boolean(),
          sewn: z.boolean(),
          state: z.enum(['DONE', 'OPEN', 'NOT_REACHED']),
          /** How many garments a report here may count: what the previous operation passed (the bundle's at the first). */
          expected: z.number().int().nullable(),
          /** The standing report: the counts, when, at which station, and whether it is the viewer's own (never who). */
          report: output({
            scanId: id(),
            kind,
            goodQuantity: z.number().int(),
            scrapQuantity: z.number().int(),
            reworkQuantity: z.number().int(),
            serverTime: instant(),
            station: output({ id: id(), code: z.string() }).nullable(),
            own: z.boolean(),
          }).nullable(),
        }),
      ),
      /** The operation this station does next for the bundle (Finish = one tap), or null: see `choose` and `hint`. */
      next: id().nullable(),
      /** Two or more fit this station: the picker's operations, first in sequence first. */
      choose: z.array(id()),
      hint: output({ code: z.string(), message: z.string(), fix: z.string() }).nullable(),
      reasons: z.array(reason),
    }),
  },
})

export const mineContract = defineContract({
  response: {
    200: output({
      since: instant(),
      /** The device's last report while it may still be undone, or null. */
      undo: output({ scanId: id(), bundleCode: z.string(), until: instant() }).nullable(),
      /** Own reports and corrections today, newest first (`standing`: no later scan voids it). */
      reports: z.array(scan.extend({ standing: z.boolean(), correctionPending: z.boolean() })),
      requests: z.array(request),
      refused: z.array(refusalRow),
      othersRefused: z.number().int(),
    }),
  },
})

export const reportContract = defineContract({
  body: input({ ...timed, ...report }),
  response: { 200: scanAnswer, 201: scanAnswer },
})

export const undoContract = defineContract({
  params: scanParams,
  body: input({ ...timed }),
  response: { 200: scanAnswer, 201: scanAnswer },
})

export const askContract = defineContract({
  params: scanParams,
  body: input({ ...timed, ...askBody }),
  response: { 200: requestAnswer, 201: requestAnswer },
})

const item = z.discriminatedUnion('action', [
  input({ action: z.literal('REPORT'), workerId: id().optional(), ...timed, ...report }),
  input({ action: z.literal('UNDO'), workerId: id().optional(), ...timed, scanId: id().optional(), undoesClientScanId: clientScanId().optional() }),
  input({ action: z.literal('ASK_CORRECTION'), workerId: id().optional(), ...timed, scanId: id().optional(), targetClientScanId: clientScanId().optional(), ...askBody }),
])

export const batchContract = defineContract({
  body: input({
    /** The device's clock when it sent the batch (the clock check, PLT-240). */
    sentAt: instant().optional(),
    /** The queue's actions in the order they were taken (FIFO): each is judged on its own, in this order. */
    items: z.array(item).min(1).max(MAX_BATCH_ITEMS),
  }),
  response: {
    200: output({
      serverTime: instant(),
      clock: output({ deviceSentAt: instant(), skewSeconds: z.number().int(), off: z.boolean(), flagged: z.boolean() }).nullable(),
      items: z.array(
        output({
          clientScanId: z.string(),
          action: z.enum(REFUSED_ACTIONS),
          status: z.enum(['accepted', 'duplicate', 'refused']),
          scan: scan.nullable(),
          request: request.nullable(),
          refusal: refusal.extend({ refusalId: id() }).nullable(),
        }),
      ),
    }),
  },
})

const listed = request.extend({
  workOrder: output({ id: id(), number: z.string(), status }),
  bundleCode: z.string(),
  operation: operationRef,
  /** The scan's counts as recorded now. */
  recorded: output({ goodQuantity: z.number().int(), scrapQuantity: z.number().int(), reworkQuantity: z.number().int(), serverTime: instant() }).nullable(),
})

export const correctionsContract = defineContract({
  querystring: input({ status: z.enum(CORRECTION_STATUSES).optional(), workOrderId: id().optional(), siteId: id().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }),
  response: { 200: output({ requests: z.array(listed) }) },
})

const person = output({ id: id(), name: z.string() })
const stationRef = output({ id: id(), code: z.string(), name: z.string() })

export const correctionContract = defineContract({
  params: requestParams,
  response: {
    200: output({
      request: listed.extend({
        askedBy: person.nullable(),
        askedAt: stationRef.nullable(),
        decidedById: id().nullable(),
        scan: output({ id: id(), kind, worker: person.nullable(), station: stationRef.nullable(), defects: z.array(defectLine) }).nullable(),
      }),
    }),
  },
})

export const approveContract = defineContract({
  params: requestParams,
  body: input({ note: z.string().trim().max(300).optional() }),
  response: { 201: output({ request, scan }) },
})

export const refuseContract = defineContract({
  params: requestParams,
  body: input({ note: z.string().trim().min(3).max(300) }),
  response: { 201: output({ request }) },
})

const flow = { arrived: z.number().int(), waiting: z.number().int(), good: z.number().int(), scrap: z.number().int(), rework: z.number().int() }
const bundleCounts = output({ done: z.number().int(), waiting: z.number().int(), notReached: z.number().int() })
const cellNames = { workOrderSizeId: id(), colourwayCode: z.string(), size: z.string() }

export const workOrderWipContract = defineContract({
  params: workOrderParams,
  response: {
    200: output({
      workOrder: output({ id: id(), number: z.string(), status, siteId: id() }),
      operations: z.array(
        output({
          operationId: id(),
          seq: z.number().int(),
          code: z.string(),
          name: z.string(),
          scanRequired: z.boolean(),
          final: z.boolean(),
          sewn: z.boolean(),
          workCentreKind: z.enum(WORK_CENTRE_KINDS),
          ...flow,
          missing: z.number().int(),
          bundles: bundleCounts,
          partBundles: bundleCounts,
          cells: z.array(output({ ...cellNames, ...flow, missing: z.number().int() })),
          lines: z.array(output({ lineId: id(), code: z.string(), name: z.string(), good: z.number().int() })),
        }),
      ),
      cells: z.array(output({ ...cellNames, quantity: z.number().int(), bundled: z.number().int(), sewn: z.number().int().nullable(), finished: z.number().int().nullable(), scrapped: z.number().int(), inRework: z.number().int() })),
      finalOperationId: id().nullable(),
      sewnOperationId: id().nullable(),
      allFinished: z.boolean(),
      readyToComplete: z.boolean(),
      correctionsWaiting: z.number().int(),
    }),
  },
})

export const siteWipContract = defineContract({
  querystring: input({ siteId: id().optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }),
  response: {
    200: output({
      workOrders: z.array(
        output({
          workOrder: output({ id: id(), number: z.string(), status, siteId: id() }),
          operations: z.array(output({ operationId: id(), seq: z.number().int(), code: z.string(), name: z.string(), scanRequired: z.boolean(), final: z.boolean(), ...flow, bundles: bundleCounts, lines: z.array(output({ lineId: id(), good: z.number().int() })) })),
          allFinished: z.boolean(),
        }),
      ),
    }),
  },
})

export const workOrderScansContract = defineContract({
  params: workOrderParams,
  querystring: input({ bundleId: id().optional() }),
  response: {
    200: output({
      workOrder: output({ id: id(), number: z.string(), status, siteId: id() }),
      scans: z.array(
        scan.extend({
          scrapReason: z.string().nullable(),
          /** Where the scan names a worker (a site that records workers): inside this one record only. */
          worker: person.nullable(),
          station: stationRef.nullable(),
          approvedById: id().nullable(),
          /** The UNDO or CORRECTION that voids it. */
          voidedById: id().nullable(),
        }),
      ),
    }),
  },
})

const officeRefusal = refusalRow.extend({ siteId: id(), device: output({ id: id(), name: z.string() }) })

export const refusalsContract = defineContract({
  querystring: input({ siteId: id().optional(), deviceId: id().optional(), workOrderId: id().optional(), all: z.enum(['true', 'false']).transform((value) => value === 'true').optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }),
  response: { 200: output({ refusals: z.array(officeRefusal) }) },
})

export const refusalContract = defineContract({
  params: refusalParams,
  response: { 200: output({ refusal: officeRefusal.extend({ worker: person.nullable(), discardedById: id().nullable() }) }) },
})

export const discardContract = defineContract({
  params: refusalParams,
  response: { 200: output({ refusal: refusalRow }) },
})
