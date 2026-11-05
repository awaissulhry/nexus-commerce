import { defineManifest, PUBLIC, SIGNED_IN } from '../../../core/manifest'

/**
 * Portal sign-in (B-W2b-159; A1 §3.10). Signing in and out are public (they check their own code, link or cookie, the
 * CSRF double submit and the abuse guard); the person's own routes need a portal session of their party (no permission:
 * they work before the first visit, when the session holds none).
 */
export const manifest = defineManifest({
  'POST /portal/signin/start': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' },
  'POST /portal/signin/code': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' },
  'POST /portal/signin/link/preview': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' },
  'POST /portal/signin/link': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' },
  'POST /portal/sign-out': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' },
  'GET /portal/me': { audiences: ['partner'], permission: SIGNED_IN, scope: 'party' },
  'POST /portal/sessions/refresh': { audiences: ['partner'], permission: SIGNED_IN, scope: 'party' },
  'GET /portal/terms': { audiences: ['partner'], permission: SIGNED_IN, scope: 'party' },
  'POST /portal/first-visit': { audiences: ['partner'], permission: SIGNED_IN, scope: 'party' },
  'POST /portal/step-up/start': { audiences: ['partner'], permission: SIGNED_IN, scope: 'party' },
  'POST /portal/step-up': { audiences: ['partner'], permission: SIGNED_IN, scope: 'party' },
})
