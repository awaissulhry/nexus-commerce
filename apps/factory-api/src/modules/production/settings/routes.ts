import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { requireStepUp } from '../../../platform/auth/office/account'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { changeBundleSizeContract, changeScanSubjectContract, floorRulesContract, getRulesContract, listRulesContract, noticeAcksContract, recordLegalBasisContract } from './contract'
// B-W2b-53: floor rules per site (MES-294) and the floor's full reason lists (MES-293).
import { addFullReasonsContract, changeFloorRulesContract, getFloorRulesContract, reasonListsContract } from './contract'
import { changeFloorRules, floorChecksRead, getFloorRules } from './floor-rules'
import { manifest } from './manifest'
import { addFullReasons, reasonLists } from './reason-lists'
import { changeBundleSize, changeScanSubject, floorRules, getRules, listNoticeAcks, listRules, recordLegalBasis } from './settings'

/**
 * A site's floor rules (B-W1-37; A2 SCR-074 Production › Settings; MES-278, PLT-208; Statuto dei Lavoratori art. 4): who
 * floor records name (the worker or the station), the legal basis on record, and who still must acknowledge the
 * information notice, and the standard bundle size of the site's cutting room. Widening asks for a fresh code (step-up);
 * narrowing never does.
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

  app.post('/production/settings/:siteId/bundle-size', { schema: changeBundleSizeContract }, async (request) =>
    changeBundleSize(request, request.params.siteId, request.body, idempotencyKeyFrom(request)),
  )

  app.get('/production/settings/:siteId/notice-acks', { schema: noticeAcksContract }, async (request) => listNoticeAcks(request, request.params.siteId))

  // B-W2b-53: the floor's read also carries the site's checks and the undo window.
  app.get('/production/floor-rules', { schema: floorRulesContract }, async (request) => ({ ...(await floorRules(request)), ...(await floorChecksRead(request)) }))

  // B-W2b-53 (MES-294): the floor checks per site (quantity guard, sequence, scrap approval limit) and what is not per site yet.
  app.get('/production/settings/:siteId/floor-rules', { schema: getFloorRulesContract }, async (request) => getFloorRules(request, request.params.siteId))

  app.post('/production/settings/:siteId/floor-rules', { schema: changeFloorRulesContract }, async (request) => changeFloorRules(request, request.params.siteId, request.body, idempotencyKeyFrom(request)))

  // B-W2b-53 (MES-293): the floor's full reason lists through the W2a editor's stores.
  app.get('/production/settings/reasons', { schema: reasonListsContract }, async (request) => reasonLists(request))

  app.post('/production/settings/reasons/full', { schema: addFullReasonsContract }, async (request) => addFullReasons(request, request.body, idempotencyKeyFrom(request)))
})
