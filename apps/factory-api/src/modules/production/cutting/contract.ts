import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output, quantity } from '@nexus/factory-domain/core/contracts'
import { HIDE_STATES } from '@nexus/factory-domain/inventory/issue/rules'
import { CUT_REFUSALS } from '@nexus/factory-domain/production/cutting/rules'
import { WORK_ORDER_STATUSES } from '@nexus/factory-domain/production/work-orders/machine'
import { moveView } from '../../inventory/ledger/contract'

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
  /** The remnant's RETURN move (Hide done with a remnant). */
  remnant: moveView.nullable(),
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
    ...clientEvent,
  }),
  response: { 200: cutAnswer, 201: cutAnswer },
})

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
  response: { 201: reversalAnswer },
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
          worker: output({ id: id(), name: z.string() }).nullable(),
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
