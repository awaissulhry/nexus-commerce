import { defineManifest, SIGNED_IN } from '../../core/manifest'

/**
 * The office shell's notices (B-W2b-F49; Owner rule W2b-6 "a test mode shows a banner on every page while it is on", for
 * everyone): any signed-in office person, no permission, tenant-wide; the handler names only the companies and sites the
 * person's own grants reach (reachWhere). Floor, partner and link sessions are refused (403) as on every office route.
 */
export const manifest = defineManifest({
  'GET /shell/notices': { audiences: ['office'], permission: SIGNED_IN, scope: 'tenant' },
})
