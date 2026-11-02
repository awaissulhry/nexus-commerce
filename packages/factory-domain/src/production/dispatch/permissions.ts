import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Dispatch every shift (apps/factory-api modules/production/dispatch; B-W2b-49; MES-022, -023, -025 … -028, -031, -032,
 * -033; design production.dispatch SCR-138, floor.supervisor "Stations" and "Handover note", floor.mywork), in the production
 * area. Each is checked with can() against the site's company and site; a floor device works at its own site only (can()
 * pins it, row-level security too).
 *
 * The W2a dispatch list stays where it was (workorders.view in the office, floor.work on the tablet); My work is floor.work.
 *
 * Nothing here measures a person (Statuto dei Lavoratori art. 4; Owner answers W1, F2): load is per line and station. A
 * name stands beside a station or an operation only where the site's floor records name workers, with the skill level
 * for that operation (a training record), never output, speed or a rank; no list, filter, group or total is per person.
 * Who is not clocked in shows only to those who run the board (dispatch.manage), only with the site's ATTENDANCE basis in
 * force, and never why.
 */
export const PRODUCTION_DISPATCH_DEFINITIONS = definePermissions('production', {
  'dispatch.view': {
    risk: 'read',
    description:
      "See the dispatch board of the sites: the lines and stations with the work queued there for a shift, the operator's name and skill level beside a station where the site names workers, what is not assigned yet, the load of each line against its available minutes, the printed list and the handover notes; load per line and station only, never a figure per person.",
  },
  'dispatch.manage': {
    risk: 'write',
    description:
      'Run the dispatch board: assign an operator to a station or an operation (the qualification check runs), reassign work whose operator is not clocked in, and in the office move work or bundles between stations, lines and operators and put them in order. Holds who is not clocked in on the board, where the site has the attendance basis in force; a floor device: at its own site.',
  },
  'dispatch.handover': {
    risk: 'write',
    description: 'Write and edit the handover note of a line for a shift (topics and a short text): the next shift reads it at sign-in; a floor device: at its own site.',
  },
})

export const PRODUCTION_DISPATCH_VIEW = 'production.dispatch.view' satisfies Permission
export const PRODUCTION_DISPATCH_MANAGE = 'production.dispatch.manage' satisfies Permission
export const PRODUCTION_DISPATCH_HANDOVER = 'production.dispatch.handover' satisfies Permission

export const PRODUCTION_DISPATCH_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCTION_DISPATCH_VIEW, PRODUCTION_DISPATCH_MANAGE, PRODUCTION_DISPATCH_HANDOVER])

/**
 * What a floor role may hold of them (FLOOR_SHARED_PERMISSIONS): the team leader's line view reads its line's stations and
 * load, reassigns work and writes the handover note at its own site. Moving work between lines is the office's.
 */
export const PRODUCTION_DISPATCH_FLOOR_PERMISSIONS: readonly Permission[] = PRODUCTION_DISPATCH_PERMISSIONS
