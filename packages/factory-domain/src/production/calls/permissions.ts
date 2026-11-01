import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Help calls (apps/factory-api modules/production/calls; B-W2b-35; MES-142 … MES-145, MES-147, MES-137; design floor.help
 * SCR-172, production.calls SCR-142, production.settings "Help-call routing", floor.supervisor "Calls", floor.display
 * "Stations"), in the production area. Each is checked with can() against the call's (or the type's) company and site; a
 * floor device works at its own site only (can() pins it, row-level security too).
 *
 * Sending a call from the station is the floor's own work (floor.work: every floor role, one tap): it needs none of these.
 * The station that sent a call also closes it ("It's solved", "Cancel call") with floor.work. Answering is a responder's
 * (a team leader on the line view, maintenance, the warehouse, quality, the office): calls.answer, which the floor shares.
 *
 * Nothing here measures a person (Statuto dei Lavoratori art. 4; Owner answers W1, F2): response times are a call's and a
 * line's, never a figure per person in a list, filter, group or total; the caller is named only inside one call, and only
 * where the site's floor records name workers.
 */
export const PRODUCTION_CALLS_DEFINITIONS = definePermissions('production', {
  'calls.view': {
    risk: 'read',
    description:
      "See the help calls of the sites: each call's station, line, type, the team it went to and its times (sent, seen, on the way, solved); the open calls, the calls by hour and the response times per line and type (never per person); the call states of a line's stations (the line view, the line TV); the help-call types and who answers them.",
  },
  'calls.answer': {
    risk: 'write',
    description:
      'Answer help calls: mark a call seen, on the way or solved (with how it was solved), cancel one, and name what it led to (a maintenance job, a machine request, a nonconformance, a task); a floor device: at its own site.',
  },
  'calls.manage': {
    risk: 'write',
    description:
      "Keep the help-call types of a site (Floor rules & codes): which code of the help-call reason list each is, its kind, the team of the site that answers it (or the site's team leaders), after how many minutes it should escalate, the off-standard code the station's waiting time books to, their order, and switch one off or on again.",
  },
})

export const PRODUCTION_CALLS_VIEW = 'production.calls.view' satisfies Permission
export const PRODUCTION_CALLS_ANSWER = 'production.calls.answer' satisfies Permission
export const PRODUCTION_CALLS_MANAGE = 'production.calls.manage' satisfies Permission

export const PRODUCTION_CALLS_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCTION_CALLS_VIEW, PRODUCTION_CALLS_ANSWER, PRODUCTION_CALLS_MANAGE])

/**
 * What a floor role may hold of them (FLOOR_SHARED_PERMISSIONS): the line's call states and the open calls (the team
 * leader's line view, a technician's tablet), and answering them at its own site. Keeping the types is the office's.
 */
export const PRODUCTION_CALLS_FLOOR_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCTION_CALLS_VIEW, PRODUCTION_CALLS_ANSWER])
