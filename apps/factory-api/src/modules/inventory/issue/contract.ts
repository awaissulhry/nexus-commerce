import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output, quantity } from '@nexus/factory-domain/core/contracts'
import { ITEM_TRACKINGS } from '@nexus/factory-domain/inventory/ledger/moves'
import { HIDE_STATES } from '@nexus/factory-domain/inventory/issue/rules'
import { UNUSABLE_REASONS } from '@nexus/factory-domain/planning/usable'
import { WORK_ORDER_STATUSES } from '@nexus/factory-domain/production/work-orders/machine'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { moveView } from '../ledger/contract'

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

const pickLine = output({
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
  /** Stock of the same material and colour that may not be issued, with the reason. */
  held: z.array(output({ reason: z.enum(UNUSABLE_REASONS), words: z.string(), lotId: id(), lotCode: z.string(), onHand: decimal, hides: z.number().int() })),
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
