import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Order structures (owb- order workflow, plan.md § 5 D; PL-split S3 ss6): how the factory handles an order — its steps as the
 * product says, the team and the people — kept as ready structures, and the rules that pick a structure for an order (by
 * customer, product or size of the order). Checked with can() against the structure's company. Office only; nothing here
 * carries money.
 *
 *   production.structures.manage   keep the order structures: add, change, close, and put one on an order by hand
 *   production.structures.rules    keep the rules that pick a structure for an order, their order, and try them on an order
 */
export const PRODUCTION_STRUCTURES_DEFINITIONS = definePermissions('production', {
  'structures.manage': {
    risk: 'write',
    description: 'Keep the order structures (the steps, the team and the people an order gets): add, change or close one, and put one on an order by hand.',
  },
  'structures.rules': {
    risk: 'write',
    description: 'Keep the rules that pick an order structure for an order (by customer, product or size of the order), put them in order and try them on an order.',
  },
})

export const PRODUCTION_STRUCTURES_MANAGE = 'production.structures.manage' satisfies Permission
export const PRODUCTION_STRUCTURES_RULES = 'production.structures.rules' satisfies Permission

export const PRODUCTION_STRUCTURES_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCTION_STRUCTURES_MANAGE, PRODUCTION_STRUCTURES_RULES])

/**
 * The role templates (roles/templates addedFor; the Owner from every()). plan.md § 5 D: the production manager keeps the
 * structures; sales keeps the rules (which customer's orders get which structure).
 */
export const PRODUCTION_STRUCTURES_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  production_manager: [PRODUCTION_STRUCTURES_MANAGE],
  sales: [PRODUCTION_STRUCTURES_RULES],
})
