import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { listPartnerThreadsContract, postPartnerMessageContract, readPartnerThreadContract } from '../../threads/partner/contract'
import { listPartnerThreads, postPartnerMessage, readPartnerThread } from '../../threads/partner/service'
import { manifest } from './manifest'

/**
 * The record thread as the partner sees it (B-W2b-168; COL-059, COL-060; design portal.frame › thread "Ask a question /
 * Messages", portal.customer.home › recent-messages). The work is platform/threads/partner (this folder holds the routes
 * only: the route loader does not look under platform/threads, which has its own routes file).
 *   GET  /portal/threads?from=&limit=                       the party's conversations, newest message first
 *   GET  /portal/threads/:recordType/:recordId?cursor=&limit= the record's shared messages and the composer's state
 *   POST /portal/threads/:recordType/:recordId/messages      a portal post into the record's thread (201)
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
})
