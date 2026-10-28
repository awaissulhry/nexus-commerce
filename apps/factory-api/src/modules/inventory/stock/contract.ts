import { z } from 'zod'
import { amountMinor, currency, defineContract, id, input, instant, output, unitPrice } from '@nexus/factory-domain/core/contracts'
import { ITEM_TRACKINGS, STOCK_MOVE_REASONS } from '@nexus/factory-domain/inventory/ledger/moves'
import { LOT_QUALITY_STATUSES } from '@nexus/factory-domain/inventory/stock/overview'
import { money } from '@nexus/factory-domain/money/marked'
import { UOMS } from '../ledger/contract'

/**
 * The stock overview's, the stock card's and the ledger check's contracts (SCM-190, SCM-191, SCM-258, SCM-280; A2
 * SCR-060, SCR-064; PLAN §4.7). Quantities are in each item's base unit, as decimal strings with four decimals. Values
 * are marked with the cost grain: a caller without it never receives them.
 */

const named = output({ id: id(), code: z.string(), name: z.string() })
const item = output({ id: id(), code: z.string(), name: z.string(), baseUom: z.enum(UOMS), tracking: z.enum(ITEM_TRACKINGS) })
const flag = () => z.enum(['true', 'false']).transform((value) => value === 'true')

export const overviewContract = defineContract({
  querystring: input({
    siteId: id().optional(),
    itemId: id().optional(),
    itemColourId: id().optional(),
    lotId: id().optional(),
    hideId: id().optional(),
    locationId: id().optional(),
    /** Only held stock (a lot that is not RELEASED). */
    held: flag().optional(),
  }),
  response: {
    200: output({
      /** Per site, location, item, colour, lot and hide; only stock that is there (on hand not 0). */
      rows: z.array(
        output({
          siteId: id(),
          siteCode: z.string(),
          location: named,
          item,
          colour: named.nullable(),
          lot: output({ id: id(), code: z.string(), qualityStatus: z.enum(LOT_QUALITY_STATUSES) }).nullable(),
          hide: output({ id: id(), code: z.string() }).nullable(),
          onHand: z.string(),
          /** The stock of a lot that is not RELEASED. */
          held: z.string(),
          available: z.string(),
          /** Per base unit: the lot's cost, else the item's standard cost; null when there is none. */
          unitCost: money.cost(unitPrice().nullable()),
          /** On hand × unit cost, in minor units of the item's currency. */
          value: money.cost(amountMinor().nullable()),
        }),
      ),
      /** Per item and colour: the hides and the area side by side (SCM-258). */
      items: z.array(
        output({
          itemId: id(),
          itemColourId: id().nullable(),
          item,
          colour: named.nullable(),
          onHand: z.string(),
          held: z.string(),
          available: z.string(),
          hides: z.number().int(),
          heldHides: z.number().int(),
          locations: z.number().int(),
          /** The sum of the rows' values; null when one has no cost. */
          value: money.cost(amountMinor().nullable()),
          currency: currency().optional(),
        }),
      ),
      /** More rows than one answer holds: narrow the filters. */
      truncated: z.boolean(),
    }),
  },
})

export const stockCardContract = defineContract({
  querystring: input({
    siteId: id(),
    itemId: id(),
    itemColourId: id().optional(),
    lotId: id().optional(),
    hideId: id().optional(),
    locationId: id().optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(200),
  }),
  response: {
    200: output({
      siteId: id(),
      itemId: id(),
      locationId: id().nullable(),
      /** The balance before the first line shown. */
      opening: z.string(),
      closing: z.string(),
      /** Every move is shown (false: only the latest `limit`). */
      complete: z.boolean(),
      lines: z.array(
        output({
          moveId: id(),
          reason: z.enum(STOCK_MOVE_REASONS),
          itemColourId: id().nullable(),
          lotId: id().nullable(),
          hideId: id().nullable(),
          fromLocationId: id().nullable(),
          toLocationId: id().nullable(),
          quantity: z.string(),
          uom: z.enum(UOMS),
          baseQuantity: z.string(),
          reference: z.string().nullable(),
          note: z.string().nullable(),
          reversalOfId: id().nullable(),
          occurredAt: instant(),
          createdAt: instant(),
          createdById: id().nullable(),
          /** + or − for the card (the location's, or the site's stock). */
          delta: z.string(),
          balance: z.string(),
        }),
      ),
    }),
  },
})

export const reconcileContract = defineContract({
  querystring: input({ siteId: id().optional() }),
  response: {
    200: output({
      /** No check of severity error failed on any site. */
      ok: z.boolean(),
      sites: z.array(
        output({
          siteId: id(),
          siteCode: z.string(),
          moves: z.number().int(),
          balances: z.number().int(),
          ok: z.boolean(),
          checks: z.array(
            output({
              name: z.enum(['balances', 'not_below_zero', 'reversals', 'valuations']),
              severity: z.enum(['error', 'warning']),
              ok: z.boolean(),
              message: z.string(),
              details: z.array(z.string()),
            }),
          ),
        }),
      ),
    }),
  },
})
