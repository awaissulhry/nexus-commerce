import { actorOf, requireContext } from '../../core/context'
import { defineRoutes } from '../../core/manifest'
import { auditHistoryContract } from './contract'
import { manifest } from './manifest'
import { readAuditHistory } from './read'

/** The audit log (platform part). Writes come from command() in every module; here it is only read. */
export default defineRoutes('audit', manifest, async (app) => {
  app.get('/audit/:recordType/:recordId', { schema: auditHistoryContract }, async (request) => {
    const context = requireContext(request)
    const { recordType, recordId } = request.params
    const entries = await request.withClient((client) => readAuditHistory(client, actorOf(context), { recordType, recordId, limit: request.query.limit }))
    return { entries }
  })
})
