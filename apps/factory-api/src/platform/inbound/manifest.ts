import { defineManifest, PUBLIC } from '../../core/manifest'

/**
 * The inbound ledger's route (plan A1 §4, §3.10 "rate limits on every public route (… inbound webhooks)"): public,
 * because a provider has no session. It is authenticated by the provider's signature, checked on the raw body before
 * anything is stored as verified (receive.ts); an unknown tenant, account or provider is a 404.
 */
export const manifest = defineManifest({
  'POST /inbound/:provider/:tenantId/:accountId': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' },
})
