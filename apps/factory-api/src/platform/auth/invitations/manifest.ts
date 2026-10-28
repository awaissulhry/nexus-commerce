import { defineManifest, PUBLIC } from '../../../core/manifest'

/**
 * Invitations (feature PLT-015). Inviting and revoking need users.invite (and a step-up); the link's own routes are
 * public: the token is the credential.
 */
export const manifest = defineManifest({
  'POST /auth/invitations': { audiences: ['office'], permission: 'users.invite', scope: 'tenant' },
  'POST /auth/invitations/:invitationId/revoke': { audiences: ['office'], permission: 'users.invite', scope: 'tenant' },
  'POST /auth/invitations/preview': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' },
  'POST /auth/invitations/accept': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' },
})
