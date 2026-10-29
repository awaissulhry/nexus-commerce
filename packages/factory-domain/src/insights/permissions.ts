import type { Permission } from '../core/permissions'
import { definePermissions } from '../auth/permissions/registry'

/**
 * Home › Today (apps/factory-api modules/insights; B-W1-52; ANA-037, SCR-029, SCR-031 W1 "Overview"), in the home area.
 * One permission reaches the page: what it shows is computed from the records the person's other permissions reach, so
 * home.view alone shows an empty list (never a record the person could not open in its own area).
 *
 *   view   the needs-attention list (what waits for me, ranked, with why it is mine and what it holds up), the role's
 *          flow strip (records per stage, how many late) and what I wait for from others
 */
export const HOME_DEFINITIONS = definePermissions('home', {
  view: {
    risk: 'read',
    description:
      "See Today: the ranked list of what waits for you across every area and company you work in (each row says why it is yours and what it holds up), your role's records per stage, and what you wait for from others. It shows only records your other permissions reach.",
  },
})

export const HOME_VIEW = 'home.view' satisfies Permission

export const HOME_PERMISSIONS: readonly Permission[] = Object.freeze([HOME_VIEW])
