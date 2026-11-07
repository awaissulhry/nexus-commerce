import { defineManifest } from '../../../core/manifest'

/**
 * Portal search (B-W2b-168; SAL-084). A portal session only; portal.search (every main partner role); scope party: the
 * session's. Each result is checked by the handler (its partner view, can() over its company and the party, a grain where
 * the view asks one: platform/search/partner/search.ts).
 */
export const manifest = defineManifest({
  'GET /portal/search': { audiences: ['partner'], permission: 'portal.search', scope: 'party' },
})
