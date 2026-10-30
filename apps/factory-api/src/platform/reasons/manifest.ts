import { defineManifest, SIGNED_IN } from '../../core/manifest'

/**
 * The reason lists (B-W2a-18; PLT-116). A list is the whole tenant's (scope `tenant`): any office or floor session reads
 * the active reasons a picker offers (GET /reasons: nothing personal or secret, the floor's tiles too); the editor's read
 * needs reasons.view; every write needs reasons.manage, and the handler asks it over every company and site (a list
 * reaches them all). Writes take an Idempotency-Key and the version read.
 */
export const manifest = defineManifest({
  'GET /reasons': { audiences: ['office', 'floor'], permission: SIGNED_IN, scope: 'tenant' },
  'GET /reasons/lists': { audiences: ['office'], permission: 'reasons.view', scope: 'tenant' },
  'POST /reasons/:list': { audiences: ['office'], permission: 'reasons.manage', scope: 'tenant' },
  'PATCH /reasons/:list/:reasonId': { audiences: ['office'], permission: 'reasons.manage', scope: 'tenant' },
  'POST /reasons/:list/active': { audiences: ['office'], permission: 'reasons.manage', scope: 'tenant' },
  'POST /reasons/:list/order': { audiences: ['office'], permission: 'reasons.manage', scope: 'tenant' },
  'POST /reasons/:list/standard': { audiences: ['office'], permission: 'reasons.manage', scope: 'tenant' },
})
