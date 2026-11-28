import { defineManifest, SIGNED_IN } from '../../../core/manifest'

/**
 * owb-of2 (order workflow, plan.md § 5f "Design desk"; the base's page row right `orders.view.own`, the Owner by every()): the Factory
 * designer's first page. It takes orders.view OR orders.view.own, and files.read — a manifest names ONE permission, so it says
 * signed-in and the handler refuses (403) a caller without them (./desk.ts); every list holds only the orders the caller may see.
 */
export const manifest = defineManifest({
  'GET /design-desk': { audiences: ['office'], permission: SIGNED_IN, scope: 'record' },
})
