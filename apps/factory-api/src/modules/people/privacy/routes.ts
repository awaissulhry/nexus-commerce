import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { requireStepUp } from '../../../platform/auth/office/account'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { accessOf, openPersonFigures } from './access'
import {
  accessContract,
  changeSettingsContract,
  companySettingsContract,
  leadsContract,
  openContract,
  overviewContract,
  rulesContract,
  sightContract,
  siteContract,
  switchOffContract,
  switchOnContract,
} from './contract'
import { manifest } from './manifest'
import { changeLeads, changeSettings, companySettings, overview, rules, sight, siteDetail, switchOff, switchOn } from './privacy'

/**
 * Privacy of people data (B-W2b-27; W2b plan §2 GATE-LABOUR; PLT-207, PLT-209, ANA-075, MES-249, MES-281, MES-282;
 * Statuto dei Lavoratori art. 4; GDPR arts. 5, 13, 22, 35): the legal gate per site and purpose (attendance, one person's
 * work figures), the minimum group size, who sees one person's figures, the people data rules, and the access to one
 * person's figures with its record. Every purpose ships OFF; switching on and every widening ask for a fresh code.
 */
export default defineRoutes('people.privacy', manifest, async (app) => {
  const stepUpOf = (request: Parameters<typeof requireStepUp>[1]) => () => requireStepUp(officeAuthOf(app), request)

  app.get('/people/privacy', { schema: overviewContract }, async (request) => overview(request, request.query))

  app.get('/people/privacy/rules', { schema: rulesContract }, async (request) => rules(request))

  app.get('/people/privacy/sites/:siteId', { schema: siteContract }, async (request) => siteDetail(request, request.params.siteId))

  app.post('/people/privacy/sites/:siteId/purposes/:purpose/switch-on', { schema: switchOnContract }, async (request) =>
    switchOn(request, request.params.siteId, request.params.purpose, request.body, { stepUp: stepUpOf(request), idempotencyKey: idempotencyKeyFrom(request) }),
  )

  app.post('/people/privacy/sites/:siteId/purposes/:purpose/switch-off', { schema: switchOffContract }, async (request) =>
    switchOff(request, request.params.siteId, request.params.purpose, request.body, idempotencyKeyFrom(request)),
  )

  app.post('/people/privacy/sites/:siteId/purposes/:purpose/leads', { schema: leadsContract }, async (request) =>
    changeLeads(request, request.params.siteId, request.params.purpose, request.body, { stepUp: stepUpOf(request), idempotencyKey: idempotencyKeyFrom(request) }),
  )

  app.get('/people/privacy/companies/:companyId', { schema: companySettingsContract }, async (request) => companySettings(request, request.params.companyId))

  app.post('/people/privacy/companies/:companyId', { schema: changeSettingsContract }, async (request) =>
    changeSettings(request, request.params.companyId, request.body, { stepUp: stepUpOf(request), idempotencyKey: idempotencyKeyFrom(request) }),
  )

  app.get('/people/privacy/what-you-see', { schema: sightContract }, async (request) => sight(request, request.query))

  app.get('/people/privacy/figures/:employeeId/access', { schema: accessContract }, async (request) => accessOf(request, request.params.employeeId, request.query.purpose))

  app.post('/people/privacy/figures/:employeeId/open', { schema: openContract }, async (request) => openPersonFigures(request, request.params.employeeId, request.body, idempotencyKeyFrom(request)))
})
