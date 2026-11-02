import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { archiveLimitContract, listLimitsContract, personLimitsContract, saveLimitContract, warningsContract } from './contract'
import { manifest } from './manifest'
import { archiveLimit, listLimits, saveLimit } from './settings'
import { listWarnings, personLimits } from './warnings'

/**
 * Working-time limits (B-W2b-42): the limits kept per company or site (./settings.ts) and what they say about the time
 * people worked (./warnings.ts; ./worked.ts is the one read). Who they alert: ./notices.ts. Each write is one command
 * with an Idempotency-Key.
 */
export default defineRoutes('people.limits', manifest, async (app) => {
  app.get('/people/limits', { schema: listLimitsContract }, async (request) => listLimits(request, request.query))
  app.put('/people/limits', { schema: saveLimitContract }, async (request) => saveLimit(request, request.body, idempotencyKeyFrom(request)))
  app.post('/people/limits/:ruleId/archive', { schema: archiveLimitContract }, async (request) => archiveLimit(request, request.params.ruleId, request.body, idempotencyKeyFrom(request)))
  app.get('/people/limits/warnings', { schema: warningsContract }, async (request) => listWarnings(request, request.query))
  app.get('/people/employees/:employeeId/limits', { schema: personLimitsContract }, async (request) => personLimits(request, request.params.employeeId))
})
