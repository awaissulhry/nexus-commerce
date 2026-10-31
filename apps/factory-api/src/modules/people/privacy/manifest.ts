import { defineManifest, SIGNED_IN } from '../../../core/manifest'

/**
 * Privacy of people data (B-W2b-27): office only. A site belongs to a company and a person to a company and a site, so
 * the handlers check each with can() and filter lists with scopeWhere() (`record`). Switching a purpose on, letting
 * leads see, lowering the minimum group size and naming another role ask for a fresh step-up inside the handler;
 * switching off and every narrowing never do. "What you see here" (the PrivacyNote said before any People page reads)
 * is for any office person, over a site their roles reach.
 */
export const manifest = defineManifest({
  'GET /people/privacy': { audiences: ['office'], permission: 'people.privacy.view', scope: 'record' },
  'GET /people/privacy/rules': { audiences: ['office'], permission: 'people.privacy.view', scope: 'record' },
  'GET /people/privacy/sites/:siteId': { audiences: ['office'], permission: 'people.privacy.view', scope: 'record' },
  'POST /people/privacy/sites/:siteId/purposes/:purpose/switch-on': { audiences: ['office'], permission: 'people.privacy.manage', scope: 'record' },
  'POST /people/privacy/sites/:siteId/purposes/:purpose/switch-off': { audiences: ['office'], permission: 'people.privacy.manage', scope: 'record' },
  'POST /people/privacy/sites/:siteId/purposes/:purpose/leads': { audiences: ['office'], permission: 'people.privacy.manage', scope: 'record' },
  'GET /people/privacy/companies/:companyId': { audiences: ['office'], permission: 'people.privacy.view', scope: 'record' },
  'POST /people/privacy/companies/:companyId': { audiences: ['office'], permission: 'people.privacy.manage', scope: 'record' },
  'GET /people/privacy/what-you-see': { audiences: ['office'], permission: SIGNED_IN, scope: 'tenant' },
  'GET /people/privacy/figures/:employeeId/access': { audiences: ['office'], permission: 'people.figures.view', scope: 'record' },
  'POST /people/privacy/figures/:employeeId/open': { audiences: ['office'], permission: 'people.figures.view', scope: 'record' },
})
