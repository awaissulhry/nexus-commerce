import { z } from 'zod'
import { COST_SHEET_STATES, FREEZE_REASONS } from '../costing/sheet-versions/rules'
import { defineEvent } from '../events/define'

/**
 * The events of cost sheet versions (B-W2b-420; FIN-014, FIN-015, FIN-016; apps/factory-api modules/costing/{sheet-versions,
 * size-weights}). Context `cost-sheet-versions`, its own module folder (B-W2b-418's components are `cost-sheets`). The office
 * screens that may see costs (costing.view) refetch what they show, with their viewer's grains: ids, numbers, states and
 * counts only, never a figure. The approval itself is also the engine's approval.requested / decided / withdrawn / stale.
 *
 *   cost_sheet.version_changed   a version was made (written from the components, copied, or saved from a what-if),
 *                                edited, deleted, sent for its yes, sent back (the request refused, withdrawn or stale) or
 *                                frozen (superseded, its season closed, taken back)
 *   cost_sheet.approved          a version was approved and locked on its request's yes (prices are released from it); the
 *                                version it replaced, if any, frozen in the same command
 *   size_weights.changed         a style's size mix for a season (or every season) was set or cleared
 */

export const VERSION_CHANGES = ['created', 'updated', 'deleted', 'submitted', 'returned', 'frozen'] as const

export const events = [
  defineEvent({
    type: 'cost_sheet.version_changed',
    context: 'cost-sheet-versions',
    description: 'A cost sheet version was made, edited, deleted, sent for its yes, sent back or frozen.',
    payload: z.strictObject({
      sheetId: z.uuid(),
      styleId: z.uuid(),
      sheetVersion: z.number().int().min(1),
      state: z.enum(COST_SHEET_STATES),
      change: z.enum(VERSION_CHANGES),
      frozenReason: z.enum(FREEZE_REASONS).nullable(),
    }),
    live: { permission: 'costing.view', fields: ['sheetId', 'styleId', 'sheetVersion', 'state', 'change'] },
  }),
  defineEvent({
    type: 'cost_sheet.approved',
    context: 'cost-sheet-versions',
    description: 'A cost sheet version was approved and locked on its yes; the version it replaced was frozen.',
    payload: z.strictObject({ sheetId: z.uuid(), styleId: z.uuid(), sheetVersion: z.number().int().min(1), taskId: z.uuid(), approvedById: z.uuid(), supersededId: z.uuid().nullable() }),
    live: { permission: 'costing.view', fields: ['sheetId', 'styleId', 'sheetVersion', 'supersededId'] },
  }),
  defineEvent({
    type: 'size_weights.changed',
    context: 'cost-sheet-versions',
    description: "A style's size mix for a season, or for every season, was set or cleared.",
    payload: z.strictObject({ styleId: z.uuid(), seasonId: z.uuid().nullable(), sizes: z.number().int().min(0) }),
    live: { permission: 'costing.view', fields: ['styleId', 'seasonId', 'sizes'] },
  }),
] as const
