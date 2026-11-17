import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { listPartnerThreadsContract, postPartnerMessageContract, readPartnerThreadContract } from '../../threads/partner/contract'
import { listPartnerThreads, postPartnerMessage, readPartnerThread } from '../../threads/partner/service'
// B-TH-027: the person's own read mark.
import { markPartnerReadContract } from '../../threads/partner/contract'
import { markPartnerThreadRead } from '../../threads/partner/service'
import { manifest } from './manifest'
// B-TH-085: the composer attaches files to its record (behind the outside-upload gate and the virus scanner).
import { processFiles } from '../../files/service'
import { announcePartnerFileContract, completePartnerFileContract } from '../../threads/partner/contract'
import { announcePartnerFile, completePartnerFile } from '../../threads/partner/service'

/**
 * The record thread as the partner sees it (B-W2b-168; COL-059, COL-060; design portal.frame › thread "Ask a question /
 * Messages", portal.customer.home › recent-messages). The work is platform/threads/partner (this folder holds the routes
 * only: the route loader does not look under platform/threads, which has its own routes file).
 *   GET  /portal/threads?from=&limit=                       the party's conversations, newest message first
 *   GET  /portal/threads/:recordType/:recordId?cursor=&limit= the record's shared messages and the composer's state
 *   POST /portal/threads/:recordType/:recordId/messages      a portal post into the record's thread (201)
 *   POST /portal/threads/:recordType/:recordId/files         B-TH-085: a file for the composer, on the record, shared with the party (201)
 *   POST /portal/threads/:recordType/:recordId/files/:fileId/complete   its bytes arrived (with the scanner: held until clean)
 */
export default defineRoutes('portal-threads', manifest, async (app) => {
  app.get('/portal/threads', { schema: listPartnerThreadsContract }, async (request) => listPartnerThreads(request, request.query))

  app.get('/portal/threads/:recordType/:recordId', { schema: readPartnerThreadContract }, async (request) => {
    const { recordType, recordId } = request.params
    return readPartnerThread(request, { type: recordType, id: recordId }, request.query)
  })

  app.post('/portal/threads/:recordType/:recordId/messages', { schema: postPartnerMessageContract }, async (request, reply) => {
    const { recordType, recordId } = request.params
    return reply.code(201).send(await postPartnerMessage(request, { type: recordType, id: recordId }, request.body, idempotencyKeyFrom(request)))
  })

  // ---- B-TH-085
  app.post('/portal/threads/:recordType/:recordId/files', { schema: announcePartnerFileContract }, async (request, reply) => {
    const { recordType, recordId } = request.params
    return reply.code(201).send(await announcePartnerFile(processFiles(), request, { type: recordType, id: recordId }, request.body, idempotencyKeyFrom(request)))
  })
  app.post('/portal/threads/:recordType/:recordId/files/:fileId/complete', { schema: completePartnerFileContract }, async (request) => {
    const { recordType, recordId, fileId } = request.params
    return completePartnerFile(processFiles(), request, { type: recordType, id: recordId }, fileId, idempotencyKeyFrom(request))
  })
  // ---- end B-TH-085

  // ---- B-TH-027
  app.post('/portal/threads/:recordType/:recordId/read', { schema: markPartnerReadContract }, async (request) => {
    const { recordType, recordId } = request.params
    return markPartnerThreadRead(request, { type: recordType, id: recordId }, request.body, idempotencyKeyFrom(request))
  })
  // ---- end B-TH-027
})
