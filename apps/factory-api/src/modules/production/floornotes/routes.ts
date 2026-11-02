import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { announceContract, completeContract, noteContract, tilesContract } from './contract'
import { manifest } from './manifest'
import { announceFile, completeFile, noteTiles, postFloorNote } from './notes'

/**
 * A comment or a photo from the floor (B-W2b-47; MES-101, COL-017): the tiles and the reminder, a file announced and
 * confirmed, the note on the work order's thread (201 posted; 200 a resend of its clientEventId). Offline the note queues as
 * production.floorNote.post; a picture goes up when the network is back, before the note is sent.
 */
export default defineRoutes('production.floornotes', manifest, async (app) => {
  app.get('/production/floor-notes/tiles', { schema: tilesContract }, async () => noteTiles())

  app.post('/production/floor-notes/work-orders/:workOrderId/files', { schema: announceContract }, async (request, reply) => reply.code(201).send(await announceFile(request, request.params.workOrderId, request.body, idempotencyKeyFrom(request))))

  app.post('/production/floor-notes/work-orders/:workOrderId/files/:fileId/complete', { schema: completeContract }, async (request) => completeFile(request, request.params.workOrderId, request.params.fileId, idempotencyKeyFrom(request)))

  app.post('/production/floor-notes/work-orders/:workOrderId', { schema: noteContract }, async (request, reply) => {
    const { replayed, ...answer } = await postFloorNote(request, request.params.workOrderId, request.body)
    return reply.code(replayed ? 200 : 201).send(answer)
  })
})
