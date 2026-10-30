import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Approved sources (B-W2a-10; SCM-005; apps/factory-api modules/purchasing/supplier-items). Seeing them is
 * purchasing.view (their prices only with the cost grain, money.cost); keeping them is its own permission, so a tenant
 * may let someone keep the price lists without placing orders. Checked with can() against the source's company (every
 * company for a source of every company) and its supplier. Office only. Requests to buy (modules/purchasing/requests)
 * need no permission of their own: seeing the queue is purchasing.view, drafting purchase orders from it
 * purchasing.manage, as "Draft PO" from the plan.
 */
export const PURCHASING_SOURCES_DEFINITIONS = definePermissions('purchasing', {
  'sources.manage': {
    risk: 'write',
    description: "Keep the approved sources of the materials: a supplier's article and colour codes, the unit it sells in, its price (a cost), minimum, steps and lead time, which source is the primary one; archive a source and approve it again.",
  },
})

export const PURCHASING_SOURCES_MANAGE = 'purchasing.sources.manage' satisfies Permission

export const PURCHASING_SOURCES_PERMISSIONS: readonly Permission[] = Object.freeze([PURCHASING_SOURCES_MANAGE])
