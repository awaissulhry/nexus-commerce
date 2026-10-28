import { defineManifest, PUBLIC, SIGNED_IN } from '../../../core/manifest'

/** The session routes (plan A1 §3.10): the CSRF token before sign-in, and the idle refresh of a live session. */
export const manifest = defineManifest({
  'GET /auth/csrf': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' },
  'POST /auth/sessions/refresh': { audiences: ['office'], permission: SIGNED_IN, scope: 'tenant' },
})
