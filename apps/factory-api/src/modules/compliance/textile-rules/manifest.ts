import { defineManifest } from '../../../core/manifest'

/**
 * The textile, leather and origin checks (B-W2b-208; PRD-338 … PRD-345; design compliance.labels › Label builder and Rule
 * checks). The office reads a style's checks with the certificate register's view permission over the style's company
 * (`record`), the switches and the builder's vocabulary with it in any grant (`tenant`: they are the factory's); switching
 * a check needs compliance.textileRules.manage over every company (the handler checks it). The customer reads a style's
 * fibres in its portal catalogue before buying (PRD-341; portal.catalogue.view, its party), only for a style its catalogue
 * offers.
 */
export const manifest = defineManifest({
  'GET /compliance/textile-rules/styles/:styleId': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'record' },
  'GET /compliance/textile-rules/switches': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'tenant' },
  'PUT /compliance/textile-rules/switches/:rule': { audiences: ['office'], permission: 'compliance.textileRules.manage', scope: 'tenant' },
  'GET /compliance/textile-rules/vocabulary': { audiences: ['office'], permission: 'compliance.certificates.view', scope: 'tenant' },
  'GET /portal/catalogue/:styleId/composition': { audiences: ['partner'], permission: 'portal.catalogue.view', scope: 'party' },
})
