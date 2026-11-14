import { actorOf, requireContext } from '../../core/context'
import { idempotencyKeyFrom } from '../../core/command'
import { defineRoutes } from '../../core/manifest'
import { auditHistoryContract, auditListContract } from './contract'
import { manifest } from './manifest'
import { listAudit, readAuditHistory } from './read'
// B-W2b-399: audit in depth (the autoloader does not look inside a folder that has a routes file).
import { personReadsContract, readLogStatusContract, recordReadsContract } from './reads/contract'
import { personReads, readLogStatus, recordReads } from './reads/read'
import { entryContract, searchContract } from './search/contract'
import { auditEntry, searchAudit } from './search/search'
import { listSecurityEventsContract, oneSecurityEventContract } from './security-events/contract'
import { listSecurityEvents, oneSecurityEvent } from './security-events/read'

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

  // B-W2b-399 (PLT-077): the search, one entry.
  app.get('/audit/search', { schema: searchContract }, async (request) => searchAudit(request, request.query))
  app.get('/audit/entries/:entryId', { schema: entryContract }, async (request) => auditEntry(request, request.params.entryId))
  // B-W2b-399 (PLT-074): who looked.
  app.get('/audit/reads', { schema: recordReadsContract }, async (request) => recordReads(request, request.query))
  app.post('/audit/reads/person', { schema: personReadsContract }, async (request) => personReads(request, request.body, idempotencyKeyFrom(request)))
  // B-W2b-413: whether the read log is on (GATE-PRIVACY), so the screen says so when it is off.
  app.get('/audit/reads/status', { schema: readLogStatusContract }, async (request) => readLogStatus(request))
  // B-W2b-399 (PLT-075): the security events.
  app.get('/audit/security-events', { schema: listSecurityEventsContract }, async (request) => listSecurityEvents(request, request.query))
  app.get('/audit/security-events/:eventId', { schema: oneSecurityEventContract }, async (request) => oneSecurityEvent(request, request.params.eventId))
})
