import { defineManifest, PUBLIC, SIGNED_IN } from '../../../core/manifest'

/**
 * Office sign-in (plan A1 §3.10). Signing in, out and resetting a password are public (they check their own token or
 * credentials, and the CSRF double submit where a cookie is involved); the account routes need any office session.
 */
export const manifest = defineManifest({
  'POST /auth/office/sign-in': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' },
  'POST /auth/office/sign-out': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' },
  'POST /auth/office/password/reset-request': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' },
  'POST /auth/office/password/reset': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' },
  'GET /auth/office/me': { audiences: ['office'], permission: SIGNED_IN, scope: 'tenant' },
  'POST /auth/office/step-up': { audiences: ['office'], permission: SIGNED_IN, scope: 'tenant' },
  'POST /auth/office/totp/setup': { audiences: ['office'], permission: SIGNED_IN, scope: 'tenant' },
  'POST /auth/office/totp/confirm': { audiences: ['office'], permission: SIGNED_IN, scope: 'tenant' },
  'POST /auth/office/totp/disable': { audiences: ['office'], permission: SIGNED_IN, scope: 'tenant' },
  'POST /auth/office/password': { audiences: ['office'], permission: SIGNED_IN, scope: 'tenant' },
  'POST /auth/office/locale': { audiences: ['office'], permission: SIGNED_IN, scope: 'tenant' },
})
