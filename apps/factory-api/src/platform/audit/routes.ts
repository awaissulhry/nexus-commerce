import { actorOf, requireContext } from '../../core/context'
import { defineRoutes } from '../../core/manifest'
import { auditHistoryContract, auditListContract } from './contract'
import { manifest } from './manifest'
import { listAudit, readAuditHistory } from './read'

/** The audit log (platform part). Writes come from command() in every module; here it is only read. */
export default defineRoutes('audit', manifest, async (app) => {
  app.get('/audit', { schema: auditListContract }, async (request) => {
    const context = requireContext(request)
    const { withCounts, ...query } = request.query
    return request.withClient((client) => listAudit(client, actorOf(context), { ...query, withCounts: withCounts === 'true' }))
  })

  app.get('/audit/:recordType/:recordId', { schema: auditHistoryContract }, async (request) => {
    const context = requireContext(request)
    const { recordType, recordId } = request.params
    const entries = await request.withClient((client) => readAuditHistory(client, actorOf(context), { recordType, recordId, limit: request.query.limit }))
    return { entries }
  })
})
