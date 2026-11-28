import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * The departments of the factory (owb- order workflow, plan.md § 5 D; PL-schema § 2): the company-wide list a basket visits
 * (1 Pattern, 2 Cutting … 9 Assembly), each with ONE number kept for ever, its names, short name, tone, icon and the ONE work
 * centre kind it stands on. Reading the list is the read of the page that shows it (workorders.view, product.styles.view,
 * floor.work: apps/factory-api modules/production/departments); keeping it is this one, in the production area. Checked with
 * can() against the department's company (a tenant-wide department: every company). Office only; nothing here carries money.
 *
 *   production.departments.manage   add a department (it takes the next free number, never one used before), rename it,
 *                                   change its short name, tone or icon, close it or open it again (a department is never
 *                                   deleted: its number stays on every route that named it)
 */
export const PRODUCTION_DEPARTMENTS_DEFINITIONS = definePermissions('production', {
  'departments.manage': {
    risk: 'write',
    description:
      "Keep the factory's departments: add one (it takes the next free number, never one used before), rename it, change its short name, colour or icon, close it or open it again.",
  },
})

export const PRODUCTION_DEPARTMENTS_MANAGE = 'production.departments.manage' satisfies Permission

export const PRODUCTION_DEPARTMENTS_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCTION_DEPARTMENTS_MANAGE])

/**
 * The role templates (roles/templates addedFor; the Owner from every()). The production manager keeps the departments (plan.md
 * § 5 D "production manager: departments, teams, structures"). Nobody on the floor: a department is the office's list.
 */
export const PRODUCTION_DEPARTMENTS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  production_manager: [PRODUCTION_DEPARTMENTS_MANAGE],
})
