import { defineManifest } from '../../../core/manifest'

/**
 * Packaging and carton marks (B-W2b-384; LOG-008, LOG-013; design warehouse.shipping "Packaging"): office only, read with
 * shipping.view, kept with shipping.packaging.manage. Each row is a company's (a customer's template: the company and the
 * customer), so the handlers check each one with can() and filter the lists with scopeWhere() (`record`).
 */
export const manifest = defineManifest({
  'GET /shipping/packaging/types': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'POST /shipping/packaging/types': { audiences: ['office'], permission: 'shipping.packaging.manage', scope: 'record' },
  'PATCH /shipping/packaging/types/:typeId': { audiences: ['office'], permission: 'shipping.packaging.manage', scope: 'record' },
  'GET /shipping/packaging/defaults': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'POST /shipping/packaging/defaults': { audiences: ['office'], permission: 'shipping.packaging.manage', scope: 'record' },
  'PATCH /shipping/packaging/defaults/:defaultId': { audiences: ['office'], permission: 'shipping.packaging.manage', scope: 'record' },
  'GET /shipping/packaging/mark-templates': { audiences: ['office'], permission: 'shipping.view', scope: 'record' },
  'POST /shipping/packaging/mark-templates': { audiences: ['office'], permission: 'shipping.packaging.manage', scope: 'record' },
  'PATCH /shipping/packaging/mark-templates/:templateId': { audiences: ['office'], permission: 'shipping.packaging.manage', scope: 'record' },
})
