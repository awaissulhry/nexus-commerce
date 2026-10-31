import { z } from 'zod'
import { defineEvent } from '../events/define'

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
] as const
