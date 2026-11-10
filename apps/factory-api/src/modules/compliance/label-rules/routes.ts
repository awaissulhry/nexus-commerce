import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { markingContract, templateChecksContract } from './contract'
import { manifest } from './manifest'
import { setMarking } from './marking'
import { templateChecks } from './read'

/**
 * What a PPE label must say (B-W2b-253): a label's marking checks per market (CE marking, class warnings, glove marking,
 * GPSR identifier and contact, the QR to the public DoC) with what it must print, and a draft label's kind, GPSR contact
 * and QR target. The screens are B-W2b-270 (Labels & marking in depth); label print asks the checks through B-W2b-254's gate.
 */
export default defineRoutes('compliance.label-rules', manifest, async (app) => {
  app.get('/compliance/label-rules/templates/:templateId', { schema: templateChecksContract }, async (request) => ({ checks: await templateChecks(request, request.params.templateId, request.query) }))
  app.put('/compliance/label-rules/templates/:templateId/marking', { schema: markingContract }, async (request) => ({
    template: await setMarking(request, request.params.templateId, request.body, idempotencyKeyFrom(request)),
  }))
})
