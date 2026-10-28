import { z } from 'zod'
import { defineEvent } from '../events/define'
import { STOCK_MOVE_REASONS } from './ledger/moves'

/**
 * The inventory module's events (plan A1 §3.4; SCM-189). apps/factory-api's modules/inventory/ledger `postMoves` emits
 * `inventory.moved` once per stock move, in the command that posts it (receipts, issues, returns, transfers,
 * adjustments, counts, scraps, reversals). `valued` says whether the command valued the move already: the office and
 * the system value their moves in the same command; the floor cannot see costs, so its moves that enter or leave the
 * site's stock are valued afterwards by the worker's `inventory.valueFloorMoves` handler. Never a cost in a payload.
 */
const decimal = () => z.string().regex(/^\d{1,14}\.\d{4}$/)

export const events = [
  defineEvent({
    type: 'inventory.moved',
    context: 'inventory',
    description: 'A stock move was posted to the ledger: stock entered a location of a site, left one, or both.',
    payload: z.strictObject({
      moveId: z.uuid(),
      reason: z.enum(STOCK_MOVE_REASONS),
      itemId: z.uuid(),
      itemColourId: z.uuid().nullable(),
      lotId: z.uuid().nullable(),
      hideId: z.uuid().nullable(),
      fromLocationId: z.uuid().nullable(),
      toLocationId: z.uuid().nullable(),
      /** In the item's base unit. */
      baseQuantity: decimal(),
      reversalOfId: z.uuid().nullable(),
      /** Who posted it: the office, a floor device, or the system (a job). */
      postedBy: z.enum(['OFFICE', 'FLOOR', 'SYSTEM']),
      /** The move enters or leaves the site's stock (not a transfer inside it): it has a value. */
      changesValue: z.boolean(),
      /** Its value was written with it (office and system moves); false: the valuation handler values it. */
      valued: z.boolean(),
    }),
    live: { permission: 'inventory.stock.view', fields: ['moveId', 'reason', 'itemId', 'lotId', 'hideId', 'fromLocationId', 'toLocationId'] },
  }),
] as const
