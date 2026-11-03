import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { assignProfile, endAssignment, readAssignments } from './assignments'
import { calculate } from './calculator'
import { resolveRoute, workOrderPlan } from './chain'
import {
  applyProfileContract,
  assignContract,
  assignmentsContract,
  calculateContract,
  createProfileContract,
  editProfileContract,
  endAssignmentContract,
  inspectionAqlContract,
  profilesContract,
  resolveContract,
  workOrderPlanContract,
} from './contract'
import { applyProfile, inspectionAql } from './inspections'
import { manifest } from './manifest'
import { createProfile, editProfile, readProfiles } from './profiles'

/**
 * The AQL engine and profiles (B-W2b-93; QHS-013, QHS-020, QHS-021): profiles (./profiles.ts), their assignments to
 * customers and styles (./assignments.ts), which profile applies and a work order's plan (./chain.ts: `aqlPlanFor` is
 * the function the inspection steps call), the calculator (./calculator.ts) and an inspection's Sample & AQL with the
 * plan taken from a profile (./inspections.ts). The ISO 2859-1 tables and the result rules are factory-domain
 * quality/aql.
 */
export default defineRoutes('quality.aql', manifest, async (app) => {
  app.get('/quality/aql/profiles', { schema: profilesContract }, async (request) => readProfiles(request, request.query))

  app.post('/quality/aql/profiles', { schema: createProfileContract }, async (request, reply) => reply.code(201).send(await createProfile(request, request.body, idempotencyKeyFrom(request))))

  app.patch('/quality/aql/profiles/:profileId', { schema: editProfileContract }, async (request) => editProfile(request, request.params.profileId, request.body, idempotencyKeyFrom(request)))

  app.get('/quality/aql/assignments', { schema: assignmentsContract }, async (request) => readAssignments(request, request.query))

  app.post('/quality/aql/assignments', { schema: assignContract }, async (request, reply) => reply.code(201).send(await assignProfile(request, request.body, idempotencyKeyFrom(request))))

  app.post('/quality/aql/assignments/:assignmentId/end', { schema: endAssignmentContract }, async (request) => endAssignment(request, request.params.assignmentId, request.body, idempotencyKeyFrom(request)))

  app.get('/quality/aql/resolve', { schema: resolveContract }, async (request) => resolveRoute(request, request.query))

  app.get('/quality/aql/calculate', { schema: calculateContract }, async (request) => calculate(request, request.query))

  app.get('/quality/aql/work-orders/:workOrderId/plan', { schema: workOrderPlanContract }, async (request) => workOrderPlan(request, request.params.workOrderId, request.query))

  app.get('/quality/aql/inspections/:inspectionId', { schema: inspectionAqlContract }, async (request) => inspectionAql(request, request.params.inspectionId))

  app.post('/quality/aql/inspections/:inspectionId/profile', { schema: applyProfileContract }, async (request) => applyProfile(request, request.params.inspectionId, request.body, idempotencyKeyFrom(request)))
})
