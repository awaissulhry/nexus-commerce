import { z } from 'zod'
import { amountMinor, currency, defineContract, id, input, instant, output, quantity, unitPrice } from '@nexus/factory-domain/core/contracts'
import { STOCK_MOVE_REASONS } from '@nexus/factory-domain/inventory/ledger/moves'
import { VALUATION_METHODS } from '@nexus/factory-domain/inventory/ledger/valuation'
import { money } from '@nexus/factory-domain/money/marked'

/**
 * The stock ledger's contracts (SCM-189, SCM-191, SCM-192, SCM-193, SCM-195; A2 SCR-064). Quantities are decimal
 * strings with at most four decimals, in the item's base unit unless `uom` names another (then `baseQuantity` is the
 * same quantity in the base unit). Costs are marked with the cost grain: a caller without it never receives them and
 * may not send them.
 */

export const UOMS = ['PCS', 'PAIR', 'SET', 'M', 'CM', 'MM', 'M2', 'DM2', 'FT2', 'KG', 'G', 'L', 'HIDE', 'SIDE', 'ROLL', 'CONE', 'BOX'] as const
const uom = z.enum(UOMS)
const reason = z.enum(STOCK_MOVE_REASONS)
const why = () => z.string().trim().min(1).max(500)
const reference = () => z.string().trim().max(120).nullish()

/** The stock a move names: the item, and its colour, lot and hide as it is tracked (a hide alone names its lot). */
const stock = {
  itemId: id(),
  /** Left out: the lot's colour. */
  itemColourId: id().nullish(),
  /** Left out: the hide's lot. */
  lotId: id().nullish(),
  hideId: id().nullish(),
}
const amount = {
  /** Above 0. */
  quantity: quantity(),
  /** Default the item's base unit. */
  uom: uom.optional(),
  /** The quantity in the item's base unit, when `uom` is another unit. */
  baseQuantity: quantity().optional(),
}

export const moveView = output({
  id: id(),
  companyId: id(),
  siteId: id(),
  reason,
  itemId: id(),
  itemColourId: id().nullable(),
  lotId: id().nullable(),
  hideId: id().nullable(),
  fromLocationId: id().nullable(),
  toLocationId: id().nullable(),
  quantity: z.string(),
  uom,
  baseQuantity: z.string(),
  receiptLineId: id().nullable(),
  workOrderId: id().nullable(),
  reference: z.string().nullable(),
  note: z.string().nullable(),
  reversalOfId: id().nullable(),
  idempotencyKey: z.string(),
  occurredAt: instant(),
  /** Its value was written with it (office moves that enter or leave the site's stock, with a cost). */
  valued: z.boolean(),
})
export type MoveView = z.infer<typeof moveView>

const oneMove = { 201: output({ move: moveView }) }

export const adjustContract = defineContract({
  body: input({
    siteId: id(),
    ...stock,
    locationId: id(),
    /** IN: found more (the location gains it); OUT: found less (the location loses it). */
    direction: z.enum(['IN', 'OUT']),
    ...amount,
    /** Why (SCM-192): required. */
    note: why(),
    reference: reference(),
    /** The cost per base unit to value it at (MANUAL); left out: the lot's cost, else the item's standard cost. */
    unitCost: money.cost(unitPrice()),
  }),
  response: oneMove,
})

export const transferContract = defineContract({
  body: input({
    /** Default (and for a floor device, only) the device's site. */
    siteId: id().optional(),
    ...stock,
    fromLocationId: id(),
    toLocationId: id(),
    ...amount,
    reference: reference(),
    note: z.string().trim().max(500).nullish(),
    /** When it happened, by the device's clock (a floor scan sent later). Default now. */
    occurredAt: instant().optional(),
  }),
  response: oneMove,
})

export const scrapContract = defineContract({
  body: input({
    siteId: id(),
    ...stock,
    fromLocationId: id(),
    ...amount,
    /** Why (damaged, defect, obsolete): required. */
    note: why(),
    reference: reference(),
  }),
  response: oneMove,
})

export const reverseContract = defineContract({
  params: input({ moveId: id() }),
  body: input({ note: why() }),
  response: { 201: output({ move: moveView, reversed: id() }) },
})

export const countContract = defineContract({
  body: input({
    siteId: id(),
    locationId: id(),
    /** Why: the count (the year-end count, a cycle count) and its sheet. */
    note: why(),
    reference: reference(),
    lines: z
      .array(
        input({
          ...stock,
          /** What was counted, in the item's base unit; 0 when none was found. */
          counted: quantity(),
        }),
      )
      .min(1)
      .max(500),
  }),
  response: {
    201: output({
      differences: z.array(
        output({
          itemId: id(),
          itemColourId: id().nullable(),
          lotId: id().nullable(),
          hideId: id().nullable(),
          system: z.string(),
          counted: z.string(),
          difference: z.string(),
          moveId: id().nullable(),
        }),
      ),
      moves: z.array(moveView),
    }),
  },
})

const named = output({ id: id(), code: z.string(), name: z.string() })

export const moveRow = moveView.omit({ valued: true }).extend({
  item: output({ id: id(), code: z.string(), name: z.string(), baseUom: uom }),
  lotCode: z.string().nullable(),
  hideCode: z.string().nullable(),
  fromLocation: named.nullable(),
  toLocation: named.nullable(),
  /** The move that reverses this one, if any. */
  reversedById: id().nullable(),
  createdAt: instant(),
  createdById: id().nullable(),
  deviceId: id().nullable(),
  /** Its value (only with the cost grain); null when it has none (a transfer, no cost, a floor move not valued yet). */
  valuation: money.cost(
    output({
      method: z.enum(VALUATION_METHODS),
      quantity: z.string(),
      unitCost: money.cost(unitPrice()),
      valueAmount: money.cost(amountMinor()),
      currency: currency(),
    }).nullable(),
  ),
})

export const listMovesContract = defineContract({
  querystring: input({
    siteId: id().optional(),
    itemId: id().optional(),
    itemColourId: id().optional(),
    lotId: id().optional(),
    hideId: id().optional(),
    /** Moves into or out of this location. */
    locationId: id().optional(),
    reason: reason.optional(),
    /** Who posted them. */
    createdById: id().optional(),
    /** Happened at or after / before (device time for floor scans). */
    from: instant().optional(),
    to: instant().optional(),
    /** The next page: the `nextCursor` of the previous one. */
    cursor: id().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  }),
  response: { 200: output({ moves: z.array(moveRow), nextCursor: id().nullable() }) },
})
