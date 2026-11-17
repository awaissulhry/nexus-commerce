import { defineManifest } from '../../../core/manifest'

/**
 * B-PR-18 (production plan §4 "What a brand sees", §5 Portal › Production › My production and Order › Status & progress): the
 * customer's own production in its portal. Partner sessions only, inside their party (row-level security); every order is read
 * in the partner scope first (another customer's order is as unknown as a wrong id: 404), then the office's facts of exactly
 * those orders. Reads only. `GET /portal/production?format=csv` is the list's own file ("Export"), written here in the partner's
 * scope: every own row of the chip and search, never the export job.
 */
export const manifest = defineManifest({
  'GET /portal/production': { audiences: ['partner'], permission: 'portal.production.view', scope: 'party' },
  'GET /portal/production/:orderId': { audiences: ['partner'], permission: 'portal.production.view', scope: 'party' },
})
