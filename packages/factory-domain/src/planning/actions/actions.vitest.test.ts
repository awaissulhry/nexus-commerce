import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { ROLE_TEMPLATES } from '../../auth/roles/templates'
import { EVENT_CATALOGUE } from '../../events/catalogue'
import type { BomLineData } from '../../product/bom/rules'
import { planRequirements, WARNING_CODES, type PlanInput, type PlanItem, type PlanOrderLine } from '../explode'
import { pegMaterial, type DemandPart } from '../mrp/net'
import { inputsSentence, protectedPlanOf, readRunInputs, RUN_LOG_VERSION, warningCounts, type RunInputs } from '../run-log/inputs'
import { plannedOrderReason, requirementReason } from '../run-log/reasons'
import { lateWarnings, plannedDateOf } from './late'
import { actionMessagesOf, decideProblem, DEFER_TOLERANCE_DAYS, ignoredBefore, type ActionMaterial } from './messages'
import { pegProblem, pegWords, plannedForAlone } from './pegs'
import { PLANNING_ACTIONS_MANAGE, PLANNING_ACTIONS_PERMISSIONS, PLANNING_PLANNED_EDIT } from './permissions'
import { applyChanges, changedFields, claimProposals, editProblems, lateOf, mergeWithPlan, overlapOf, planValuesOf, protectedAfter, protectedAfterReset, readPlanValues, shiftedBy, type EditFacts, type PlanFields } from './protect'

/**
 * MRP you can trust (B-W2b-306): order-specific supply in the netting (PLN-072), the action messages (PLN-073), a planner's
 * protected edits and the run's merge (PLN-076, PLN-078), nothing planned in the past (PLN-083), the run log (PLN-095).
 */

const part = (fields: Partial<DemandPart> & Pick<DemandPart, 'key' | 'quantity'>): DemandPart => ({
  orderId: 'so-1',
  orderNumber: 'SO-1',
  orderLineId: 'ol-1',
  lineSeq: 10,
  partyId: 'party-1',
  size: '52',
  workOrderId: null,
  workOrderNumber: null,
  pieces: 1,
  dueDate: '2026-12-01',
  issued: '0',
  ...fields,
})
const lot = (id: string) => ({ id, qualityStatus: 'RELEASED' as const, requiresCrViTest: false, crViStatus: 'NOT_REQUIRED' as const })
const RUN = '2026-11-12'
const material = (pegging: ActionMaterial['pegging'], fields: Partial<ActionMaterial> = {}): ActionMaterial => ({ requirementId: 'req-1', label: 'LEA BLK', uom: 'FT2', pegging, keptInStock: false, ...fields })
const purchase = (id: string, quantity: string, dueDate: string) => ({ purchaseOrderLineId: id, purchaseOrderNumber: `PO-${id}`, openQuantity: quantity, dueDate })

describe('order-specific supply (PLN-072)', () => {
  const bomLine = (fields: Partial<BomLineData> & Pick<BomLineData, 'id' | 'seq' | 'itemId' | 'qty' | 'uom'>): BomLineData => ({ placement: null, wastagePct: '0', sizeDependent: false, colourDependent: false, itemColourId: null, colourwayId: null, supplierId: null, note: null, sizes: [], colours: [], ...fields })
  const units = { baseUom: 'FT2', purchaseUom: 'FT2', purchaseFactor: '1', consumptionUom: 'FT2', consumptionFactor: '1' } as const
  const items: PlanItem[] = [{ id: 'leather', code: 'LEA', sourcing: 'BUY', units, defaultSupplierId: 'tannery' }]
  const revision = { id: 'rev-1', lines: [bomLine({ id: 'bl-10', seq: 10, itemId: 'leather', qty: '10', uom: 'FT2' })] }
  const line = (orderLineId: string, orderNumber: string, pieces: number): PlanOrderLine => ({ orderId: `so-${orderLineId}`, orderNumber, orderLineId, lineSeq: 10, styleId: 'style-1', colourwayId: 'cw', revisionId: 'rev-1', sizes: [{ size: '52', pieces }], dueDate: '2026-12-01', partyId: `party-${orderLineId}` })
  const input = (fields: Partial<PlanInput> = {}): PlanInput => ({
    runDate: RUN,
    orderLines: [line('ol-1', 'SO-1', 3), line('ol-2', 'SO-2', 2)],
    revisions: [revision],
    items,
    workOrderCells: [],
    workOrderIssues: [],
    stock: [{ itemId: 'leather', itemColourId: null, lotId: null, quantity: '25', hides: 0 }],
    lots: [],
    purchases: [{ itemId: 'leather', itemColourId: null, ...purchase('pl-1', '20', '2026-11-20') }],
    ...fields,
  })

  it('without a peg the netting is W2a’s: one line for every order', () => {
    const plan = planRequirements(input())
    expect(plan.requirements.map((row) => [row.grossQuantity, row.usableStock, row.onOrder, row.netQuantity, row.reservedFor ?? null])).toEqual([['50.0000', '25.0000', '20.0000', '5.0000', null]])
  })

  it('a pegged order line is a line of its own, never taking free stock nor the other orders’ purchase lines', () => {
    const plan = planRequirements(input({ orderSpecific: { pegs: [{ itemId: 'leather', itemColourId: null, orderLineId: 'ol-2' }], purchaseFor: new Map() } }))
    expect(plan.requirements.map((row) => [row.seq, row.grossQuantity, row.usableStock, row.onOrder, row.netQuantity, row.reservedFor?.orderLineId ?? null, row.sources.map((source) => source.orderLineId).join(',')])).toEqual([
      [1, '30.0000', '25.0000', '5.0000', '0.0000', null, 'ol-1'],
      [2, '20.0000', '0.0000', '0.0000', '20.0000', 'ol-2', 'ol-2'],
    ])
    expect(plan.requirements[1]!.reservedFor).toEqual({ orderLineId: 'ol-2', partyId: 'party-ol-2' })
  })

  it('a purchase line bought for the order line serves only it; with no need left it is free supply again', () => {
    const pegged = planRequirements(input({ orderSpecific: { pegs: [{ itemId: 'leather', itemColourId: null, orderLineId: 'ol-2' }], purchaseFor: new Map([['pl-1', 'ol-2']]) } }))
    expect(pegged.requirements.map((row) => [row.onOrder, row.netQuantity])).toEqual([
      ['0.0000', '5.0000'],
      ['20.0000', '0.0000'],
    ])
    const released = planRequirements(input({ orderLines: [line('ol-1', 'SO-1', 3)], orderSpecific: { pegs: [], purchaseFor: new Map([['pl-1', 'ol-2']]) } }))
    expect(released.requirements.map((row) => [row.onOrder, row.netQuantity])).toEqual([['5.0000', '0.0000']])
  })

  it('ownOnly: stock its reservations hold, never free stock; the identity holds', () => {
    const own = pegMaterial({ itemColourId: 'blk', parts: [part({ key: 'a', quantity: '40' })], stock: [{ itemColourId: 'blk', lotId: null, quantity: '100', hides: 0 }], lotOf: lot, runDate: RUN, purchases: [], reservations: [{ id: 'r1', itemId: 'leather', itemColourId: 'blk', lotId: null, hideId: null, open: '15', workOrderId: null, salesOrderLineId: 'ol-1', demandOpen: true }], ownOnly: true })
    expect([own.gross, own.usable, own.onOrder, own.net]).toEqual(['40.0000', '15.0000', '0.0000', '25.0000'])
  })

  it('who may be pegged, and what a purchase line bought for one order line is', () => {
    const line = { decision: 'OPEN', orderSpecific: false, reservedForLineId: null, sources: [{ orderLineId: 'ol-1', orderNumber: 'SO-1', lineSeq: 10 }, { orderLineId: 'ol-2', orderNumber: 'SO-2', lineSeq: 20 }] }
    expect(pegProblem(line, 'DONE', 'ol-2')).toBeNull()
    expect(pegProblem(line, 'SUPERSEDED', 'ol-2')).toContain('newer plan')
    expect(pegProblem({ ...line, decision: 'ORDERED' }, 'DONE', 'ol-2')).toContain('ordered')
    expect(pegProblem(line, 'DONE', 'ol-9')).toContain('does not need')
    expect(pegProblem(line, 'DONE', null)).toContain('every order already')
    expect(pegProblem({ ...line, orderSpecific: true, reservedForLineId: 'ol-2' }, 'DONE', 'ol-2')).toContain('already')
    expect(plannedForAlone({ orderSpecific: true, reservedForLineId: 'ol-2', sources: line.sources })).toBe(false)
    expect(plannedForAlone({ orderSpecific: true, reservedForLineId: 'ol-2', sources: [line.sources[1]!] })).toBe(true)
    expect(pegWords(line, 'ol-2')).toContain('SO-2 line 20')
    expect(pegWords(line, null)).toContain('every order')
  })
})

describe('action messages on existing orders (PLN-073)', () => {
  it('a purchase line too late is expedited to the need (never before today); one too early is deferred past the tolerance', () => {
    const late = pegMaterial({ itemColourId: 'blk', parts: [part({ key: 'a', quantity: '30', dueDate: '2026-11-20' })], stock: [], lotOf: lot, runDate: RUN, purchases: [purchase('pl-1', '30', '2026-11-28')] })
    const [expedite] = actionMessagesOf({ runDate: RUN, materials: [material(late)], purchaseOf: () => ({ purchaseOrderNumber: 'PO-0042', lineSeq: 10 }) })
    expect(expedite).toMatchObject({ recordType: 'PurchaseOrderLine', recordId: 'pl-1', action: 'EXPEDITE', fromDate: '2026-11-28', toDate: '2026-11-20', fromQuantity: null, uom: null })
    expect(expedite!.message).toContain('Expedite PO-0042 line 10 (LEA BLK) from 2026-11-28 to 2026-11-20')
    // The need is past: today at the earliest.
    const past = pegMaterial({ itemColourId: 'blk', parts: [part({ key: 'a', quantity: '30', dueDate: '2026-11-01' })], stock: [], lotOf: lot, runDate: RUN, purchases: [purchase('pl-1', '30', '2026-11-28')] })
    expect(actionMessagesOf({ runDate: RUN, materials: [material(past)], purchaseOf: () => undefined })[0]).toMatchObject({ action: 'EXPEDITE', toDate: RUN })
    const early = pegMaterial({ itemColourId: 'blk', parts: [part({ key: 'a', quantity: '30', dueDate: '2026-12-20' })], stock: [], lotOf: lot, runDate: RUN, purchases: [purchase('pl-1', '30', '2026-11-20')] })
    expect(actionMessagesOf({ runDate: RUN, materials: [material(early)], purchaseOf: () => undefined })).toEqual([expect.objectContaining({ action: 'DEFER', fromDate: '2026-11-20', toDate: '2026-12-20' })])
    const inTolerance = pegMaterial({ itemColourId: 'blk', parts: [part({ key: 'a', quantity: '30', dueDate: '2026-11-27' })], stock: [], lotOf: lot, runDate: RUN, purchases: [purchase('pl-1', '30', '2026-11-20')] })
    expect(DEFER_TOLERANCE_DAYS).toBe(7)
    expect(actionMessagesOf({ runDate: RUN, materials: [material(inTolerance)], purchaseOf: () => undefined })).toEqual([])
  })

  it('more than needed is a decrease, nothing needed a cancel; never for a material kept in stock', () => {
    const some = pegMaterial({ itemColourId: 'blk', parts: [part({ key: 'a', quantity: '12', dueDate: '2026-11-25' })], stock: [], lotOf: lot, runDate: RUN, purchases: [purchase('pl-1', '30', '2026-11-20')] })
    const none = pegMaterial({ itemColourId: 'blk', parts: [], stock: [], lotOf: lot, runDate: RUN, purchases: [purchase('pl-2', '30', '2026-11-20')] })
    const found = actionMessagesOf({ runDate: RUN, materials: [material(some), material(none, { requirementId: 'req-2' })], purchaseOf: () => undefined })
    expect(found.map((row) => [row.recordId, row.action, row.fromQuantity, row.toQuantity, row.uom])).toEqual([
      ['pl-2', 'CANCEL', '30.0000', null, 'FT2'],
      ['pl-1', 'DECREASE', '30.0000', '12.0000', 'FT2'],
    ])
    expect(actionMessagesOf({ runDate: RUN, materials: [material(none, { keptInStock: true })], purchaseOf: () => undefined })).toEqual([])
  })

  it('the firm planned order the line carries: expedite, increase; work orders, subcontract orders and protected planned orders', () => {
    const firm = pegMaterial({ itemColourId: 'blk', parts: [part({ key: 'a', quantity: '50', dueDate: '2026-11-20' })], stock: [], lotOf: lot, runDate: RUN, purchases: [], firm: { requirementId: 'old', baseQuantity: '30', date: '2026-11-25' } })
    const found = actionMessagesOf({
      runDate: RUN,
      materials: [material(firm, { requirementId: 'req-9' })],
      purchaseOf: () => undefined,
      workOrders: [
        { id: 'wo-1', number: 'WO-1', status: 'RELEASED', dueDate: '2026-12-10', neededBy: '2026-12-04', neededFor: 'SO-2', stillNeeded: true, started: false },
        { id: 'wo-2', number: 'WO-2', status: 'DRAFT', dueDate: null, neededBy: null, neededFor: null, stillNeeded: false, started: false },
        { id: 'wo-3', number: 'WO-3', status: 'IN_PROGRESS', dueDate: null, neededBy: null, neededFor: null, stillNeeded: false, started: true },
      ],
      subcontracts: [{ id: 'sc-1', number: 'SC-1', workshop: 'WS', expectedBackDate: '2026-12-08', workOrderNumber: 'WO-1', neededBy: '2026-12-02' }],
      planned: [
        { id: 'pw-1', label: 'JKT BLK', protectedFields: ['dueDate', 'sizes'], dueDate: '2026-12-20', quantity: 6, planDueDate: '2026-12-14', planQuantity: 8, needed: true },
        { id: 'pw-2', label: 'JKT RED', protectedFields: ['lineId'], dueDate: '2026-12-20', quantity: 4, planDueDate: null, planQuantity: null, needed: false },
      ],
    })
    expect(found.map((row) => [row.recordType, row.recordId, row.action, row.fromDate ?? row.fromQuantity, row.toDate ?? row.toQuantity])).toEqual([
      ['MaterialRequirement', 'req-9', 'EXPEDITE', '2026-11-25', '2026-11-20'],
      ['MaterialRequirement', 'req-9', 'INCREASE', '30.0000', '50.0000'],
      ['SubcontractOrder', 'sc-1', 'EXPEDITE', '2026-12-08', '2026-12-02'],
      ['WorkOrder', 'wo-1', 'EXPEDITE', '2026-12-10', '2026-12-04'],
      ['WorkOrder', 'wo-2', 'CANCEL', null, null],
      ['PlannedWorkOrder', 'pw-1', 'EXPEDITE', '2026-12-20', '2026-12-14'],
      ['PlannedWorkOrder', 'pw-2', 'CANCEL', '2026-12-20', null],
      ['PlannedWorkOrder', 'pw-1', 'INCREASE', '6.0000', '8.0000'],
    ])
    expect(found.find((row) => row.recordId === 'pw-2')!.message).toContain('Reset to plan')
  })

  it('an ignored message is not raised again while it asks the same; a decided one is not decided twice', () => {
    const draft = { recordType: 'PurchaseOrderLine' as const, recordId: 'pl-1', action: 'DECREASE' as const, fromDate: null, toDate: null, fromQuantity: '30.0000', toQuantity: '12.0000', uom: 'FT2' as const, message: 'm', facts: {} }
    expect(ignoredBefore(draft, [{ recordType: 'PurchaseOrderLine', recordId: 'pl-1', action: 'DECREASE', toDate: null, toQuantity: '12' }])).toBe(true)
    expect(ignoredBefore(draft, [{ recordType: 'PurchaseOrderLine', recordId: 'pl-1', action: 'DECREASE', toDate: null, toQuantity: '10' }])).toBe(false)
    expect(decideProblem({ status: 'DONE' }, { status: 'DONE' })).toContain('done already')
    expect(decideProblem({ status: 'OPEN' }, { status: 'SUPERSEDED' })).toContain('newer plan')
    expect(decideProblem({ status: 'OPEN' }, { status: 'DONE' })).toBeNull()
  })
})

describe('protected edits (PLN-076, PLN-078) and nothing in the past (PLN-083)', () => {
  const stored: PlanFields = { sizes: [{ size: '50', quantity: 2 }, { size: '52', quantity: 4 }], startDate: '2026-12-10', dueDate: '2026-12-18', lineId: null, partyId: null, operationSeqs: [], kitDueAt: null, styleRevisionId: null }
  const facts: EditFacts = { kind: 'MAKE', today: RUN, styleSizes: ['48', '50', '52', '54'], routingSeqs: [10, 20, 30], line: { id: 'line-1', status: 'ACTIVE' }, workshop: null, revision: null }
  const kitAt = (day: string) => `${day}T07:00:00.000Z`

  it('the fields an edit changes join the protected list; Reset to plan takes them out', () => {
    const next = applyChanges(stored, { dueDate: '2026-12-20', lineId: 'line-1' })
    const changed = changedFields(stored, next)
    expect(changed).toEqual(['dueDate', 'lineId'])
    expect(protectedAfter(['sizes'], changed)).toEqual(['sizes', 'dueDate', 'lineId'])
    expect(protectedAfterReset(['sizes', 'dueDate'], ['dueDate'])).toEqual(['sizes'])
    expect(protectedAfterReset(['sizes', 'dueDate'])).toEqual([])
    expect(editProblems(next, changed, facts)).toEqual([])
    expect(shiftedBy(stored, 3)).toEqual({ startDate: '2026-12-13', dueDate: '2026-12-21' })
  })

  it('every problem of an edit at once, in words: before today, start after due, a size not of the style, a workshop on a MAKE', () => {
    const next = applyChanges(stored, { startDate: '2026-11-01', sizes: [{ size: '60', quantity: 1 }], partyId: 'ws-1' })
    const problems = editProblems(next, changedFields(stored, next), facts)
    expect(problems.map((issue) => issue.field)).toEqual(['sizes', 'startDate', 'partyId'])
    expect(problems[1]!.message).toContain('Nothing is planned before today')
    const backwards = applyChanges(stored, { startDate: '2026-12-19' })
    expect(editProblems(backwards, changedFields(stored, backwards), facts)[0]!.message).toContain('after it is due')
  })

  it('the run keeps the protected fields and rewrites the rest, keeping start ≤ due and the kit by its due date', () => {
    const plan: PlanFields = { ...stored, sizes: [{ size: '50', quantity: 3 }], startDate: '2026-12-22', dueDate: '2026-12-28' }
    const merged = mergeWithPlan({ ...stored, dueDate: '2026-12-20' }, plan, ['dueDate'], 'MAKE', kitAt)
    expect([merged.sizes, merged.startDate, merged.dueDate]).toEqual([[{ size: '50', quantity: 3 }], '2026-12-20', '2026-12-20'])
    const sub = mergeWithPlan({ ...stored, partyId: 'ws-1', operationSeqs: [20], kitDueAt: kitAt('2026-12-10') }, { ...plan, partyId: 'ws-1', operationSeqs: [20], kitDueAt: kitAt('2026-12-29') }, ['dueDate'], 'SUBCONTRACT', kitAt)
    expect([sub.startDate, sub.dueDate, sub.kitDueAt]).toEqual(['2026-12-18', '2026-12-18', kitAt('2026-12-18')])
    // PLN-083: a protected date that fell before today moves to today (it stays protected).
    const fallen = mergeWithPlan({ ...stored, startDate: '2026-11-01', dueDate: '2026-11-05' }, plan, ['startDate', 'dueDate'], 'MAKE', kitAt, RUN)
    expect([fallen.startDate, fallen.dueDate]).toEqual([RUN, RUN])
    expect(planValuesOf(plan, ['dueDate', 'sizes'])).toEqual({ sizes: [{ size: '50', quantity: 3 }], dueDate: '2026-12-28' })
    expect(readPlanValues(planValuesOf(plan, ['dueDate', 'sizes']))).toEqual({ sizes: [{ size: '50', quantity: 3 }], dueDate: '2026-12-28' })
  })

  it('a protected row follows the proposal that pegs most of its pieces', () => {
    const demand = (orderLineId: string, pieces: number) => [{ orderId: 'so', orderLineId, size: '52', pieces }]
    const proposals = [
      { kind: 'MAKE', styleId: 's', colourwayId: 'c', demand: demand('ol-1', 1) },
      { kind: 'MAKE', styleId: 's', colourwayId: 'c', demand: [...demand('ol-1', 3), ...demand('ol-2', 2)] },
      { kind: 'MAKE', styleId: 's', colourwayId: 'x', demand: demand('ol-1', 9) },
    ]
    expect(overlapOf(demand('ol-1', 4), proposals[1]!.demand)).toBe(3)
    expect([...claimProposals([{ id: 'pw-1', kind: 'MAKE', styleId: 's', colourwayId: 'c', demand: demand('ol-1', 4) }, { id: 'pw-2', kind: 'MAKE', styleId: 's', colourwayId: 'c', demand: demand('ol-9', 4) }], proposals)]).toEqual([['pw-1', 1]])
  })

  it('late demand starts today: how late, the LATE warning, the planned date of a purchase', () => {
    expect(lateOf('2026-11-20', '2026-11-24')).toEqual({ needDate: '2026-11-20', daysLate: 4 })
    expect(lateOf('2026-11-20', '2026-11-20')).toBeNull()
    expect(plannedDateOf('2026-11-01', RUN)).toBe(RUN)
    expect(plannedDateOf('2026-12-01', RUN)).toBe('2026-12-01')
    const line = (orderLineId: string, dueDate: string) => ({ orderId: 'so', orderNumber: 'SO-1', orderLineId, lineSeq: 10, dueDate })
    const warnings = lateWarnings([{ line: line('ol-1', '2026-11-02'), readyDate: '2026-11-16' }, { line: line('ol-2', '2026-11-14'), readyDate: '2026-11-18' }, { line: line('ol-3', '2026-11-20'), readyDate: null }], RUN)
    expect(warnings.map((warning) => [warning.code, warning.orderLineId])).toEqual([
      ['LATE', 'ol-1'],
      ['LATE', 'ol-2'],
    ])
    expect(warnings[0]!.message).toContain('10 days ago')
    expect(warnings[1]!.message).toContain('4 days late')
    expect(WARNING_CODES).toContain('LATE')
  })
})

describe('the run log (PLN-095)', () => {
  it('keeps what the run read and the plan of protected fields; old runs read as none', () => {
    const counts = Object.fromEntries(['orderLines', 'orderLinesPlanned', 'orders', 'lateOrderLines', 'undatedOrderLines', 'madeToMeasure', 'notPlaced', 'revisions', 'materials', 'workOrders', 'workOrderCells', 'scheduledWorkOrders', 'stockLines', 'lots', 'purchaseLines', 'purchaseOrders', 'purchaseLinesForOneOrder', 'reservations', 'firmPlannedOrders', 'orderSpecificPegs', 'itemParameters', 'approvedSources', 'plannedWorkOrdersFirm', 'plannedWorkOrdersProtected', 'plannedWorkOrdersPlain'].map((key) => [key, 2]))
    const inputs: RunInputs = { version: RUN_LOG_VERSION, runDate: RUN, timezone: 'Europe/Rome', previousRunId: null, explosion: 'MULTI_LEVEL', passes: 2, sizeRunRule: 'ONE_GRID', sizeGroups: 0, counts: counts as unknown as RunInputs['counts'], protectedPlan: [{ plannedWorkOrderId: 'pw-1', fields: { dueDate: '2026-12-18' } }] }
    const read = readRunInputs(JSON.parse(JSON.stringify(inputs)))
    expect(read).toEqual(inputs)
    expect(readRunInputs({})).toBeNull()
    expect(protectedPlanOf(read, 'pw-1')).toEqual({ dueDate: '2026-12-18' })
    expect(inputsSentence(read!)).toContain('2 of 2 order lines planned')
    expect(warningCounts([{ code: 'LATE' }, { code: 'LATE' }, { code: 'NO_DATE' }])).toEqual([
      { code: 'NO_DATE', count: 1 },
      { code: 'LATE', count: 2 },
    ])
  })

  it('says why each proposal exists in one sentence', () => {
    const reason = requirementReason({ action: 'BUY', label: 'LEA BLK', uom: 'FT2', grossQuantity: '420.0000', usableStock: '120.0000', onOrder: '100.0000', netQuantity: '200.0000', suggestedQuantity: '200.0000', suggestedUom: 'FT2', needDate: '2026-11-26', orders: ['SO-1', 'SO-2'], firm: null, reservedFor: null })
    expect(reason).toContain('Buy 200')
    expect(reason).toContain('for SO-1 and SO-2')
    expect(reason).toContain('Need 420')
    expect(requirementReason({ action: 'BUY', label: 'LEA BLK', uom: 'FT2', grossQuantity: '20.0000', usableStock: '0.0000', onOrder: '0.0000', netQuantity: '20.0000', suggestedQuantity: '20.0000', suggestedUom: 'FT2', needDate: '2026-11-26', orders: ['SO-2'], firm: null, reservedFor: { orderNumber: 'SO-2', lineSeq: 20 } })).toContain('SO-2 line 20 alone')
    const planned = plannedOrderReason({ kind: 'MAKE', label: 'JKT BLK', sizes: [{ size: '50', quantity: 2 }], quantity: 2, startDate: RUN, dueDate: '2026-11-16', needDate: '2026-11-10', orderLines: ['SO-1 line 10'], workshop: null, operationSeqs: [], firm: false, protectedFields: ['dueDate'] })
    expect(planned).toContain('Make 2 JKT BLK (50×2) for SO-1 line 10')
    expect(planned).toContain('cannot be ready by 2026-11-10')
    expect(planned).toContain('protected its due date')
  })
})

describe('the catalogues', () => {
  it('declares the two permissions for the planner, the buyer and the production manager, and the four events', () => {
    for (const name of PLANNING_ACTIONS_PERMISSIONS) expect(FACTORY_PERMISSIONS.isDeclared(name)).toBe(true)
    const holds = (key: string, permission: string) => ROLE_TEMPLATES.find((role) => role.key === key)?.permissions.includes(permission as never) ?? false
    expect([holds('planner', PLANNING_ACTIONS_MANAGE), holds('planner', PLANNING_PLANNED_EDIT)]).toEqual([true, true])
    expect([holds('buyer', PLANNING_ACTIONS_MANAGE), holds('buyer', PLANNING_PLANNED_EDIT)]).toEqual([true, false])
    expect([holds('production_manager', PLANNING_ACTIONS_MANAGE), holds('production_manager', PLANNING_PLANNED_EDIT)]).toEqual([true, true])
    expect(holds('read_only', PLANNING_ACTIONS_MANAGE)).toBe(false)
    for (const type of ['mrp_action_messages.raised', 'mrp_action_messages.decided', 'planned_work_orders.edited', 'material_requirement.pegged']) expect(EVENT_CATALOGUE.find(type, 1), type).toBeDefined()
  })
})
