import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Firm planned orders (apps/factory-api modules/planning; B-W2a-22; PLN-075; design planning.mrp "firm and convert").
 * Checked with can() against the site's company and the site of the run. Office only. A firm planned order carries a
 * quantity, a date and a supplier, never a price.
 */
export const PLANNING_FIRM_DEFINITIONS = definePermissions('planning', {
  firm: {
    risk: 'write',
    description: 'Make a planned order of the latest plan firm (how much, by when, from which supplier) so the next runs keep it instead of planning it again, and make it planned again.',
  },
})

export const PLANNING_FIRM = 'planning.firm' satisfies Permission

export const PLANNING_FIRM_PERMISSIONS: readonly Permission[] = Object.freeze([PLANNING_FIRM])
