import { z } from 'zod'
import { UPLIFT_TARGETS } from '../costing/sheet-components/rules'
import { defineEvent } from '../events/define'

/**
 * The events of the cost sheet's components (B-W2b-418; FIN-003, FIN-008, FIN-009, FIN-011, FIN-020; apps/factory-api
 * modules/costing/sheet-components). Context `cost-sheets`, its own module folder (the costing events file is W1's and W2a's).
 * The office screens that may see costs (costing.view) refetch what they show, with their viewer's grains: ids, targets and
 * counts only, never a figure. Switching piece-rate labour emits W1's costing_settings.changed (fields pieceRateLabour).
 *
 *   cost_sheet.components_written   a draft cost sheet's lines were written again from its components (its typed lines kept)
 *   leather_cost_basis.changed      a leather article's cost basis was added, corrected or archived
 *   cost_uplift.changed             a freight, duty and insurance uplift (a material or a kind) or a workshop's transport was
 *                                   added, corrected or archived
 */

/** What happened to a basis or an uplift. */
export const COST_INPUT_CHANGES = ['created', 'updated', 'archived'] as const

export const events = [
  defineEvent({
    type: 'cost_sheet.components_written',
    context: 'cost-sheets',
    description: "A draft cost sheet's lines were written again from its components (leather, labour, outside operations, freight and duty, packaging, overhead); its typed lines were kept.",
    payload: z.strictObject({ sheetId: z.uuid(), styleId: z.uuid(), revisionId: z.uuid(), lines: z.number().int().min(0), leftOut: z.number().int().min(0) }),
    live: { permission: 'costing.view', fields: ['sheetId', 'styleId', 'revisionId'] },
  }),
  defineEvent({
    type: 'leather_cost_basis.changed',
    context: 'cost-sheets',
    description: "A leather article's cost basis (area unit, expected yield, grade mix) was added, corrected or archived.",
    payload: z.strictObject({ basisId: z.uuid(), itemId: z.uuid(), styleId: z.uuid().nullable(), change: z.enum(COST_INPUT_CHANGES) }),
    live: { permission: 'costing.view', fields: ['basisId', 'itemId', 'styleId', 'change'] },
  }),
  defineEvent({
    type: 'cost_uplift.changed',
    context: 'cost-sheets',
    description: "A freight, duty and insurance uplift on a material or a kind of material, or a workshop's transport out and back, was added, corrected or archived.",
    payload: z.strictObject({ upliftId: z.uuid(), target: z.enum(UPLIFT_TARGETS), change: z.enum(COST_INPUT_CHANGES) }),
    live: { permission: 'costing.view', fields: ['upliftId', 'target', 'change'] },
  }),
] as const
