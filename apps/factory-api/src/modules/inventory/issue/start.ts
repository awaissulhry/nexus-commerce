import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { startOnFirstWork } from '../../production/work-orders/moves'

/**
 * A released work order starts with its first issue (B-W1-39; MES-007; ownership/production.json: "the worker's handlers
 * move a released one to IN_PROGRESS after the first floor work"). The floor role cannot update a work order, and an
 * office issuer may hold no work-order permission, so the issue only says so in its event (`startsWorkOrder`) and the
 * worker, as the event's tenant's system caller, moves it RELEASED → IN_PROGRESS through the work-orders module
 * (startOnFirstWork: one command on the work order, audited, `workorder.status_changed`). Safe to repeat: a work order
 * already started (or cancelled meanwhile) is left as it is, and its start key makes a repeat answer from the receipt.
 *
 * Listed in background.ts HANDLERS for the worker: startOnIssueHandler().
 */
export function startOnIssueHandler(): EventHandler {
  return defineHandler({
    name: 'inventory.startWorkOrderOnIssue',
    events: ['inventory.issued'],
    async handle(event, { caller }) {
      const payload = event.payload as { workOrderId: string; issueId: string; startsWorkOrder: boolean }
      if (!payload.startsWorkOrder) return
      await startOnFirstWork(caller, payload.workOrderId, { what: `the issue ${payload.issueId}`, causationId: event.eventId })
    },
  })
}
