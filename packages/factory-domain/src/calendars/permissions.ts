import type { Permission } from '../core/permissions'
import { definePermissions } from '../auth/permissions/registry'

/**
 * Business calendars and shift patterns (apps/factory-api platform/calendars; B-W2a-08; PLT-103, PLN-001, PLN-002;
 * design planning.settings "Calendars & shifts", admin.org "Working days and holidays", Purchasing › Supplier
 * closures). Checked with can() against the calendar's owner: its company and site (a line or workshop: its site), a
 * supplier's: its company and party. A company's calendar and a tenant-wide or company shift pattern reach every site
 * of the company: keeping them needs a grant over all its sites (every company for a tenant-wide pattern). Office
 * only. Nothing here names a person or carries money.
 */
export const CALENDARS_DEFINITIONS = definePermissions('calendars', {
  view: {
    risk: 'read',
    description: "See the business calendars of the companies, sites, lines, workshops and suppliers: working week, holidays, closures and extra working days, the shift patterns, and the working time, next working day and a supplier's closed days they give.",
  },
  manage: {
    risk: 'write',
    description: 'Keep the calendars of the companies, sites, lines and workshops: make and archive them, set the working week and the shift pattern, add and remove holidays, closures and extra working days, load the national holidays, and keep the shift patterns with their shifts and breaks.',
  },
  'suppliers.manage': {
    risk: 'write',
    description: "Keep the suppliers' and subcontractors' calendars: their working week and the days they are closed (August, Christmas), which the order-by dates count around.",
  },
})

export const CALENDARS_VIEW = 'calendars.view' satisfies Permission
export const CALENDARS_MANAGE = 'calendars.manage' satisfies Permission
export const CALENDARS_SUPPLIERS_MANAGE = 'calendars.suppliers.manage' satisfies Permission

export const CALENDARS_PERMISSIONS: readonly Permission[] = Object.freeze([CALENDARS_VIEW, CALENDARS_MANAGE, CALENDARS_SUPPLIERS_MANAGE])
