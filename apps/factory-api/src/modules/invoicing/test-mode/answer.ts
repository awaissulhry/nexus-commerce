import { isTestRef } from '@nexus/factory-domain/invoicing/test-mode/test-mode'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { pollSend } from '../sdi/poll'
import { processSdi, type SdiRuntime } from '../sdi/runtime'

/**
 * SDI's simulated answer to a send simulated in test mode (B-W2b-401; FIN-096), right away: the worker's handler
 * `invoicing.sdiTestAnswer`, on invoice.sdi_status_changed when a simulated send became SENT, asks the simulation for its
 * status through the SDI runtime (never the intermediary: the send's provider id is a simulated one) and records the answer by
 * the status poll's own path (sdi/poll.ts pollSend: ONE command, each notification once). The scheduler's status poll finds
 * the same answer later if this handler is lost: SDI's answers and the simulated ones go through one recording path.
 */
export function sdiTestAnswerHandler(runtime: () => SdiRuntime = processSdi): EventHandler {
  return defineHandler({
    name: 'invoicing.sdiTestAnswer',
    events: ['invoice.sdi_status_changed'],
    attempts: 5,
    async handle(event, { caller }) {
      const payload = event.payload as { submissionId: string; sendStatus: string }
      if (payload.sendStatus !== 'SENT') return
      const send = await caller.withClient((client) => client.sdiSubmission.findUnique({ where: { id: payload.submissionId }, select: { providerRef: true, status: true } }))
      if (!send || send.status !== 'SENT' || !isTestRef(send.providerRef)) return
      await pollSend(runtime(), caller, payload.submissionId, { causationId: event.eventId })
    },
  })
}
