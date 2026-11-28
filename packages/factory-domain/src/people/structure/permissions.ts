import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * The factory structure (owb- order workflow, plan.md § 5 D; PL-split S3 ss5 + ss8): the units of the factory (a team, a group of
 * teams, a department's crew), who leads each, which unit sits under which, a unit's picture as letters or an icon (never a
 * photo: the schema's data-minimisation rule), moving, merging and closing units. Reading it is people.view. Checked with can()
 * against the unit's company and site. Office only; nothing here carries money or measures a person.
 *
 *   people.structure.manage   keep the factory structure: add, change, move, merge and close units and set who leads them
 */
export const PEOPLE_STRUCTURE_DEFINITIONS = definePermissions('people', {
  'structure.manage': {
    risk: 'write',
    description: "Keep the factory structure: add, change, move, merge or close a unit (a team or a group of teams), set who leads it and its picture as letters or an icon.",
  },
})

export const PEOPLE_STRUCTURE_MANAGE = 'people.structure.manage' satisfies Permission

export const PEOPLE_STRUCTURE_PERMISSIONS: readonly Permission[] = Object.freeze([PEOPLE_STRUCTURE_MANAGE])

/**
 * The role templates (roles/templates addedFor; the Owner from every()). The administrator and HR keep the people register
 * today (people.teams.manage), so they keep its structure too.
 */
export const PEOPLE_STRUCTURE_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  admin: [PEOPLE_STRUCTURE_MANAGE],
  hr: [PEOPLE_STRUCTURE_MANAGE],
})
