import { defineManifest } from '../../../core/manifest'

/**
 * The costing method per company (B-W2a-21; FIN-025; design finance.settings "Costing"). Office only. Choosing it needs
 * costing.method.manage over the company (the tenant-wide method: a grant over every company) and a fresh step-up: it is
 * the accountant's choice and locks with the first cost entry posted under it.
 */
export const manifest = defineManifest({
  'GET /costing/method': { audiences: ['office'], permission: 'costing.view', scope: 'record' },
  'PUT /costing/method': { audiences: ['office'], permission: 'costing.method.manage', scope: 'record' },
})
