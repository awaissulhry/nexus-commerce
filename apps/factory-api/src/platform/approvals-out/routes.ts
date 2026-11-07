import { idempotencyKeyFrom } from '../../core/command'
import { defineRoutes } from '../../core/manifest'
import { approvalsMailSettings, openApprovalFromMail, setApprovalsMail } from '../../modules/insights/sources/approvals-mail'
import { answerByLink, answerInPortal, linkApproval, portalApproval, portalApprovals } from './answer'
import {
  askContract,
  linkApproveContract,
  linkPageContract,
  linkRefuseContract,
  mailOpenContract,
  mailSettingsContract,
  officeRequestContract,
  portalAnswerContract,
  portalListContract,
  portalPageContract,
  recordRequestsContract,
  setMailContract,
  withdrawContract,
} from './contract'
import { manifest } from './manifest'
import { askApproval, officeRequest, recordRequests, withdrawApproval } from './office'

/**
 * Approval requests to partners (B-W2b-184): the office asks and withdraws (./office.ts), the partner answers by link or in
 * its portal (./answer.ts), the office's side settles each answer (./settle.ts); the sweep (./sweep.ts) expires what nobody
 * answered; Home › Approvals by e-mail (modules/insights/sources/approvals-mail.ts, PLT-089). The screens are B-W2b-188's.
 */
export default defineRoutes('approvals-out', manifest, async (app) => {
  app.post('/approvals-out', { schema: askContract }, async (request, reply) => {
    const answer = await askApproval(request, request.body, idempotencyKeyFrom(request))
    return reply.code(201).send(answer)
  })

  app.get('/approvals-out', { schema: recordRequestsContract }, async (request) => recordRequests(request, request.query.recordType, request.query.recordId))

  app.get('/approvals-out/:requestId', { schema: officeRequestContract }, async (request) => officeRequest(request, request.params.requestId))

  app.post('/approvals-out/:requestId/withdraw', { schema: withdrawContract }, async (request) => withdrawApproval(request, request.params.requestId, request.body, idempotencyKeyFrom(request)))

  app.get('/link/approval', { schema: linkPageContract }, async (request) => linkApproval(app, request, request.query.language))

  app.post('/link/approval/approve', { schema: linkApproveContract }, async (request) => answerByLink(app, request, request.body, request.query.language))

  app.post('/link/approval/refuse', { schema: linkRefuseContract }, async (request) => answerByLink(app, request, { ...request.body, decision: 'REFUSED' }, request.query.language))

  app.get('/portal/approvals', { schema: portalListContract }, async (request) => portalApprovals(app, request, request.query.state))

  app.get('/portal/approvals/:requestId', { schema: portalPageContract }, async (request) => portalApproval(app, request, request.params.requestId))

  app.post('/portal/approvals/:requestId/answer', { schema: portalAnswerContract }, async (request) => answerInPortal(app, request, request.params.requestId, request.body))

  app.get('/approvals/mail-me', { schema: mailSettingsContract }, async (request) => approvalsMailSettings(request))

  app.put('/approvals/mail-me', { schema: setMailContract }, async (request) => setApprovalsMail(request, request.body, idempotencyKeyFrom(request)))

  app.post('/approvals/mail-open', { schema: mailOpenContract }, async (request) => openApprovalFromMail(request, request.body.key))
})
