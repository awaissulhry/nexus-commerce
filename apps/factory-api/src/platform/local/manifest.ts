import { defineManifest, SIGNED_IN } from '../../core/manifest'

/**
 * The Owner's local test server (B-W2b-F58): the local mailbox, for any signed-in office person of the tenant (each sees the
 * tenant's FAKE mail, as the Owner tests invitations, password resets and portal codes for people who are not signed in).
 * Registered ONLY on FACTORY_ENV=local (routes.ts): elsewhere neither the route nor this entry exists, so it answers 404.
 */
export const manifest = defineManifest({
  'GET /local/mailbox': { audiences: ['office'], permission: SIGNED_IN, scope: 'tenant' },
})
