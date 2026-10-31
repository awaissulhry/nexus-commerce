import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { LABEL_LANGUAGES } from '@nexus/factory-domain/labels/model'
import { BUNDLE_REFUSALS, MAX_BUNDLE_SIZE, MAX_BUNDLES_PER_MAKE } from '@nexus/factory-domain/production/bundles/rules'
import { SPLIT_REASONS } from '@nexus/factory-domain/production/bundles/split'
import { WORK_ORDER_KINDS, WORK_ORDER_STATUSES } from '@nexus/factory-domain/production/work-orders/machine'
// W2b B-W2b-41.
import { BUNDLE_CODE_MODES } from '@nexus/factory-domain/production/bundles/coupons'
import { FINDING_STATUSES, SCAN_PATTERN_KINDS, WHO_PURPOSES } from '@nexus/factory-domain/production/bundles/patterns'
import { BUNDLE_PLACES, MAX_STUCK_BUNDLE_HOURS, MIN_STUCK_BUNDLE_HOURS, QUALITY_REASONS } from '@nexus/factory-domain/production/bundles/where'
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
  /** W2a (MES-071): the bundle it was split off (genealogy), or null. */
  parentBundleId: id().nullable(),
  version: z.number().int(),
  createdAt: instant(),
})
/** A bundle as the answers show it (W2a B-W2a-13: the rework answers reuse it). */
export const bundleView = bundle

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

export const ticketAnswerView = output({
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
      /** W2b (MES-067): one bundle code at every operation, or a coupon per operation (then: print the coupons). */
      bundleCodeMode: z.enum(BUNDLE_CODE_MODES),
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
  tickets: z.array(ticketAnswerView),
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
    /** The ticket's code from the tablet's own BUNDLE block (a ticket printed offline); only with clientEventId. */
    ticketCode: z.string().trim().min(1).max(60).optional(),
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
      /** W2b (MES-067): the coupon the code is, with the one operation it reports; null: the bundle's own ticket. */
      coupon: output({ id: id(), code: z.string(), status: z.enum(['ACTIVE', 'VOID']), operation: output({ id: id(), seq: z.number().int(), code: z.string(), name: z.string() }) }).nullable(),
    }),
  },
})

const reprintAnswer = output({ bundle, replacedCode: z.string(), ticket: ticketAnswerView, replayed: z.boolean() })

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

// ---- W2a B-W2a-13: split a bundle (MES-071) -------------------------------------------------------------------------------------

const splitAnswer = output({
  /** The child bundle split off. */
  bundle,
  /** The parent: it keeps its quantity as cut; `live` garments are still in it. */
  parent: bundle.extend({ live: z.number().int() }),
  ticket: ticketAnswerView,
  replayed: z.boolean(),
})

export const splitBundleContract = defineContract({
  params: bundleParams,
  body: input({
    /** Garments into the child bundle: 1 to the parent's live garments − 1 (at least one stays). */
    quantity: z.number().int().min(1).max(MAX_BUNDLE_SIZE),
    /** Why (the floor's reason tiles): rework, a recut, a hold. */
    reason: z.enum(SPLIT_REASONS),
    note: z.string().trim().min(1).max(200).optional(),
    /** The floor queue's id for this event (A1 §3.8): a resend under any key answers the bundle it made. */
    clientEventId: z.string().trim().min(1).max(80).optional(),
    /** The ticket's code from the tablet's own BUNDLE block (a ticket printed offline); only with clientEventId. */
    ticketCode: z.string().trim().min(1).max(60).optional(),
    ...printing,
  }),
  response: { 200: splitAnswer, 201: splitAnswer },
})

// ---- W2b B-W2b-41: bundles tracked (MES-067, MES-074, MES-075, MES-078, MES-168) --------------------------------------------

const opRef = output({ id: id(), seq: z.number().int(), code: z.string(), name: z.string() })
const stationRef = output({ id: id(), code: z.string(), name: z.string() })
const placeEnum = z.enum(BUNDLE_PLACES)
const commaList = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .transform((value) => value.split(',').map((part) => part.trim()).filter((part) => part.length > 0))
    .pipe(z.array(z.enum(values)))
const flag = () => z.enum(['true', 'false']).transform((value) => value === 'true')

/** Where a bundle is now (factory-domain production/bundles/where.ts), its last scan (time, operation, station; never who) and its stuck wait. */
const placeFields = {
  place: placeEnum,
  /** QUALITY: on HOLD or in REWORK. */
  qualityReason: z.enum(QUALITY_REASONS).nullable(),
  /** LINE: the last operation it was reported at; FINISHED: the last scanned operation. */
  operation: opRef.nullable(),
  /** CUTTING and LINE: the next scanned operation without a standing report. */
  next: opRef.nullable(),
  subcontract: output({ orderId: id(), number: z.string() }).nullable(),
  /** Since when it is where it is: its last scan, else when it was made. */
  since: instant(),
  lastScan: output({ at: instant(), operation: opRef.nullable(), station: stationRef.nullable() }).nullable(),
  /** Working hours since its last scan on the site's calendar against the site's limit (MES-168). */
  stuck: output({ stuck: z.boolean(), workingHours: z.number(), limitHours: z.number().int() }),
}

const hideRef = output({ hideId: id(), code: z.string(), lotId: id(), lotCode: z.string() })

const trackedRow = output({
  id: id(),
  code: z.string(),
  replacedCodes: z.array(z.string()),
  status: z.enum(['ACTIVE', 'VOID']),
  siteId: id(),
  workOrder: output({ id: id(), number: z.string(), status }),
  style,
  workOrderSizeId: id(),
  colourwayCode: z.string(),
  colourwayName: z.string(),
  size: z.string(),
  part: z.string().nullable(),
  quantity: z.number().int(),
  parentBundleId: id().nullable(),
  ...placeFields,
  hides: z.array(hideRef),
  voidedAt: instant().nullable(),
  createdAt: instant(),
})

export const listBundlesContract = defineContract({
  querystring: input({
    siteId: id().optional(),
    workOrderId: id().optional(),
    status: z.enum(['ACTIVE', 'VOID']).optional(),
    /** Comma-separated places. */
    place: commaList(BUNDLE_PLACES).optional(),
    /** true: only the bundles stuck now. */
    stuck: flag().optional(),
    /** A scanned or typed ticket or coupon code, or a work order number. */
    q: z.string().trim().min(1).max(60).optional(),
    cursor: id().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: { 200: output({ bundles: z.array(trackedRow), nextCursor: id().nullable(), asOf: instant() }) },
})

const siteQuery = input({ siteId: id().optional() })

export const bundleTilesContract = defineContract({
  querystring: siteQuery,
  response: {
    200: output({
      active: z.number().int(),
      stuck: z.number().int(),
      stuckLimitHours: z.number().int().nullable(),
      ticketsReplacedToday: z.number().int(),
      onHold: z.number().int(),
      atSubcontractor: z.number().int(),
      /** More ACTIVE bundles than one read tracks: narrow by site. */
      capped: z.boolean(),
      asOf: instant(),
    }),
  },
})

export const stuckBundlesContract = defineContract({
  querystring: siteQuery,
  response: { 200: output({ bundles: z.array(trackedRow), capped: z.boolean(), asOf: instant() }) },
})

const couponView = output({
  id: id(),
  bundleId: id(),
  workOrderId: id(),
  code: z.string(),
  status: z.enum(['ACTIVE', 'VOID']),
  operation: opRef,
  voidedAt: instant().nullable(),
  voidReason: z.string().nullable(),
  replacesId: id().nullable(),
  postedBy: z.enum(['FLOOR', 'OFFICE']),
  createdAt: instant(),
})

export const bundleRecordContract = defineContract({
  params: bundleParams,
  response: {
    200: output({
      bundle: bundle.extend({ colourwayName: z.string(), scans: z.number().int() }),
      workOrder: output({ id: id(), number: z.string(), batchNumber: z.string().nullable(), status, siteId: id() }),
      style,
      ...placeFields,
      /** OperationFlow: per operation done · here · not reached, with the standing report's counts. */
      progress: z.array(opRef.extend({ scanRequired: z.boolean(), state: z.enum(['DONE', 'HERE', 'NOT_REACHED']), good: z.number().int().nullable(), scrap: z.number().int().nullable(), rework: z.number().int().nullable() })),
      quality: output({
        holds: z.array(output({ id: id(), subjectType: z.string(), reasonCode: z.string(), placedAt: instant() })),
        reworks: z.array(output({ id: id(), status: z.string(), quantity: z.number().int(), createdAt: instant() })),
      }),
      genealogy: output({
        hides: z.array(hideRef),
        /** The known shades of its hides (MES-078). */
        shades: z.array(z.string()),
        parent: output({ id: id(), code: z.string() }).nullable(),
        children: z.array(output({ id: id(), code: z.string(), quantity: z.number().int(), status: z.enum(['ACTIVE', 'VOID']) })),
        serials: z.array(output({ id: id(), serial: z.string(), status: z.string() })),
      }),
      ticket: output({
        code: z.string(),
        replacedCodes: z.array(z.string()),
        reprints: z.array(output({ code: z.string(), replacedCode: z.string(), reason: z.string(), printerId: id().nullable(), postedBy: z.enum(['FLOOR', 'OFFICE']), at: instant() })),
        /** Its tickets' print jobs, newest first; null without print.view. */
        jobs: z.array(output({ jobId: id(), printerId: id(), scanId: z.string().nullable(), status: z.enum(['QUEUED', 'SENT', 'PRINTED', 'FAILED']), lastError: z.string().nullable(), createdAt: instant() })).nullable(),
        /** MES-067: its coupons per operation (ACTIVE and VOID). */
        coupons: z.array(couponView),
      }),
      asOf: instant(),
    }),
  },
})

// ---- coupons (MES-067) ------------------------------------------------------------------------------------------------------

const couponTicket = output({
  code: z.string(),
  bundleCode: z.string(),
  operation: output({ seq: z.number().int(), code: z.string(), name: z.string() }),
  ticket: output({
    language: z.enum(LABEL_LANGUAGES),
    maker: z.string().nullable(),
    workOrder: output({ number: z.string(), batchNumber: z.string().nullable() }),
    style: output({ code: z.string(), name: z.string() }),
    colourway: output({ code: z.string(), name: z.string() }),
    size: z.string(),
    quantity: z.number().int(),
    part: z.string().nullable(),
  }),
})
const couponPrint = output({ couponId: id(), code: z.string(), coupon: couponTicket, label: labelBody, job: printJobView.nullable(), problem: z.string().nullable() })

const issueAnswer = output({ workOrder: output({ id: id(), number: z.string() }), coupons: z.array(couponView), printed: z.array(couponPrint), replayed: z.boolean() })

export const issueCouponsContract = defineContract({
  params: workOrderParams,
  body: input({
    /** The work order's bundles to print coupons for; absent: every ACTIVE bundle of it. */
    bundleIds: z.array(id()).min(1).max(200).optional(),
    ...printing,
  }),
  response: { 200: issueAnswer, 201: issueAnswer },
})

const couponParams = input({ couponId: id() })
const reprintCouponAnswer = output({ coupon: couponView, replacement: couponView, printed: couponPrint, replayed: z.boolean() })

export const reprintCouponContract = defineContract({
  params: couponParams,
  body: input({ reason: z.string().trim().min(3).max(200), ...printing }),
  response: { 200: reprintCouponAnswer, 201: reprintCouponAnswer },
})

const voidCouponAnswer = output({ coupon: couponView, replayed: z.boolean() })

export const voidCouponContract = defineContract({
  params: couponParams,
  body: input({ reason: z.string().trim().min(3).max(200) }),
  response: { 200: voidCouponAnswer, 201: voidCouponAnswer },
})

// ---- the site's bundle rules (MES-067, MES-168) ---------------------------------------------------------------------------------

const siteParams = input({ siteId: id() })
const rulesAnswer = output({
  site: output({ id: id(), code: z.string(), name: z.string() }),
  bundleCodeMode: z.enum(BUNDLE_CODE_MODES),
  stuckBundleHours: z.number().int(),
  version: z.number().int().nullable(),
  updatedAt: instant().nullable(),
  changed: z.boolean(),
})

export const bundleRulesContract = defineContract({ params: siteParams, response: { 200: rulesAnswer } })

export const changeBundleRulesContract = defineContract({
  params: siteParams,
  body: input({
    bundleCodeMode: z.enum(BUNDLE_CODE_MODES).optional(),
    stuckBundleHours: z.number().int().min(MIN_STUCK_BUNDLE_HOURS).max(MAX_STUCK_BUNDLE_HOURS).optional(),
    /** The rules' version as read (the edit guard); absent the first time. */
    version: z.number().int().min(1).optional(),
  }),
  response: { 200: rulesAnswer },
})

// ---- scan-pattern checks (MES-075) -----------------------------------------------------------------------------------------

const kindEnum = z.enum(SCAN_PATTERN_KINDS)
const findingView = output({
  id: id(),
  siteId: id(),
  kind: kindEnum,
  status: z.enum(FINDING_STATUSES),
  bundle: output({ id: id(), code: z.string(), quantity: z.number().int(), part: z.string().nullable() }),
  workOrder: output({ id: id(), number: z.string() }),
  operation: opRef.nullable(),
  line: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
  windowStart: instant(),
  windowEnd: instant(),
  /** What was seen: counts and times only (never a worker, never a station). */
  seen: z.record(z.string(), z.union([z.number(), z.string(), z.null()])),
  reviewedAt: instant().nullable(),
  reviewNote: z.string().nullable(),
  version: z.number().int(),
  createdAt: instant(),
})

export const findingsSummaryContract = defineContract({
  querystring: input({ siteId: id().optional(), days: z.coerce.number().int().min(1).max(90).optional() }),
  response: {
    200: output({
      legalNote: z.string(),
      days: z.number().int(),
      /** Per site whether its checks run (ON) and why not: a STATION site, no legal basis, the PERFORMANCE purpose off. */
      sites: z.array(output({ id: id(), code: z.string(), name: z.string(), checks: z.enum(['ON', 'STATION_SITE', 'NO_BASIS', 'GATE_CLOSED']), words: z.string().nullable() })),
      /** Counts per line, operation and kind (a count opens the bundles, never the people). */
      rows: z.array(output({ line: output({ id: id(), code: z.string(), name: z.string() }).nullable(), operation: output({ code: z.string(), name: z.string() }).nullable(), kind: kindEnum, open: z.number().int(), reviewed: z.number().int(), dismissed: z.number().int() })),
      asOf: instant(),
    }),
  },
})

export const listFindingsContract = defineContract({
  querystring: input({
    siteId: id().optional(),
    bundleId: id().optional(),
    kind: kindEnum.optional(),
    status: z.enum(FINDING_STATUSES).optional(),
    lineId: id().optional(),
    operationCode: z.string().trim().min(1).max(60).optional(),
    cursor: id().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: { 200: output({ findings: z.array(findingView), nextCursor: id().nullable() }) },
})

const findingParams = input({ findingId: id() })

export const reviewFindingContract = defineContract({
  params: findingParams,
  body: input({ status: z.enum(['REVIEWED', 'DISMISSED']), note: z.string().trim().min(1).max(500).optional(), version: z.number().int().min(1).optional() }),
  response: { 201: output({ finding: findingView }) },
})

export const showWhoContract = defineContract({
  params: findingParams,
  body: input({
    /** Why the names are opened (the audit row keeps it). */
    purpose: z.enum(WHO_PURPOSES),
    note: z.string().trim().min(1).max(300).optional(),
  }),
  response: {
    201: output({
      finding: output({ id: id(), kind: kindEnum, windowStart: instant(), windowEnd: instant() }),
      purpose: z.enum(WHO_PURPOSES),
      /** The opening is in the audit log (who looked, why, whom it showed). */
      logged: z.literal(true),
      scans: z.array(
        output({
          id: id(),
          kind: z.string(),
          at: instant(),
          operation: opRef.nullable(),
          good: z.number().int(),
          scrap: z.number().int(),
          rework: z.number().int(),
          /** Inside this one finding only (Statuto art. 4): never a list, a filter or a total. */
          worker: output({ id: id(), name: z.string() }).nullable(),
          station: stationRef.nullable(),
        }),
      ),
    }),
  },
})

// ---- pair and set matching (MES-078) ------------------------------------------------------------------------------------------

export const workOrderSetsContract = defineContract({
  params: workOrderParams,
  response: {
    200: output({
      workOrder: output({ id: id(), number: z.string(), status, siteId: id() }),
      cells: z.array(
        output({
          workOrderSizeId: id(),
          colourwayCode: z.string(),
          size: z.string(),
          parts: z.array(z.string()),
          sets: z.array(
            output({
              shade: z.string().nullable(),
              complete: z.number().int(),
              bundles: z.array(output({ id: id(), code: z.string(), part: z.string().nullable(), quantity: z.number().int() })),
              unmatched: z.array(output({ part: z.string(), pieces: z.number().int(), waitsFor: z.array(z.string()) })),
            }),
          ),
          mixed: z.array(output({ id: id(), code: z.string(), shades: z.array(z.string()) })),
        }),
      ),
    }),
  },
})

export const checkSetContract = defineContract({
  querystring: input({
    /** Comma-separated bundle ids (two or more). */
    bundleIds: z
      .string()
      .transform((value) => value.split(',').map((part) => part.trim()).filter((part) => part.length > 0))
      .pipe(z.array(id()).min(2).max(20)),
  }),
  response: {
    200: output({
      ok: z.boolean(),
      refusal: refusal.nullable(),
      shade: z.string().nullable(),
      unknown: z.array(z.string()),
      bundles: z.array(output({ id: id(), code: z.string(), part: z.string().nullable(), quantity: z.number().int(), shades: z.array(z.string()) })),
    }),
  },
})
