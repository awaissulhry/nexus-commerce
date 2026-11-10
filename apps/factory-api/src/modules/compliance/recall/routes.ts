import { dispositionOf } from '@nexus/factory-domain/files/preview/rules'
import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { requireStepUp } from '../../../platform/auth/office/account'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import {
  addProgressContract,
  answerDistributorNoticeContract,
  answerRequestContract,
  cancelDistributorNoticeContract,
  cancelNoticeContract,
  cancelRecallContract,
  cancelRequestContract,
  closeRecallContract,
  draftDistributorNoticesContract,
  draftNoticeContract,
  draftRecallContract,
  editDistributorNoticeContract,
  editNoticeContract,
  editRecallContract,
  editRequestContract,
  failDistributorNoticeContract,
  getNoticeContract,
  getRecallContract,
  getRequestContract,
  holdRecallContract,
  listNoticesContract,
  listRecallsContract,
  listRequestsContract,
  logRequestContract,
  noticePdfContract,
  noticeReferenceContract,
  publishNoticeContract,
  recipientsContract,
  recordProgressContract,
  requestEntryContract,
  requestEvidenceContract,
  sendDistributorNoticesContract,
  sendNoticeContract,
  startRecallContract,
  surveillanceContract,
  withdrawNoticeContract,
} from './contract'
import {
  answerDistributorNotice,
  cancelDistributorNotice,
  draftDistributorNotices,
  editDistributorNotice,
  failDistributorNotice,
  recipients,
  sendDistributorNotices,
} from './distributors'
import { manifest } from './manifest'
import { cancelAuthorityNotice, draftAuthorityNotice, editAuthorityNotice, getNotice, listNotices, markNoticeSent, noticePdf, recordNoticeReference } from './notices'
import { addProgress, cancelRecall, closeRecall, draftRecall, editRecall, getRecall, holdRecall, listRecalls, publishNotice, recordProgress, startRecall, withdrawNotice } from './recalls'
import { answerRequest, cancelRequest, editRequest, getRequest, linkRequestEntry, listRequests, logRequest, requestEvidence } from './requests'
import { surveillanceOf } from './surveillance'

/**
 * Recall, withdrawal and authority (B-W2b-260; PRD-387, PRD-388, PRD-390; RG1:01, RG1:02): the notices to market
 * surveillance authorities, recalls and withdrawals with their holds, public notice and progress per customer, the
 * distributors told one by one, and the authority request log. The screens are B-W2b-271 (Compliance › Register in depth and
 * the public safety notice); the public DoC page's `notices` is read by modules/compliance/public-doc (notice.ts). The worker's
 * handlers (distributors.ts) record a distributor's reply and a bounced mail.
 */
export default defineRoutes('compliance.recall', manifest, async (app) => {
  const stepUpFor = (request: Parameters<typeof requireStepUp>[1]) => () => requireStepUp(officeAuthOf(app), request)

  app.get('/compliance/register/:entryId/surveillance', { schema: surveillanceContract }, async (request) => surveillanceOf(request, request.params.entryId))
  app.get('/compliance/register/:entryId/distributors', { schema: recipientsContract }, async (request) => recipients(request, request.params.entryId))
  app.post('/compliance/register/:entryId/authority-notices', { schema: draftNoticeContract }, async (request, reply) =>
    reply.code(201).send(await draftAuthorityNotice(request, request.params.entryId, request.body, idempotencyKeyFrom(request))),
  )
  app.post('/compliance/register/:entryId/recalls', { schema: draftRecallContract }, async (request, reply) => reply.code(201).send(await draftRecall(request, request.params.entryId, request.body, idempotencyKeyFrom(request))))
  app.post('/compliance/register/:entryId/distributor-notices', { schema: draftDistributorNoticesContract }, async (request, reply) =>
    reply.code(201).send(await draftDistributorNotices(request, request.params.entryId, request.body, idempotencyKeyFrom(request))),
  )
  app.post('/compliance/register/:entryId/distributor-notices/send', { schema: sendDistributorNoticesContract }, async (request) =>
    sendDistributorNotices(request, request.params.entryId, request.body, { stepUp: stepUpFor(request), idempotencyKey: idempotencyKeyFrom(request) }),
  )

  app.get('/compliance/authority-notices', { schema: listNoticesContract }, async (request) => listNotices(request, request.query))
  app.get('/compliance/authority-notices/:noticeId', { schema: getNoticeContract }, async (request) => getNotice(request, request.params.noticeId))
  app.get('/compliance/authority-notices/:noticeId/pdf', { schema: noticePdfContract }, async (request, reply) => {
    const pdf = await noticePdf(request, request.params.noticeId, request.query.language)
    return reply.type('application/pdf').header('cache-control', 'no-store').header('x-content-type-options', 'nosniff').header('content-disposition', dispositionOf('inline', pdf.name)).send(pdf.bytes)
  })
  app.patch('/compliance/authority-notices/:noticeId', { schema: editNoticeContract }, async (request) => editAuthorityNotice(request, request.params.noticeId, request.body, idempotencyKeyFrom(request)))
  app.post('/compliance/authority-notices/:noticeId/sent', { schema: sendNoticeContract }, async (request) =>
    markNoticeSent(request, request.params.noticeId, request.body, { stepUp: stepUpFor(request), idempotencyKey: idempotencyKeyFrom(request) }),
  )
  app.post('/compliance/authority-notices/:noticeId/reference', { schema: noticeReferenceContract }, async (request) => recordNoticeReference(request, request.params.noticeId, request.body, idempotencyKeyFrom(request)))
  app.post('/compliance/authority-notices/:noticeId/cancel', { schema: cancelNoticeContract }, async (request) => cancelAuthorityNotice(request, request.params.noticeId, request.body, idempotencyKeyFrom(request)))

  app.get('/compliance/recalls', { schema: listRecallsContract }, async (request) => listRecalls(request, request.query))
  app.get('/compliance/recalls/:recallId', { schema: getRecallContract }, async (request) => getRecall(request, request.params.recallId))
  app.patch('/compliance/recalls/:recallId', { schema: editRecallContract }, async (request) => editRecall(request, request.params.recallId, request.body, idempotencyKeyFrom(request)))
  app.post('/compliance/recalls/:recallId/start', { schema: startRecallContract }, async (request) => startRecall(request, request.params.recallId, request.body, idempotencyKeyFrom(request)))
  app.post('/compliance/recalls/:recallId/holds', { schema: holdRecallContract }, async (request) => holdRecall(request, request.params.recallId, request.body, idempotencyKeyFrom(request)))
  app.post('/compliance/recalls/:recallId/notice/publish', { schema: publishNoticeContract }, async (request) =>
    publishNotice(request, request.params.recallId, request.body, { stepUp: stepUpFor(request), idempotencyKey: idempotencyKeyFrom(request) }),
  )
  app.post('/compliance/recalls/:recallId/notice/withdraw', { schema: withdrawNoticeContract }, async (request) => withdrawNotice(request, request.params.recallId, request.body, idempotencyKeyFrom(request)))
  app.post('/compliance/recalls/:recallId/progress', { schema: addProgressContract }, async (request, reply) => reply.code(201).send(await addProgress(request, request.params.recallId, request.body, idempotencyKeyFrom(request))))
  app.patch('/compliance/recalls/:recallId/progress/:progressId', { schema: recordProgressContract }, async (request) =>
    recordProgress(request, request.params.recallId, request.params.progressId, request.body, idempotencyKeyFrom(request)),
  )
  app.post('/compliance/recalls/:recallId/close', { schema: closeRecallContract }, async (request) => closeRecall(request, request.params.recallId, request.body, idempotencyKeyFrom(request)))
  app.post('/compliance/recalls/:recallId/cancel', { schema: cancelRecallContract }, async (request) => cancelRecall(request, request.params.recallId, request.body, idempotencyKeyFrom(request)))

  app.patch('/compliance/distributor-notices/:noticeId', { schema: editDistributorNoticeContract }, async (request) => editDistributorNotice(request, request.params.noticeId, request.body, idempotencyKeyFrom(request)))
  app.post('/compliance/distributor-notices/:noticeId/answer', { schema: answerDistributorNoticeContract }, async (request) => answerDistributorNotice(request, request.params.noticeId, request.body, idempotencyKeyFrom(request)))
  app.post('/compliance/distributor-notices/:noticeId/failed', { schema: failDistributorNoticeContract }, async (request) => failDistributorNotice(request, request.params.noticeId, request.body, idempotencyKeyFrom(request)))
  app.post('/compliance/distributor-notices/:noticeId/cancel', { schema: cancelDistributorNoticeContract }, async (request) => cancelDistributorNotice(request, request.params.noticeId, request.body, idempotencyKeyFrom(request)))

  app.get('/compliance/authority-requests', { schema: listRequestsContract }, async (request) => listRequests(request, request.query))
  app.post('/compliance/authority-requests', { schema: logRequestContract }, async (request, reply) => reply.code(201).send(await logRequest(request, request.body, idempotencyKeyFrom(request))))
  app.get('/compliance/authority-requests/:requestId', { schema: getRequestContract }, async (request) => getRequest(request, request.params.requestId))
  app.patch('/compliance/authority-requests/:requestId', { schema: editRequestContract }, async (request) => editRequest(request, request.params.requestId, request.body, idempotencyKeyFrom(request)))
  app.post('/compliance/authority-requests/:requestId/register-entry', { schema: requestEntryContract }, async (request) => linkRequestEntry(request, request.params.requestId, request.body, idempotencyKeyFrom(request)))
  app.post('/compliance/authority-requests/:requestId/evidence', { schema: requestEvidenceContract }, async (request) => requestEvidence(request, request.params.requestId, request.body, idempotencyKeyFrom(request)))
  app.post('/compliance/authority-requests/:requestId/answer', { schema: answerRequestContract }, async (request) => answerRequest(request, request.params.requestId, request.body, idempotencyKeyFrom(request)))
  app.post('/compliance/authority-requests/:requestId/cancel', { schema: cancelRequestContract }, async (request) => cancelRequest(request, request.params.requestId, request.body, idempotencyKeyFrom(request)))
})
