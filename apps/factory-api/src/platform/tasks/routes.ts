import { idempotencyKeyFrom } from '../../core/command'
import { defineRoutes } from '../../core/manifest'
import { assignTaskContract, bulkTasksContract, createTaskContract, getTaskContract, listTasksContract, snoozeTaskContract, taskAssigneesContract, taskStatusContract, updateTaskContract } from './contract'
import { manifest } from './manifest'
import { assignTask, bulkTasks, createTask, getTask, listTasks, setTaskStatus, snoozeTask, taskAssignees, updateTask } from './tasks'
// B-W2b-388: reminders (COL-041).
import { bulkRemindersContract, listRemindersContract, putOffReminderContract, reminderDoneContract, reminderUndoContract, removeReminderContract, setReminderContract } from './reminders/contract'
import { bulkReminders, listReminders, putOffReminder, removeReminder, setReminder, setReminderDone } from './reminders/reminders'

/**
 * Tasks on any record (B-W2a-20; COL-037): My tasks and a record's tasks, one task, make, change, assign, done / reopen
 * / cancel, snooze, and the bulk actions of My tasks. Rules: factory-domain tasks/rules; storage and commands: tasks.ts.
 */
export default defineRoutes('tasks', manifest, async (app) => {
  app.get('/tasks', { schema: listTasksContract }, async (request) => listTasks(request, request.query))

  app.post('/tasks/bulk', { schema: bulkTasksContract }, async (request) => bulkTasks(request, request.body, idempotencyKeyFrom(request)))

  app.get('/tasks/assignees', { schema: taskAssigneesContract }, async (request) => taskAssignees(request, request.query))

  app.get('/tasks/:id', { schema: getTaskContract }, async (request) => getTask(request, request.params.id))

  app.post('/tasks', { schema: createTaskContract }, async (request, reply) => reply.code(201).send(await createTask(request, request.body, idempotencyKeyFrom(request))))

  app.put('/tasks/:id', { schema: updateTaskContract }, async (request) => updateTask(request, request.params.id, request.body, idempotencyKeyFrom(request)))

  app.post('/tasks/:id/assign', { schema: assignTaskContract }, async (request) => assignTask(request, request.params.id, request.body, idempotencyKeyFrom(request)))

  app.post('/tasks/:id/status', { schema: taskStatusContract }, async (request) => setTaskStatus(request, request.params.id, request.body, idempotencyKeyFrom(request)))

  app.post('/tasks/:id/snooze', { schema: snoozeTaskContract }, async (request) => snoozeTask(request, request.params.id, request.body, idempotencyKeyFrom(request)))

  // B-W2b-388 (COL-041): Remind me about this — my reminders (reminders/reminders.ts; the folder has no routes file of its own:
  // the autoloader never looks inside a folder that has one).
  app.get('/reminders', { schema: listRemindersContract }, async (request) => listReminders(request, request.query))

  app.post('/reminders', { schema: setReminderContract }, async (request, reply) => reply.code(201).send(await setReminder(request, request.body, idempotencyKeyFrom(request))))

  app.post('/reminders/bulk', { schema: bulkRemindersContract }, async (request) => bulkReminders(request, request.body, idempotencyKeyFrom(request)))

  app.post('/reminders/:id/put-off', { schema: putOffReminderContract }, async (request) => putOffReminder(request, request.params.id, request.body, idempotencyKeyFrom(request)))

  app.post('/reminders/:id/done', { schema: reminderDoneContract }, async (request) => setReminderDone(request, request.params.id, request.body, true, idempotencyKeyFrom(request)))

  app.post('/reminders/:id/undo', { schema: reminderUndoContract }, async (request) => setReminderDone(request, request.params.id, request.body, false, idempotencyKeyFrom(request)))

  app.delete('/reminders/:id', { schema: removeReminderContract }, async (request) => removeReminder(request, request.params.id, request.query.version, idempotencyKeyFrom(request)))
})
