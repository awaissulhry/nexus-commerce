import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { appClock } from './clock'
import { askContract, cancelContract, handoverContract, moveDueContract, officeTasksContract, portalDoneContract, portalTasksContract, portalUndoContract, reopenContract } from './contract'
import { manifest } from './manifest'
import { askPartner, cancelTask, moveDue, partyTasks, reopenTask } from './office'
import { handover, markDone, myTasks, undoDone } from './portal'

/**
 * Tasks for partners (B-W2b-167; COL-043 "Tasks for customers and suppliers"; design portal.frame action-needed, office
 * home.tasks "tasks staff give the customer"): the partner's one list, done with Undo, the hand-over when a colleague leaves;
 * the office's requests by hand and their changes. The reminder mails are the scheduler's (./reminders.ts); the sources that
 * open and close requests in their own commands are ./sources.
 */
export default defineRoutes('portal-tasks', manifest, async (app) => {
  app.get('/portal/tasks', { schema: portalTasksContract }, async (request) => myTasks(request, request.query.state, appClock(app).now()))

  app.post('/portal/tasks/:taskId/done', { schema: portalDoneContract }, async (request) => markDone(app, request, request.params.taskId, request.body.version, idempotencyKeyFrom(request), appClock(app).now()))

  app.post('/portal/tasks/:taskId/undo', { schema: portalUndoContract }, async (request) => undoDone(app, request, request.params.taskId, idempotencyKeyFrom(request), appClock(app).now()))

  app.get('/portal/tasks/handover/:userId', { schema: handoverContract }, async (request) => handover(app, request, request.params.userId, appClock(app).now()))

  app.get('/partners/:partyId/tasks', { schema: officeTasksContract }, async (request) => partyTasks(app, request, request.params.partyId, request.query.status))

  app.post('/partners/:partyId/tasks', { schema: askContract }, async (request) => askPartner(app, request, request.params.partyId, request.body, idempotencyKeyFrom(request)))

  app.post('/partner-tasks/:taskId/cancel', { schema: cancelContract }, async (request) => cancelTask(app, request, request.params.taskId, request.body.version, idempotencyKeyFrom(request)))

  app.post('/partner-tasks/:taskId/reopen', { schema: reopenContract }, async (request) => reopenTask(app, request, request.params.taskId, request.body.version, idempotencyKeyFrom(request)))

  app.patch('/partner-tasks/:taskId', { schema: moveDueContract }, async (request) => moveDue(app, request, request.params.taskId, request.body, idempotencyKeyFrom(request)))
})
