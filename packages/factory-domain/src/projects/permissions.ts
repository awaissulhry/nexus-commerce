import type { Permission } from '../core/permissions'
import { definePartnerPermissions } from '../auth/partners/permissions'
import { definePermissions } from '../auth/permissions/registry'

/**
 * Projects (threads plan TH-5, B-TH-066; PROJ-G08). Checked with can() against the project's company AND its outside company
 * (the office's customer limit walls projects too: a person limited to brand A never opens or finds brand B's project, W38).
 *
 * The OFFICE's:
 *   projects.manage    make a project, change its name, goal, lead, target date and season, put it on hold, close it with its
 *                      outcome and reopen it, link and unlink its records, add and remove its people (office colleagues and
 *                      the outside company's portal people)
 * Reading a project is threads.read over it, as every record's conversation; writing in it and adding a colleague is
 * threads.post (the record thread's own rules, platform/threads): no new permission for them.
 *
 * The PARTNER's (area `portal`, flagged `partner`: held only by partner roles):
 *   portal.projects.view   see the projects of its organisation it was ADDED to by the factory (its members only: the API's
 *                          check on top of the party wall): name, status, target date, its own linked records, the shared
 *                          messages. Writing takes portal.comment, attaching portal.upload, as on every record.
 */
export const PROJECTS_DEFINITIONS = definePermissions('projects', {
  manage: {
    risk: 'write',
    description:
      "Make projects (work on several styles, samples and orders, or work with no record yet), change their name, goal, lead, target date and season, put them on hold, close them with their outcome and reopen them, link their records and add or remove their people, the outside company's portal people included.",
  },
})

export const PORTAL_PROJECTS_DEFINITIONS = definePartnerPermissions('portal', {
  'projects.view': {
    risk: 'read',
    description:
      "See the projects of your organisation the factory added you to: their name, status and target date, your own records linked to them and the messages shared with you.",
  },
})

export const PROJECTS_MANAGE = 'projects.manage' satisfies Permission
export const PROJECTS_PERMISSIONS: readonly Permission[] = Object.freeze([PROJECTS_MANAGE])

export const PORTAL_PROJECTS_VIEW = 'portal.projects.view' satisfies Permission
export const PORTAL_PROJECTS_PERMISSIONS: readonly Permission[] = Object.freeze([PORTAL_PROJECTS_VIEW])

/**
 * The office templates (auth/roles/templates; the owner from every()): the Administrator, Sales, the Production manager and the
 * Buyer make and keep projects (lead pick, 08-projects-notes §10). Every other office role reads them with threads.read.
 */
export const PROJECTS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  admin: [PROJECTS_MANAGE],
  sales: [PROJECTS_MANAGE],
  production_manager: [PROJECTS_MANAGE],
  buyer: [PROJECTS_MANAGE],
})

/**
 * The partner templates (auth/roles/templates PARTNER_ADDS, one line): every main customer, supplier and workshop role that
 * works with us on goods (not the money-only Finance and Invoices roles); each Admin follows. Membership stays the per-person
 * gate: a role that holds this sees only the projects its person was added to.
 */
export const PORTAL_PROJECTS_TEMPLATES = ['customer-buyer', 'customer-quality', 'customer-designer', 'customer-production', 'customer-viewer', 'supplier-orders', 'supplier-quality', 'subcontractor-jobs'] as const

export const PORTAL_PROJECTS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze(Object.fromEntries(PORTAL_PROJECTS_TEMPLATES.map((key) => [key, [PORTAL_PROJECTS_VIEW] as readonly Permission[]])))
