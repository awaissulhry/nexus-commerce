import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Planning settings and capacity (apps/factory-api modules/planning/settings and capacity; B-W2a-16; PLN-003, PLN-005,
 * PLN-014, PLN-099, PLN-115, PLN-116; design planning.settings "Item parameters", "Reorder rules", "Horizon & fences",
 * "Line efficiency", planning.capacity "Capacity & load"). Reading them is planning.view (the planning module's); keeping
 * them is one of these, checked with can() against the site's company and the site (a line's or work centre's: its
 * site). Office only. Nothing here names a person or carries money: efficiency and people are per line or work centre,
 * never per person (Statuto dei Lavoratori art. 4).
 */
export const PLANNING_SETTINGS_DEFINITIONS = definePermissions('planning', {
  'settings.manage': {
    risk: 'write',
    description:
      "Keep a site's planning settings (how far the plan looks ahead, its day, week and month buckets, the default efficiency, the time of the nightly run) and the planned efficiency and people of its lines and work centres, which the capacity is counted with.",
  },
  'items.manage': {
    risk: 'write',
    description:
      'Keep how a site plans each item and colour: from the orders, by a reorder point or by min/max; its lead times, safety stock, order minimum, step and maximum; bought from which supplier or made at which plant. Remove them to plan the item by its defaults again.',
  },
})

export const PLANNING_SETTINGS_MANAGE = 'planning.settings.manage' satisfies Permission
export const PLANNING_ITEMS_MANAGE = 'planning.items.manage' satisfies Permission

export const PLANNING_SETTINGS_PERMISSIONS: readonly Permission[] = Object.freeze([PLANNING_SETTINGS_MANAGE, PLANNING_ITEMS_MANAGE])
