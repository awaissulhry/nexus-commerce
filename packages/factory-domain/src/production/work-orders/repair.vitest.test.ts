import { describe, expect, it } from 'vitest'
import type { StepData } from '../../product/routing/rules'
import { liveWorkOrderProblem, repairGarmentOf, repairLineProblems, repairNotRequired, repairSizeOf, repairStageProblem, repairStepPlan, repairWorkCentreCheck, type RepairFacts, type SoldLineFacts } from './repair'

/** A repair work order (B-W2a-12; MES-019): the rules by hand. */

const repair: RepairFacts = { number: 'REP-1', companyId: 'co', partyId: 'p1', styleId: 'st', colourwayId: 'blk', size: null }
const line: SoldLineFacts = { id: 'l1', seq: 10, orderNumber: 'SO-1', companyId: 'co', partyId: 'p1', styleId: 'st', colourwayId: 'blk', kind: 'SIZE_GRID', measurementProfileId: null, sizes: [{ size: '50', quantity: 2 }, { size: '52', quantity: 0 }] }
const step = (seq: number, code: string, kind: StepData['workCentreKind']): StepData => ({ id: `s${seq}`, seq, operationId: `o${seq}`, code, name: code.toLowerCase(), nameI18n: null, workCentreKind: kind, standardMinutes: '10.0000', scanRequired: true, instructions: null })
const centres = [
  { id: 'cut', code: 'CUT', name: 'Cutting', kind: 'CUTTING' as const, status: 'ACTIVE' },
  { id: 'sew', code: 'SEW', name: 'Sewing', kind: 'SEWING' as const, status: 'ACTIVE' },
  { id: 'old', code: 'QC-OLD', name: 'Old bench', kind: 'INSPECTION' as const, status: 'ARCHIVED' },
]
const routing = [step(10, 'CUT', 'CUTTING'), step(20, 'SEW', 'SEWING'), step(30, 'QC', 'INSPECTION')]

describe('the repair order', () => {
  it('gets a work order before its repair is done, and only one live one', () => {
    expect(repairStageProblem('REP-1', 'RECEIVED')).toBeNull()
    expect(repairStageProblem('REP-1', 'IN_REPAIR')).toBeNull()
    expect(repairStageProblem('REP-1', 'REPAIRED')).toBe('Repair REP-1 is REPAIRED: its work is done (back to IN_REPAIR first if it needs more).')
    expect(repairStageProblem('REP-1', 'SHIPPED')).toBe('Repair REP-1 is SHIPPED: it gets no repair work order any more.')
    expect(liveWorkOrderProblem('REP-1', null)).toBeNull()
    expect(liveWorkOrderProblem('REP-1', { number: 'WO-9', status: 'CANCELLED' })).toBeNull()
    expect(liveWorkOrderProblem('REP-1', { number: 'WO-9', status: 'DRAFT' })).toBe('Repair REP-1 already has repair work order WO-9 (DRAFT); cancel it first to make another.')
    // B-W2b-16: back into repair after it was repaired, a done work order no longer stops the rework's; a live one does.
    expect(liveWorkOrderProblem('REP-1', { number: 'WO-9', status: 'COMPLETED' }, true)).toBeNull()
    expect(liveWorkOrderProblem('REP-1', { number: 'WO-9', status: 'COMPLETED' })).toBe('Repair REP-1 already has repair work order WO-9 (COMPLETED); cancel it first to make another.')
    expect(liveWorkOrderProblem('REP-1', { number: 'WO-9', status: 'RELEASED' }, true)).toBe('Repair REP-1 already has repair work order WO-9 (RELEASED); cancel it first to make another.')
  })
})

describe('the garment: asked, else the RMA line, else the serial', () => {
  it('takes the first that says it', () => {
    const rma = { salesOrderLineId: 'l1', size: '50' }
    const serial = { salesOrderLineId: 'l2', size: '52' }
    expect(repairGarmentOf({ asked: { salesOrderLineId: 'l3', size: null }, returnLine: rma, serialCell: serial })).toEqual({ salesOrderLineId: 'l3', size: null, from: 'ASKED' })
    expect(repairGarmentOf({ asked: null, returnLine: rma, serialCell: serial })).toEqual({ ...rma, from: 'RETURN_LINE' })
    expect(repairGarmentOf({ asked: null, returnLine: null, serialCell: serial })).toEqual({ ...serial, from: 'SERIAL' })
    expect(repairGarmentOf({ asked: null, returnLine: null, serialCell: null })).toBeNull()
  })

  it("is the repair's customer's, company's, style's and colourway's, in a size the line sold", () => {
    expect(repairLineProblems(repair, line, '50', 'body/salesOrderLineId')).toEqual([])
    expect(repairLineProblems(repair, line, '52', 'x')).toEqual([{ path: 'x/size', message: 'SO-1 line 10 sold no size 52.' }])
    expect(repairLineProblems(repair, line, null, 'x')).toEqual([{ path: 'x/size', message: "Name the garment's size (SO-1 line 10)." }])
    expect(repairLineProblems({ ...repair, partyId: 'p2', colourwayId: 'red' }, line, '50', 'x').map((problem) => problem.message)).toEqual([
      "SO-1 line 10 was sold to another customer than repair REP-1's.",
      'SO-1 line 10 is another colourway than repair REP-1 names.',
    ])
  })

  it('a made-to-measure unit: its one size, any size the label says', () => {
    const unit = { ...line, kind: 'MADE_TO_MEASURE', measurementProfileId: 'prof', sizes: [{ size: '52', quantity: 1 }] }
    expect(repairSizeOf({ salesOrderLineId: 'l1', size: null }, repair, unit)).toBe('52')
    expect(repairSizeOf({ salesOrderLineId: 'l1', size: null }, { ...repair, size: '54' }, unit)).toBe('54')
    expect(repairLineProblems(repair, unit, '54', 'x')).toEqual([])
  })
})

describe('the steps (factory-db: a repair is released with at least one operation)', () => {
  it('the chosen routing steps at an active work centre of their kind', () => {
    const plan = repairStepPlan(routing, [20], centres, 1, 'body/routingSeqs')
    expect(plan.problems).toEqual([])
    expect(plan.operations).toEqual([expect.objectContaining({ seq: 20, routingSeq: 20, code: 'SEW', workCentreId: 'sew', workCentreCode: 'SEW' })])
  })

  it('refuses none, twice, unknown, and a step the site cannot run, in words', () => {
    expect(repairStepPlan(routing, [], centres, 1, 'p').problems).toEqual([{ path: 'p', message: 'Choose at least one routing step the repair needs.' }])
    expect(repairStepPlan(routing, [20, 20, 40, 30], centres, 1, 'p').problems).toEqual([
      { path: 'p/1', message: 'Name each step once.' },
      { path: 'p/2', message: "Revision 1's routing has no step 40." },
      { path: 'p/3', message: 'Step 30 QC (qc) needs an active INSPECTION work centre on the site; it has none.' },
    ])
  })

  it("the release: a repair's own answers", () => {
    expect(repairNotRequired('DEPOSIT')).toEqual({ code: 'DEPOSIT', state: 'NOT_REQUIRED', message: 'A repair is no new sale: no deposit is checked.', problems: [] })
    expect(repairWorkCentreCheck('A1', [])).toMatchObject({ state: 'BLOCKED', message: 'The repair names no step: choose the routing steps it needs.' })
    expect(repairWorkCentreCheck('A1', [{ seq: 20, code: 'SEW', name: 'sew', workCentreKind: 'SEWING', workCentreCode: 'SEW', workCentreStatus: 'ACTIVE' }])).toMatchObject({ state: 'OK' })
    expect(repairWorkCentreCheck('A1', [{ seq: 30, code: 'QC', name: 'qc', workCentreKind: 'INSPECTION', workCentreCode: 'QC-OLD', workCentreStatus: 'ARCHIVED' }])).toMatchObject({
      state: 'BLOCKED',
      problems: [{ path: 'checks/WORK_CENTRES/30', message: 'Step 30 QC (qc): work centre QC-OLD is not active.' }],
    })
  })
})
