import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Working-time limits (B-W2b-42; apps/factory-api modules/people/limits; MES-232; design people.settings "Working-time
 * limits"), in the people area. The limits themselves carry no person: they are read with the roster's or attendance's
 * own permission. What a limit says about one person is attendance data: people.attendance.view, behind the site's
 * ATTENDANCE gate.
 *
 *   people.limits.manage   keep the working-time limits of a company or a site: the value, warn or block, whom it alerts,
 *                          and the law or CCNL article it applies
 */
export const PEOPLE_LIMITS_DEFINITIONS = definePermissions('people', {
  'limits.manage': {
    risk: 'write',
    description: 'Keep the working-time limits of a company or a site (rest between shifts, weekly average, overtime cap, night work): the value, warn or block, whom it alerts, and the law or CCNL article it applies.',
  },
})

export const PEOPLE_LIMITS_MANAGE = 'people.limits.manage' satisfies Permission

export const PEOPLE_LIMITS_PERMISSIONS: readonly Permission[] = Object.freeze([PEOPLE_LIMITS_MANAGE])
