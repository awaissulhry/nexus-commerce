import { defineManifest } from '../../../core/manifest'

/** The partner's Home (B-W2b-167): what waits for the person, the rail's badges, the counts at a glance. */
export const manifest = defineManifest({
  'GET /portal/home': { audiences: ['partner'], permission: 'portal.home.view', scope: 'party' },
})
