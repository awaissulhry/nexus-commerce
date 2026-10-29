import { defineManifest } from '../../core/manifest'

/**
 * What to buy and make (B-W1-29; PLN-062 to PLN-066; A2 SCR-055). Office only: a run, its lines and the stock behind
 * them belong to a site and its company, so the handlers check the site (or the run's site) with can() and filter the
 * run history with scopeWhere() (`record`). No floor, portal or link route.
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
})
