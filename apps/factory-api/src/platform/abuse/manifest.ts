import { defineManifest, PUBLIC } from '../../core/manifest'

/** The abuse guard (B-W2b-159; PLT-066): a proof-of-work challenge for anyone a public route asked one of. */
export const manifest = defineManifest({
  'GET /abuse/challenge': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' },
})
