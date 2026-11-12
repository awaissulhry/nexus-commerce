import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { ITEM_TRACKINGS, STOCK_MOVE_REASONS } from '@nexus/factory-domain/inventory/ledger/moves'
import { UOMS } from '@nexus/factory-domain/product/units/units'

/**
 * "Why is it 84.20 m²?" (B-W2b-314; SCM-191; design warehouse.stock st-why, warehouse.moves mv-why): the balance bridge of one
 * stock figure over a period of days. Office, inventory.stock.view at the site; read only. Quantities are decimal strings
 * with four decimals in the item's base unit.
 */

const reason = z.enum(STOCK_MOVE_REASONS)
const named = output({ id: id(), code: z.string(), name: z.string() })
const words = output({ en: z.string(), it: z.string() })

/** The Movements grid's query that lists a step's moves (GET /inventory/ledger with these). */
const ledgerLink = output({
  path: z.literal('/inventory/ledger'),
  query: output({
    siteId: id(),
    itemId: id(),
    itemColourId: id().optional(),
    lotId: id().optional(),
    hideId: id().optional(),
    locationId: id().optional(),
    /** Comma separated, as the ledger reads them. */
    reasons: z.string().optional(),
    postedFrom: businessDate().optional(),
    postedTo: businessDate().optional(),
    from: instant().optional(),
    to: instant().optional(),
  }),
})

const moveLine = output({
  id: id(),
  reason,
  occurredAt: instant(),
  /** The day it counts on (its posting date, else the day it happened). */
  postingDay: businessDate(),
  /** Dated apart from the day it happened. */
  backDated: z.boolean(),
  /** Its effect on the figure (the location's, else the site's). */
  delta: z.string(),
  document: output({ type: z.enum(['GoodsReceipt', 'WorkOrder']), id: id(), number: z.string() }).nullable(),
  reference: z.string().nullable(),
})

export const whyContract = defineContract({
  querystring: input({
    siteId: id(),
    itemId: id(),
    itemColourId: id().optional(),
    lotId: id().optional(),
    hideId: id().optional(),
    /** The figure of one location; default the site's stock (transfers inside it net 0). */
    locationId: id().optional(),
    /** The first day of the period (its start balance is the day before's end); left out: from the first move. */
    from: businessDate().optional(),
    /** The last day (default today). */
    to: businessDate().optional(),
    /** POSTING (default): the days the moves count on in the books; ENTRY: the days they happened. */
    basis: z.enum(['POSTING', 'ENTRY']).optional(),
  }),
  response: {
    200: output({
      site: named,
      item: output({ id: id(), code: z.string(), name: z.string(), baseUom: z.enum(UOMS), tracking: z.enum(ITEM_TRACKINGS) }),
      colour: named.nullable(),
      lot: output({ id: id(), code: z.string() }).nullable(),
      hide: output({ id: id(), code: z.string() }).nullable(),
      location: named.nullable(),
      uom: z.enum(UOMS),
      basis: z.enum(['POSTING', 'ENTRY']),
      period: output({ from: businessDate().nullable(), to: businessDate() }),
      /** The balance at the start of `from` (0 without one). */
      start: z.string(),
      /** One step per reason with moves in the period, in the formula's order; each lists its moves through `link`. */
      steps: z.array(
        output({
          reason,
          sign: z.enum(['+', '−', '±']),
          in: z.string(),
          out: z.string(),
          net: z.string(),
          moves: z.number().int(),
          before: z.string(),
          after: z.string(),
          /** The step's only move, when it has one. */
          moveId: id().nullable(),
          link: ledgerLink,
        }),
      ),
      /** start + every step. */
      sum: z.string(),
      /** The balance at the end of `to`, read apart from the steps. */
      end: z.string(),
      addsUp: z.boolean(),
      /** end − sum: a gap is a bug, and the words say so. */
      gap: z.string(),
      /** The figure now (what the stock page shows), whatever `to` is. */
      onHandNow: z.string(),
      moves: z.number().int(),
      /** The period's last moves (at most 5), newest first. */
      last: z.array(moveLine),
      /** Every move of the period ("Open all 23 moves"). */
      allMoves: ledgerLink,
      formula: words,
      words,
    }),
  },
})
