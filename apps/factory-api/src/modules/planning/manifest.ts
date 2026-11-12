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
  // B-W2b-20: one command for many rows of one site.
  'POST /planning/item-parameters/bulk': { audiences: ['office'], permission: 'planning.items.manage', scope: 'record' },
  'GET /planning/item-parameters/:itemPlanningId': { audiences: ['office'], permission: 'planning.view', scope: 'record' },
  'PATCH /planning/item-parameters/:itemPlanningId': { audiences: ['office'], permission: 'planning.items.manage', scope: 'record' },
  'POST /planning/item-parameters/:itemPlanningId/delete': { audiences: ['office'], permission: 'planning.items.manage', scope: 'record' },
  'GET /planning/reorder-rules': { audiences: ['office'], permission: 'planning.view', scope: 'record' },
  'GET /planning/lanes': { audiences: ['office'], permission: 'planning.view', scope: 'record' },
  'PATCH /planning/lanes': { audiences: ['office'], permission: 'planning.settings.manage', scope: 'record' },
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
  // B-W2b-312: scheduling in depth (./schedule-depth): pins with planning.schedule.pin; the material check read with
  // planning.view; forward scheduling and the backlog reschedule previewed with planning.view (the handler asks
  // planning.schedule.manage when it applies); a what-if is its planner's own (read with planning.view, the owner only;
  // made, tried, applied and discarded with planning.schedule.manage).
  'POST /planning/schedule/slots/:slotId/pin': { audiences: ['office'], permission: 'planning.schedule.pin', scope: 'record' },
  'POST /planning/schedule/work-orders/:workOrderId/pin': { audiences: ['office'], permission: 'planning.schedule.pin', scope: 'record' },
  'GET /planning/schedule/work-orders/:workOrderId/material': { audiences: ['office'], permission: 'planning.view', scope: 'record' },
  'POST /planning/schedule/forward': { audiences: ['office'], permission: 'planning.view', scope: 'record' },
  'POST /planning/schedule/reschedule-backlog': { audiences: ['office'], permission: 'planning.view', scope: 'record' },
  'POST /planning/schedule/what-ifs': { audiences: ['office'], permission: 'planning.schedule.manage', scope: 'record' },
  'GET /planning/schedule/what-ifs': { audiences: ['office'], permission: 'planning.view', scope: 'record' },
  'GET /planning/schedule/what-ifs/:scenarioId': { audiences: ['office'], permission: 'planning.view', scope: 'record' },
  'PUT /planning/schedule/what-ifs/:scenarioId/moves': { audiences: ['office'], permission: 'planning.schedule.manage', scope: 'record' },
  'POST /planning/schedule/what-ifs/:scenarioId/apply': { audiences: ['office'], permission: 'planning.schedule.manage', scope: 'record' },
  'POST /planning/schedule/what-ifs/:scenarioId/discard': { audiences: ['office'], permission: 'planning.schedule.manage', scope: 'record' },
  // B-W2b-132: the leather and cut plan (./leather): read with planning.view; a style's cutting loss changed or its proposal
  // dismissed with planning.leather.manage at the site whose cuts it rests on.
  'GET /planning/leather/need': { audiences: ['office'], permission: 'planning.view', scope: 'record' },
  'GET /planning/leather/protectors': { audiences: ['office'], permission: 'planning.view', scope: 'record' },
  'GET /planning/leather/yield': { audiences: ['office'], permission: 'planning.view', scope: 'record' },
  'POST /planning/leather/styles/:styleId/loss/accept': { audiences: ['office'], permission: 'planning.leather.manage', scope: 'record' },
  'POST /planning/leather/styles/:styleId/loss/dismiss': { audiences: ['office'], permission: 'planning.leather.manage', scope: 'record' },
  // B-W2b-263: Time & action (./milestones): read with planning.view over the order's company and customer; gates kept with
  // planning.milestones.manage; "Start before the gate" with planning.milestones.override (someone other than its planner).
  'GET /planning/milestones': { audiences: ['office'], permission: 'planning.view', scope: 'record' },
  'GET /planning/milestones/orders/:salesOrderId/choices': { audiences: ['office'], permission: 'planning.view', scope: 'record' },
  'POST /planning/milestones/gates': { audiences: ['office'], permission: 'planning.milestones.manage', scope: 'record' },
  'POST /planning/milestones/gates/pass': { audiences: ['office'], permission: 'planning.milestones.manage', scope: 'record' },
  'PATCH /planning/milestones/gates/:gateId': { audiences: ['office'], permission: 'planning.milestones.manage', scope: 'record' },
  'POST /planning/milestones/gates/:gateId/remove': { audiences: ['office'], permission: 'planning.milestones.manage', scope: 'record' },
  'POST /planning/milestones/gates/:gateId/start-before': { audiences: ['office'], permission: 'planning.milestones.override', scope: 'record' },
  // B-W2b-293: planned work and subcontract orders (./planned-orders): read with planning.view; made firm with planning.firm;
  // made real with planning.planned.convert (and what the work order and subcontract order ask themselves).
  'GET /planning/planned-orders': { audiences: ['office'], permission: 'planning.view', scope: 'record' },
  'POST /planning/planned-orders/convert': { audiences: ['office'], permission: 'planning.planned.convert', scope: 'record' },
  'GET /planning/planned-orders/:plannedOrderId': { audiences: ['office'], permission: 'planning.view', scope: 'record' },
  'POST /planning/planned-orders/:plannedOrderId/firm': { audiences: ['office'], permission: 'planning.firm', scope: 'record' },
  'POST /planning/planned-orders/:plannedOrderId/unfirm': { audiences: ['office'], permission: 'planning.firm', scope: 'record' },
  // B-W2b-301: promise dates (./promise): read with planning.promise.view over the site (a quote also with quotes.view, an
  // order line with orders.view over its order); an order line's promise per size recorded with planning.promise.manage. The
  // calculator is a POST that writes nothing.
  'GET /planning/promise/atp': { audiences: ['office'], permission: 'planning.promise.view', scope: 'record' },
  'GET /planning/promise/atp/styles': { audiences: ['office'], permission: 'planning.promise.view', scope: 'record' },
  'POST /planning/promise/calculate': { audiences: ['office'], permission: 'planning.promise.view', scope: 'record' },
  'GET /planning/promise/quotes/:quoteId': { audiences: ['office'], permission: 'planning.promise.view', scope: 'record' },
  'GET /planning/promise/order-lines/:orderLineId': { audiences: ['office'], permission: 'planning.promise.view', scope: 'record' },
  'POST /planning/promise/order-lines/:orderLineId': { audiences: ['office'], permission: 'planning.promise.manage', scope: 'record' },
  // B-W2b-319: one demand view (./demand), read with planning.view over the site (each source over its customer too); the production
  // strategy per item (./strategy), read with planning.view, kept with planning.strategy.manage over the site.
  'GET /planning/demand': { audiences: ['office'], permission: 'planning.view', scope: 'record' },
  'GET /planning/demand/rows': { audiences: ['office'], permission: 'planning.view', scope: 'record' },
  'GET /planning/strategy': { audiences: ['office'], permission: 'planning.view', scope: 'record' },
  'PUT /planning/strategy/items/:itemId': { audiences: ['office'], permission: 'planning.strategy.manage', scope: 'record' },
  'POST /planning/strategy/bulk': { audiences: ['office'], permission: 'planning.strategy.manage', scope: 'record' },
  // B-W2b-317: keeping promises (./promise-keep): the promise list, a line's history and the re-promise draft read with
  // planning.promise.view over the site (each line also orders.view over its order); a re-promise proposed with
  // planning.promise.manage, accepted or declined by sales with orders.manage over the order (email.send to tell the
  // customer), withdrawn by the planner who proposed it. The backlog (./backlog): read with planning.view over the company,
  // ranked with planning.backlog.manage (rank-by-rule previews with planning.view). Supply too late
  // (./exceptions/supply-late.ts): read with planning.view over the site, checked now with planning.exceptions.manage.
  'GET /planning/promises': { audiences: ['office'], permission: 'planning.promise.view', scope: 'record' },
  'GET /planning/promises/order-lines/:orderLineId/history': { audiences: ['office'], permission: 'planning.promise.view', scope: 'record' },
  'GET /planning/promises/order-lines/:orderLineId/re-promise': { audiences: ['office'], permission: 'planning.promise.view', scope: 'record' },
  'POST /planning/promises/order-lines/:orderLineId/re-promise': { audiences: ['office'], permission: 'planning.promise.manage', scope: 'record' },
  'GET /planning/promises/re-promises': { audiences: ['office'], permission: 'planning.promise.view', scope: 'record' },
  'GET /planning/promises/re-promises/:proposalId': { audiences: ['office'], permission: 'planning.promise.view', scope: 'record' },
  'POST /planning/promises/re-promises/:proposalId/accept': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'POST /planning/promises/re-promises/:proposalId/decline': { audiences: ['office'], permission: 'orders.manage', scope: 'record' },
  'POST /planning/promises/re-promises/:proposalId/withdraw': { audiences: ['office'], permission: 'planning.promise.manage', scope: 'record' },
  'GET /planning/backlog': { audiences: ['office'], permission: 'planning.view', scope: 'record' },
  'PUT /planning/backlog/ranks': { audiences: ['office'], permission: 'planning.backlog.manage', scope: 'record' },
  'POST /planning/backlog/rank-by-rule': { audiences: ['office'], permission: 'planning.view', scope: 'record' },
  'GET /planning/exceptions/supply-late': { audiences: ['office'], permission: 'planning.view', scope: 'record' },
  'POST /planning/exceptions/supply-late/check': { audiences: ['office'], permission: 'planning.exceptions.manage', scope: 'record' },
  'GET /planning/exceptions/:exceptionId/fixes': { audiences: ['office'], permission: 'planning.view', scope: 'record' },
})
