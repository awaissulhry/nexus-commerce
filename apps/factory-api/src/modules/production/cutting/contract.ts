import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output, quantity } from '@nexus/factory-domain/core/contracts'
import { HIDE_STATES } from '@nexus/factory-domain/inventory/issue/rules'
import { CUT_REFUSALS } from '@nexus/factory-domain/production/cutting/rules'
import { WORK_ORDER_STATUSES } from '@nexus/factory-domain/production/work-orders/machine'
import { moveView } from '../../inventory/ledger/contract'
// B-W2b-103: the table's leather checks, "Cut anyway", the hide's photo.
import { SHADE_RULES } from '@nexus/factory-domain/inventory/reservations/shade'
import { CUT_OVERRIDE_REASON_CODES, CUT_WARNING_CODES, CUT_WARNING_KINDS, WRONG_HIDE_DIFFERENCES } from '@nexus/factory-domain/production/cutting/checks'
import { fileView, presignedView } from '../../../platform/files/contract'

/**
 * The cutting log per hide (B-W1-40; MES-051, MES-056, MES-058, SCM-194, SCM-253; A2 SCR-094, SCR-071). Areas are
 * decimal strings with four decimals in the hide's material's base unit (an area unit) unless `uom` names another of
 * m², dm² or ft². No field carries money: the floor and the office see the same figures. A refusal by a cutting rule is a
 * 409 whose issue path is `refusal/<CODE>` (factory-domain production/cutting/rules CUT_REFUSALS).
 */

const areaUom = z.enum(['M2', 'DM2', 'FT2'])
const decimal = z.string()
const hideState = z.enum(HIDE_STATES)
const status = z.enum(WORK_ORDER_STATUSES)

const workOrderParams = input({ workOrderId: id() })
const cutParams = input({ cutLogId: id() })

const area = input({ area: quantity(), uom: areaUom.optional() })

const refusal = output({ code: z.enum(CUT_REFUSALS), message: z.string() })

const piece = output({ workOrderSizeId: id(), part: z.string(), pieces: z.number().int() })

const entry = output({
  id: id(),
  workOrderId: id(),
  hideId: id(),
  lotId: id(),
  uom: z.string(),
  areaUsed: decimal,
  baseAreaUsed: decimal,
  remnantArea: decimal,
  baseRemnantArea: decimal,
  /** The entry this one reverses (an undo or a correction). */
  reversalOfId: id().nullable(),
  note: z.string().nullable(),
  /** The signed-in worker, where the site names workers; null at a site that records the station only. */
  workerId: id().nullable(),
  stationId: id().nullable(),
  deviceId: id().nullable(),
  clientEventId: z.string(),
  deviceTime: instant().nullable(),
  serverTime: instant(),
  pieces: z.array(piece),
  /** B-W2b-103 (MES-060): the photo of the hide on the table before the cut (a file of the hide). */
  photoFileId: id().nullable(),
  /** B-W2b-103 (MES-064): the thickness measured at the table, mm ("1.25"). */
  measuredThicknessMm: z.string().nullable(),
  /** B-W2b-103: the warnings a lead let through with "Cut anyway" (none: nothing stood). */
  overrides: z.array(z.enum(CUT_WARNING_KINDS)),
  /** The lead's reason in words (the tile, and the note). */
  overrideReason: z.string().nullable(),
})

// ---- B-W2b-103: the table's checks (factory-domain production/cutting/checks) -------------------------------------------------------

const warningKind = z.enum(CUT_WARNING_KINDS)
const shadeLot = output({ lotCode: z.string(), shadeLabel: z.string().nullable() })
const thicknessSource = z.enum(['TABLE', 'HIDE'])

/** One warning of the hide check: its kind, finer code, words (English) and the facts the floor words in its own language. */
const warning = output({
  kind: warningKind,
  code: z.enum(CUT_WARNING_CODES),
  message: z.string(),
  shade: output({ rule: z.enum(SHADE_RULES), cutFrom: z.array(shadeLot), hide: shadeLot.extend({ outOfShade: z.boolean() }), cell: z.string().nullable() }).optional(),
  wrongHide: output({
    reservedHides: z.array(output({ code: z.string(), lotCode: z.string(), grade: z.string().nullable() })),
    reservedLots: z.array(z.string()),
    differs: z.array(z.enum(WRONG_HIDE_DIFFERENCES)),
    hide: output({ lotCode: z.string(), grade: z.string().nullable() }),
  }).optional(),
  thickness: output({ valueMm: z.string(), source: thicknessSource, minMm: z.string().nullable(), maxMm: z.string().nullable() }).optional(),
  grade: output({ hideGrade: z.string().nullable(), pieces: z.array(output({ name: z.string(), minGrade: z.string() })) }).optional(),
})

/** The hide check of a work order (design floor.hidecut "Check the hide"): what stands, what a lead passed, the card's facts. */
const checks = output({
  /** Every warning of the hide for the work order (the grade: over every piece of its leather in the work order). */
  warnings: z.array(warning),
  /** The kinds no lead passed yet for this hide and work order: "Cut anyway" signs for these. Empty: straight to the sizes. */
  standing: z.array(warningKind),
  /** The kinds a lead already passed for this hide and work order (an earlier live entry). */
  passed: z.array(warningKind),
  /** Shade: the site's rule, the shade lots the work order is cut from, the hide's; `same` null: no other hide yet. */
  shade: output({ rule: z.enum(SHADE_RULES), cutFrom: z.array(shadeLot), hide: shadeLot.extend({ outOfShade: z.boolean() }), same: z.boolean().nullable() }),
  /** Thickness against the leather's range: OK, THIN, THICK, UNKNOWN (none recorded) or NO_SPEC (no range). */
  thickness: output({ verdict: z.enum(['OK', 'THIN', 'THICK', 'UNKNOWN', 'NO_SPEC']), valueMm: z.string().nullable(), source: thicknessSource.nullable(), minMm: z.string().nullable(), maxMm: z.string().nullable() }),
  /** The hide's grade (record, else its text: `byText`) and the pattern pieces of its leather with their minimum and verdict. */
  grade: output({ hide: z.string().nullable(), byText: z.boolean(), pieces: z.array(output({ name: z.string(), minGrade: z.string().nullable(), verdict: z.enum(['OK', 'BELOW', 'UNKNOWN']) })) }),
  /** The work order's own leather reservations still waiting (hides by name, lots), and whether this hide is reserved for it. */
  reserved: output({ forIt: z.boolean(), hides: z.array(z.string()), lots: z.array(z.string()) }),
  /** The photo before cutting (MES-060): asked by the site (no setting yet: false, optional everywhere). */
  photo: output({ required: z.boolean() }),
})

const cellAfter = output({ workOrderSizeId: id(), colourwayCode: z.string(), size: z.string(), quantity: z.number().int(), cut: z.number().int(), toCut: z.number().int() })

const hideAfter = output({ id: id(), code: z.string(), state: hideState, left: decimal, closed: z.boolean() })

const partCount = output({ part: z.string(), pieces: z.number().int(), planned: z.boolean() })

const style = output({ id: id(), code: z.string(), name: z.string() })

export const cuttingWorkOrdersContract = defineContract({
  querystring: input({
    /** A scanned or typed work order number (exact). */
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
          colourways: z.array(z.string()),
          pieces: z.number().int(),
          /** Garments still to cut (every part cut from hides). */
          toCut: z.number().int(),
          /** "BLK 52": the cells with garments still to cut. */
          sizesLeft: z.array(z.string()),
        }),
      ),
    }),
  },
})

export const cuttingViewContract = defineContract({
  params: workOrderParams,
  response: {
    200: output({
      workOrder: output({
        id: id(),
        number: z.string(),
        batchNumber: z.string().nullable(),
        status,
        companyId: id(),
        siteId: id(),
        dueDate: businessDate().nullable(),
        priority: z.number().int(),
        /** RELEASED or IN_PROGRESS: hides may be cut for it. */
        cuttable: z.boolean(),
        style: style.nullable(),
      }),
      cells: z.array(
        output({
          id: id(),
          colourwayCode: z.string(),
          size: z.string(),
          quantity: z.number().int(),
          /** Garments cut (every part cut from hides); null: the cell has no part cut from hides. */
          cut: z.number().int().nullable(),
          toCut: z.number().int().nullable(),
          /** Per hide-cut material: its parts, the BOM's area per garment, the sets cut and still to cut. */
          materials: z.array(output({ itemId: id(), itemColourId: id().nullable(), colourCode: z.string().nullable(), parts: z.array(z.string()), perGarment: decimal, cut: z.number().int(), toCut: z.number().int() })),
          parts: z.array(partCount),
        }),
      ),
      /** The hides the work order holds or held: issued minus returned, cut, left. */
      hides: z.array(output({ hideId: id(), code: z.string(), lotId: id(), lotCode: z.string(), dyeBatch: z.string().nullable(), grade: z.string().nullable(), state: hideState, atWorkOrder: decimal, cut: decimal, left: decimal })),
      /** The cutter's own last entry on this device, while it may be undone (the Undo strip). */
      undo: entry.nullable(),
    }),
  },
})

export const scanHideContract = defineContract({
  querystring: input({
    /** The scanned hide tag. */
    code: z.string().trim().min(1).max(120),
    /** Only this work order (the one the cutting table works for). */
    workOrderId: id().optional(),
  }),
  response: {
    200: output({
      hide: output({
        id: id(),
        code: z.string(),
        supplierCode: z.string().nullable(),
        itemId: id(),
        itemCode: z.string(),
        itemName: z.string(),
        itemColourId: id().nullable(),
        colourCode: z.string().nullable(),
        area: decimal,
        areaUom: z.string(),
        baseArea: decimal,
        baseUom: z.string(),
        /** B-W2b-219: the site's smallest remnant in the base unit (four places); null for a unit that is not an area. */
        remnantMinimum: z.string().nullable(),
        grade: z.string().nullable(),
        shade: z.string().nullable(),
        thicknessMm: z.string().nullable(),
        defects: z.string().nullable(),
        state: hideState,
        lot: output({
          id: id(),
          code: z.string(),
          supplierLotRef: z.string().nullable(),
          dyeBatch: z.string().nullable(),
          shade: z.string().nullable(),
          qualityStatus: z.string(),
          crViStatus: z.string(),
          usable: z.boolean(),
          /** Why it is not cut, in words ("Do not cut this hide …"). */
          words: z.string().nullable(),
        }),
      }),
      onHand: z.array(output({ locationId: id(), locationCode: z.string(), onHand: decimal })),
      /** The hide's last cut: when, for which work order, at which table (never who). */
      lastCut: output({ at: instant(), workOrderNumber: z.string(), station: output({ id: id(), code: z.string(), name: z.string() }).nullable() }).nullable(),
      workOrders: z.array(
        output({
          id: id(),
          number: z.string(),
          status,
          /** The work order holds the hide (it was issued to it); otherwise a cut issues it first. */
          holdsHide: z.boolean(),
          /** What this hide can still give the work order (base unit). */
          left: decimal,
          cuttable: z.boolean(),
          refusal: refusal.nullable(),
          cells: z.array(output({ id: id(), colourwayCode: z.string(), size: z.string(), quantity: z.number().int(), parts: z.array(z.string()), perGarment: decimal, cut: z.number().int(), toCut: z.number().int() })),
          /** B-W2b-103: the hide check against this work order; null when it may not be cut for it at all (`refusal`). */
          checks: checks.nullable(),
        }),
      ),
    }),
  },
})

const line = input({
  workOrderSizeId: id(),
  /** Whole garment sets: one piece of every part of the hide's material in the cell. */
  sets: z.number().int().min(1).max(500).optional(),
  /** Single parts by name (a hide that runs out mid-set, a recut). */
  parts: z.array(input({ part: z.string().trim().min(1).max(80), pieces: z.number().int().min(1).max(500) })).max(40).optional(),
})

const cutAnswer = output({
  cut: entry.nullable(),
  /** The hide was issued to the work order by this cut. */
  issue: output({
    id: id(),
    workOrderId: id(),
    number: z.string(),
    itemId: id(),
    itemColourId: id().nullable(),
    lotId: id().nullable(),
    hideId: id().nullable(),
    baseQuantity: decimal,
    overIssue: z.boolean(),
    startsWorkOrder: z.boolean(),
    moves: z.array(moveView),
  }).nullable(),
  /** The remnant's move (Hide done with a remnant): a REMNANT since B-W2b-100. */
  remnant: moveView.nullable(),
  /** B-W2b-100 (SCM-254): the remnant's own tag (RM-…). */
  remnantTag: output({ id: id(), code: z.string() }).nullable().optional(),
  hide: hideAfter,
  cells: z.array(cellAfter),
  /** The device sent this event before (its client event id): the entry recorded then; nothing was written now. */
  replayed: z.boolean(),
})

const clientEvent = {
  /** The device's id for this event (A1 §3.8): a resend under any key is recorded once. */
  clientEventId: z.string().trim().min(1).max(100),
  /** When it happened, by the device's clock. */
  occurredAt: instant().optional(),
}

export const cutContract = defineContract({
  params: workOrderParams,
  body: input({
    /** The scanned hide tag, or the hide's id: exactly one. */
    code: z.string().trim().min(1).max(120).optional(),
    hideId: id().optional(),
    lines: z.array(line).max(60).default([]),
    /** Single parts without Hide done: the area they used. */
    area: area.optional(),
    /** Hide done: the remnant set aside and where it goes, or null (no remnant: the rest is used). */
    done: input({ remnant: input({ area: quantity(), uom: areaUom.optional(), toLocationId: id() }).nullable() }).optional(),
    note: z.string().trim().max(500).nullish(),
    /** B-W2b-103 (MES-060): the photo of the hide on the table, uploaded first (POST …/hides/:hideId/photos). */
    photoFileId: id().nullish(),
    /** B-W2b-103 (MES-064): the thickness measured at the table, in mm, above 0 and below 100, at most two decimals. */
    measuredThicknessMm: z.string().trim().regex(/^\d{1,2}(\.\d{1,2})?$/, 'A thickness in mm, like 1.25.').nullish(),
    ...clientEvent,
  }),
  response: { 200: cutAnswer, 201: cutAnswer },
})

/** B-W2b-103: the answer of "Cut anyway": the cut's, and what the lead let through (null: nothing stood any more). */
const anywayAnswer = cutAnswer.extend({ override: output({ overrides: z.array(warningKind), reasonCode: z.enum(CUT_OVERRIDE_REASON_CODES) }).nullable() })

export const cutAnywayContract = defineContract({
  params: workOrderParams,
  body: input({
    /** The cut, as the tablet sent it (the same client event id). */
    cut: cutContract.body,
    /** The lead: their badge, scanned, or their worker id, picked by name; and their 6-digit PIN (never stored, never logged). */
    lead: input({ badgeCode: z.string().trim().min(1).max(64).optional(), workerId: id().optional(), pin: z.string().regex(/^\d{6}$/, 'Expected 6 digits.') }),
    reasonCode: z.enum(CUT_OVERRIDE_REASON_CODES),
    /** A few words; required with OTHER. */
    note: z.string().trim().min(3).max(200).optional(),
    /** The warnings the card showed and the lead signs for. */
    warnings: z.array(warningKind).min(1).max(CUT_WARNING_KINDS.length),
  }),
  response: { 200: anywayAnswer, 201: anywayAnswer },
})

/** B-W2b-103 (MES-060): a photo of the hide on the table, announced (the presigned PUT), then confirmed. */
export const announceHidePhotoContract = defineContract({
  params: input({ hideId: id() }),
  body: input({
    originalName: z.string().min(1).max(500),
    contentType: z.string().min(1).max(200),
    sizeBytes: z.number().int().min(1),
    /** SHA-256 of the content, 64 lower-case hex digits. */
    sha256: z.string(),
  }),
  response: { 201: output({ file: fileView, upload: presignedView }) },
})

export const completeHidePhotoContract = defineContract({ params: input({ hideId: id(), fileId: id() }), response: { 200: output({ file: fileView }) } })

export const remnantContract = defineContract({
  params: input({ workOrderId: id(), hideId: id() }),
  body: input({
    /** The remnant set aside and where it goes, or null: no remnant, the rest of the hide is waste. */
    remnant: input({ area: quantity(), uom: areaUom.optional(), toLocationId: id() }).nullable(),
    note: z.string().trim().max(500).nullish(),
    ...clientEvent,
  }),
  response: { 200: cutAnswer, 201: cutAnswer },
})

const reversalAnswer = output({
  /** The mirror entry. */
  reversal: entry,
  reversedId: id(),
  /** The undo of Hide done took its remnant back to the work order too. */
  remnantReturnReversed: z.boolean(),
  hide: hideAfter,
  cells: z.array(cellAfter),
})

export const undoContract = defineContract({
  params: cutParams,
  response: { 201: reversalAnswer },
})

export const correctContract = defineContract({
  params: cutParams,
  body: input({ reason: z.string().trim().min(3).max(500) }),
  response: {
    201: reversalAnswer.extend({
      /** `workerId` only while the site's PERFORMANCE gate is open; `workerHidden`: the entry names a person and the gate keeps back who. */
      reversal: entry.extend({ workerHidden: z.boolean() }),
    }),
  },
})

export const cutLogContract = defineContract({
  params: workOrderParams,
  response: {
    200: output({
      workOrder: output({ id: id(), number: z.string(), status, siteId: id() }),
      /** Newest first, reversals included. */
      entries: z.array(
        entry.extend({
          hideCode: z.string(),
          lotCode: z.string(),
          /** The BOM's area of the whole sets it logs; null for a reversal or an entry of single parts. */
          pattern: decimal.nullable(),
          reversedById: id().nullable(),
          live: z.boolean(),
          /** The closing entry of its used-up hide: the one cut of that hide the office may still correct (it opens the hide again). */
          closing: z.boolean(),
          /** Who cut it, where the site names workers and its PERFORMANCE gate is on (this one record). */
          worker: output({ id: id(), name: z.string() }).nullable(),
          /** The entry names a person and the gate keeps back who. */
          workerHidden: z.boolean(),
          /** B-W2b-103: the lead who signed "Cut anyway", behind the same gate as the cutter (this one record). */
          overrideLead: output({ id: id(), name: z.string() }).nullable(),
          overrideLeadHidden: z.boolean(),
          station: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
          cells: z.array(output({ workOrderSizeId: id(), colourwayCode: z.string(), size: z.string() })),
        }),
      ),
      /** Each hide's area bar: cut + waste + returned + left = issued (base unit). */
      hides: z.array(output({ hideId: id(), code: z.string(), lotCode: z.string(), state: hideState, issued: decimal, cut: decimal, waste: decimal, returned: decimal, left: decimal })),
      cells: z.array(output({ id: id(), colourwayCode: z.string(), size: z.string(), quantity: z.number().int(), cut: z.number().int().nullable(), toCut: z.number().int().nullable(), parts: z.array(partCount) })),
    }),
  },
})

// ---- the cutting office (B-W2a-60; design production.cutting, SCR-238) ------------------------------------------------------------

/** Where a work order's leather cutting stands: nothing cut yet, cutting, every garment cut, or held (the work order ON_HOLD). */
export const CUT_STATES = ['WAITING', 'CUTTING', 'CUT', 'HELD'] as const
/** The list's saved filters: open = waiting + cutting + held. */
export const CUT_VIEWS = ['open', 'waiting', 'cutting', 'cut', 'held', 'all'] as const

const pct = z.string().regex(/^-?\d{1,6}\.\d{2}$/).nullable()
const areaOf = output({ uom: z.string(), area: decimal })

export const cutsListContract = defineContract({
  querystring: input({
    siteId: id().optional(),
    view: z.enum(CUT_VIEWS).default('open'),
    /** Part of the work order's number, its batch number, or the style's code or name (any case). */
    q: z.string().trim().min(1).max(60).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: {
    200: output({
      /** One cut per work order whose parts are cut from hides (W2a: leather by hide; fabric lays are W2b), most urgent first. */
      cuts: z.array(
        output({
          workOrder: output({ id: id(), number: z.string(), batchNumber: z.string().nullable(), status, companyId: id(), siteId: id(), dueDate: businessDate().nullable(), priority: z.number().int(), holdReason: z.string().nullable() }),
          style: style,
          kind: z.literal('LEATHER'),
          state: z.enum(CUT_STATES),
          /** The leathers its parts are cut from. */
          materials: z.array(output({ itemId: id(), itemColourId: id().nullable(), code: z.string(), name: z.string(), baseUom: z.string(), colourCode: z.string().nullable() })),
          /** The lots of the hides cut for it (the shade lot: the dye batch). */
          lots: z.array(output({ id: id(), code: z.string(), dyeBatch: z.string().nullable() })),
          garments: output({ planned: z.number().int(), cut: z.number().int(), toCut: z.number().int() }),
          /** Pieces: garments × the parts of each cell, and the pieces its live entries cut (recuts included). */
          pieces: output({ planned: z.number().int(), cut: z.number().int() }),
          /** The hides its live entries cut, and the area they used (per unit: never added across units). */
          hides: output({ count: z.number().int(), used: z.array(areaOf) }),
          /** Hides reserved whole for it and not issued yet (Allocate hides). */
          allocated: z.number().int(),
          yield: output({ yieldPct: pct, plannedPct: pct, variancePct: pct, plannedSource: z.enum(['STYLE', 'BOM']) }),
          /** The cutting tables its entries were cut at (never who). */
          stations: z.array(output({ id: id(), code: z.string() })),
          lastCutAt: instant().nullable(),
          /** Recuts asked for scrapped pieces and not cut yet (MES-130). */
          recutsOpen: z.number().int(),
        }),
      ),
      /** More cuts match than `limit`. */
      more: z.boolean(),
      tiles: output({
        waiting: z.number().int(),
        cutting: z.number().int(),
        held: z.number().int(),
        /** Today (Europe/Rome), live entries only. */
        piecesToday: z.number().int(),
        hidesToday: z.number().int(),
        /** The area used today in square metres (each leather's unit converted). */
        areaTodayM2: decimal,
      }),
      asOf: instant(),
    }),
  },
})
