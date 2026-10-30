import { defineManifest } from '../../core/manifest'

/**
 * What to buy and make (B-W1-29; PLN-062 to PLN-066; A2 SCR-055). Office only: a run, its lines and the stock behind
 * them belong to a site and its company, so the handlers check the site (or the run's site) with can() and filter the
 * run history with scopeWhere() (`record`). No floor, portal or link route.
 *
 * B-W2a-16: planning settings and capacity, office only, checked per site (a line's or work centre's: its site) with
 * can() (`record`): read with planning.view, kept with planning.settings.manage (settings, lanes) and
 * planning.items.manage (item parameters and reorder rules).
 *
 * B-W2a-22: MRP every day, office only, checked per site (a line's, run's, work order's or exception's: its site) with
 * can() (`record`): read with planning.view; firm planned orders with planning.firm; the exception list worked with
 * planning.exceptions.manage.
 *
 * B-W2a-34: the planning board, office only, checked per site (a work order's, slot's or version's: its site) with
 * can() (`record`): read with planning.view (a production manager sees it read-only); the working plan changed with
 * planning.schedule.manage (a preview of the placement by due date only needs planning.view: the handler asks manage
 * when it applies); published with planning.schedule.publish.
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
  // B-W2a-22: MRP every day.
  'POST /planning/requirements/:requirementId/firm': { audiences: ['office'], permission: 'planning.firm', scope: 'record' },
  'POST /planning/requirements/:requirementId/unfirm': { audiences: ['office'], permission: 'planning.firm', scope: 'record' },
  'GET /planning/pegging': { audiences: ['office'], permission: 'planning.view', scope: 'record' },
  'GET /planning/readiness': { audiences: ['office'], permission: 'planning.view', scope: 'record' },
  'GET /planning/work-orders/:workOrderId/readiness': { audiences: ['office'], permission: 'planning.view', scope: 'record' },
  'GET /planning/shortages': { audiences: ['office'], permission: 'planning.view', scope: 'record' },
  'GET /planning/exceptions': { audiences: ['office'], permission: 'planning.view', scope: 'record' },
  'POST /planning/exceptions/acknowledge': { audiences: ['office'], permission: 'planning.exceptions.manage', scope: 'record' },
  'GET /planning/exceptions/:exceptionId': { audiences: ['office'], permission: 'planning.view', scope: 'record' },
  'POST /planning/exceptions/:exceptionId/snooze': { audiences: ['office'], permission: 'planning.exceptions.manage', scope: 'record' },
  'POST /planning/exceptions/:exceptionId/resolve': { audiences: ['office'], permission: 'planning.exceptions.manage', scope: 'record' },
  // B-W2a-34: the planning board.
  'GET /planning/schedule': { audiences: ['office'], permission: 'planning.view', scope: 'record' },
  'GET /planning/schedule/work-orders/:workOrderId': { audiences: ['office'], permission: 'planning.view', scope: 'record' },
  'POST /planning/schedule/slots': { audiences: ['office'], permission: 'planning.schedule.manage', scope: 'record' },
  'PATCH /planning/schedule/slots/:slotId': { audiences: ['office'], permission: 'planning.schedule.manage', scope: 'record' },
  'POST /planning/schedule/slots/:slotId/remove': { audiences: ['office'], permission: 'planning.schedule.manage', scope: 'record' },
  'POST /planning/schedule/place-by-due-date': { audiences: ['office'], permission: 'planning.view', scope: 'record' },
  'GET /planning/schedule/publish': { audiences: ['office'], permission: 'planning.view', scope: 'record' },
  'POST /planning/schedule/publish': { audiences: ['office'], permission: 'planning.schedule.publish', scope: 'record' },
  'GET /planning/schedule/versions': { audiences: ['office'], permission: 'planning.view', scope: 'record' },
  'GET /planning/schedule/versions/:versionId': { audiences: ['office'], permission: 'planning.view', scope: 'record' },
  'GET /planning/allocation': { audiences: ['office'], permission: 'planning.view', scope: 'record' },
  'PUT /planning/allocation/work-orders/:workOrderId': { audiences: ['office'], permission: 'planning.schedule.manage', scope: 'record' },
})
