import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Line targets and boards (apps/factory-api modules/production/boards; B-W2b-50; MES-084, MES-161, MES-162, MES-166,
 * ANA-007; design production.floor "Hour by hour", "WIP by operation" heat map, the popover "Why was 10:00–11:00 short?",
 * the new tab "Line TV board"; floor.display SCR-173), in the production area. Each is checked with can() against the
 * line's company and site; a floor device works at its own site only (can() pins it, row-level security too).
 *
 * The line TV of a DISPLAY device needs none of them: nobody signs in on it (B-W2b-52), it reads its own line's board with
 * the device token alone.
 *
 * Nothing here measures a person (Statuto dei Lavoratori art. 4; Owner answers W1, F2): targets are a LINE's pieces an
 * hour, the boards show line and team totals only, never a figure per person in a list, filter, group or total, and never
 * a worker's name.
 */
export const PRODUCTION_BOARDS_DEFINITIONS = definePermissions('production', {
  'boards.view': {
    risk: 'read',
    description:
      "See the line boards of the sites: each line's pieces hour by hour against its hourly targets with the reasons given for a short hour, the bundles waiting at each operation across the lines (the WIP heat map) and the line TV board (output, the stations' call and machine states, WIP, DHU, the team leader's note); line and team totals only, never per person.",
  },
  'boards.targets': {
    risk: 'write',
    description: "Set, change and remove a line's hourly targets for a day (the pieces out of the line each hour), today or later; never a target per person.",
  },
  'boards.reason': {
    risk: 'write',
    description: "Give the reason for a line's short hour (a code of the downtime reason list and a few words), once the hour is over; a floor device: at its own site.",
  },
})

export const PRODUCTION_BOARDS_VIEW = 'production.boards.view' satisfies Permission
export const PRODUCTION_BOARDS_TARGETS = 'production.boards.targets' satisfies Permission
export const PRODUCTION_BOARDS_REASON = 'production.boards.reason' satisfies Permission

export const PRODUCTION_BOARDS_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCTION_BOARDS_VIEW, PRODUCTION_BOARDS_TARGETS, PRODUCTION_BOARDS_REASON])

/**
 * What a floor role may hold of them (FLOOR_SHARED_PERMISSIONS): the team leader's line view reads its line's hour by hour
 * and board, and gives the reason for a short hour at its own site. Setting targets is the office's.
 */
export const PRODUCTION_BOARDS_FLOOR_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCTION_BOARDS_VIEW, PRODUCTION_BOARDS_REASON])
