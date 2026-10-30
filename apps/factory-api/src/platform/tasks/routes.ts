import { idempotencyKeyFrom } from '../../core/command'
import { defineRoutes } from '../../core/manifest'
import { assignTaskContract, bulkTasksContract, createTaskContract, getTaskContract, listTasksContract, snoozeTaskContract, taskStatusContract, updateTaskContract } from './contract'
import { manifest } from './manifest'
import { assignTask, bulkTasks, createTask, getTask, listTasks, setTaskStatus, snoozeTask, updateTask } from './tasks'

/**
 * Tasks on any record (B-W2a-20; COL-037): My tasks and a record's tasks, one task, make, change, assign, done / reopen
 * / cancel, snooze, and the bulk actions of My tasks. Rules: factory-domain tasks/rules; storage and commands: tasks.ts.
 */
export default defineRoutes('tasks', manifest, async (app) => {
  app.get('/tasks', { schema: listTasksContract }, async (request) => listTasks(request, request.query))

  app.post('/tasks/bulk', { schema: bulkTasksContract }, async (request) => bulkTasks(request, request.body, idempotencyKeyFrom(request)))

  app.get('/tasks/:id', { schema: getTaskContract }, async (request) => getTask(request, request.params.id))

  app.post('/tasks', { schema: createTaskContract }, async (request, reply) => reply.code(201).send(await createTask(request, request.body, idempotencyKeyFrom(request))))

  app.put('/tasks/:id', { schema: updateTaskContract }, async (request) => updateTask(request, request.params.id, request.body, idempotencyKeyFrom(request)))

  app.post('/tasks/:id/assign', { schema: assignTaskContract }, async (request) => assignTask(request, request.params.id, request.body, idempotencyKeyFrom(request)))

  app.post('/tasks/:id/status', { schema: taskStatusContract }, async (request) => setTaskStatus(request, request.params.id, request.body, idempotencyKeyFrom(request)))

  app.post('/tasks/:id/snooze', { schema: snoozeTaskContract }, async (request) => snoozeTask(request, request.params.id, request.body, idempotencyKeyFrom(request)))
})
