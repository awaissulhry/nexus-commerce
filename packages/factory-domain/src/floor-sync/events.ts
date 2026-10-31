import { z } from 'zod'
import { defineEvent } from '../events/define'
import { CONFLICT_KINDS } from './conflicts/rules'

/**
 * The floor sync's events (B-W0-30; apps/factory-api platform/floor-sync). The module commands that a queued event runs
 * emit their own events (production.scan_recorded, production.bundle_created …); these two are about the queue itself.
 *
 *   floor.action_refused         a tablet's queued action was refused and kept with its reason and fix: the refused
 *                                actions lists refresh (the office's with floorsync.view, and the tablets of the site)
 *   floor.refused_action_closed  a refused action was recorded after all (RESOLVED: the same event passed when sent
 *                                again) or discarded with a reason (DISCARDED): it leaves the open lists
 */

const live = { permission: 'floorsync.view', floor: 'floor.work', fields: ['refusedId', 'deviceId'] } as const

/**
 * B-W2b-52 (MES-196; platform/floor-sync/conflicts): a KEEP_RECORDED decision discards the refused action (it announces
 * itself above); a SEND_TO_OFFICE decision changes no record, so it says so:
 *   floor.conflict_sent_to_office   a team leader sent a sync conflict to the office (the refused report should stand):
 *                                   the office's refused lists and the line's conflict list refresh. No person in it.
 */
const conflictSentToOffice = defineEvent({
  type: 'floor.conflict_sent_to_office',
  context: 'floor-sync',
  description: 'A team leader sent a sync conflict (one bundle reported on two tablets) to the office: the refused report should stand.',
  payload: z.strictObject({
    refusedId: z.uuid(),
    deviceId: z.uuid(),
    kind: z.enum(CONFLICT_KINDS),
    /** The lead's reason tile (floor-sync/conflicts/rules CONFLICT_REASONS.SEND_TO_OFFICE). */
    reason: z.string(),
  }),
  live: { permission: 'floorsync.view', floor: 'floor.lead', fields: ['refusedId', 'deviceId'] },
})

export const events = [
  defineEvent({
    type: 'floor.action_refused',
    context: 'floor-sync',
    description: "A floor tablet's queued action was refused and kept with its reason in words and one fix.",
    payload: z.strictObject({
      refusedId: z.uuid(),
      deviceId: z.uuid(),
      kind: z.string(),
      code: z.string(),
      /** False: the tablet sends it again by itself. */
      final: z.boolean(),
    }),
    live,
  }),
  defineEvent({
    type: 'floor.refused_action_closed',
    context: 'floor-sync',
    description: 'A refused floor action left the open list: recorded when sent again, or discarded with a reason.',
    payload: z.strictObject({
      refusedId: z.uuid(),
      deviceId: z.uuid(),
      status: z.enum(['RESOLVED', 'DISCARDED']),
      /** Who closed it: the tablet, the office, or the server when the same event passed. */
      by: z.enum(['FLOOR', 'OFFICE', 'SYSTEM']),
    }),
    live,
  }),
  // B-W2b-52
  conflictSentToOffice,
] as const
