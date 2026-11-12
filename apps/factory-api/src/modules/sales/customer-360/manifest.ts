import { defineManifest } from '../../../core/manifest'

/**
 * Customer 360 (B-W2b-324; SAL-019; design sales.customers record › Overview). Office only: parties.view over the customer
 * and the company (the handler checks both with can()); each part asks its own permission inside and is named in
 * `withheld` without it (factory-domain sales/customer-360/glance PART_PERMISSIONS). A read: no command, no event.
 */
const view = { audiences: ['office'], permission: 'parties.view', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /sales/customer-360/:partyId': view,
})
