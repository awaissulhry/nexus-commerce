import { defineManifest } from '../../../core/manifest'

/**
 * The tenant's users (features PLT-015, PLT-016, PLT-070). Tenant-wide: a user is not a company's record. The
 * lifecycle commands also need a step-up (users/lifecycle.ts).
 */
export const manifest = defineManifest({
  'GET /auth/users': { audiences: ['office'], permission: 'users.view', scope: 'tenant' },
  'POST /auth/users/:userId/suspend': { audiences: ['office'], permission: 'users.suspend', scope: 'tenant' },
  'POST /auth/users/:userId/reactivate': { audiences: ['office'], permission: 'users.reactivate', scope: 'tenant' },
  'POST /auth/users/:userId/deactivate': { audiences: ['office'], permission: 'users.deactivate', scope: 'tenant' },
  'POST /auth/users/:userId/require-password-reset': { audiences: ['office'], permission: 'users.resetPassword', scope: 'tenant' },
})
