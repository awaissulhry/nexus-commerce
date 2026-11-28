import { defineRoutes } from '../../../core/manifest'
import { departmentsContract } from './contract'
import { manifest } from './manifest'
import { readDepartments } from './read'

/** owb- (order workflow, b3.3): the departments, read only (S4 adds the manage routes here). */
export default defineRoutes('production.departments', manifest, async (app) => {
  app.get('/production/departments', { schema: departmentsContract }, async (request) => readDepartments(request))
})
