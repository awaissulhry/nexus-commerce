import { defineManifest, PUBLIC, SIGNED_IN } from '../../../core/manifest'

/**
 * The session routes (plan A1 §3.10): the CSRF token before sign-in, and the idle refresh of a live session. B-W2b-404
 * (PLT-064, PLT-068, PLT-063): my own sessions (any office session: no permission), a person's sessions (an administrator's,
 * tenant-wide like the users), and the company's security settings (read with Security & health's view, changed with
 * security.settings.manage; a wider change asks for a fresh code in the handler).
 */
export const manifest = defineManifest({
  'GET /auth/csrf': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' },
  'POST /auth/sessions/refresh': { audiences: ['office'], permission: SIGNED_IN, scope: 'tenant' },
  'GET /auth/sessions': { audiences: ['office'], permission: SIGNED_IN, scope: 'tenant' },
  'POST /auth/sessions/:sessionId/end': { audiences: ['office'], permission: SIGNED_IN, scope: 'tenant' },
  'POST /auth/sessions/end-others': { audiences: ['office'], permission: SIGNED_IN, scope: 'tenant' },
  'GET /auth/users/:userId/sessions': { audiences: ['office'], permission: 'users.sessions.manage', scope: 'tenant' },
  'POST /auth/users/:userId/sessions/end': { audiences: ['office'], permission: 'users.sessions.manage', scope: 'tenant' },
  'GET /auth/security-settings': { audiences: ['office'], permission: 'security.view', scope: 'tenant' },
  'PUT /auth/security-settings/sessions': { audiences: ['office'], permission: 'security.settings.manage', scope: 'tenant' },
  'PUT /auth/security-settings/step-up': { audiences: ['office'], permission: 'security.settings.manage', scope: 'tenant' },
})
