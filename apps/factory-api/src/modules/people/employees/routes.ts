import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import {
  createEmployeeContract,
  employeeCountsContract,
  employeeFromUserContract,
  employeeFromWorkerContract,
  employeeRecordContract,
  importMissingContract,
  linkWorkerContract,
  listEmployeesContract,
  setAccountContract,
  unlinkedWorkersContract,
  unlinkWorkerContract,
  updateEmployeeContract,
} from './contract'
import { employeeCounts, employeeRecord, importMissing, listEmployees, unlinkedWorkers } from './employees'
import { manifest } from './manifest'
import { createEmployee, employeeFromUser, employeeFromWorker, linkWorker, setAccount, unlinkWorker, updateEmployee } from './writes'

/** The employee record (B-W2b-26; ./employees.ts reads, ./writes.ts writes). Each write is one command with an Idempotency-Key. */
export default defineRoutes('people.employees', manifest, async (app) => {
  app.get('/people/employees', { schema: listEmployeesContract }, async (request) => listEmployees(request, request.query))

  app.get('/people/employees/counts', { schema: employeeCountsContract }, async (request) => employeeCounts(request, request.query))

  app.get('/people/employees/unlinked-workers', { schema: unlinkedWorkersContract }, async (request) => unlinkedWorkers(request, request.query))

  app.get('/people/employees/import/:jobId/missing', { schema: importMissingContract }, async (request) => importMissing(request, request.params.jobId))

  app.get('/people/employees/:employeeId', { schema: employeeRecordContract }, async (request) => employeeRecord(request, request.params.employeeId))

  app.post('/people/employees', { schema: createEmployeeContract }, async (request, reply) => {
    const { replayed, ...answer } = await createEmployee(request, request.body, idempotencyKeyFrom(request))
    return reply.code(replayed ? 200 : 201).send(answer)
  })

  app.post('/people/employees/from-worker', { schema: employeeFromWorkerContract }, async (request, reply) => {
    const { replayed, ...answer } = await employeeFromWorker(request, request.body, idempotencyKeyFrom(request))
    return reply.code(replayed ? 200 : 201).send(answer)
  })

  app.post('/people/employees/from-user', { schema: employeeFromUserContract }, async (request, reply) => {
    const { replayed, ...answer } = await employeeFromUser(request, request.body, idempotencyKeyFrom(request))
    return reply.code(replayed ? 200 : 201).send(answer)
  })

  app.patch('/people/employees/:employeeId', { schema: updateEmployeeContract }, async (request) => updateEmployee(request, request.params.employeeId, request.body, idempotencyKeyFrom(request)))

  app.post('/people/employees/:employeeId/workers', { schema: linkWorkerContract }, async (request) => linkWorker(request, request.params.employeeId, request.body, idempotencyKeyFrom(request)))

  app.post('/people/employees/:employeeId/workers/:workerId/unlink', { schema: unlinkWorkerContract }, async (request) =>
    unlinkWorker(request, request.params.employeeId, request.params.workerId, request.body, idempotencyKeyFrom(request)),
  )

  app.put('/people/employees/:employeeId/user', { schema: setAccountContract }, async (request) => setAccount(request, request.params.employeeId, request.body, idempotencyKeyFrom(request)))
})
