import { defineManifest, SIGNED_IN } from '../../core/manifest'

/**
 * Global search (B-W2a-32; PLT-153). Office only. Searching needs no permission of its own (any office session): every
 * result is filtered by the entry's own view permission and its company, site and party against the reader's grants
 * (`record`: the handler filters). Rebuilding the tenant's index is search.rebuild and takes an Idempotency-Key.
 */
export const manifest = defineManifest({
  'GET /search': { audiences: ['office'], permission: SIGNED_IN, scope: 'record' },
  'POST /search/rebuild': { audiences: ['office'], permission: 'search.rebuild', scope: 'tenant' },
})
