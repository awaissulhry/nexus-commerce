import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { announceContract, completeContract, floorAsksContract, noteContract, tilesContract } from './contract'
import { manifest } from './manifest'
import { announceFile, completeFile, noteTiles, postFloorNote } from './notes'
import { floorAsks } from './asks' // B-OF-034
// owb-fl3 (S5 server B): Tell the office and the Me page.
import { profileContract, suggestionContract, suggestionVoiceCompleteContract, suggestionVoiceContract } from './contract'
import { myProfile } from './profile'
import { announceSuggestionVoice, completeSuggestionVoice, tellOffice } from './suggestions'

/**
 * A comment or a photo from the floor (B-W2b-47; MES-101, COL-017): the tiles and the reminder, a file announced and
 * confirmed, the note on the work order's thread (201 posted; 200 a resend of its clientEventId). Offline the note queues as
 * production.floorNote.post; a picture goes up when the network is back, before the note is sent.
 */
export default defineRoutes('production.floornotes', manifest, async (app) => {
  app.get('/production/floor-notes/tiles', { schema: tilesContract }, async () => noteTiles())

  // B-OF-034: the office's open asks for files this tablet answers (a photo with `askId` answers one).
  app.get('/production/floor-notes/asks', { schema: floorAsksContract }, async (request) => floorAsks(request))

  app.post('/production/floor-notes/work-orders/:workOrderId/files', { schema: announceContract }, async (request, reply) => reply.code(201).send(await announceFile(request, request.params.workOrderId, request.body, idempotencyKeyFrom(request))))

  app.post('/production/floor-notes/work-orders/:workOrderId/files/:fileId/complete', { schema: completeContract }, async (request) => completeFile(request, request.params.workOrderId, request.params.fileId, idempotencyKeyFrom(request)))

  app.post('/production/floor-notes/work-orders/:workOrderId', { schema: noteContract }, async (request, reply) => {
    const { replayed, ...answer } = await postFloorNote(request, request.params.workOrderId, request.body)
    return reply.code(replayed ? 200 : 201).send(answer)
  })

  // ---- owb-fl3 (S5 server B): Tell the office (./suggestions.ts) and the Me page (./profile.ts) ----
  app.post('/floor/suggestions/files', { schema: suggestionVoiceContract }, async (request, reply) => reply.code(201).send(await announceSuggestionVoice(request, request.body, idempotencyKeyFrom(request))))

  app.post('/floor/suggestions/files/:fileId/complete', { schema: suggestionVoiceCompleteContract }, async (request) => completeSuggestionVoice(request, request.params.fileId, idempotencyKeyFrom(request)))

  app.post('/floor/suggestions', { schema: suggestionContract }, async (request, reply) => {
    const answer = await tellOffice(request, request.body, idempotencyKeyFrom(request))
    return reply.code(answer.replayed ? 200 : 201).send(answer)
  })

  app.get('/floor/me/profile', { schema: profileContract }, async (request) => myProfile(request))
})
