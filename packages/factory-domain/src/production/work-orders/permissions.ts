import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * The work orders' permissions (apps/factory-api modules/production/work-orders; features MES-001, MES-002, MES-005,
 * MES-007, MES-305; A2 SCR-069, SCR-070; A1 §3.11 names `workorders.release`). Each is checked with can() against the
 * work order's company and site. Office only: the floor reads its own site's work orders through its own screens
 * (B-W1-39, 40, 42), never these routes. Nothing here carries money.
 */
export const WORKORDERS_DEFINITIONS = definePermissions('workorders', {
  view: { risk: 'read', description: 'See the work orders: their cells, frozen specification, release check, status and history, and how the frozen specification compares with the style today; print their travellers.' },
  manage: { risk: 'write', description: 'Make a draft work order from sales order lines, change its cells and revision while it is a draft, split a draft in two, its due date, priority, rush flag and note; start, complete, close or cancel it with a reason.' },
  release: { risk: 'write', description: 'Release a work order to the floor: its specification is frozen and its batch number given; a material shortage passes only with a reason.' },
})

export const WORKORDERS_VIEW = 'workorders.view' satisfies Permission
export const WORKORDERS_MANAGE = 'workorders.manage' satisfies Permission
export const WORKORDERS_RELEASE = 'workorders.release' satisfies Permission

export const WORKORDERS_PERMISSIONS: readonly Permission[] = Object.freeze([WORKORDERS_VIEW, WORKORDERS_MANAGE, WORKORDERS_RELEASE])
