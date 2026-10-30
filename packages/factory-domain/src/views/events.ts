import { z } from 'zod'
import { defineEvent } from '../events/define'
import { EXPORT_FORMATS } from './exports'

/**
 * The exports' events (plan A1 §3.4; B-W2a-23; PLT-179). apps/factory-api platform/exports emits them in the commands
 * that ask for an export and that end it; the worker's handler `exports.run` reads the list on `export.requested`.
 * Ids, keys and counts only: never a cell of the list. No live rule: an export is the person's own (their screen asks
 * for its state), and the live feed is per permission, not per person.
 *
 *   export.requested  a person asked for the export of a list (QUEUED)
 *   export.finished   the export ended: DONE with its file, or FAILED with why (the notification centre may tell them)
 */
export const events = [
  defineEvent({
    type: 'export.requested',
    context: 'views',
    description: 'A person asked for the export of a list: the worker reads it with their rights and writes the file.',
    payload: z.strictObject({
      jobId: z.uuid(),
      listKey: z.string().min(1).max(120),
      format: z.enum(EXPORT_FORMATS),
      requestedById: z.uuid(),
    }),
  }),
  defineEvent({
    type: 'export.finished',
    context: 'views',
    description: 'The export of a list ended: its file is ready (DONE), or it failed and says why.',
    payload: z.strictObject({
      jobId: z.uuid(),
      listKey: z.string().min(1).max(120),
      status: z.enum(['DONE', 'FAILED']),
      rowCount: z.number().int().min(0).nullable(),
      fileId: z.uuid().nullable(),
      requestedById: z.uuid(),
    }),
  }),
] as const
