import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * The exception list of the planning runs (apps/factory-api modules/planning/exceptions; B-W2a-22; PLN-193; design
 * planning.exceptions). Reading it is planning.view; working it is this permission, checked with can() against the
 * site's company and the site. Office only. An exception carries quantities and dates, never money or a person's figure.
 */
export const PLANNING_EXCEPTIONS_DEFINITIONS = definePermissions('planning', {
  'exceptions.manage': {
    risk: 'write',
    description: 'Work the exception list of a site\'s planning runs: acknowledge an exception (and own it), snooze it until a moment or the next run, resolve it with a note.',
  },
})

export const PLANNING_EXCEPTIONS_MANAGE = 'planning.exceptions.manage' satisfies Permission

export const PLANNING_EXCEPTIONS_PERMISSIONS: readonly Permission[] = Object.freeze([PLANNING_EXCEPTIONS_MANAGE])
