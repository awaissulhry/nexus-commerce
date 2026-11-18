import { defineRoutes } from '../../../core/manifest'
import { listIncomingContract, waitingCountContract } from './contract'
import { listIncoming, waitingCount } from './incoming'
import { manifest } from './manifest'

/**
 * Sales › Incoming (B-TH-039): requests, catalogue orders and change requests in one paged list (./incoming.ts). Each kind keeps
 * its own record routes: an inquiry modules/sales/inquiries, a catalogue order modules/sales/portal-ordering, a change request
 * modules/sales/change-requests (answered in Home › Approvals, agreement T3).
 */
export default defineRoutes('sales.incoming', manifest, async (app) => {
  app.get('/sales/incoming', { schema: listIncomingContract }, async (request) => listIncoming(request, request.query))

  // B-SA-010: the office shell's "N waiting on us" beside Incoming.
  app.get('/sales/incoming/waiting-count', { schema: waitingCountContract }, async (request) => waitingCount(request))
})
