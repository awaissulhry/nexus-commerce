import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { cancelContract, changeContract, createContract, doneContract, giveBackContract, inboxContract, listContract, recordContract, takeContract } from './contract'
import { doneTask, giveBackTask, inbox, takeTask } from './floor'
import { manifest } from './manifest'
import { cancelTask, changeTask, createTask, listTasks, taskRecord } from './office'

/**
 * The warehouse task inbox (B-W2b-292; SCM-274; follow-ups WT1:01, WT1:02): the tablet's inbox and its steps (./floor.ts), the
 * office's list, one task, a task by hand, its change and its cancel (./office.ts). The sources that make tasks by themselves
 * are ./sources (a receipt, a released lot or hold, a hold that asks quarantine, a pick list, a due count), run by the worker
 * (./handlers.ts in background.ts).
 */
export default defineRoutes('inventory.tasks', manifest, async (app) => {
  app.get('/inventory/tasks/inbox', { schema: inboxContract }, async (request) => inbox(request, new Date()))

  app.post('/inventory/tasks/:taskId/take', { schema: takeContract }, async (request) => takeTask(request, request.params.taskId, request.body, idempotencyKeyFrom(request)))

  app.post('/inventory/tasks/:taskId/give-back', { schema: giveBackContract }, async (request) => giveBackTask(request, request.params.taskId, request.body, idempotencyKeyFrom(request)))

  app.post('/inventory/tasks/:taskId/done', { schema: doneContract }, async (request) => doneTask(request, request.params.taskId, request.body, idempotencyKeyFrom(request)))

  app.get('/inventory/tasks', { schema: listContract }, async (request) => listTasks(request, request.query))

  app.get('/inventory/tasks/:taskId', { schema: recordContract }, async (request) => taskRecord(request, request.params.taskId))

  app.post('/inventory/tasks', { schema: createContract }, async (request, reply) => reply.code(201).send(await createTask(request, request.body, idempotencyKeyFrom(request))))

  app.patch('/inventory/tasks/:taskId', { schema: changeContract }, async (request) => changeTask(request, request.params.taskId, request.body, idempotencyKeyFrom(request)))

  app.post('/inventory/tasks/:taskId/cancel', { schema: cancelContract }, async (request) => cancelTask(request, request.params.taskId, request.body, idempotencyKeyFrom(request)))
})
