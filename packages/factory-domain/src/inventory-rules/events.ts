import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * Warehouse rules and the adjustments they hold back (B-W2b-314; SCM-196, SCM-281; design warehouse.settings ws-posting,
 * ws-adjust, warehouse.moves mv-approval). apps/factory-api's modules/inventory/posting emits them in the commands that make
 * the change, and the STOCK_ADJUSTMENT approval kind (platform/approvals/kinds/stock-adjustment.ts) in the decision's
 * command. Its own module folder, as inventory-rolls: the inventory events file is other steps'.
 *
 *   inventory.rules_changed               a card of the warehouse rules was saved with a change (posting dates, adjustment
 *                                         approval, low-stock alerts): which fields, and whether it loosened a rule
 *   inventory.adjustment_request_changed  an adjustment above the value waits for a yes, or its request was decided: POSTED
 *                                         on the yes (its move also emits inventory.moved), REJECTED, WITHDRAWN or STALE
 *
 * They reach the warehouse screens (inventory.stock.view). Ids, codes and states only: never the value (a cost), never a
 * person.
 */

export const RULES_CARDS = ['POSTING_DATES', 'ADJUSTMENT_APPROVAL', 'LOW_STOCK_ALERTS'] as const
export type RulesCard = (typeof RULES_CARDS)[number]

export const ADJUSTMENT_REQUEST_STATES = ['WAITING', 'POSTED', 'REJECTED', 'WITHDRAWN', 'STALE'] as const
export type AdjustmentRequestState = (typeof ADJUSTMENT_REQUEST_STATES)[number]

export const events = [
  defineEvent({
    type: 'inventory.rules_changed',
    context: 'inventory-rules',
    description: 'A card of the warehouse rules was saved with a change: how far back a move may be dated, the value above which an adjustment waits for a yes, or the low-stock alerts.',
    payload: z.strictObject({
      companyId: z.uuid().nullable(),
      card: z.enum(RULES_CARDS),
      fields: z.array(z.string()).min(1),
      loosened: z.boolean(),
    }),
    live: { permission: 'inventory.stock.view', fields: ['companyId', 'card'] },
  }),
  defineEvent({
    type: 'inventory.adjustment_request_changed',
    context: 'inventory-rules',
    description: 'An adjustment above the value of the warehouse rules waits for a yes, or its request was decided: posted on the yes, rejected, withdrawn or stale.',
    payload: z.strictObject({
      requestId: z.uuid(),
      taskId: z.uuid(),
      siteId: z.uuid(),
      itemId: z.uuid(),
      lotId: z.uuid().nullable(),
      hideId: z.uuid().nullable(),
      locationId: z.uuid(),
      direction: z.enum(['IN', 'OUT']),
      state: z.enum(ADJUSTMENT_REQUEST_STATES),
      moveId: z.uuid().nullable(),
    }),
    live: { permission: 'inventory.stock.view', fields: ['requestId', 'siteId', 'itemId', 'state'] },
  }),
]
