import { defineRoutes } from '../../../core/manifest'
import { officeAuthOf } from '../sessions/office-auth'
import {
  assignContract,
  createRoleContract,
  editRoleContract,
  endAssignmentContract,
  listAssignmentsContract,
  listRolesContract,
  listTemplatesContract,
  syncTemplatesContract,
} from './contract'
import { manifest } from './manifest'
import { assignRole, createRole, editRole, endAssignment, listRoles, listTemplates, syncTemplates, userAssignments } from './roles'

/**
 * GET   /auth/roles/templates                      the system templates, every assignable permission, the grains
 * GET   /auth/roles                                the tenant's roles, with holders, outdated and template additions
 * POST  /auth/roles                                create a custom role (often a copy of a template)
 * PATCH /auth/roles/:roleId                        edit a custom role (version; audited with what it adds and removes)
 * POST  /auth/roles/sync-templates                 bring the system roles up to their templates (one audit row each)
 * GET   /auth/users/:userId/roles                  a person's assignments, live and ended
 * POST  /auth/users/:userId/roles                  give a person a role over some companies, sites or parties
 * POST  /auth/role-assignments/:assignmentId/end   end an assignment (version)
 */
export default defineRoutes('auth-roles', manifest, async (app) => {
  const auth = () => officeAuthOf(app)
  app.get('/auth/roles/templates', { schema: listTemplatesContract }, () => listTemplates())
  app.get('/auth/roles', { schema: listRolesContract }, (request) => listRoles(auth(), request))
  app.post('/auth/roles', { schema: createRoleContract }, (request) => createRole(auth(), request, request.body))
  app.patch('/auth/roles/:roleId', { schema: editRoleContract }, (request) => editRole(auth(), request, request.params.roleId, request.body))
  app.post('/auth/roles/sync-templates', { schema: syncTemplatesContract }, (request) => syncTemplates(auth(), request))
  app.get('/auth/users/:userId/roles', { schema: listAssignmentsContract }, (request) => userAssignments(auth(), request, request.params.userId))
  app.post('/auth/users/:userId/roles', { schema: assignContract }, (request) => assignRole(auth(), request, request.params.userId, request.body))
  app.post('/auth/role-assignments/:assignmentId/end', { schema: endAssignmentContract }, (request) =>
    endAssignment(auth(), request, request.params.assignmentId, request.body),
  )
})
