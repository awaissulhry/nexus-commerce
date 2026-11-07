import { defineManifest, SIGNED_IN } from '../../../core/manifest'

/**
 * Partner organisations, their people and roles (B-W2b-162). Office routes: each party is checked with can() in the
 * handler (scope record; a tenant-wide party's changes need a grant over every company); every change but the preview also
 * asks a step-up. Portal routes: the session's party; the admin's changes ask a step-up by e-mail code.
 */
export const manifest = defineManifest({
  'GET /partners': { audiences: ['office'], permission: 'partners.view', scope: 'record' },
  'GET /partners/:partyId': { audiences: ['office'], permission: 'partners.view', scope: 'record' },
  'POST /partners/:partyId/settings': { audiences: ['office'], permission: 'partners.manage', scope: 'record' },
  'POST /partners/:partyId/people': { audiences: ['office'], permission: 'partners.invite', scope: 'record' },
  'POST /partners/:partyId/people/:userId/invitation': { audiences: ['office'], permission: 'partners.invite', scope: 'record' },
  'POST /partners/:partyId/people/:userId/invitation/revoke': { audiences: ['office'], permission: 'partners.invite', scope: 'record' },
  'PATCH /partners/:partyId/people/:userId': { audiences: ['office'], permission: 'partners.manage', scope: 'record' },
  'POST /partners/:partyId/people/:userId/suspend': { audiences: ['office'], permission: 'partners.manage', scope: 'record' },
  'POST /partners/:partyId/people/:userId/reactivate': { audiences: ['office'], permission: 'partners.manage', scope: 'record' },
  'POST /partners/:partyId/people/:userId/deactivate': { audiences: ['office'], permission: 'partners.manage', scope: 'record' },
  'POST /partners/:partyId/preview': { audiences: ['office'], permission: 'partners.preview', scope: 'record' },
  'GET /portal/access': { audiences: ['partner'], permission: SIGNED_IN, scope: 'party' },
  'GET /portal/colleagues': { audiences: ['partner'], permission: 'portal.colleagues.view', scope: 'party' },
  'POST /portal/colleagues': { audiences: ['partner'], permission: 'portal.colleagues.manage', scope: 'party' },
  'PATCH /portal/colleagues/:userId': { audiences: ['partner'], permission: 'portal.colleagues.manage', scope: 'party' },
  'POST /portal/colleagues/:userId/deactivate': { audiences: ['partner'], permission: 'portal.colleagues.manage', scope: 'party' },
})
