import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * People: leaver steps (apps/factory-api modules/people/leavers; B-W2b-26; MES-214; design people.employees "Leavers in
 * progress", "Start leaver steps"), in the people area. Checked with can() against the person's company and site.
 * Starting the steps agrees to what the system then does on its own after the last working day: the person's floor
 * sign-in is switched off (badge off, sessions ended). Ending the office account stays a step-up act in Admin › Users.
 */
export const PEOPLE_LEAVERS_DEFINITIONS = definePermissions('people', {
  'leavers.manage': {
    risk: 'write',
    description:
      "Start a person's leaver steps with their last working day (after it their floor sign-in is switched off on its own), tick or skip each step, cancel the leaving until the last day; the record becomes Left once every step is done.",
  },
})

export const PEOPLE_LEAVERS_MANAGE = 'people.leavers.manage' satisfies Permission

export const PEOPLE_LEAVERS_PERMISSIONS: readonly Permission[] = Object.freeze([PEOPLE_LEAVERS_MANAGE])
