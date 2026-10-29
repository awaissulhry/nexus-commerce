import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { requireStepUp } from '../../../platform/auth/office/account'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { changeScanSubjectContract, floorRulesContract, getRulesContract, listRulesContract, noticeAcksContract, recordLegalBasisContract } from './contract'
import { manifest } from './manifest'
import { changeScanSubject, floorRules, getRules, listNoticeAcks, listRules, recordLegalBasis } from './settings'

/**
 * A site's floor rules (B-W1-37; A2 SCR-074 Production › Settings; MES-278, PLT-208; Statuto dei Lavoratori art. 4): who
 * floor records name (the worker or the station), the legal basis on record, and who still must acknowledge the
 * information notice. Widening asks for a fresh code (step-up); narrowing never does.
 */
export default defineRoutes('production.settings', manifest, async (app) => {
  app.get('/production/settings', { schema: listRulesContract }, async (request) => listRules(request, request.query))

  app.get('/production/settings/:siteId', { schema: getRulesContract }, async (request) => getRules(request, request.params.siteId))

  app.post('/production/settings/:siteId/scan-subject', { schema: changeScanSubjectContract }, async (request) =>
    changeScanSubject(request, request.params.siteId, request.body, { stepUp: () => requireStepUp(officeAuthOf(app), request), idempotencyKey: idempotencyKeyFrom(request) }),
  )

  app.post('/production/settings/:siteId/legal-basis', { schema: recordLegalBasisContract }, async (request) =>
    recordLegalBasis(request, request.params.siteId, request.body, idempotencyKeyFrom(request)),
  )

  app.get('/production/settings/:siteId/notice-acks', { schema: noticeAcksContract }, async (request) => listNoticeAcks(request, request.params.siteId))

  app.get('/production/floor-rules', { schema: floorRulesContract }, async (request) => floorRules(request))
})
