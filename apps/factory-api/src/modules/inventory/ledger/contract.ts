import { z } from 'zod'
import { amountMinor, currency, defineContract, id, input, instant, output, quantity, unitPrice } from '@nexus/factory-domain/core/contracts'
import { STOCK_MOVE_REASONS } from '@nexus/factory-domain/inventory/ledger/moves'
import { VALUATION_METHODS } from '@nexus/factory-domain/inventory/ledger/valuation'
import { MAX_WRITE_OFF_LINES } from '@nexus/factory-domain/inventory/ledger/write-off'
import { money } from '@nexus/factory-domain/money/marked'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { fileView, presignedView } from '../../../platform/files/contract'

/**
 * The stock ledger's contracts (SCM-189, SCM-191, SCM-192, SCM-193, SCM-195; A2 SCR-064). Quantities are decimal
 * strings with at most four decimals, in the item's base unit unless `uom` names another (then `baseQuantity` is the
 * same quantity in the base unit). Costs are marked with the cost grain: a caller without it never receives them and
 * may not send them.
 */

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
  /**
   * The quantity in the item's base unit. Computed when `uom` is another unit the item converts (m² for ft²); one sent
   * must match it. Required for a unit of the item's own size (HIDE, SIDE, ROLL, CONE, BOX, SET): what it measures.
   */
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

// ---- write-off (B-W2a-11; SCM-193) -------------------------------------------------------------------------------------------

/** The value leaving stock per currency, from the moves' valuations (cost grain): `valued` of `moves` have one. */
const writeOffValues = money.cost(
  output({
    valued: z.number().int(),
    moves: z.number().int(),
    byCurrency: z.array(output({ currency: currency(), amount: money.cost(amountMinor()) })),
  }),
)

export const writeOffContract = defineContract({
  body: input({
    siteId: id(),
    /** A code of the tenant's WRITE_OFF reason list (DAMAGED, EXPIRED, OBSOLETE, LOST, OTHER …). */
    reasonCode: z.string().trim().min(1).max(40),
    /** What happened; required when the reason needs detail. */
    note: z.string().trim().max(500).nullish(),
    reference: reference(),
    lines: z
      .array(
        input({
          /** A hide goes whole, from wherever it lies at the site: name it alone. */
          hideId: id().optional(),
          itemId: id().optional(),
          itemColourId: id().nullish(),
          lotId: id().nullish(),
          fromLocationId: id().optional(),
          quantity: quantity().optional(),
          uom: uom.optional(),
          baseQuantity: quantity().optional(),
        }),
      )
      .min(1)
      .max(MAX_WRITE_OFF_LINES),
  }),
  response: {
    201: output({
      writeOff: output({
        /** Its first move's id: the record of its photos (StockWriteOff). */
        id: id(),
        siteId: id(),
        reasonCode: z.string(),
        reasonLabel: z.string(),
        note: z.string().nullable(),
        reference: z.string().nullable(),
        moves: z.array(moveView),
        hideIds: z.array(id()),
        values: writeOffValues,
      }),
      /** The stock keys it leaves with more reserved than available (the reservations stay; release or move them). */
      overReserved: z.array(output({ itemId: id(), itemColourId: id().nullable(), available: z.string(), reserved: z.string() })),
    }),
  },
})

const writeOffParams = input({ writeOffId: id() })

export const writeOffRecordContract = defineContract({
  params: writeOffParams,
  response: {
    200: output({
      writeOff: output({
        id: id(),
        companyId: id(),
        siteId: id(),
        reasonCode: z.string(),
        reasonLabel: output({ en: z.string(), it: z.string() }).nullable(),
        note: z.string().nullable(),
        reference: z.string().nullable(),
        occurredAt: instant(),
        createdBy: output({ id: id(), name: z.string() }).nullable(),
        moves: z.array(
          output({
            id: id(),
            item: output({ id: id(), code: z.string(), name: z.string(), baseUom: uom }),
            itemColourId: id().nullable(),
            lot: output({ id: id(), code: z.string() }).nullable(),
            hide: output({ id: id(), code: z.string(), state: z.string() }).nullable(),
            from: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
            quantity: z.string(),
            uom,
            baseQuantity: z.string(),
            reversedById: id().nullable(),
          }),
        ),
        photos: z.array(output({ id: id(), originalName: z.string(), contentType: z.string(), sizeBytes: z.number().int(), status: z.string(), createdAt: instant() })),
        values: writeOffValues,
      }),
    }),
  },
})

export const announcePhotoContract = defineContract({
  params: writeOffParams,
  body: input({
    originalName: z.string().min(1).max(500),
    /** A picture: the PHOTO kind's types (JPEG, PNG, WebP, HEIC). */
    contentType: z.string().min(1).max(200),
    sizeBytes: z.number().int().min(1),
    sha256: z.string(),
  }),
  response: { 201: output({ file: fileView, upload: presignedView }) },
})

export const completePhotoContract = defineContract({ params: input({ writeOffId: id(), fileId: id() }), response: { 200: output({ file: fileView }) } })
