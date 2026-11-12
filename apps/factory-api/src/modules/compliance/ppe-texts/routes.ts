import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { requireStepUp } from '../../../platform/auth/office/account'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { announceEvidence, listPpeTexts, recordApproval, withdrawApproval } from './approvals'
import { announceContract, listContract, recordContract, withdrawContract } from './contract'
import { manifest } from './manifest'

/**
 * The PPE text approvals (B-W2b-288, FU2:01; GATE-PPE-TEXTS): where a PPE consultant's yes to a template of generated PPE
 * texts is recorded and withdrawn. The screen is Compliance › Rules & markets › Templates (B-W2b-288); the DoC generator, the
 * user information builder and the label class warnings read the approvals (./store).
 */
export default defineRoutes('compliance.ppeTexts', manifest, async (app) => {
  app.get('/compliance/ppe-texts', { schema: listContract }, async (request) => listPpeTexts(request, request.query))
  app.post('/compliance/ppe-texts/evidence', { schema: announceContract }, async (request, reply) => reply.code(201).send(await announceEvidence(request, request.body, idempotencyKeyFrom(request))))
  app.post('/compliance/ppe-texts', { schema: recordContract }, async (request, reply) =>
    reply.code(201).send(await recordApproval(request, request.body, idempotencyKeyFrom(request), () => requireStepUp(officeAuthOf(app), request))),
  )
  app.post('/compliance/ppe-texts/:approvalId/withdraw', { schema: withdrawContract }, async (request) => withdrawApproval(request, request.params.approvalId, request.body, idempotencyKeyFrom(request)))
})
