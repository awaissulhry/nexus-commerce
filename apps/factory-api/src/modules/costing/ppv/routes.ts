import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { requireStepUp } from '../../../platform/auth/office/account'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { postDocument, reverseVariance } from './actions'
import { ppvListContract, ppvPostContract, ppvReverseContract, saveSettingsContract, settingsContract } from './contract'
import { manifest } from './manifest'
import { ppvList } from './reads'
import { actualSettingsView, saveActualSettings } from './settings'

/**
 * Purchase price variance (B-W2b-407; FIN-031; design finance.costing "Purchase price variance"): the variances taken at
 * the receipt or at the supplier's invoice (where the company takes them), a document's variances posted now, one
 * reversed with a reason; and the company's actual-cost settings (GATE-ACCOUNTANT: the switch for the accountant's
 * figures, OFF by default, and where the variance is taken). A repeated Idempotency-Key answers 200 from its receipt.
 */
export default defineRoutes('costing.ppv', manifest, async (app) => {
  app.get('/costing/actuals/settings', { schema: settingsContract }, async (request) => ({ settings: await actualSettingsView(request, request.query.companyId) }))

  app.put('/costing/actuals/settings', { schema: saveSettingsContract }, async (request) => {
    requireStepUp(officeAuthOf(app), request)
    return { settings: (await saveActualSettings(request, request.body, idempotencyKeyFrom(request))).settings }
  })

  app.get('/costing/ppv', { schema: ppvListContract }, async (request) => ppvList(request, request.query))

  app.post('/costing/ppv/post', { schema: ppvPostContract }, async (request, reply) => {
    const result = await postDocument(request, request.body, idempotencyKeyFrom(request))
    return reply.code(result.posted.length > 0 && !result.replayed ? 201 : 200).send(result)
  })

  app.post('/costing/ppv/:varianceId/reverse', { schema: ppvReverseContract }, async (request, reply) => {
    const result = await reverseVariance(request, request.params.varianceId, request.body.reason, idempotencyKeyFrom(request))
    return reply.code(result.replayed ? 200 : 201).send(result)
  })
})
