import { defineManifest } from '../../../core/manifest'

/**
 * Warehouse rules and what they hold back (B-W2b-314; SCM-196, SCM-281; design warehouse.settings ws-posting, ws-adjust,
 * warehouse.moves mv-approval). Office only. Reading is inventory.stock.view (the rules over the company read; a posting
 * date at a site; the adjustments waiting at the sites the reader reaches); the cards are changed with inventory.rules.manage
 * over the company (every company: a grant over every company), the adjustment value also with the cost grain, checked in
 * the handler (`record`).
 */
const view = { audiences: ['office'], permission: 'inventory.stock.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'inventory.rules.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /inventory/rules': view,
  'PUT /inventory/rules/posting-dates': manage,
  'PUT /inventory/rules/adjustment-approval': manage,
  'PUT /inventory/rules/low-stock-alerts': manage,
  'GET /inventory/posting/check': view,
  'GET /inventory/adjustments/waiting': view,
})
