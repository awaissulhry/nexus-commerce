import { idempotencyKeyFrom } from '../../core/command'
import { defineRoutes } from '../../core/manifest'
import { assignInboundContract, getInboundContract, listInboundContract, rejectInboundContract, releaseInboundContract } from './contract'
import { manifest } from './manifest'
import { processEmailIn } from './service'
import { assignInbound, getInbound, listInbound, rejectInbound, releaseInbound } from './triage'

/**
 * Email in (platform part; plan A1 §3.7; features COL-020, COL-022, COL-023, COL-025, COL-026): "mail to sort" — list
 * and read the received mail that waits for a person, assign it to a record, release a held one, or throw it away. The
 * mail itself arrives through platform/inbound (SES's notification, receive.ts) and the worker (fetch.ts, sort.ts).
 */
export default defineRoutes('email-in', manifest, async (app) => {
  app.get('/email/inbound', { schema: listInboundContract }, async (request) => listInbound(request, request.query))

  app.get('/email/inbound/:inboundEmailId', { schema: getInboundContract }, async (request) => getInbound(request, request.params.inboundEmailId))

  app.post('/email/inbound/:inboundEmailId/assign', { schema: assignInboundContract }, async (request) =>
    assignInbound(processEmailIn(), request, request.params.inboundEmailId, request.body, idempotencyKeyFrom(request)),
  )

  app.post('/email/inbound/:inboundEmailId/release', { schema: releaseInboundContract }, async (request) =>
    releaseInbound(processEmailIn(), request, request.params.inboundEmailId, request.body, idempotencyKeyFrom(request)),
  )

  app.post('/email/inbound/:inboundEmailId/reject', { schema: rejectInboundContract }, async (request) =>
    rejectInbound(request, request.params.inboundEmailId, request.body, idempotencyKeyFrom(request)),
  )
})
