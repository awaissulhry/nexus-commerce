import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * An unplanned operation (apps/factory-api modules/production/extraops; B-W2b-47; MES-086): the team leader on the tablet,
 * or the production office, adds to a released work order an operation its routing does not have, with a reason. Seeing
 * them is part of the work order record (workorders.view; the floor: production.scan). Nothing here carries money.
 */
export const PRODUCTION_EXTRAOPS_DEFINITIONS = definePermissions('production', {
  'extraops.add': {
    risk: 'write',
    description: 'Add to a released work order an operation of the library that its routing does not have, with a reason.',
  },
})

export const PRODUCTION_EXTRAOPS_ADD = 'production.extraops.add' satisfies Permission

export const PRODUCTION_EXTRAOPS_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCTION_EXTRAOPS_ADD])

/** What a floor role may hold of them (FLOOR_SHARED_PERMISSIONS). */
export const PRODUCTION_EXTRAOPS_FLOOR_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCTION_EXTRAOPS_ADD])
