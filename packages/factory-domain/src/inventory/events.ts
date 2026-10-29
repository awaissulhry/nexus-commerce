import { z } from 'zod'
import { defineEvent } from '../events/define'
import { HIDE_STATES } from './issue/rules'
import { STOCK_MOVE_REASONS } from './ledger/moves'

/**
 * The inventory module's events (plan A1 §3.4; SCM-189). apps/factory-api's modules/inventory/ledger `postMoves` emits
 * `inventory.moved` once per stock move, in the command that posts it (receipts, issues, returns, transfers,
 * adjustments, counts, scraps, reversals). `valued` says whether the command valued the move already: the office and
 * the system value their moves in the same command; the floor cannot see costs, so its moves that enter or leave the
 * site's stock are valued afterwards by the worker's `inventory.valueFloorMoves` handler. Never a cost in a payload.
 *
 * Picking (B-W1-39, modules/inventory/issue): `inventory.issued` once per issue to a work order (its moves; the worker's
 * `inventory.startWorkOrderOnIssue` handler moves a RELEASED work order to IN_PROGRESS on it), `inventory.returned` once
 * per return of unused stock from a work order, `inventory.pick_reversed` once per undo or reversal of either. They reach
 * the office's pick and work-order screens and the site's floor devices (the pick list of another tablet refreshes).
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
  defineEvent({
    type: 'inventory.issued',
    context: 'inventory',
    description: 'Stock was issued to a work order: a hide whole, or a quantity of a lot or an untracked material.',
    payload: z.strictObject({
      workOrderId: z.uuid(),
      number: z.string(),
      /** The issue's first move: the undo and the reversal name it. */
      issueId: z.uuid(),
      moveIds: z.array(z.uuid()).min(1),
      itemId: z.uuid(),
      itemColourId: z.uuid().nullable(),
      lotId: z.uuid().nullable(),
      hideId: z.uuid().nullable(),
      /** In the item's base unit, all its moves together. */
      baseQuantity: decimal(),
      /** More than the work order still needed, with the reason (the office). */
      overIssue: z.boolean(),
      /** The work order was RELEASED: its first work, so the worker moves it to IN_PROGRESS. */
      startsWorkOrder: z.boolean(),
      postedBy: z.enum(['OFFICE', 'FLOOR', 'SYSTEM']),
    }),
    live: { permission: 'inventory.issue', floor: true, fields: ['workOrderId', 'number', 'itemId', 'lotId', 'hideId'] },
  }),
  defineEvent({
    type: 'inventory.returned',
    context: 'inventory',
    description: 'Unused stock came back from a work order: a remnant of a hide with its measured area, or part of a lot.',
    payload: z.strictObject({
      workOrderId: z.uuid(),
      number: z.string(),
      returnId: z.uuid(),
      itemId: z.uuid(),
      itemColourId: z.uuid().nullable(),
      lotId: z.uuid().nullable(),
      hideId: z.uuid().nullable(),
      toLocationId: z.uuid(),
      baseQuantity: decimal(),
      /** The hide's state after the return (REMNANT once part of it stayed with the work order). */
      hideState: z.enum(HIDE_STATES).nullable(),
      postedBy: z.enum(['OFFICE', 'FLOOR', 'SYSTEM']),
    }),
    live: { permission: 'inventory.issue', floor: true, fields: ['workOrderId', 'number', 'itemId', 'lotId', 'hideId'] },
  }),
  defineEvent({
    type: 'inventory.pick_reversed',
    context: 'inventory',
    description: 'An issue to a work order (or a return from it) was undone on the spot or reversed by the office: one mirror move per move.',
    payload: z.strictObject({
      workOrderId: z.uuid(),
      number: z.string(),
      /** The issue or return reversed (its first move). */
      reversedId: z.uuid(),
      of: z.enum(['ISSUE', 'RETURN']),
      /** The poster's own last issue, undone before its next action (else a reversal by the office). */
      undo: z.boolean(),
      moveIds: z.array(z.uuid()).min(1),
      postedBy: z.enum(['OFFICE', 'FLOOR', 'SYSTEM']),
    }),
    live: { permission: 'inventory.issue', floor: true, fields: ['workOrderId', 'number', 'reversedId', 'of'] },
  }),
] as const
