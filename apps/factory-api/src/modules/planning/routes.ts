import { idempotencyKeyFrom } from '../../core/command'
import { defineRoutes } from '../../core/manifest'
import { explainContract, latestPlanContract, listRunsContract, reopenContract, runPlanContract, runPlanViewContract, setAsideContract, unusableStockContract } from './contract'
import { manifest } from './manifest'
import { explainLine, latestPlan, listRuns, planOfRun, reopen, setAside, unusableStock } from './requirements'
import { runPlan } from './run'
// B-W2a-16: planning settings and capacity (./settings, ./capacity).
import { capacity, capacityCell } from './capacity/capacity'
import { capacityCellContract, capacityContract } from './capacity/contract'
import {
  createItemParametersContract,
  deleteItemParametersContract,
  editItemParametersContract,
  editLineCapacityContract,
  editSettingsContract,
  editWorkCentreCapacityContract,
  getItemParametersContract,
  getSettingsContract,
  lanesContract,
  listItemParametersContract,
  listSettingsContract,
  reorderRulesContract,
} from './settings/contract'
import { createItemParameters, deleteItemParameters, editItemParameters, getItemParameters, listItemParameters, reorderRules } from './settings/items'
import { editLineCapacity, editWorkCentreCapacity, listLanes } from './settings/lanes'
import { editSettings, getSettings, listSettings } from './settings/settings'
// B-W2a-22: MRP every day (firm planned orders, pegging, readiness, the shortage list, the exception list).
import { firmContract, unfirmContract } from './contract'
import { firmLine, unfirmLine } from './firm'
import { peggingContract, pegging } from './pegging/pegging'
import { readinessContract, shortagesContract, workOrderReadinessContract } from './readiness/contract'
import { readiness, shortages, workOrderReadiness } from './readiness/readiness'
import { acknowledgeExceptionsContract, getExceptionContract, listExceptionsContract, resolveExceptionContract, snoozeExceptionContract } from './exceptions/contract'
import { acknowledgeExceptions, getException, listExceptions, resolveException, snoozeException } from './exceptions/exceptions'
// B-W2b-20: bulk writes of item parameters and lanes.
import { bulkItemParameters, bulkLanes } from './settings/bulk'
import { bulkItemParametersContract, bulkLanesContract } from './settings/contract'
// B-W2a-34: the planning board (backward scheduling, the working plan, publish to the floor, allocation).
import { allocate, allocationBoard } from './schedule/allocation'
import { board, workOrderSchedule } from './schedule/board'
import { allocateContract, allocationContract, boardContract, moveSlotContract, placeByDueDateContract, placeSlotContract, publishContract, publishPreviewContract, removeSlotContract, versionContract, versionsContract, workOrderScheduleContract } from './schedule/contract'
import { getVersion, listVersions, publish, publishPreview } from './schedule/publish'
import { moveSlot, placeByDueDate, placeSlot, removeSlot } from './schedule/slots'
// B-W2b-312: scheduling in depth (pins, material, forward scheduling, the backlog reschedule, what-if).
import { applyWhatIfContract, backlogContract, createWhatIfContract, discardWhatIfContract, forwardContract, getWhatIfContract, listWhatIfsContract, materialContract, pinSlotContract, pinWorkOrderContract, setWhatIfMovesContract } from './schedule-depth/contract'
import { workOrderMaterial } from './schedule-depth/material'
import { pinSlot, pinWorkOrder } from './schedule-depth/pins'
import { rescheduleBacklog, scheduleForward } from './schedule-depth/reschedule'
import { applyWhatIf, createWhatIf, discardWhatIf, getWhatIf, listWhatIfs, setWhatIfMoves } from './schedule-depth/whatif'
// B-W2b-329: the board's record (the change log with undo, day sheets per line, a published version read-only).
import { changesContract, daySheetsContract, daySheetsPaperContract, undoContract, versionBoardContract } from './schedule-log/contract'
import { daySheetsPaper, daySheetsPdf } from './schedule-log/day-sheets'
import { changes } from './schedule-log/feed'
import { undoChange } from './schedule-log/undo'
import { versionBoard } from './schedule-log/version-board'
import { inlineDisposition } from '../production/work-orders/traveller'
// B-W2b-132: the leather and cut plan (need per order with one shade's answer, certified protectors, yield and the cutting loss).
import { acceptLossContract, dismissLossContract, needContract, protectorsContract, yieldContract } from './leather/contract'
import { acceptLoss, dismissLoss } from './leather/loss'
import { certifiedProtectors, leatherNeed } from './leather/need'
import { leatherYield } from './leather/yield'
// B-W2b-263: Time & action (the gates of a sales order, its milestones, start before the gate).
import { addGateContract, choicesContract, editGateContract, milestonesContract, passGatesContract, removeGateContract, startBeforeContract } from './milestones/contract'
import { addGate, editGate, gateChoices, passGates, removeGate, startBefore } from './milestones/gates'
import { readMilestones } from './milestones/milestones'
// B-W2b-293: planned work and subcontract orders (the run proposes them; firm; made real in bulk with a preview).
import { convertPlannedOrdersContract, firmPlannedOrderContract, getPlannedOrderContract, listPlannedOrdersContract } from './planned-orders/contract'
import { convertPlannedOrders } from './planned-orders/convert'
import { firmPlannedOrder, unfirmPlannedOrder } from './planned-orders/firm'
import { getPlannedOrder, listPlannedOrders } from './planned-orders/read'
// B-W2b-301: promise dates (available to promise, the promise calculator, a quote's suggested dates, an order line's promise per size).
import { atpContract, atpStylesContract, calculateContract, orderLineContract, quoteContract, recordContract } from './promise/contract'
import { orderLinePromise, recordPromise } from './promise/order-lines'
import { availableToPromise, calculatePromise, quoteSuggestion, stockStyles } from './promise/read'
// B-W2b-319: one demand view and the production strategy per item.
import { demandContract, demandRowsContract } from './demand/contract'
import { readDemand, readDemandRows } from './demand/demand'
import { bulkStrategyContract, listStrategyContract, setStrategyContract } from './strategy/contract'
import { bulkStrategy, listStrategy, setStrategy } from './strategy/strategy'
// B-W2b-321: work to subcontractors (weekly capacity, only approved workshops, kit timing, in-house or outside, the heatmap).
import { subcontractorCapacity, subcontractorCell } from './capacity/subcontractors'
import { heatmapContract } from './heatmap/contract'
import { heatmap } from './heatmap/heatmap'
import {
  allocationWorkshopsContract,
  createCapacityContract,
  deleteCapacityContract,
  editCapacityContract,
  fromAllocationContract,
  inHouseContract,
  kitTimingContract,
  listCapacityContract,
  outsideContract,
  setKitDueContract,
  subcontractorCapacityContract,
  subcontractorCellContract,
  workOrderWorkshopsContract,
} from './subcontract-capacity/contract'
import { kitTiming, setKitDue } from './subcontract-capacity/kit-timing'
import { bringInHouse, createFromAllocation, sendOutside } from './subcontract-capacity/outside'
import { createCapacity, deleteCapacity, editCapacity, listCapacity } from './subcontract-capacity/rows'
import { allocationWorkshops, workOrderWorkshops } from './subcontract-capacity/workshops'
// B-W2b-306: MRP you can trust (action messages, protected edits and bulk edit of planned orders, order-specific supply, the run log).
import { bulkEditPlannedOrdersContract, decideActionMessagesContract, editPlannedOrderContract, listActionMessagesContract, pegRequirementContract, resetPlannedOrderContract } from './actions/contract'
import { bulkEditPlannedOrders, editPlannedOrder, resetPlannedOrder } from './actions/edit'
import { decideActionMessages, listActionMessages } from './actions/messages'
import { pegRequirement } from './actions/peg'
import { runLogContract } from './run-log/contract'
import { runLog } from './run-log/log'

/**
 * What to buy and make (B-W1-29; PLN-062 to PLN-066; A2 SCR-055, design 02): run the plan for a site, read the latest
 * plan (or one run) with its tiles and lines, explain a line, set lines aside and open them again, and list the stock
 * the plan may not use. Turning a line into a purchase order line is purchasing's (B-W1-30), through ./hooks.
 *
 * B-W2a-16 (PLN-003, PLN-005, PLN-014, PLN-099, PLN-115, PLN-116; design planning.settings and planning.capacity): a
 * site's planning settings (horizon, buckets, default efficiency, nightly run time), its item parameters and reorder
 * rules, its lanes' planned efficiency and people, and Capacity & load (available against booked standard minutes per
 * lane and bucket, and the orders behind a cell). The route folder has its own routes file, so the parts' routes are
 * listed here (as purchasing lists ./confirm's).
 *
 * B-W2a-22 (PLN-071, PLN-075, PLN-085, PLN-086, PLN-193; design planning.mrp "Short on open work orders" and the Why
 * drawer's pegging, planning.exceptions, warehouse.picking's readiness word): firm a line of the latest plan (or make it
 * planned again), the pegging of a requirement, order line, work order, purchase order line or reservation, the
 * readiness of the site's work orders and the shortage list with its fixes (computed now), and the exception list of
 * the runs (acknowledge, snooze, resolve).
 *
 * B-W2a-34 (PLN-129, PLN-131, PLN-132, PLN-147, PLN-160; design planning.board, planning.allocation; Owner answer P3): the
 * planning board (lanes with their load, the working plan's slots, the order view with each work order's latest safe
 * start and why it is late or at risk, the tray, the problems), moves into the site's shared working plan (place, move,
 * remove, place by due date), publishing it to the floor as a numbered version, the published versions, and the
 * allocation of work orders to lines and workshops.
 *
 * B-W2b-20 (W2a follow-ups): bulk writes of a site's item parameters (POST /planning/item-parameters/bulk) and lanes
 * (PATCH /planning/lanes), each ONE command; the other follow-ups are fields of the routes above (stable refusal codes,
 * per-component readiness, customer and family, lanes without a calendar, exceptions' age in working days).
 *
 * B-W2b-306 (PLN-072, PLN-073, PLN-076, PLN-078, PLN-083, PLN-095; design planning.mrp "To make", the protected cell, the
 * run log): a run's log (./run-log), its action messages on existing orders and their decisions, a planned order's edit
 * protected from the next run, Reset to plan and the bulk edit with one review, and a requirement kept for one order line
 * (./actions).
 *
 * B-W2b-319 (PLN-017, PLN-040, PLN-041, PLN-042, PLN-061; design planning.demand, planning.mps sec:strategy): one demand view
 * (./demand: the tiles and the time-phased rows, and the same demand as a list with its source) and the production strategy per
 * item (./strategy: the list, one item's autosave, a bulk change in one command).
 */
export default defineRoutes('planning', manifest, async (app) => {
  app.post('/planning/runs', { schema: runPlanContract }, async (request, reply) => reply.code(201).send(await runPlan(request, request.body, idempotencyKeyFrom(request))))
  app.get('/planning/runs', { schema: listRunsContract }, async (request) => listRuns(request, request.query))
  app.get('/planning/runs/latest', { schema: latestPlanContract }, async (request) => latestPlan(request, request.query))
  app.get('/planning/runs/:runId', { schema: runPlanViewContract }, async (request) => planOfRun(request, request.params.runId, request.query))
  app.get('/planning/requirements/:requirementId', { schema: explainContract }, async (request) => explainLine(request, request.params.requirementId))
  app.post('/planning/requirements/set-aside', { schema: setAsideContract }, async (request) => setAside(request, request.body, idempotencyKeyFrom(request)))
  app.post('/planning/requirements/reopen', { schema: reopenContract }, async (request) => reopen(request, request.body, idempotencyKeyFrom(request)))
  app.get('/planning/unusable-stock', { schema: unusableStockContract }, async (request) => unusableStock(request, request.query))

  // ---- B-W2a-16: planning settings and capacity --------------------------------------------------------------------
  app.get('/planning/settings', { schema: listSettingsContract }, async (request) => listSettings(request, request.query))
  app.get('/planning/settings/:siteId', { schema: getSettingsContract }, async (request) => getSettings(request, request.params.siteId))
  app.patch('/planning/settings/:siteId', { schema: editSettingsContract }, async (request) => editSettings(request, request.params.siteId, request.body, idempotencyKeyFrom(request)))
  app.get('/planning/item-parameters', { schema: listItemParametersContract }, async (request) => listItemParameters(request, request.query))
  app.post('/planning/item-parameters', { schema: createItemParametersContract }, async (request, reply) => reply.code(201).send(await createItemParameters(request, request.body, idempotencyKeyFrom(request))))
  // B-W2b-20: before /:itemPlanningId (a static path).
  app.post('/planning/item-parameters/bulk', { schema: bulkItemParametersContract }, async (request) => bulkItemParameters(request, request.body, idempotencyKeyFrom(request)))
  app.get('/planning/item-parameters/:itemPlanningId', { schema: getItemParametersContract }, async (request) => getItemParameters(request, request.params.itemPlanningId))
  app.patch('/planning/item-parameters/:itemPlanningId', { schema: editItemParametersContract }, async (request) => editItemParameters(request, request.params.itemPlanningId, request.body, idempotencyKeyFrom(request)))
  app.post('/planning/item-parameters/:itemPlanningId/delete', { schema: deleteItemParametersContract }, async (request) => deleteItemParameters(request, request.params.itemPlanningId, request.body, idempotencyKeyFrom(request)))
  app.get('/planning/reorder-rules', { schema: reorderRulesContract }, async (request) => reorderRules(request, request.query.siteId))
  app.get('/planning/lanes', { schema: lanesContract }, async (request) => listLanes(request, request.query.siteId))
  app.patch('/planning/lanes', { schema: bulkLanesContract }, async (request) => bulkLanes(request, request.body, idempotencyKeyFrom(request)))
  app.patch('/planning/lines/:lineId/capacity', { schema: editLineCapacityContract }, async (request) => editLineCapacity(request, request.params.lineId, request.body, idempotencyKeyFrom(request)))
  app.patch('/planning/work-centres/:workCentreId/capacity', { schema: editWorkCentreCapacityContract }, async (request) => editWorkCentreCapacity(request, request.params.workCentreId, request.body, idempotencyKeyFrom(request)))
  app.get('/planning/capacity', { schema: capacityContract }, async (request) => capacity(request, request.query))
  app.get('/planning/capacity/cell', { schema: capacityCellContract }, async (request) => capacityCell(request, request.query))

  // ---- B-W2a-22: MRP every day -------------------------------------------------------------------------------------
  app.post('/planning/requirements/:requirementId/firm', { schema: firmContract }, async (request) => firmLine(request, request.params.requirementId, request.body, idempotencyKeyFrom(request)))
  app.post('/planning/requirements/:requirementId/unfirm', { schema: unfirmContract }, async (request) => unfirmLine(request, request.params.requirementId, request.body, idempotencyKeyFrom(request)))
  app.get('/planning/pegging', { schema: peggingContract }, async (request) => pegging(request, request.query))
  app.get('/planning/readiness', { schema: readinessContract }, async (request) => readiness(request, request.query))
  app.get('/planning/work-orders/:workOrderId/readiness', { schema: workOrderReadinessContract }, async (request) => workOrderReadiness(request, request.params.workOrderId))
  app.get('/planning/shortages', { schema: shortagesContract }, async (request) => shortages(request, request.query))
  app.get('/planning/exceptions', { schema: listExceptionsContract }, async (request) => listExceptions(request, request.query))
  app.post('/planning/exceptions/acknowledge', { schema: acknowledgeExceptionsContract }, async (request) => acknowledgeExceptions(request, request.body, idempotencyKeyFrom(request)))
  app.get('/planning/exceptions/:exceptionId', { schema: getExceptionContract }, async (request) => getException(request, request.params.exceptionId))
  app.post('/planning/exceptions/:exceptionId/snooze', { schema: snoozeExceptionContract }, async (request) => snoozeException(request, request.params.exceptionId, request.body, idempotencyKeyFrom(request)))
  app.post('/planning/exceptions/:exceptionId/resolve', { schema: resolveExceptionContract }, async (request) => resolveException(request, request.params.exceptionId, request.body, idempotencyKeyFrom(request)))

  // ---- B-W2a-34: the planning board --------------------------------------------------------------------------------
  app.get('/planning/schedule', { schema: boardContract }, async (request) => board(request, request.query))
  app.get('/planning/schedule/work-orders/:workOrderId', { schema: workOrderScheduleContract }, async (request) => workOrderSchedule(request, request.params.workOrderId))
  app.post('/planning/schedule/slots', { schema: placeSlotContract }, async (request, reply) => reply.code(201).send(await placeSlot(request, request.body, idempotencyKeyFrom(request))))
  app.patch('/planning/schedule/slots/:slotId', { schema: moveSlotContract }, async (request) => moveSlot(request, request.params.slotId, request.body, idempotencyKeyFrom(request)))
  app.post('/planning/schedule/slots/:slotId/remove', { schema: removeSlotContract }, async (request) => removeSlot(request, request.params.slotId, request.body, idempotencyKeyFrom(request)))
  app.post('/planning/schedule/place-by-due-date', { schema: placeByDueDateContract }, async (request) => placeByDueDate(request, request.body, idempotencyKeyFrom(request)))
  app.get('/planning/schedule/publish', { schema: publishPreviewContract }, async (request) => publishPreview(request, request.query))
  app.post('/planning/schedule/publish', { schema: publishContract }, async (request, reply) => reply.code(201).send(await publish(request, request.body, idempotencyKeyFrom(request))))
  app.get('/planning/schedule/versions', { schema: versionsContract }, async (request) => listVersions(request, request.query))
  app.get('/planning/schedule/versions/:versionId', { schema: versionContract }, async (request) => getVersion(request, request.params.versionId))
  app.get('/planning/allocation', { schema: allocationContract }, async (request) => allocationBoard(request, request.query))
  app.put('/planning/allocation/work-orders/:workOrderId', { schema: allocateContract }, async (request) => allocate(request, request.params.workOrderId, request.body, idempotencyKeyFrom(request)))
  // B-W2b-312: scheduling in depth.
  app.post('/planning/schedule/slots/:slotId/pin', { schema: pinSlotContract }, async (request) => pinSlot(request, request.params.slotId, request.body, idempotencyKeyFrom(request)))
  app.post('/planning/schedule/work-orders/:workOrderId/pin', { schema: pinWorkOrderContract }, async (request) => pinWorkOrder(request, request.params.workOrderId, request.body, idempotencyKeyFrom(request)))
  app.get('/planning/schedule/work-orders/:workOrderId/material', { schema: materialContract }, async (request) => workOrderMaterial(request, request.params.workOrderId, request.query))
  app.post('/planning/schedule/forward', { schema: forwardContract }, async (request) => scheduleForward(request, request.body, idempotencyKeyFrom(request)))
  app.post('/planning/schedule/reschedule-backlog', { schema: backlogContract }, async (request) => rescheduleBacklog(request, request.body, idempotencyKeyFrom(request)))
  app.post('/planning/schedule/what-ifs', { schema: createWhatIfContract }, async (request, reply) => reply.code(201).send(await createWhatIf(request, request.body, idempotencyKeyFrom(request))))
  app.get('/planning/schedule/what-ifs', { schema: listWhatIfsContract }, async (request) => listWhatIfs(request, request.query))
  app.get('/planning/schedule/what-ifs/:scenarioId', { schema: getWhatIfContract }, async (request) => getWhatIf(request, request.params.scenarioId))
  app.put('/planning/schedule/what-ifs/:scenarioId/moves', { schema: setWhatIfMovesContract }, async (request) => setWhatIfMoves(request, request.params.scenarioId, request.body, idempotencyKeyFrom(request)))
  app.post('/planning/schedule/what-ifs/:scenarioId/apply', { schema: applyWhatIfContract }, async (request) => applyWhatIf(request, request.params.scenarioId, request.body, idempotencyKeyFrom(request)))
  app.post('/planning/schedule/what-ifs/:scenarioId/discard', { schema: discardWhatIfContract }, async (request) => discardWhatIf(request, request.params.scenarioId, request.body, idempotencyKeyFrom(request)))
  // B-W2b-329: the board's record.
  app.get('/planning/schedule/changes', { schema: changesContract }, async (request) => changes(request, request.query))
  app.post('/planning/schedule/changes/:changeId/undo', { schema: undoContract }, async (request) => undoChange(request, request.params.changeId, request.body, idempotencyKeyFrom(request)))
  app.get('/planning/schedule/day-sheets/paper', { schema: daySheetsPaperContract }, async (request) => {
    const paper = await daySheetsPaper(request, request.query)
    return { ...paper, columns: [...paper.columns], sheets: paper.sheets.map((sheet) => ({ ...sheet, facts: [...sheet.facts], rows: sheet.rows.map((row) => ({ ...row, cells: [...row.cells] })) })) }
  })
  app.get('/planning/schedule/day-sheets', { schema: daySheetsContract }, async (request, reply) => {
    const { pdf, fileName } = await daySheetsPdf(request, request.query)
    return reply.type('application/pdf').header('content-disposition', inlineDisposition(fileName)).header('cache-control', 'no-store').send(pdf)
  })
  app.get('/planning/schedule/versions/:versionId/board', { schema: versionBoardContract }, async (request) => versionBoard(request, request.params.versionId))
  // B-W2b-132: the leather and cut plan.
  app.get('/planning/leather/need', { schema: needContract }, async (request) => leatherNeed(request, request.query))
  app.get('/planning/leather/protectors', { schema: protectorsContract }, async (request) => certifiedProtectors(request, request.query))
  app.get('/planning/leather/yield', { schema: yieldContract }, async (request) => leatherYield(request, request.query))
  app.post('/planning/leather/styles/:styleId/loss/accept', { schema: acceptLossContract }, async (request) => acceptLoss(request, request.params.styleId, request.body, idempotencyKeyFrom(request)))
  app.post('/planning/leather/styles/:styleId/loss/dismiss', { schema: dismissLossContract }, async (request) => dismissLoss(request, request.params.styleId, request.body, idempotencyKeyFrom(request)))
  // B-W2b-263: Time & action.
  app.get('/planning/milestones', { schema: milestonesContract }, async (request) => readMilestones(request, request.query))
  app.get('/planning/milestones/orders/:salesOrderId/choices', { schema: choicesContract }, async (request) => gateChoices(request, request.params.salesOrderId))
  app.post('/planning/milestones/gates', { schema: addGateContract }, async (request, reply) => reply.code(201).send(await addGate(request, request.body, idempotencyKeyFrom(request))))
  // Before /:gateId (a static path).
  app.post('/planning/milestones/gates/pass', { schema: passGatesContract }, async (request) => passGates(request, request.body, idempotencyKeyFrom(request)))
  app.patch('/planning/milestones/gates/:gateId', { schema: editGateContract }, async (request) => editGate(request, request.params.gateId, request.body, idempotencyKeyFrom(request)))
  app.post('/planning/milestones/gates/:gateId/remove', { schema: removeGateContract }, async (request) => removeGate(request, request.params.gateId, request.body, idempotencyKeyFrom(request)))
  app.post('/planning/milestones/gates/:gateId/start-before', { schema: startBeforeContract }, async (request) => startBefore(request, request.params.gateId, request.body, idempotencyKeyFrom(request)))
  // B-W2b-293: planned work and subcontract orders.
  app.get('/planning/planned-orders', { schema: listPlannedOrdersContract }, async (request) => listPlannedOrders(request, request.query))
  // Before /:plannedOrderId (a static path).
  app.post('/planning/planned-orders/convert', { schema: convertPlannedOrdersContract }, async (request) => convertPlannedOrders(request, request.body, idempotencyKeyFrom(request)))
  app.get('/planning/planned-orders/:plannedOrderId', { schema: getPlannedOrderContract }, async (request) => getPlannedOrder(request, request.params.plannedOrderId))
  app.post('/planning/planned-orders/:plannedOrderId/firm', { schema: firmPlannedOrderContract }, async (request) => firmPlannedOrder(request, request.params.plannedOrderId, request.body, idempotencyKeyFrom(request)))
  app.post('/planning/planned-orders/:plannedOrderId/unfirm', { schema: firmPlannedOrderContract }, async (request) => unfirmPlannedOrder(request, request.params.plannedOrderId, request.body, idempotencyKeyFrom(request)))
  // B-W2b-301: promise dates.
  app.get('/planning/promise/atp', { schema: atpContract }, async (request) => availableToPromise(request, request.query))
  app.get('/planning/promise/atp/styles', { schema: atpStylesContract }, async (request) => stockStyles(request, request.query))
  app.post('/planning/promise/calculate', { schema: calculateContract }, async (request) => calculatePromise(request, request.body))
  app.get('/planning/promise/quotes/:quoteId', { schema: quoteContract }, async (request) => quoteSuggestion(request, request.params.quoteId, request.query))
  app.get('/planning/promise/order-lines/:orderLineId', { schema: orderLineContract }, async (request) => orderLinePromise(request, request.params.orderLineId))
  app.post('/planning/promise/order-lines/:orderLineId', { schema: recordContract }, async (request) => recordPromise(request, request.params.orderLineId, request.body, idempotencyKeyFrom(request)))
  // B-W2b-319: one demand view (orders, quotes likely to win, made-to-measure units, samples, remakes by week) and the
  // production strategy per item.
  app.get('/planning/demand', { schema: demandContract }, async (request) => readDemand(request, request.query))
  app.get('/planning/demand/rows', { schema: demandRowsContract }, async (request) => readDemandRows(request, request.query))
  app.get('/planning/strategy', { schema: listStrategyContract }, async (request) => listStrategy(request, request.query))
  app.put('/planning/strategy/items/:itemId', { schema: setStrategyContract }, async (request) => setStrategy(request, request.params.itemId, request.body, idempotencyKeyFrom(request)))
  app.post('/planning/strategy/bulk', { schema: bulkStrategyContract }, async (request) => bulkStrategy(request, request.body, idempotencyKeyFrom(request)))
  // B-W2b-321: work to subcontractors.
  app.get('/planning/subcontract-capacity', { schema: listCapacityContract }, async (request) => listCapacity(request, request.query))
  app.post('/planning/subcontract-capacity', { schema: createCapacityContract }, async (request, reply) => reply.code(201).send(await createCapacity(request, request.body, idempotencyKeyFrom(request))))
  app.patch('/planning/subcontract-capacity/:capacityId', { schema: editCapacityContract }, async (request) => editCapacity(request, request.params.capacityId, request.body, idempotencyKeyFrom(request)))
  app.delete('/planning/subcontract-capacity/:capacityId', { schema: deleteCapacityContract }, async (request) => deleteCapacity(request, request.params.capacityId, request.query.version, idempotencyKeyFrom(request)))
  app.get('/planning/capacity/subcontractors', { schema: subcontractorCapacityContract }, async (request) => subcontractorCapacity(request, request.query))
  app.get('/planning/capacity/subcontractors/cell', { schema: subcontractorCellContract }, async (request) => subcontractorCell(request, request.query))
  app.get('/planning/heatmap', { schema: heatmapContract }, async (request) => heatmap(request, request.query))
  app.get('/planning/allocation/workshops', { schema: allocationWorkshopsContract }, async (request) => allocationWorkshops(request, request.query))
  app.post('/planning/allocation/subcontract-orders', { schema: fromAllocationContract }, async (request) => createFromAllocation(request, request.body, idempotencyKeyFrom(request)))
  app.get('/planning/work-orders/:workOrderId/workshops', { schema: workOrderWorkshopsContract }, async (request) => workOrderWorkshops(request, request.params.workOrderId, request.query))
  app.get('/planning/work-orders/:workOrderId/kit-timing', { schema: kitTimingContract }, async (request) => kitTiming(request, request.params.workOrderId, request.query))
  app.post('/planning/work-orders/:workOrderId/operations/:operationId/outside', { schema: outsideContract }, async (request) => sendOutside(request, request.params.workOrderId, request.params.operationId, request.body, idempotencyKeyFrom(request)))
  app.post('/planning/work-orders/:workOrderId/operations/:operationId/in-house', { schema: inHouseContract }, async (request) => bringInHouse(request, request.params.workOrderId, request.params.operationId, request.body, idempotencyKeyFrom(request)))
  app.put('/planning/subcontract-orders/:subcontractOrderId/kit-due', { schema: setKitDueContract }, async (request) => setKitDue(request, request.params.subcontractOrderId, request.body, idempotencyKeyFrom(request)))
  // B-W2b-306: MRP you can trust. The run log of a run; the run's action messages (decided several at once); a planned order's
  // edit (its fields protected from the next run), Reset to plan and the bulk edit; a requirement kept for one order line.
  app.get('/planning/runs/:runId/log', { schema: runLogContract }, async (request) => runLog(request, request.params.runId))
  app.get('/planning/action-messages', { schema: listActionMessagesContract }, async (request) => listActionMessages(request, request.query))
  app.post('/planning/action-messages/decide', { schema: decideActionMessagesContract }, async (request) => decideActionMessages(request, request.body, idempotencyKeyFrom(request)))
  // Before /:plannedOrderId (a static path).
  app.post('/planning/planned-orders/bulk', { schema: bulkEditPlannedOrdersContract }, async (request) => bulkEditPlannedOrders(request, request.body, idempotencyKeyFrom(request)))
  app.patch('/planning/planned-orders/:plannedOrderId', { schema: editPlannedOrderContract }, async (request) => editPlannedOrder(request, request.params.plannedOrderId, request.body, idempotencyKeyFrom(request)))
  app.post('/planning/planned-orders/:plannedOrderId/reset', { schema: resetPlannedOrderContract }, async (request) => resetPlannedOrder(request, request.params.plannedOrderId, request.body, idempotencyKeyFrom(request)))
  app.post('/planning/requirements/:requirementId/order-specific', { schema: pegRequirementContract }, async (request) => pegRequirement(request, request.params.requirementId, request.body, idempotencyKeyFrom(request)))
})
