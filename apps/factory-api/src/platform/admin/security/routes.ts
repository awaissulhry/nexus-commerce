import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { officeAuthOf } from '../../auth/sessions/office-auth'
import { attentionList } from './attention'
import {
  attentionContract,
  drillsContract,
  evidenceCompleteContract,
  evidenceContract,
  fingerprintContract,
  pageContract,
  recordDrillContract,
  twoFactorChangeContract,
  twoFactorListContract,
  twoFactorPreviewContract,
} from './contract'
import { announceEvidence, completeEvidence, listDrills, readFingerprint, recordDrill } from './drills'
import { manifest } from './manifest'
import { securityPage } from './page'
import { changeTwoFactor, listTwoFactor, previewTwoFactor } from './two-factor'

/**
 * Security & health (B-W2a-36; PLT-045, PLT-214; SCR-166):
 *   GET  /admin/security                                   the page: status lines, sign-in rules, backups, protection
 *   GET  /admin/security/two-factor                        every office role's two-factor rule with its holders
 *   POST /admin/security/two-factor/preview                who a change affects and what it would refuse (no write)
 *   POST /admin/security/two-factor                        ask (or stop asking) two-factor of roles (step-up, one command)
 *   GET  /admin/security/fingerprint?asOf=                 this database's fingerprint as of a time
 *   GET  /admin/security/drills                            the restore drills, newest first
 *   POST /admin/security/drills/evidence                   announce the evidence file of a drill (its id made first)
 *   POST /admin/security/drills/evidence/:fileId/complete  confirm its upload
 *   POST /admin/security/drills                            record a restore drill (compared here, append-only)
 *   GET  /admin/security/attention                         All settings › Needs attention, by what the person may read
 */
export default defineRoutes('admin-security', manifest, async (app) => {
  const auth = () => officeAuthOf(app)
  app.get('/admin/security', { schema: pageContract }, (request) => securityPage(auth(), request))
  app.get('/admin/security/two-factor', { schema: twoFactorListContract }, (request) => listTwoFactor(auth(), request))
  app.post('/admin/security/two-factor/preview', { schema: twoFactorPreviewContract }, (request) => previewTwoFactor(auth(), request, request.body))
  app.post('/admin/security/two-factor', { schema: twoFactorChangeContract }, (request) => changeTwoFactor(auth(), request, request.body))
  app.get('/admin/security/fingerprint', { schema: fingerprintContract }, (request) => readFingerprint(auth(), request, request.query.asOf))
  app.get('/admin/security/drills', { schema: drillsContract }, (request) => listDrills(auth(), request))
  app.post('/admin/security/drills/evidence', { schema: evidenceContract }, async (request, reply) =>
    reply.code(201).send(await announceEvidence(request, request.body, idempotencyKeyFrom(request) ?? undefined)),
  )
  app.post('/admin/security/drills/evidence/:fileId/complete', { schema: evidenceCompleteContract }, (request) =>
    completeEvidence(request, request.params.fileId, idempotencyKeyFrom(request) ?? undefined),
  )
  app.post('/admin/security/drills', { schema: recordDrillContract }, (request) => recordDrill(auth(), request, request.body, idempotencyKeyFrom(request) ?? undefined))
  app.get('/admin/security/attention', { schema: attentionContract }, (request) => attentionList(auth(), request))
})
