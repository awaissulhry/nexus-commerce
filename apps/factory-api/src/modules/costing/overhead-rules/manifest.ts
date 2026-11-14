import { defineManifest } from '../../../core/manifest'

/**
 * Overhead absorption rules (B-W2b-419; FIN-007; design finance.settings › Costing). Office only: the floor, partner and link
 * sessions never see a cost (A1 §2.6). Each handler checks the rule's company with can() and filters the list with
 * scopeWhere() (`record`). Kept with costing.rates.manage, the labour rates' and overhead's permission (every company's
 * rule: a grant over every company); a value sent needs the cost grain.
 */
const view = { audiences: ['office'], permission: 'costing.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'costing.rates.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /costing/overhead-rules': view,
  'GET /costing/overhead-rules/in-force': view,
  'GET /costing/overhead-rules/:ruleId': view,
  'POST /costing/overhead-rules': manage,
  'PATCH /costing/overhead-rules/:ruleId': manage,
  'POST /costing/overhead-rules/:ruleId/archive': manage,
})
