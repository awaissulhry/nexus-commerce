import { z } from 'zod'
import { defineEvent } from '../events/define'
import { WORK_CENTRE_KINDS } from '../product/routing/operations'
import { COST_ENTRY_KINDS, COSTING_METHODS } from './ledger/entries'
import { LABOUR_RATE_STATUSES } from './rates'
import { STANDARD_COST_CHANGES, STANDARD_COST_STATUSES } from './standards/rules'

/**
 * Costing's events (plan A1 §3.4, §3.5; B-W1-16). apps/factory-api's modules/costing emits them in the command that
 * changes a labour rate or the costing settings; the office screens that may see costs (costing.view) refetch the rate
 * list and every open Cost tab (a sheet is computed on read, so it follows). Ids, kinds and fields only: never a figure
 * (a screen refetches what it shows, with its viewer's grains).
 */
const rateLive = { permission: 'costing.view', fields: ['rateId', 'workCentreKind'] } as const
const kind = z.enum(WORK_CENTRE_KINDS)

export const events = [
  defineEvent({
    type: 'labour_rate.created',
    context: 'costing',
    description: 'A cost per standard minute was added for a kind of work centre, from a day.',
    payload: z.strictObject({ rateId: z.uuid(), workCentreKind: kind, validFrom: z.string() }),
    live: rateLive,
  }),
  defineEvent({
    type: 'labour_rate.updated',
    context: 'costing',
    description: 'A labour rate was corrected: its cost per minute, currency, planned efficiency, first day or note.',
    payload: z.strictObject({ rateId: z.uuid(), workCentreKind: kind, fields: z.array(z.string()) }),
    live: rateLive,
  }),
  defineEvent({
    type: 'labour_rate.status_changed',
    context: 'costing',
    description: 'A labour rate was archived: cost sheets no longer use it.',
    payload: z.strictObject({ rateId: z.uuid(), workCentreKind: kind, status: z.enum(LABOUR_RATE_STATUSES) }),
    live: rateLive,
  }),
  defineEvent({
    type: 'costing_settings.changed',
    context: 'costing',
    description: "A company's (or the tenant-wide) costing settings changed: the overhead percentage.",
    payload: z.strictObject({ settingsId: z.uuid(), fields: z.array(z.string()) }),
    live: { permission: 'costing.view', fields: ['settingsId'] },
  }),
  // B-W2a-21 (standard vs actual): standards, the costing method, the work-order cost ledger. Ids, kinds and states only.
  defineEvent({
    type: 'standard_cost.changed',
    context: 'costing',
    description: "An item's standard cost for a period was prepared, corrected, discarded, frozen, or ended by the next one.",
    payload: z.strictObject({
      standardId: z.uuid(),
      itemId: z.uuid(),
      validFrom: z.string(),
      status: z.enum(STANDARD_COST_STATUSES),
      change: z.enum(STANDARD_COST_CHANGES),
    }),
    live: { permission: 'costing.view', fields: ['standardId', 'itemId', 'status', 'change'] },
  }),
  defineEvent({
    type: 'costing_method.changed',
    context: 'costing',
    description: "A company's (or the tenant-wide) costing method was chosen, or locked by the first cost entry posted under it.",
    payload: z.strictObject({ settingsId: z.uuid(), method: z.enum(COSTING_METHODS), change: z.enum(['chosen', 'locked']) }),
    live: { permission: 'costing.view', fields: ['settingsId', 'method', 'change'] },
  }),
  defineEvent({
    type: 'work_order_cost.posted',
    context: 'costing',
    description: "Entries were posted to a work order's cost ledger: material issued or returned, scrap, labour earned, garments into finished goods, their reversals.",
    payload: z.strictObject({
      workOrderId: z.uuid(),
      number: z.string(),
      entryIds: z.array(z.uuid()),
      kinds: z.array(z.enum(COST_ENTRY_KINDS)),
      reversals: z.number().int().min(0),
    }),
    live: { permission: 'costing.view', fields: ['workOrderId', 'number', 'kinds'] },
  }),
  defineEvent({
    type: 'work_order_cost.reversed',
    context: 'costing',
    description: "A person reversed a work order's cost entry with a reason (the entry stays; its opposite is posted).",
    payload: z.strictObject({ workOrderId: z.uuid(), number: z.string(), entryId: z.uuid(), reversalIds: z.array(z.uuid()) }),
    live: { permission: 'costing.view', fields: ['workOrderId', 'number', 'entryId'] },
  }),
] as const
