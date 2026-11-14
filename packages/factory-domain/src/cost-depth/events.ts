import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * The events of cost in depth (B-W2b-423; FIN-018, FIN-022; apps/factory-api modules/costing/{option-cost,mass-update}).
 * Context `cost-depth`, its own module folder (the costing events file is W1's and W2a's). The office screens that may see
 * costs (costing.view) refetch what they show, with their viewer's grains: ids and counts only, never a figure. A mass
 * update also emits W1's material.standard_cost_changed per material and B-W2b-420's cost_sheet.version_changed per new
 * draft version.
 *
 *   option_value.delta_changed   an option value's typed material delta (with its currency) or minutes delta was set,
 *                                changed or cleared (the Effects tab's cost column)
 *   mass_update.applied          a mass cost update was applied: materials' new standard prices, new draft versions of the
 *                                cost sheet series that take them
 */

export const events = [
  defineEvent({
    type: 'option_value.delta_changed',
    context: 'cost-depth',
    description: "An option value's typed material delta (with its currency) or minutes delta was set, changed or cleared.",
    payload: z.strictObject({ groupId: z.uuid(), valueId: z.uuid(), parts: z.array(z.enum(['material', 'minutes'])).min(1).max(2) }),
    live: { permission: 'costing.view', fields: ['groupId', 'valueId', 'parts'] },
  }),
  defineEvent({
    type: 'mass_update.applied',
    context: 'cost-depth',
    description: "A mass cost update was applied: the materials' new standard prices and a new draft version of each cost sheet series that takes them.",
    payload: z.strictObject({ itemIds: z.array(z.uuid()).min(1).max(50), sheetIds: z.array(z.uuid()).max(100), skipped: z.number().int().min(0) }),
    live: { permission: 'costing.view', fields: ['itemIds', 'sheetIds', 'skipped'] },
  }),
] as const
