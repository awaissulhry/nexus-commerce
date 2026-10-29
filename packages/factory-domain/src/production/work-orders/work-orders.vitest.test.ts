import { describe, expect, it } from 'vitest'
import type { BomLineData } from '../../product/bom/rules'
import type { StepData } from '../../product/routing/rules'
import type { ItemUnits } from '../../product/units/units'
import { canTransition } from '../../state/machine'
import { allOpenCells, cellProblems, clashProblems, duplicateRequests, lineProblems, openSizes, revisionFor, type OrderLineFacts } from './cells'
import { compareSpec, type SpecSnapshot } from './compare'
import { daysLate, moveChange, nextActions, workOrderMachine } from './machine'
import {
  batchCheck,
  bomCheck,
  cellsCheck,
  certificateCheck,
  depositCheck,
  depositGate,
  labelCheck,
  materialCheck,
  materialLines,
  releaseChecklist,
  releaseRefusal,
  revisionCheck,
  workCentreCheck,
  type MaterialFacts,
} from './release'
import { planMaterials, planOperations, type SpecCell } from './spec'

// Every id, code and number is made up.
const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`

describe('the work order machine (MES-007)', () => {
  it('moves DRAFT → RELEASED → IN_PROGRESS → COMPLETED → CLOSED, and cancels before completion with a reason', () => {
    expect(nextActions('DRAFT')).toEqual(['RELEASED', 'CANCELLED'])
    expect(nextActions('COMPLETED')).toEqual(['CLOSED'])
    expect(nextActions('CLOSED')).toEqual([])
    expect(nextActions('CANCELLED')).toEqual([])
    expect(canTransition(workOrderMachine, 'DRAFT', 'RELEASED', { releaseBlockers: [] }).ok).toBe(true)
    expect(canTransition(workOrderMachine, 'DRAFT', 'RELEASED', {})).toMatchObject({ ok: false, missing: ['the release check'] })
    expect(canTransition(workOrderMachine, 'DRAFT', 'RELEASED', { releaseBlockers: ['a deposit'] })).toMatchObject({ ok: false, missing: ['a deposit'] })
    expect(canTransition(workOrderMachine, 'RELEASED', 'CANCELLED', { reason: '  ' })).toMatchObject({ ok: false, missing: ['a reason for the cancellation'] })
    expect(canTransition(workOrderMachine, 'IN_PROGRESS', 'CANCELLED', { reason: 'Order cancelled' }).ok).toBe(true)
    expect(canTransition(workOrderMachine, 'COMPLETED', 'CANCELLED', { reason: 'late' })).toMatchObject({ ok: false, reason: 'not_allowed' })
    expect(canTransition(workOrderMachine, 'DRAFT', 'IN_PROGRESS', {})).toMatchObject({ ok: false, reason: 'not_allowed' })
  })

  it('sets each move\'s time with it (the trigger refuses a status without its time)', () => {
    const now = new Date('2026-11-20T10:00:00.000Z')
    expect(moveChange('IN_PROGRESS', now)).toEqual({ status: 'IN_PROGRESS', startedAt: now })
    expect(moveChange('CLOSED', now)).toEqual({ status: 'CLOSED', closedAt: now })
    expect(moveChange('CANCELLED', now, ' Customer withdrew ')).toEqual({ status: 'CANCELLED', cancelledAt: now, cancelReason: 'Customer withdrew' })
  })

  it('counts whole days late for open work orders only (MES-305)', () => {
    expect(daysLate('RELEASED', '2026-11-10', '2026-11-13')).toBe(3)
    expect(daysLate('DRAFT', '2026-11-10', '2026-11-10')).toBe(0)
    expect(daysLate('IN_PROGRESS', '2026-02-27', '2026-03-02')).toBe(3)
    expect(daysLate('COMPLETED', '2026-11-10', '2026-11-13')).toBeNull()
    expect(daysLate('DRAFT', null, '2026-11-13')).toBeNull()
  })
})

const line = (over: Partial<OrderLineFacts> = {}): OrderLineFacts => ({
  id: id(1),
  seq: 10,
  orderId: id(2),
  orderNumber: 'SO-1',
  orderStatus: 'CONFIRMED',
  companyId: id(3),
  partyId: id(4),
  kind: 'SIZE_GRID',
  styleId: id(5),
  styleRevisionId: null,
  colourwayId: id(6),
  siteId: null,
  sizes: [
    { size: '50', quantity: 2 },
    { size: '52', quantity: 4 },
  ],
  onWorkOrders: { '52': 3 },
  ...over,
})
const target = { companyId: id(3), siteId: id(7), styleId: id(5), styleSizes: ['50', '52', '54'], styleRevisionId: id(8) }

describe('cells from order lines (MES-001, MES-002)', () => {
  it('opens each size: ordered less already on other work orders', () => {
    expect(openSizes(line())).toEqual([
      { size: '50', ordered: 2, onWorkOrders: 0, open: 2 },
      { size: '52', ordered: 4, onWorkOrders: 3, open: 1 },
    ])
    expect(allOpenCells(line({ onWorkOrders: { '50': 2 } }))).toEqual([{ salesOrderLineId: id(1), size: '52', quantity: 4 }])
  })

  it('refuses another style, company, site, revision or an order not confirmed', () => {
    expect(lineProblems(line(), target, 'body/lines/0')).toEqual([])
    const messages = lineProblems(line({ orderStatus: 'SHIPPED', companyId: id(9), styleId: id(9), siteId: id(9), styleRevisionId: id(9) }), target, 'p').map((issue) => issue.message)
    expect(messages).toEqual([
      'SO-1 line 10: the order is SHIPPED; work orders are made for CONFIRMED or IN_PRODUCTION orders.',
      "SO-1 line 10 is an order of another company than the work order's site.",
      'SO-1 line 10 is another style: a work order makes one style.',
      'SO-1 line 10 is made at another site.',
      "SO-1 line 10 is ordered to another revision of the style than the work order's.",
    ])
  })

  it('takes at most what is open, in the style range and the line\'s grid', () => {
    expect(cellProblems(line(), target, '52', 1, 'c')).toEqual([])
    expect(cellProblems(line(), target, '52', 2, 'c')).toEqual([{ path: 'c/quantity', message: 'SO-1 line 10 size 52: 4 ordered, 3 already on other work orders, so 1 can still be made; 2 asked.' }])
    expect(cellProblems(line(), target, '54', 1, 'c')).toEqual([{ path: 'c/size', message: 'SO-1 line 10 orders no size 54.' }])
    expect(cellProblems(line(), target, '58', 1, 'c')).toEqual([{ path: 'c/size', message: "Size 58 is not in the style's size range." }])
    expect(cellProblems(line(), target, '50', -1, 'c')[0]!.path).toBe('c/quantity')
    expect(cellProblems(line(), target, '50', 0, 'c')).toEqual([])
  })

  it('keeps one cell per colourway and size, and one request per line and size', () => {
    const held = [{ salesOrderLineId: id(1), colourwayId: id(6), size: '50' }]
    expect(clashProblems([{ salesOrderLineId: id(1), colourwayId: id(6), size: '50', quantity: 1 }], held, 'b')).toEqual([])
    expect(clashProblems([{ salesOrderLineId: id(9), colourwayId: id(6), size: '50', quantity: 1 }], held, 'b')).toHaveLength(1)
    expect(clashProblems([{ salesOrderLineId: id(9), colourwayId: id(6), size: '50', quantity: 0 }], held, 'b')).toEqual([])
    expect(duplicateRequests([{ salesOrderLineId: id(1), size: '50', quantity: 1 }, { salesOrderLineId: id(1), size: '50', quantity: 2 }], 'b')).toEqual([{ path: 'b/1', message: 'Size 50 of this order line is named twice.' }])
  })

  it('chooses the revision asked, else the one the lines fix, else the released one', () => {
    expect(revisionFor(null, [{ styleRevisionId: null }], id(8))).toEqual({ revisionId: id(8), problem: null })
    expect(revisionFor(null, [{ styleRevisionId: id(9) }], id(8))).toEqual({ revisionId: id(9), problem: null })
    expect(revisionFor(id(8), [{ styleRevisionId: null }], null)).toEqual({ revisionId: id(8), problem: null })
    expect(revisionFor(id(8), [{ styleRevisionId: id(9) }], id(8)).problem).toMatch(/another revision/)
    expect(revisionFor(null, [{ styleRevisionId: id(9) }, { styleRevisionId: id(10) }], id(8)).problem).toMatch(/different revisions/)
    expect(revisionFor(null, [], null)).toEqual({ revisionId: null, problem: null })
  })
})

const step = (seq: number, kind: StepData['workCentreKind'], minutes = '10.000'): StepData => ({
  id: id(100 + seq),
  seq,
  operationId: id(200 + seq),
  code: `OP-${seq}`,
  name: `Step ${seq}`,
  nameI18n: null,
  workCentreKind: kind,
  standardMinutes: minutes,
  scanRequired: true,
  instructions: null,
})
const leatherUnits: ItemUnits = { baseUom: 'FT2', purchaseUom: 'FT2', purchaseFactor: '1', consumptionUom: 'FT2', consumptionFactor: '1' }
const liningUnits: ItemUnits = { baseUom: 'M', purchaseUom: 'ROLL', purchaseFactor: '50', consumptionUom: 'M', consumptionFactor: '1' }
const bomLine = (over: Partial<BomLineData>): BomLineData => ({
  id: id(300),
  seq: 10,
  itemId: id(400),
  placement: null,
  qty: '1',
  uom: 'FT2',
  wastagePct: '0',
  sizeDependent: false,
  colourDependent: false,
  itemColourId: null,
  colourwayId: null,
  supplierId: null,
  note: null,
  sizes: [],
  colours: [],
  ...over,
})
const BLK = id(500)
const RED = id(501)
const leather = bomLine({
  id: id(301),
  itemId: id(401),
  qty: '45',
  wastagePct: '12',
  sizeDependent: true,
  colourDependent: true,
  sizes: [
    { size: '50', qty: '43' },
    { size: '52', qty: '45' },
  ],
  colours: [{ colourwayId: BLK, itemColourId: id(601) }],
})
const lining = bomLine({ id: id(302), seq: 20, itemId: id(402), qty: '1.8', uom: 'CM', wastagePct: '5', itemColourId: id(602) })
const redPatch = bomLine({ id: id(303), seq: 30, itemId: id(403), qty: '0.3333', uom: 'FT2', colourwayId: RED })
const units = new Map([
  [id(401), leatherUnits],
  [id(402), liningUnits],
  [id(403), leatherUnits],
])
const code = (itemId: string) => ({ [id(401)]: 'LEA', [id(402)]: 'LIN', [id(403)]: 'PATCH' })[itemId] ?? '?'
const cell = (n: number, colourwayId: string, size: string, quantity: number): SpecCell => ({ id: id(700 + n), colourwayId, colourwayCode: colourwayId === BLK ? 'BLK' : 'RED', size, quantity })

describe('the frozen spec builder (MES-005, PRD-192)', () => {
  it('maps every routing step to the first active work centre of its kind, and names the kinds the site lacks', () => {
    const centres = [
      { id: id(801), code: 'SEW-2', name: 'Sewing 2', kind: 'SEWING' as const, status: 'ACTIVE' },
      { id: id(802), code: 'SEW-1', name: 'Sewing 1', kind: 'SEWING' as const, status: 'ACTIVE' },
      { id: id(803), code: 'CUT', name: 'Cutting', kind: 'CUTTING' as const, status: 'ARCHIVED' },
    ]
    const { operations, missing } = planOperations([step(20, 'SEWING', '96.5'), step(10, 'CUTTING'), step(30, 'FINISHING'), step(40, 'CUTTING')], centres)
    expect(operations.map((op) => [op.seq, op.routingSeq, op.code, op.standardMinutes, op.workCentreCode])).toEqual([
      [10, 10, 'OP-10', '10.000', null],
      [20, 20, 'OP-20', '96.5', 'SEW-1'],
      [30, 30, 'OP-30', '10.000', null],
      [40, 40, 'OP-40', '10.000', null],
    ])
    expect(missing).toEqual([
      { kind: 'CUTTING', steps: [{ seq: 10, code: 'OP-10', name: 'Step 10' }, { seq: 40, code: 'OP-40', name: 'Step 40' }] },
      { kind: 'FINISHING', steps: [{ seq: 30, code: 'OP-30', name: 'Step 30' }] },
    ])
  })

  it('plans BOM line × cell with wastage, in the line\'s unit and the base unit, rounded up once', () => {
    const { materials, gaps } = planMaterials([leather, lining, redPatch], [cell(1, BLK, '52', 2), cell(2, RED, '50', 3)], (itemId) => units.get(itemId), code)
    expect(materials.map((m) => [m.cellId, m.itemId, m.itemColourId, m.quantity, m.uom, m.baseQuantity, m.baseUom])).toEqual([
      // 45 × 1.12 × 2 = 100.8 ft²; 1.8 cm × 1.05 × 2 = 3.78 cm = 0.0378 m
      [id(701), id(401), id(601), '100.8', 'FT2', '100.8', 'FT2'],
      [id(701), id(402), id(602), '3.78', 'CM', '0.0378', 'M'],
      // 1.8 × 1.05 × 3 = 5.67 cm = 0.0567 m; 0.3333 × 3 = 0.9999 ft²
      [id(702), id(402), id(602), '5.67', 'CM', '0.0567', 'M'],
      [id(702), id(403), null, '0.9999', 'FT2', '0.9999', 'FT2'],
    ])
    // RED is not in the leather's colour grid: the BOM lacks the colourway.
    expect(gaps).toEqual([{ code: 'COLOURWAY_NOT_IN_BOM', cellId: id(702), bomLineId: id(301), message: 'RED 50: the colourway is not in the revision\'s BOM (line 10 (LEA) names no colour for it).' }])
  })

  it('refuses a size the frozen BOM lacks and rounds a third up, never down', () => {
    const third = bomLine({ id: id(304), itemId: id(403), qty: '0.33333', uom: 'FT2' })
    const { materials, gaps } = planMaterials([leather, third], [cell(3, BLK, '54', 1)], (itemId) => units.get(itemId), code)
    expect(gaps.map((gap) => gap.code)).toEqual(['SIZE_NOT_IN_BOM'])
    expect(gaps[0]!.message).toBe("BLK 54: size 54 is not in the revision's BOM (line 10 (LEA) has no quantity for it).")
    expect(materials.map((m) => m.quantity)).toEqual(['0.3334'])
  })

  it('leaves out a size that uses none of a line (0)', () => {
    const zero = bomLine({ id: id(305), itemId: id(401), sizeDependent: true, sizes: [{ size: '52', qty: '0' }] })
    expect(planMaterials([zero], [cell(4, BLK, '52', 2)], (itemId) => units.get(itemId), code)).toEqual({ materials: [], gaps: [] })
  })
})

describe('the deposit gate (A1 §2.5, ported)', () => {
  const order = (depositRequired: boolean, statuses: ('OPEN' | 'PAID' | 'WAIVED' | 'CANCELLED')[]) => ({
    orderId: id(900),
    orderNumber: 'SO-9',
    depositRequired,
    requests: statuses.map((status, index) => ({ status, dueDate: `2026-11-1${index}` })),
  })

  it('passes without a required deposit, or when every live request is paid or waived', () => {
    expect(depositGate(order(false, []))).toEqual({ passed: true, message: 'SO-9 requires no deposit.' })
    expect(depositGate(order(true, ['PAID']))).toEqual({ passed: true, message: "SO-9's deposit is paid." })
    expect(depositGate(order(true, ['CANCELLED', 'WAIVED']))).toEqual({ passed: true, message: "SO-9's deposit is waived." })
  })

  it('holds the release while a deposit is required and not in', () => {
    expect(depositGate(order(true, []))).toEqual({ passed: false, message: 'SO-9 requires a deposit and has no deposit request: ask for it first.' })
    expect(depositGate(order(true, ['CANCELLED']))).toMatchObject({ passed: false })
    expect(depositGate(order(true, ['PAID', 'OPEN']))).toEqual({ passed: false, message: 'SO-9 waits for its deposit (due 2026-11-11): production starts when it is paid or waived.' })
    expect(depositCheck([order(true, ['OPEN'])])).toMatchObject({ state: 'BLOCKED', problems: [{ path: `orders/${id(900)}/deposit` }] })
    expect(depositCheck([order(false, [])])).toMatchObject({ state: 'NOT_REQUIRED' })
    expect(depositCheck([order(true, ['PAID'])])).toMatchObject({ state: 'OK' })
  })
})

describe('material availability (A1 §2.5: available, or a planner override with a reason)', () => {
  const facts = (over: Partial<MaterialFacts>): MaterialFacts => ({
    itemId: id(401),
    itemColourId: id(601),
    label: 'LEA BLK',
    baseUom: 'FT2',
    planned: '100.8',
    issued: '0',
    usable: '150',
    committed: '0',
    held: [],
    ...over,
  })

  it('needs planned less issued, from usable stock less what other released work orders still need', () => {
    expect(materialLines([facts({ issued: '20.8', usable: '100', committed: '30' })])[0]).toMatchObject({ needed: '80', available: '70', short: '10' })
    expect(materialLines([facts({ issued: '120' , usable: '0' })])[0]).toMatchObject({ needed: '0', short: '0' })
    expect(materialLines([facts({ committed: '200' })])[0]).toMatchObject({ available: '0', short: '100.8' })
  })

  it('blocks a shortage in words, with the stock that is there but not usable; a reason overrides it', () => {
    const lines = materialLines([facts({ usable: '51.8', held: [{ reason: 'CR_VI_PENDING', quantity: '53.2' }] }), facts({ itemId: id(402), itemColourId: null, label: 'LIN', baseUom: 'M', planned: '3', usable: '120' })])
    const check = materialCheck(lines, null)
    expect(check).toMatchObject({ code: 'MATERIAL', state: 'BLOCKED' })
    expect(check.problems).toEqual([
      {
        path: `materials/${id(401)}/${id(601)}`,
        message: 'LEA BLK: 100.8 FT2 needed, 51.8 usable on hand and 0 promised to other released work orders, so 49 FT2 short. On hand but not usable: 53.2 FT2 no chromium VI test result yet.',
      },
    ])
    expect(materialCheck(lines, { reason: '  ' }).state).toBe('BLOCKED')
    expect(materialCheck(lines, { reason: 'Leather arrives Monday; cutting starts Tuesday' })).toMatchObject({ state: 'OVERRIDDEN', problems: [expect.objectContaining({ path: `materials/${id(401)}/${id(601)}` })] })
    expect(materialCheck(materialLines([facts({})]), null)).toMatchObject({ state: 'OK', message: 'Usable stock at the site covers every material (1).' })
  })
})

describe('the release checklist (A1 §2.5, design 02 "Release check")', () => {
  const style = id(5)
  const released = { id: id(8), revision: 2, status: 'RELEASED', styleId: style }

  it('names the revision, label, certificate, work centres, BOM and cells in words', () => {
    expect(revisionCheck(style, released, released).state).toBe('OK')
    expect(revisionCheck(style, { ...released, status: 'OBSOLETE' }, { id: id(9), revision: 3 }).message).toBe(
      "Revision 2 is OBSOLETE; a work order is released only with a RELEASED revision. The style's released revision now is 3: choose it on the work order.",
    )
    expect(revisionCheck(style, null, null).message).toMatch(/No released revision of the style is chosen. The style has no released revision/)
    expect(labelCheck(released, null).message).toMatch(/names no garment label template/)
    expect(labelCheck(released, { id: id(10), code: 'LBL', revision: 1, status: 'RETIRED' }).message).toBe('Garment label template LBL v1 is RETIRED; the release needs it ACTIVE.')
    expect(labelCheck(released, { id: id(10), code: 'LBL', revision: 1, status: 'ACTIVE' }).state).toBe('OK')
    expect(workCentreCheck('A1', 0, []).state).toBe('BLOCKED')
    expect(workCentreCheck('A1', 3, [{ kind: 'FINISHING', steps: [{ seq: 30, code: 'PRESS', name: 'Press' }] }]).problems).toEqual([
      { path: 'checks/WORK_CENTRES/FINISHING', message: 'No active FINISHING work centre on site A1 for step 30 PRESS (Press).' },
    ])
    expect(bomCheck(released, []).state).toBe('OK')
    expect(cellsCheck([]).message).toBe('The work order has no cells: add sizes from its order lines.')
    expect(cellsCheck([{ id: id(1), label: 'BLK 58', inRange: false }]).problems[0]!.path).toBe(`cells/${id(1)}/size`)
    expect(batchCheck(false).message).toMatch(/no active batch number series/)
  })

  it('needs a certificate covering every cell of PPE, and none for a style that is not PPE', () => {
    const covered = { outcome: 'covered' as const, certificateNumber: 'CERT-1', validTo: '2029-01-01', reasons: [], message: null }
    expect(certificateCheck([{ cellId: id(1), label: 'BLK 50', ...covered }, { cellId: id(2), label: 'BLK 52', ...covered }])).toMatchObject({
      state: 'OK',
      message: "Certificate CERT-1 (valid to 2029-01-01) covers every cell's colourway and size.",
    })
    const refused = certificateCheck([
      { cellId: id(1), label: 'BLK 50', ...covered },
      { cellId: id(2), label: 'BLK 56', outcome: 'refused', certificateNumber: null, validTo: null, reasons: ['Certificate CERT-1 does not cover size 56.'], message: null },
    ])
    expect(refused).toMatchObject({ state: 'BLOCKED', problems: [{ path: `cells/${id(2)}/certificate`, message: 'BLK 56: Certificate CERT-1 does not cover size 56.' }] })
    expect(refused.message).toBe('No valid certificate covers BLK 56 today (Reg. (EU) 2016/425): 1 of 2 cell(s).')
    expect(certificateCheck([{ cellId: id(1), label: 'BLK 50', outcome: 'not_required', certificateNumber: null, validTo: null, reasons: [], message: 'Style X is not PPE.' }])).toMatchObject({ state: 'NOT_REQUIRED', message: 'Style X is not PPE.' })
  })

  it('sorts the checks, lists every blocker and says how many in the refusal', () => {
    const checklist = releaseChecklist([batchCheck(true), depositCheck([{ orderId: id(1), orderNumber: 'SO-1', depositRequired: true, requests: [] }]), revisionCheck(style, released, released), labelCheck(released, null)])
    expect(checklist.checks.map((check) => check.code)).toEqual(['REVISION', 'LABEL_TEMPLATE', 'DEPOSIT', 'BATCH_NUMBER'])
    expect(checklist.releasable).toBe(false)
    expect(checklist.blockers.map((issue) => issue.path)).toEqual(['checks/LABEL_TEMPLATE', `orders/${id(1)}/deposit`])
    expect(releaseRefusal('WO-00007', checklist)).toBe('Work order WO-00007 cannot be released yet: 2 problem(s) to fix first (label template, deposit).')
    expect(releaseChecklist([batchCheck(true), materialCheck([], null)]).releasable).toBe(true)
  })
})

describe('the frozen spec against today\'s master (MES-005)', () => {
  const snapshot = (revisionId: string, revision: number, over: Partial<SpecSnapshot> = {}): SpecSnapshot => ({
    revision: { id: revisionId, revision, status: 'RELEASED' },
    label: { id: id(10), code: 'LBL', revision: 1, status: 'ACTIVE' },
    bom: { plannedHideYieldPct: '75', labelTemplateId: id(10), lines: [leather, lining] },
    steps: [step(10, 'CUTTING'), step(20, 'SEWING', '96.5')],
    ...over,
  })

  it('says nothing changed while the frozen revision is still the released one', () => {
    const same = compareSpec(snapshot(id(8), 1), snapshot(id(8), 1))
    expect(same).toMatchObject({ sameRevision: true, noMaster: false, label: { changed: false } })
    expect(same.summary).toEqual(["Revision 1 is still the style's released revision: nothing changed."])
  })

  it('lists what a newer revision changed: BOM, routing, minutes and label', () => {
    const newer = snapshot(id(9), 2, {
      label: { id: id(11), code: 'LBL', revision: 2, status: 'ACTIVE' },
      bom: { plannedHideYieldPct: '75', labelTemplateId: id(11), lines: [{ ...leather, wastagePct: '15' }] },
      steps: [step(10, 'CUTTING'), step(20, 'SEWING', '90'), step(30, 'INSPECTION', '5')],
    })
    const diff = compareSpec(snapshot(id(8), 1), newer)
    expect(diff.summary).toEqual([
      "The style's released revision is now 2; the work order keeps revision 1.",
      'BOM: 1 line removed, 1 line changed.',
      'Routing: 1 step added, 1 step changed, standard minutes 106.5 → 105 per garment.',
      'Garment label template: LBL v1 → LBL v2.',
    ])
    expect(compareSpec(snapshot(id(8), 1), null)).toMatchObject({ noMaster: true, summary: ['The style has no released revision today; the work order keeps revision 1.'] })
    expect(compareSpec(snapshot(id(8), 1), snapshot(id(9), 2)).summary).toEqual([
      "The style's released revision is now 2; the work order keeps revision 1.",
      'Its BOM, routing and label template are the same.',
    ])
  })
})
