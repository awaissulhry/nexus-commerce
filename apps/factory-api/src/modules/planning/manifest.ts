import { defineManifest } from '../../core/manifest'

/**
 * What to buy and make (B-W1-29; PLN-062 to PLN-066; A2 SCR-055). Office only: a run, its lines and the stock behind
 * them belong to a site and its company, so the handlers check the site (or the run's site) with can() and filter the
 * run history with scopeWhere() (`record`). No floor, portal or link route.
 *
 * B-W2a-16: planning settings and capacity, office only, checked per site (a line's or work centre's: its site) with
 * can() (`record`): read with planning.view, kept with planning.settings.manage (settings, lanes) and
 * planning.items.manage (item parameters and reorder rules).
 */
export const manifest = defineManifest({
  'POST /planning/runs': { audiences: ['office'], permission: 'planning.run', scope: 'record' },
  'GET /planning/runs': { audiences: ['office'], permission: 'planning.view', scope: 'record' },
  'GET /planning/runs/latest': { audiences: ['office'], permission: 'planning.view', scope: 'record' },
  'GET /planning/runs/:runId': { audiences: ['office'], permission: 'planning.view', scope: 'record' },
  'GET /planning/requirements/:requirementId': { audiences: ['office'], permission: 'planning.view', scope: 'record' },
  'POST /planning/requirements/set-aside': { audiences: ['office'], permission: 'planning.decide', scope: 'record' },
  'POST /planning/requirements/reopen': { audiences: ['office'], permission: 'planning.decide', scope: 'record' },
  'GET /planning/unusable-stock': { audiences: ['office'], permission: 'planning.view', scope: 'record' },
  // B-W2a-16: planning settings and capacity.
  'GET /planning/settings': { audiences: ['office'], permission: 'planning.view', scope: 'record' },
  'GET /planning/settings/:siteId': { audiences: ['office'], permission: 'planning.view', scope: 'record' },
  'PATCH /planning/settings/:siteId': { audiences: ['office'], permission: 'planning.settings.manage', scope: 'record' },
  'GET /planning/item-parameters': { audiences: ['office'], permission: 'planning.view', scope: 'record' },
  'POST /planning/item-parameters': { audiences: ['office'], permission: 'planning.items.manage', scope: 'record' },
  'GET /planning/item-parameters/:itemPlanningId': { audiences: ['office'], permission: 'planning.view', scope: 'record' },
  'PATCH /planning/item-parameters/:itemPlanningId': { audiences: ['office'], permission: 'planning.items.manage', scope: 'record' },
  'POST /planning/item-parameters/:itemPlanningId/delete': { audiences: ['office'], permission: 'planning.items.manage', scope: 'record' },
  'GET /planning/reorder-rules': { audiences: ['office'], permission: 'planning.view', scope: 'record' },
  'GET /planning/lanes': { audiences: ['office'], permission: 'planning.view', scope: 'record' },
  'PATCH /planning/lines/:lineId/capacity': { audiences: ['office'], permission: 'planning.settings.manage', scope: 'record' },
  'PATCH /planning/work-centres/:workCentreId/capacity': { audiences: ['office'], permission: 'planning.settings.manage', scope: 'record' },
  'GET /planning/capacity': { audiences: ['office'], permission: 'planning.view', scope: 'record' },
  'GET /planning/capacity/cell': { audiences: ['office'], permission: 'planning.view', scope: 'record' },
})
