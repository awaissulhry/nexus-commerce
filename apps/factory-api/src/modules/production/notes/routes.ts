import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { checkNotes } from './check'
import { checkNotesContract, writeNotesContract } from './contract'
import { manifest } from './manifest'
import { writeNotes } from './notes'

/** Note to N records and ask the supervisor (./manifest, B-PR-43a): the check before Send, and the write. */
export default defineRoutes('production.notes', manifest, async (app) => {
  app.post('/production/notes/check', { schema: checkNotesContract }, async (request) => checkNotes(request, request.body))

  app.post('/production/notes', { schema: writeNotesContract }, async (request) => writeNotes(request, request.body, idempotencyKeyFrom(request)))
})
