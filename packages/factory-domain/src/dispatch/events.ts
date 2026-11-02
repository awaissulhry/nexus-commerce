import { z } from 'zod'
import { defineEvent } from '../events/define'
import { HANDOVER_TOPICS } from '../production/dispatch/handover'

/**
 * Dispatch every shift (B-W2b-49; MES-023, MES-027, MES-033; design production.dispatch "'List changed 10:42' after a
 * move", floor.mywork "the 'List changed · Show' button", floor.signin). apps/factory-api's modules/production/dispatch
 * emits them in the commands that make the change. Its own module folder: production's events file is another step's.
 *
 *   dispatch.assignment_changed   an operator was assigned or reassigned, or work was moved, put in order or taken off (the
 *                                 board, the station's list and My work read again)
 *   dispatch.handover_written     a line's handover note of a shift was written or edited
 *
 * Reach the office's board (production.dispatch.view) and the floor devices of the site (floor.work: the lists of its
 * tablets). Ids, days and states only: never who (Statuto dei Lavoratori art. 4), never the words of a note.
 */

const live = { permission: 'production.dispatch.view', floor: 'floor.work' } as const

export const DISPATCH_CHANGES = ['ASSIGNED', 'REASSIGNED', 'MOVED', 'REMOVED'] as const

export const events = [
  defineEvent({
    type: 'dispatch.assignment_changed',
    context: 'dispatch',
    description: "A site's dispatch of a day changed: an operator assigned or reassigned, work moved, put in order or taken off; the lines and stations it touched.",
    payload: z.strictObject({
      siteId: z.uuid(),
      workDate: z.iso.date(),
      change: z.enum(DISPATCH_CHANGES),
      assignmentIds: z.array(z.uuid()),
      lineIds: z.array(z.uuid()),
      stationIds: z.array(z.uuid()),
      workOrderId: z.uuid().nullable(),
      workOrderOperationId: z.uuid().nullable(),
    }),
    live: { ...live, fields: ['siteId', 'workDate', 'change', 'lineIds', 'stationIds', 'workOrderId'] },
  }),
  defineEvent({
    type: 'dispatch.handover_written',
    context: 'dispatch',
    description: "A line's handover note of a shift was written or edited (its topics, never its words).",
    payload: z.strictObject({
      noteId: z.uuid(),
      siteId: z.uuid(),
      lineId: z.uuid(),
      shiftDate: z.iso.date(),
      shiftLabel: z.string(),
      topics: z.array(z.enum(HANDOVER_TOPICS)),
      by: z.enum(['OFFICE', 'FLOOR']),
    }),
    live: { ...live, fields: ['noteId', 'lineId', 'shiftDate', 'shiftLabel', 'topics'] },
  }),
] as const
