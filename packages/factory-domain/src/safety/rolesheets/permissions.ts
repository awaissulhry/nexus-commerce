import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Safety at work: the role risk sheets, the scheda mansione (apps/factory-api modules/safety/rolesheets; B-W2b-128; QHS-236;
 * design plant.risk "Role sheets", the record's Role sheets tab, the pop-up "What this changes"; Owner answer H2), in the
 * safety area. Reading is safety.view (../organisation/permissions.ts); checked with can() against the sheet's company and
 * site.
 *
 *   safety.rolesheets.manage   keep the role sheets of a site: add one, type its risks and surveillance needs, its PPE kit
 *                              (items of the PPE catalogue, how many, when to wear them), the courses it asks (from the
 *                              course catalogue, within how many days) and whether the role needs health surveillance; Apply
 *                              it after reading what it changes for the people in the role; archive a sheet nobody active
 *                              is in, restore it.
 *
 * Which sheet a person is in is the HR record's (people.employees.manage, apps/factory-api modules/people/employees/
 * role-sheet.ts): the role change previews its courses, kit and visit first.
 */
export const SAFETY_ROLESHEETS_DEFINITIONS = definePermissions('safety', {
  'rolesheets.manage': {
    risk: 'write',
    description:
      "Keep the role risk sheets (scheda mansione) of a site: add a role, type its risks and surveillance needs, its PPE kit with when to wear each item, the courses it asks and whether it needs health surveillance; apply a sheet after reading what it changes for the people in the role (who now needs which course, which kit items to issue, how many visits become due); archive a role nobody active is in.",
  },
})

export const SAFETY_ROLESHEETS_MANAGE = 'safety.rolesheets.manage' satisfies Permission

export const SAFETY_ROLESHEETS_PERMISSIONS: readonly Permission[] = Object.freeze([SAFETY_ROLESHEETS_MANAGE])
