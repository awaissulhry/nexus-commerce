import { z } from 'zod'
import { periodLockOverride } from '@nexus/factory-domain/accounting/contracts'
import { businessDate, defineContract, id, input, instant, output, quantity } from '@nexus/factory-domain/core/contracts'
import { notMoney } from '@nexus/factory-domain/money/marked'
import { ITEM_TRACKINGS } from '@nexus/factory-domain/inventory/ledger/moves'
import { HIDE_STATES } from '@nexus/factory-domain/inventory/issue/rules'
import { UNUSABLE_REASONS } from '@nexus/factory-domain/planning/usable'
import { READINESS_WORDS } from '@nexus/factory-domain/planning/readiness/readiness'
import { WORK_ORDER_STATUSES } from '@nexus/factory-domain/production/work-orders/machine'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { moveView } from '../ledger/contract'
import { KIT_STATUSES, MAX_PICK_LISTS, PICK_VIEWS } from './kit-rules'

/**
 * Picking and issuing to a work order (B-W1-39; SCM-215, SCM-194, SCM-216; A2 SCR-093, SCR-070). Quantities are decimal
 * strings with four decimals in the item's base unit unless `uom` names another. No field carries money: the floor and
 * the office see the same answers. A refusal by a pick rule is a 409 whose issue path is `refusal/<CODE>` (factory-domain
 * inventory/issue/rules REFUSALS).
 */

const uom = z.enum(UOMS)
const decimal = z.string()
const why = () => z.string().trim().min(3).max(500)

/** The stock a request names: exactly one of a scanned code (a hide tag, a lot label, a material code) or an id. */
const stock = {
  code: z.string().trim().min(1).max(120).optional(),
  hideId: id().optional(),
  lotId: id().optional(),
  itemId: id().optional(),
  /** An untracked material in colours: its colour (default the one the work order plans, when only one). */
  itemColourId: id().nullish(),
}

export const workOrderParams = input({ workOrderId: id() })

export const pickingWorkOrdersContract = defineContract({
  querystring: input({
    /** Default (and for a floor device, only) the device's site; the office: any it may pick at. */
    siteId: id().optional(),
    /** A scanned or typed work order number (exact). */
    number: z.string().trim().min(1).max(60).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  response: {
    200: output({
      workOrders: z.array(
        output({
          id: id(),
          number: z.string(),
          batchNumber: z.string().nullable(),
          status: z.enum(WORK_ORDER_STATUSES),
          siteId: id(),
          dueDate: businessDate().nullable(),
          priority: z.number().int(),
          style: output({ id: id(), code: z.string(), name: z.string() }),
          pieces: z.number().int(),
          colourways: z.array(z.string()),
        }),
      ),
    }),
  },
})

const candidate = output({
  lotId: id().nullable(),
  lotCode: z.string().nullable(),
  hideId: id().nullable(),
  hideCode: z.string().nullable(),
  hideState: z.enum(HIDE_STATES).nullable(),
  grade: z.string().nullable(),
  dyeBatch: z.string().nullable(),
  receivedAt: instant().nullable(),
  locationId: id(),
  locationCode: z.string(),
  onHand: decimal,
})

/** The quality hold (B-W2a-26) behind a held entry: its reason in both languages and since when (B-W2a-58). */
export const pickHold = output({ id: id(), subjectType: z.enum(['Lot', 'Hide']), reasonCode: z.string(), reasonIt: z.string(), reasonEn: z.string(), placedAt: instant() })

export const pickLine = output({
  itemId: id(),
  itemCode: z.string(),
  itemName: z.string(),
  tracking: z.enum(ITEM_TRACKINGS),
  baseUom: z.string(),
  itemColourId: id().nullable(),
  colourCode: z.string().nullable(),
  colourName: z.string().nullable(),
  planned: decimal,
  issued: decimal,
  toIssue: decimal,
  over: decimal,
  covered: z.boolean(),
  /** Per BOM line × cell, issued shared in their order. */
  rows: z.array(
    output({
      materialId: id(),
      bomLineId: id(),
      bomSeq: z.number().int(),
      placement: z.string().nullable(),
      workOrderSizeId: id(),
      colourwayCode: z.string(),
      size: z.string(),
      planned: decimal,
      issued: decimal,
      toIssue: decimal,
    }),
  ),
  /** Usable stock of the site, oldest first (at most 50; `more` counts the rest). */
  usable: output({ onHand: decimal, candidates: z.array(candidate), more: z.number().int() }),
  /**
   * Stock of the same material and colour that may not be issued, with the reason. B-W2a-58: stock under an ACTIVE quality
   * hold (B-W2a-26) is here too (reason QUALITY_HOLD) with the hold — a held lot, or one held hide of its lot.
   */
  held: z.array(
    output({
      reason: z.enum(UNUSABLE_REASONS),
      words: z.string(),
      lotId: id(),
      lotCode: z.string(),
      onHand: decimal,
      hides: z.number().int(),
      hideId: id().nullable().optional(),
      hideCode: z.string().nullable().optional(),
      hold: pickHold.optional(),
    }),
  ),
  /** What the work order holds (issued minus returned) per lot and hide; `returnable` = it less what was cut. */
  atWorkOrder: z.array(
    output({ lotId: id().nullable(), lotCode: z.string().nullable(), hideId: id().nullable(), hideCode: z.string().nullable(), quantity: decimal, cut: decimal, returnable: decimal }),
  ),
})

export const pickListContract = defineContract({
  params: workOrderParams,
  response: {
    200: output({
      workOrder: output({
        id: id(),
        number: z.string(),
        batchNumber: z.string().nullable(),
        status: z.enum(WORK_ORDER_STATUSES),
        companyId: id(),
        siteId: id(),
        dueDate: businessDate().nullable(),
        priority: z.number().int(),
        version: z.number().int(),
        /** RELEASED or IN_PROGRESS: stock may be issued to it. */
        issuable: z.boolean(),
        style: output({ id: id(), code: z.string(), name: z.string() }),
      }),
      lines: z.array(pickLine),
      /** The caller's own last stock action when it is an issue to this work order it may still undo. */
      undo: output({
        issueId: id(),
        itemId: id(),
        itemColourId: id().nullable(),
        lotId: id().nullable(),
        hideId: id().nullable(),
        baseQuantity: decimal,
        occurredAt: instant(),
      }).nullable(),
    }),
  },
})

const line = output({ planned: decimal, issued: decimal, toIssue: decimal })

export const issueContract = defineContract({
  params: workOrderParams,
  body: input({
    ...stock,
    /** A lot or untracked material: how much (default what the work order still needs, up to what is on hand). Never for a hide. */
    quantity: quantity().optional(),
    uom: uom.optional(),
    /** For a unit of the item's own size (ROLL, CONE …): the measured quantity in the base unit. */
    baseQuantity: quantity().optional(),
    /** Take it from this location only. */
    fromLocationId: id().optional(),
    /** An over-issue (the office, inventory.issue.over): why. */
    overIssueReason: why().optional(),
    /** When it happened, by the device's clock. Default now. */
    occurredAt: instant().optional(),
    periodLockOverride: periodLockOverride.optional(),
  }),
  response: {
    201: output({
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
        /** The work order was RELEASED: the worker moves it to IN_PROGRESS. */
        startsWorkOrder: z.boolean(),
        moves: z.array(moveView),
      }),
      line,
    }),
  },
})

export const returnContract = defineContract({
  params: workOrderParams,
  body: input({
    ...stock,
    /** Measured: a remnant's area, a roll's metres, in `uom` (default the base unit). */
    quantity: quantity(),
    uom: uom.optional(),
    baseQuantity: quantity().optional(),
    toLocationId: id(),
    note: z.string().trim().max(500).nullish(),
    occurredAt: instant().optional(),
    periodLockOverride: periodLockOverride.optional(),
  }),
  response: {
    201: output({
      return: output({ id: id(), workOrderId: id(), number: z.string(), hideState: z.enum(HIDE_STATES).nullable(), move: moveView }),
    }),
  },
})

const reversal = output({
  reversal: output({ reversedId: id(), of: z.enum(['ISSUE', 'RETURN']), workOrderId: id(), number: z.string(), baseQuantity: decimal, moves: z.array(moveView) }),
})

export const undoContract = defineContract({
  params: input({ issueId: id() }),
  response: { 201: reversal },
})

export const reversePickContract = defineContract({
  params: input({ moveId: id() }),
  body: input({ note: why() }),
  response: { 201: reversal },
})

// ---- Picking & kits (B-W2a-58; design warehouse.picking, SCR-237; PLN-086) ----------------------------------------------

const readinessMaterial = output({
  itemId: id(),
  itemColourId: id().nullable(),
  label: z.string(),
  uom,
  word: z.enum(READINESS_WORDS),
  date: businessDate().nullable(),
  needed: decimal,
  issued: decimal,
  reserved: decimal,
  inStock: decimal,
  onOrder: decimal,
  short: decimal,
  /** One sentence in English (the screens say their own words from `word`, `date` and the figures). */
  reason: z.string(),
  /** The purchase orders it counts on ("Open PO"). */
  purchaseOrders: z.array(output({ id: id(), number: z.string(), status: z.string(), dueDate: businessDate() })),
})

/** The plan's readiness word of a work order (planning readiness, computed now), with each material's reason. */
const readiness = output({ word: z.enum(READINESS_WORDS), label: z.string(), date: businessDate().nullable(), reason: z.string(), materials: z.array(readinessMaterial) })

const kitWorkOrder = output({
  id: id(),
  number: z.string(),
  status: z.enum(WORK_ORDER_STATUSES),
  kind: z.string(),
  companyId: id(),
  siteId: id(),
  dueDate: businessDate().nullable(),
  priority: z.number().int(),
  pieces: z.number().int(),
  style: output({ id: id(), code: z.string(), name: z.string() }),
  /** ON_HOLD: why (the floor's words) and the status it goes back to. */
  onHold: output({ reason: z.string().nullable(), from: z.enum(WORK_ORDER_STATUSES).nullable() }).nullable(),
})

/** Who picked: a team (the floor device's work centre, else the device) or the office. Never a person. */
const pickedBy = z.array(output({ kind: z.enum(['OFFICE', 'TEAM']), name: z.string().nullable() }))
/** The work order's pick list = its reservations (ACTIVE or ISSUED). */
const pickListState = output({ created: z.boolean(), reservations: z.number().int(), createdAt: instant().nullable() })
const kitStatus = z.enum(KIT_STATUSES)

export const pickListsContract = defineContract({
  querystring: input({
    siteId: id().optional(),
    view: z.enum(PICK_VIEWS).default('all'),
    q: z.string().trim().max(80).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().regex(/^\d+$/).optional(),
  }),
  response: {
    200: output({
      asOf: instant(),
      sites: z.array(output({ id: id(), code: z.string(), name: z.string() })),
      /** The saved rows' counts (after the search): to pick today, waiting for material, kits complete, no pick list yet, all. */
      tiles: output({ today: z.number().int(), waiting: z.number().int(), complete: z.number().int(), toCreate: z.number().int(), all: z.number().int() }),
      rows: z.array(
        output({
          workOrder: kitWorkOrder,
          /** The plan's first day for it (the site's working plan), else null. */
          cutDate: businessDate().nullable(),
          readiness,
          /** Lines (material × colour) issued in full of all lines ("6 of 9"). */
          lines: output({ all: z.number().int(), picked: z.number().int(), short: z.number().int() }),
          /** OPEN · PARTLY · COMPLETE from the issues; `location` is not recorded yet (no schema: always null). */
          kit: output({ status: kitStatus, location: z.null() }),
          pickList: pickListState,
          pickedBy,
          startedAt: instant().nullable(),
          finishedAt: instant().nullable(),
        }),
      ),
      /** How many rows the saved row holds (all pages): a count, not money. */
      total: notMoney(z.number().int()),
      nextCursor: z.string().nullable(),
    }),
  },
})

const place = output({ locationId: id(), locationCode: z.string(), onHand: decimal })

export const pickListSheetsContract = defineContract({
  querystring: input({ workOrderIds: z.string().trim().min(1).max(800) }),
  response: {
    200: output({
      asOf: instant(),
      sheets: z.array(
        output({
          workOrder: kitWorkOrder.extend({ batchNumber: z.string().nullable(), version: z.number().int(), issuable: z.boolean() }),
          cutDate: businessDate().nullable(),
          readiness,
          kit: output({ status: kitStatus, location: z.null(), all: z.number().int(), picked: z.number().int(), short: z.number().int() }),
          pickList: pickListState,
          pickedBy,
          startedAt: instant().nullable(),
          finishedAt: instant().nullable(),
          lines: z.array(
            pickLine.extend({
              /** The pick list of the line: reserved for it (open), what a new pick list would reserve, what nothing covers. */
              pick: output({
                reserved: decimal,
                short: decimal,
                proposed: z.array(
                  output({ kind: z.enum(['HIDE', 'LOT', 'ANY']), lotId: id().nullable(), lotCode: z.string().nullable(), hideId: id().nullable(), hideCode: z.string().nullable(), quantity: decimal, locations: z.array(place) }),
                ),
                reservations: z.array(
                  output({
                    id: id(),
                    status: z.enum(['ACTIVE', 'ISSUED', 'RELEASED']),
                    lotId: id().nullable(),
                    lotCode: z.string().nullable(),
                    hideId: id().nullable(),
                    hideCode: z.string().nullable(),
                    quantity: decimal,
                    issued: decimal,
                    locations: z.array(place),
                  }),
                ),
              }),
            }),
          ),
        }),
      ),
    }),
  },
})

export const createPickListsContract = defineContract({
  body: input({ siteId: id(), workOrderIds: z.array(id()).min(1).max(MAX_PICK_LISTS) }),
  response: {
    201: output({
      created: z.number().int(),
      results: z.array(
        output({
          workOrderId: id(),
          number: z.string().nullable(),
          /** CREATED (reserved now) · NOTHING_TO_RESERVE (already reserved or issued, or no usable stock) · REFUSED (words). */
          outcome: z.enum(['CREATED', 'NOTHING_TO_RESERVE', 'REFUSED']),
          reserved: z.array(output({ itemCode: z.string(), colourCode: z.string().nullable(), kind: z.enum(['HIDE', 'LOT', 'ANY']), lotCode: z.string().nullable(), hideCode: z.string().nullable(), quantity: decimal, baseUom: z.string() })),
          short: z.array(output({ itemCode: z.string(), colourCode: z.string().nullable(), quantity: decimal, baseUom: z.string() })),
          refusal: output({ code: z.string(), message: z.string() }).nullable(),
        }),
      ),
    }),
  },
})
