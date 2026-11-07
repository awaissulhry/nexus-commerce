import { defineManifest, PUBLIC, SIGNED_IN } from '../../../core/manifest'

/**
 * The partner's bell, e-mail settings and live channel (B-W2b-167; PLT-148, COL-063). The bell and the live channel need
 * portal.home.view (every main role, after the first visit); the e-mail settings are the signed-in person's own (they work at
 * the first visit, before any grant). The unsubscribe link is public: its signed token names the person (CSRF on the write).
 */
export const manifest = defineManifest({
  'GET /portal/notifications': { audiences: ['partner'], permission: 'portal.home.view', scope: 'party' },
  'GET /portal/notifications/counts': { audiences: ['partner'], permission: 'portal.home.view', scope: 'party' },
  'POST /portal/notifications/read': { audiences: ['partner'], permission: 'portal.home.view', scope: 'party' },
  'GET /portal/live': { audiences: ['partner'], permission: 'portal.home.view', scope: 'party' },
  'GET /portal/email-settings': { audiences: ['partner'], permission: SIGNED_IN, scope: 'party' },
  'PUT /portal/email-settings': { audiences: ['partner'], permission: SIGNED_IN, scope: 'party' },
  'POST /portal/unsubscribe/preview': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' },
  'POST /portal/unsubscribe': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' },
})
