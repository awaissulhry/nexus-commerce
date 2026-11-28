import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * The factory structure (owb- order workflow, plan.md § 5 D; PL-split S3 ss5 + ss8): the units of the factory (a team, a group of
 * teams, a department's crew), who leads each, which unit sits under which, a unit's picture as letters or an icon (never a
 * photo: the schema's data-minimisation rule), moving, merging and closing units. Checked with can() against the unit's company
 * and site. Office only; nothing here carries money or measures a person.
 *
 *   people.structure.view     see the factory structure: its units and teams, who leads each and who is in it (GET
 *                             /people/structure, GET /people/units/:unitId) — owb-b7 (R49, the Owner's yes of 2026-11-28): the
 *                             structure's two reads take people.view OR this right; the HR register (every other people.view
 *                             read: employees, a person's record, the histories) stays people.view only
 *   people.structure.manage   keep the factory structure: add, change, move, merge and close units and set who leads them
 */
export const PEOPLE_STRUCTURE_DEFINITIONS = definePermissions('people', {
  'structure.view': {
    risk: 'read',
    description: 'See the factory structure: its units and teams, who leads each and who is in it. Not the people register.',
  },
  'structure.manage': {
    risk: 'write',
    description: "Keep the factory structure: add, change, move, merge or close a unit (a team or a group of teams), set who leads it and its picture as letters or an icon.",
  },
})

export const PEOPLE_STRUCTURE_VIEW = 'people.structure.view' satisfies Permission
export const PEOPLE_STRUCTURE_MANAGE = 'people.structure.manage' satisfies Permission

export const PEOPLE_STRUCTURE_PERMISSIONS: readonly Permission[] = Object.freeze([PEOPLE_STRUCTURE_VIEW, PEOPLE_STRUCTURE_MANAGE])

/**
 * The role templates (roles/templates addedFor; the Owner from every(), read-only takes the read from every()). The administrator
 * and HR keep the people register today (people.teams.manage), so they keep its structure too (people.view reads it for them).
 * owb-b7 (R49): Sales reads the structure (which team makes an order) without the people register.
 */
export const PEOPLE_STRUCTURE_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  admin: [PEOPLE_STRUCTURE_MANAGE],
  hr: [PEOPLE_STRUCTURE_MANAGE],
  sales: [PEOPLE_STRUCTURE_VIEW],
})
