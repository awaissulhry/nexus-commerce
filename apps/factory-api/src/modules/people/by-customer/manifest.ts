import { defineManifest } from '../../../core/manifest'

/**
 * owb-of2 (order workflow, plan.md § 5f "People by customer"; the base's page row right, shared-asks 22:34): who of the office works
 * for which customer, and the extra rights. Every route needs the right that assigns roles today (`roles.assign`: the Owner and the
 * Administrator); an extra right also passes through today's role assignment (its step-up and checks).
 */
export const manifest = defineManifest({
  'GET /people/by-customer': { audiences: ['office'], permission: 'roles.assign', scope: 'tenant' },
  'PUT /people/by-customer/:partyId/:userId': { audiences: ['office'], permission: 'roles.assign', scope: 'tenant' },
  'POST /people/by-customer/every-customer': { audiences: ['office'], permission: 'roles.assign', scope: 'tenant' },
  'PUT /people/by-customer/extra/:userId': { audiences: ['office'], permission: 'roles.assign', scope: 'tenant' },
})
