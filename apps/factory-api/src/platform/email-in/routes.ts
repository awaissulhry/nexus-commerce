import { idempotencyKeyFrom } from '../../core/command'
import { defineRoutes } from '../../core/manifest'
import { assignInboundContract, getInboundContract, listInboundContract, rejectInboundContract, releaseInboundContract } from './contract'
import { manifest } from './manifest'
import { processEmailIn } from './service'
import { assignInbound, getInbound, listInbound, rejectInbound, releaseInbound } from './triage'
// B-W2b-394 (COL-021, COL-027): the capture address and the team inboxes.
import { createCapture, getCapture, turnOffCapture, updateCapture } from './capture/capture'
import { createCaptureContract, getCaptureContract, turnOffCaptureContract, updateCaptureContract } from './capture/contract'
import {
  assigneeContract,
  closeContract,
  createInboxContract,
  followUpContract,
  inboxPeopleContract,
  listInboxesContract,
  moveContract,
  queueContract,
  reopenContract,
  snoozeContract,
  updateInboxContract,
} from './team-inbox/contract'
import { createInbox, inboxPeople, listInboxes, updateInbox } from './team-inbox/inboxes'
import { listQueue } from './team-inbox/queue'
import { closeMail, moveMail, reopenMail, setAssignee, setFollowUp, snoozeMail } from './team-inbox/work'

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

  // B-W2b-394 (COL-021): the company's capture address for forwarded mail.
  app.get('/email/capture', { schema: getCaptureContract }, async (request) => getCapture(request, request.query.companyId))
  app.post('/email/capture', { schema: createCaptureContract }, async (request, reply) => reply.code(201).send(await createCapture(request, request.body, idempotencyKeyFrom(request))))
  app.put('/email/capture/:captureAddressId', { schema: updateCaptureContract }, async (request) => updateCapture(request, request.params.captureAddressId, request.body, idempotencyKeyFrom(request)))
  app.post('/email/capture/:captureAddressId/turn-off', { schema: turnOffCaptureContract }, async (request) => turnOffCapture(request, request.params.captureAddressId, request.body, idempotencyKeyFrom(request)))

  // B-W2b-394 (COL-027): team inboxes, their queues, and the work on their mail.
  app.get('/email/team-inboxes', { schema: listInboxesContract }, async (request) => listInboxes(request, request.query))
  app.post('/email/team-inboxes', { schema: createInboxContract }, async (request, reply) => reply.code(201).send(await createInbox(request, request.body, idempotencyKeyFrom(request))))
  app.get('/email/team-inboxes/people', { schema: inboxPeopleContract }, async (request) => inboxPeople(request, request.query.companyId))
  app.put('/email/team-inboxes/:teamInboxId', { schema: updateInboxContract }, async (request) => updateInbox(request, request.params.teamInboxId, request.body, idempotencyKeyFrom(request)))
  app.get('/email/team-inboxes/:teamInboxId/mail', { schema: queueContract }, async (request) => listQueue(request, request.params.teamInboxId, request.query))
  app.post('/email/inbound/:inboundEmailId/assignee', { schema: assigneeContract }, async (request) => setAssignee(request, request.params.inboundEmailId, request.body, idempotencyKeyFrom(request)))
  app.post('/email/inbound/:inboundEmailId/close', { schema: closeContract }, async (request) => closeMail(request, request.params.inboundEmailId, request.body, idempotencyKeyFrom(request)))
  app.post('/email/inbound/:inboundEmailId/reopen', { schema: reopenContract }, async (request) => reopenMail(request, request.params.inboundEmailId, request.body, idempotencyKeyFrom(request)))
  app.post('/email/inbound/:inboundEmailId/snooze', { schema: snoozeContract }, async (request) => snoozeMail(request, request.params.inboundEmailId, request.body, idempotencyKeyFrom(request)))
  app.post('/email/inbound/:inboundEmailId/follow-up', { schema: followUpContract }, async (request) => setFollowUp(request, request.params.inboundEmailId, request.body, idempotencyKeyFrom(request)))
  app.post('/email/inbound/:inboundEmailId/team-inbox', { schema: moveContract }, async (request) => moveMail(request, request.params.inboundEmailId, request.body, idempotencyKeyFrom(request)))
})
