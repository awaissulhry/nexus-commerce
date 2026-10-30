import { idempotencyKeyFrom } from '../../core/command'
import { defineRoutes } from '../../core/manifest'
import { requireStepUp } from '../auth/office/account'
import { officeAuthOf } from '../auth/sessions/office-auth'
import { checkIdentityContract, createIdentityContract, listEmailsContract, listIdentitiesContract, sendEmailContract, updateIdentityContract } from './contract'
import { checkIdentity, createIdentity, listIdentities, updateIdentity } from './identities'
import { manifest } from './manifest'
import { listThreadEmails, sendFromThread } from './outbound'
import { processEmail } from './service'
// B-W2a-41: the delivery log and the blocked addresses (delivery/).
import { listBlockedContract, listDeliveryContract, unblockContract } from './delivery/contract'
import { listBlocked, listDelivery, unblockAddress } from './delivery/log'

/**
 * Email out (platform part; plan A1 §3.7; features PLT-139, PLT-230, COL-024): send a mail from a record's thread as
 * the signed-in person, list the thread's mail and where each one is, and keep the companies' sending identities. The
 * worker sends the queued mail (outbound.ts emailSendHandler); SES's notifications arrive through platform/inbound.
 */
export default defineRoutes('email-out', manifest, async (app) => {
  app.post('/threads/:recordType/:recordId/emails', { schema: sendEmailContract }, async (request, reply) => {
    const { recordType, recordId } = request.params
    return reply.code(201).send(await sendFromThread(request, { type: recordType, id: recordId }, request.body, idempotencyKeyFrom(request)))
  })

  app.get('/threads/:recordType/:recordId/emails', { schema: listEmailsContract }, async (request) => {
    const { recordType, recordId } = request.params
    return listThreadEmails(request, { type: recordType, id: recordId }, request.query)
  })

  app.get('/email/identities', { schema: listIdentitiesContract }, async (request) => listIdentities(request, request.query))

  app.post('/email/identities', { schema: createIdentityContract }, async (request, reply) => {
    requireStepUp(officeAuthOf(app), request)
    return reply.code(201).send(await createIdentity(processEmail(), request, request.body, idempotencyKeyFrom(request)))
  })

  app.post('/email/identities/:identityId/check', { schema: checkIdentityContract }, async (request) => {
    requireStepUp(officeAuthOf(app), request)
    return checkIdentity(processEmail(), request, request.params.identityId)
  })

  app.put('/email/identities/:identityId', { schema: updateIdentityContract }, async (request) => {
    requireStepUp(officeAuthOf(app), request)
    return updateIdentity(request, request.params.identityId, request.body, idempotencyKeyFrom(request))
  })

  // B-W2a-41 (PLT-149): the delivery log and the blocked addresses.
  app.get('/email/delivery', { schema: listDeliveryContract }, async (request) => listDelivery(request, request.query))
  app.get('/email/blocked', { schema: listBlockedContract }, async (request) => listBlocked(request, request.query))
  app.post('/email/blocked/:suppressionId/unblock', { schema: unblockContract }, async (request) => ({
    address: await unblockAddress(request, request.params.suppressionId, request.body, idempotencyKeyFrom(request)),
  }))
})
