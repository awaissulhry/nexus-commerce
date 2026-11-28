import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { createDepartmentContract, departmentsContract, moveDepartmentContract, updateDepartmentContract } from './contract'
import { createDepartment, moveDepartment, updateDepartment } from './manage'
import { manifest } from './manifest'
import { readDepartments } from './read'

/** owb- (order workflow, b3.3): the departments, read; owb-pd1 1.3: kept — added, renamed, closed and opened again (./manage.ts). */
export default defineRoutes('production.departments', manifest, async (app) => {
  app.get('/production/departments', { schema: departmentsContract }, async (request) => readDepartments(request))

  app.post('/production/departments', { schema: createDepartmentContract }, async (request, reply) =>
    reply.code(201).send({ department: await createDepartment(request, request.body, idempotencyKeyFrom(request)) }),
  )

  app.patch('/production/departments/:departmentId', { schema: updateDepartmentContract }, async (request) => ({
    department: await updateDepartment(request, request.params.departmentId, request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/production/departments/:departmentId/close', { schema: moveDepartmentContract }, async (request) => ({
    department: await moveDepartment(request, request.params.departmentId, 'CLOSED', request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/production/departments/:departmentId/open', { schema: moveDepartmentContract }, async (request) => ({
    department: await moveDepartment(request, request.params.departmentId, 'ACTIVE', request.body, idempotencyKeyFrom(request)),
  }))
})
