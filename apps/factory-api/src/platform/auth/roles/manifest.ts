import { defineManifest } from '../../../core/manifest'

/**
 * Roles and assignments (features PLT-029, PLT-030, PLT-032). Tenant-wide: a role and a person are not a company's
 * records (an assignment's scope says which companies it reaches). The writes also need a step-up (roles/roles.ts).
 */
export const manifest = defineManifest({
  'GET /auth/roles/templates': { audiences: ['office'], permission: 'roles.view', scope: 'tenant' },
  'GET /auth/roles': { audiences: ['office'], permission: 'roles.view', scope: 'tenant' },
  'POST /auth/roles': { audiences: ['office'], permission: 'roles.manage', scope: 'tenant' },
  'PATCH /auth/roles/:roleId': { audiences: ['office'], permission: 'roles.manage', scope: 'tenant' },
  'POST /auth/roles/sync-templates': { audiences: ['office'], permission: 'roles.manage', scope: 'tenant' },
  'GET /auth/users/:userId/roles': { audiences: ['office'], permission: 'roles.view', scope: 'tenant' },
  'POST /auth/users/:userId/roles': { audiences: ['office'], permission: 'roles.assign', scope: 'tenant' },
  'POST /auth/role-assignments/:assignmentId/end': { audiences: ['office'], permission: 'roles.assign', scope: 'tenant' },
})
