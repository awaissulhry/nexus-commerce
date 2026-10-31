import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { at, canOf, COLOURS, inShell, MATERIALS, PREFIX, SITE, SITE_SOUTH, SUPPLIER_LIST, SUPPLIERS, TIME_ZONE, uid, type Role } from '../../_shared/buying/fixtures'
import type { Explain, OpenDraft, PegDemand, Plan, PlanLine, PlanRun, SendCard, Shortages, StockLine } from './api'
import type { PlanModel } from './model'
import { PlanView } from './view/PlanView'

/**
 * SCR-055 — What to buy & make (design planning.mrp) with made-up data only: a plan of the site STAB-N with leather by
 * area (≈ hides), protectors, a zip with no supplier on record, a part we make, lines in a draft PO and ordered, one set
 * aside; the stock that exists but may not be used; the Why drawer (the netting in words, the ladder, each order and
 * size, today's lots with why one is not counted, the open purchase lines with one too late); Draft POs per supplier
 * (into its open draft or a new one), its result, Set aside, Run history; and the states (no plan, covered, running,
 * failed, warnings, loading, error, no permission). Roles: Owner, Buyer, Planner (no money), Read-only, Sales (none).
 */

const run = (over: Partial<PlanRun> = {}): PlanRun => ({
  id: uid('5501', 14),
  companyId: SITE.companyId,
  siteId: SITE.id,
  trigger: 'MANUAL',
  status: 'DONE',
  orderLines: 61,
  startedAt: at(29, 6, 2),
  finishedAt: '2026-10-29T06:02:04.000Z',
  error: null,
  note: null,
  warnings: [],
  createdById: uid('3333', 1),
  requirements: 7,
  short: 6,
  version: 2,
  ...over,
})

const ORDERS = [
  { id: uid('5151', 42), number: 'SO-DEMO-0042' },
  { id: uid('5151', 43), number: 'SO-DEMO-0043' },
  { id: uid('5151', 44), number: 'SO-DEMO-0044' },
]

const line = (n: number, over: Partial<PlanLine>): PlanLine => ({
  id: uid('5502', n),
  runId: uid('5501', 14),
  seq: n * 10,
  version: 1,
  action: 'BUY',
  item: { id: MATERIALS.leather.id, code: MATERIALS.leather.code, name: MATERIALS.leather.name, kind: 'LEATHER', baseUom: 'FT2', purchaseUom: 'FT2', requiresCrViTest: true },
  colour: COLOURS.black,
  uom: 'FT2',
  grossQuantity: '420.0000',
  usableStock: '120.0000',
  heldStock: '0.0000',
  onOrder: '100.0000',
  netQuantity: '200.0000',
  suggestedQuantity: '210.0000',
  suggestedUom: 'FT2',
  suggestedBaseQuantity: '210.0000',
  estimatedHides: 9,
  needDate: '2026-11-26',
  orderBy: { date: '2026-11-12', leadTimeDays: 14, passed: false },
  supplier: { id: SUPPLIERS.tannery.id, code: SUPPLIERS.tannery.code, name: SUPPLIERS.tannery.legalName },
  orders: ORDERS.slice(0, 2),
  sources: [],
  decision: 'OPEN',
  decisionReason: null,
  decisionNote: null,
  purchaseOrderLineId: null,
  purchaseOrder: null,
  decidedAt: null,
  unitCost: '4.200000',
  expectedAmount: 88_200,
  currency: 'EUR',
  ...over,
})

const LINES: PlanLine[] = [
  line(1, { heldStock: '60.0000' }),
  line(2, {
    colour: COLOURS.red,
    grossQuantity: '202.1600',
    usableStock: '0.0000',
    onOrder: '0.0000',
    netQuantity: '202.1600',
    suggestedQuantity: '210.0000',
    suggestedBaseQuantity: '210.0000',
    estimatedHides: 4,
    needDate: '2026-11-10',
    orderBy: { date: '2026-10-27', leadTimeDays: 14, passed: true },
    orders: ORDERS.slice(1, 2),
    expectedAmount: 88_200,
  }),
  line(3, {
    item: { id: MATERIALS.protector.id, code: MATERIALS.protector.code, name: MATERIALS.protector.name, kind: 'PROTECTOR', baseUom: 'PCS', purchaseUom: 'PCS', requiresCrViTest: false },
    colour: null,
    uom: 'PCS',
    grossQuantity: '48.0000',
    usableStock: '16.0000',
    onOrder: '0.0000',
    netQuantity: '32.0000',
    suggestedQuantity: '36.0000',
    suggestedUom: 'PCS',
    suggestedBaseQuantity: '36.0000',
    estimatedHides: null,
    needDate: '2026-11-20',
    orderBy: { date: '2026-11-06', leadTimeDays: 14, passed: false },
    supplier: { id: SUPPLIERS.protector.id, code: SUPPLIERS.protector.code, name: SUPPLIERS.protector.legalName },
    orders: ORDERS,
    decision: 'ORDERED',
    purchaseOrderLineId: uid('5803', 1),
    purchaseOrder: { id: uid('5801', 7), number: 'PO-2026-0007', status: 'DRAFT' },
    decidedAt: at(29, 7, 10),
    unitCost: '6.500000',
    expectedAmount: 23_400,
  }),
  line(4, {
    item: { id: MATERIALS.zip.id, code: MATERIALS.zip.code, name: MATERIALS.zip.name, kind: 'TRIM', baseUom: 'PCS', purchaseUom: 'PCS', requiresCrViTest: false },
    colour: COLOURS.black,
    uom: 'PCS',
    grossQuantity: '30.0000',
    usableStock: '10.0000',
    onOrder: '0.0000',
    netQuantity: '20.0000',
    suggestedQuantity: '20.0000',
    suggestedUom: 'PCS',
    suggestedBaseQuantity: '20.0000',
    estimatedHides: null,
    needDate: '2026-11-24',
    orderBy: { date: '2026-11-24', leadTimeDays: null, passed: false },
    supplier: null,
    orders: ORDERS.slice(0, 1),
    unitCost: '1.800000',
    expectedAmount: 3_600,
  }),
  line(5, {
    item: { id: MATERIALS.lining.id, code: MATERIALS.lining.code, name: MATERIALS.lining.name, kind: 'LINING', baseUom: 'M', purchaseUom: 'M', requiresCrViTest: false },
    colour: COLOURS.grey,
    uom: 'M',
    grossQuantity: '18.5000',
    usableStock: '4.0000',
    onOrder: '0.0000',
    netQuantity: '14.5000',
    suggestedQuantity: '15.0000',
    suggestedUom: 'M',
    suggestedBaseQuantity: '15.0000',
    estimatedHides: null,
    needDate: '2026-11-18',
    orderBy: { date: '2026-11-04', leadTimeDays: 14, passed: false },
    supplier: { id: SUPPLIERS.fabric.id, code: SUPPLIERS.fabric.code, name: SUPPLIERS.fabric.legalName },
    decision: 'ORDERED',
    purchaseOrderLineId: uid('5803', 2),
    purchaseOrder: { id: uid('5801', 5), number: 'PO-2026-0005', status: 'SENT' },
    decidedAt: at(28, 15, 0),
    unitCost: '7.900000',
    expectedAmount: 11_850,
  }),
  line(6, {
    action: 'MAKE',
    item: { id: uid('7171', 9), code: 'DEMO-IMB-09', name: 'Imbottitura cucita schiena', kind: 'COMPONENT', baseUom: 'PCS', purchaseUom: 'PCS', requiresCrViTest: false },
    colour: null,
    uom: 'PCS',
    grossQuantity: '24.0000',
    usableStock: '0.0000',
    onOrder: '0.0000',
    netQuantity: '24.0000',
    suggestedQuantity: '24.0000',
    suggestedUom: 'PCS',
    suggestedBaseQuantity: '24.0000',
    estimatedHides: null,
    orderBy: null,
    supplier: null,
    unitCost: null,
    expectedAmount: null,
  }),
  line(7, {
    colour: COLOURS.grey,
    grossQuantity: '52.5000',
    usableStock: '0.0000',
    onOrder: '0.0000',
    netQuantity: '52.5000',
    suggestedQuantity: '60.0000',
    suggestedBaseQuantity: '60.0000',
    estimatedHides: 2,
    decision: 'IGNORED',
    decisionReason: 'STOCK_NOT_IN_SYSTEM',
    decisionNote: 'Two grey hides are in the sample room',
    orders: ORDERS.slice(2),
    decidedAt: at(29, 7, 30),
    expectedAmount: 25_200,
  }),
]

const SUMMARY: Plan['summary'] = { toBuy: 3, orderByPassed: 1, toMake: 1, inDraftPurchaseOrder: 1, ordered: 2, setAside: 1, shortWithHeldStock: 1 }

const HELD: StockLine[] = [
  {
    item: { id: MATERIALS.leather.id, code: MATERIALS.leather.code, name: MATERIALS.leather.name, baseUom: 'FT2' },
    colour: COLOURS.black,
    lot: { id: uid('6262', 44), code: 'LA-000044', qualityStatus: 'QUARANTINE', crViStatus: 'PENDING', qualityNote: null, receivedAt: at(27, 9), qualityDecidedAt: null },
    quantity: '60.0000',
    hides: 3,
    reason: 'CR_VI_PENDING',
    held: true,
  },
  // B-W2a-70: a hide under a quality hold (its lot is released): held, with the hold's reason.
  {
    item: { id: MATERIALS.leather.id, code: MATERIALS.leather.code, name: MATERIALS.leather.name, baseUom: 'FT2' },
    colour: COLOURS.black,
    lot: { id: uid('6262', 41), code: 'LA-000041', qualityStatus: 'RELEASED', crViStatus: 'PASS', qualityNote: null, receivedAt: at(14, 9), qualityDecidedAt: at(16, 11) },
    quantity: '24.5000',
    hides: 1,
    reason: 'QUALITY_HOLD',
    held: true,
    hide: { id: uid('6363', 7), code: 'H-DEMO-0007' },
    hold: { id: uid('6464', 1), subjectType: 'Hide', reasonCode: 'SHADE', reasonIt: 'Tonalità da verificare', reasonEn: 'Shade to check', placedAt: at(28, 15) },
  },
]

/** B-W2a-70: the pegging tree of the black leather — which supply covers which order line, size and work order. */
const PEGGING: PegDemand[] = [
  {
    requirementId: uid('5502', 1),
    kind: 'WORK_ORDER',
    order: { id: uid('5151', 43), number: 'SO-DEMO-0043' },
    orderLine: { id: uid('5152', 2), seq: 20 },
    size: '54',
    workOrder: { id: uid('9191', 41), number: 'WO-00041', status: 'RELEASED' },
    demandDate: '2026-11-20',
    quantity: '118.0000',
    planned: '0.0000',
    supplies: [
      { seq: 1, kind: 'RESERVATION', quantity: '60.0000', date: null, reservation: { id: uid('6565', 1), kind: 'HIDE', lot: { id: uid('6262', 41), code: 'LA-000041' }, hide: { id: uid('6363', 3), code: 'H-DEMO-0003' } }, purchaseOrder: null, firm: false },
      { seq: 2, kind: 'STOCK', quantity: '58.0000', date: null, reservation: null, purchaseOrder: null, firm: false },
    ],
  },
  {
    requirementId: uid('5502', 1),
    kind: 'ORDER_LINE',
    order: { id: uid('5151', 42), number: 'SO-DEMO-0042' },
    orderLine: { id: uid('5152', 1), seq: 10 },
    size: '52',
    workOrder: null,
    demandDate: '2026-11-26',
    quantity: '176.0000',
    planned: '76.0000',
    supplies: [
      { seq: 3, kind: 'PURCHASE_ORDER', quantity: '100.0000', date: '2026-11-20', reservation: null, purchaseOrder: { id: uid('5801', 3), number: 'PO-2026-0003', status: 'CONFIRMED', lineId: uid('5803', 3), seq: 10 }, firm: false },
      { seq: 4, kind: 'PLANNED', quantity: '76.0000', date: '2026-11-26', reservation: null, purchaseOrder: null, firm: false },
    ],
  },
  {
    requirementId: uid('5502', 1),
    kind: 'ORDER_LINE',
    order: { id: uid('5151', 42), number: 'SO-DEMO-0042' },
    orderLine: { id: uid('5152', 1), seq: 10 },
    size: '50',
    workOrder: null,
    demandDate: '2026-11-26',
    quantity: '126.0000',
    planned: '124.0000',
    supplies: [{ seq: 5, kind: 'PLANNED', quantity: '124.0000', date: '2026-11-24', reservation: null, purchaseOrder: null, firm: true }],
  },
]

const EXPLAIN: Explain = {
  run: run(),
  line: {
    ...LINES[0]!,
    sources: [
      { orderId: ORDERS[0]!.id, orderNumber: ORDERS[0]!.number, orderLineId: uid('5152', 1), lineSeq: 10, size: '50', pieces: 6, made: 0, quantity: '126.0000', issued: '0.0000', dueDate: '2026-11-26', workOrders: [] },
      { orderId: ORDERS[0]!.id, orderNumber: ORDERS[0]!.number, orderLineId: uid('5152', 1), lineSeq: 10, size: '52', pieces: 8, made: 0, quantity: '176.0000', issued: '0.0000', dueDate: '2026-11-26', workOrders: [] },
      { orderId: ORDERS[1]!.id, orderNumber: ORDERS[1]!.number, orderLineId: uid('5152', 2), lineSeq: 20, size: '54', pieces: 5, made: 1, quantity: '118.0000', issued: '0.0000', dueDate: '2026-12-04', workOrders: ['WO-00041'] },
    ],
  },
  pegging: PEGGING,
  bridge: [
    { step: 'NEED', quantity: '420.0000', uom: 'FT2' },
    { step: 'USABLE', quantity: '-120.0000', uom: 'FT2' },
    { step: 'ON_ORDER', quantity: '-100.0000', uom: 'FT2' },
    { step: 'SHORT', quantity: '200.0000', uom: 'FT2' },
    { step: 'ROUNDING', quantity: '10.0000', uom: 'FT2' },
    { step: 'BUY', quantity: '210.0000', uom: 'FT2' },
  ],
  rounding: [
    { rule: 'WHOLE_UNITS', quantity: '200.0000' },
    { rule: 'MULTIPLE', quantity: '210.0000' },
  ],
  now: {
    usableStock: '120.0000',
    heldStock: '60.0000',
    onOrder: '100.0000',
    netQuantity: '200.0000',
    changedSinceRun: false,
    stock: [
      { item: { id: MATERIALS.leather.id, code: MATERIALS.leather.code, name: MATERIALS.leather.name, baseUom: 'FT2' }, colour: COLOURS.black, lot: { id: uid('6262', 41), code: 'LA-000041', qualityStatus: 'RELEASED', crViStatus: 'PASS', qualityNote: null, receivedAt: at(14, 9), qualityDecidedAt: at(16, 11) }, quantity: '120.0000', hides: 5, reason: null, held: false },
      ...HELD,
      { item: { id: MATERIALS.leather.id, code: MATERIALS.leather.code, name: MATERIALS.leather.name, baseUom: 'FT2' }, colour: COLOURS.red, lot: { id: uid('6262', 39), code: 'LA-000039', qualityStatus: 'RELEASED', crViStatus: 'PASS', qualityNote: null, receivedAt: at(2, 9), qualityDecidedAt: at(3, 11) }, quantity: '25.5000', hides: 1, reason: 'OTHER_COLOUR', held: false },
    ],
    purchases: [
      { purchaseOrderId: uid('5801', 3), purchaseOrderNumber: 'PO-2026-0003', purchaseOrderStatus: 'CONFIRMED', purchaseOrderLineId: uid('5803', 3), seq: 10, openQuantity: '100.0000', dueDate: '2026-11-20', confirmed: true, counted: '100.0000', notCounted: '0.0000', why: null },
      { purchaseOrderId: uid('5801', 6), purchaseOrderNumber: 'PO-2026-0006', purchaseOrderStatus: 'SENT', purchaseOrderLineId: uid('5803', 6), seq: 20, openQuantity: '40.0000', dueDate: '2026-12-03', confirmed: false, counted: '0.0000', notCounted: '40.0000', why: 'TOO_LATE' },
    ],
  },
}

const DRAFTS: OpenDraft[] = [{ id: uid('5801', 7), number: 'PO-2026-0007', partyId: SUPPLIERS.protector.id, supplierName: SUPPLIERS.protector.legalName, lineCount: 2, siteId: SITE.id, currency: 'EUR' }, { id: uid('5801', 8), number: 'PO-2026-0008', partyId: SUPPLIERS.tannery.id, supplierName: SUPPLIERS.tannery.legalName, lineCount: 1, siteId: SITE.id, currency: 'EUR' }]

const plan = (over: Partial<Plan> = {}): Plan => ({ run: run(), latestAttempt: null, summary: SUMMARY, lines: LINES, ...over })

/** B-W2a-70: the line with the firm planned order (Move the firm order). */
const FIRM_LINE: PlanLine = { ...LINES[1]!, firm: { quantity: '210.0000', uom: 'FT2', baseQuantity: '210.0000', date: '2026-11-24', supplier: { id: SUPPLIERS.tannery.id, code: SUPPLIERS.tannery.code, name: SUPPLIERS.tannery.legalName }, firmedAt: at(28, 10), carried: true } }
const WITH_FIRM = LINES.map((entry) => (entry.id === FIRM_LINE.id ? FIRM_LINE : entry))

const WO = (n: number, style: string) => ({ id: uid('9191', n), number: `WO-DEMO-00${n}`, status: 'RELEASED', kind: 'PRODUCTION', dueDate: '2026-11-27', startedAt: null, style: { id: uid('7070', n), code: `MOD-${n}`, name: style } })
const SHORTAGES: Shortages = {
  siteId: SITE.id,
  asOf: '2026-10-29',
  latestRunId: uid('5501', 14),
  rows: [
    { workOrder: WO(41, 'Giacca Aero'), material: { itemId: MATERIALS.leather.id, itemColourId: COLOURS.black.id, label: 'DEMO-LEA-01 BLK', uom: 'FT2' }, word: 'NOT_ENOUGH', short: '62.0000', neededBy: '2026-11-20', expected: null, fixes: [{ kind: 'BUY', requirementId: LINES[0]!.id, purchaseOrder: null }] },
    { workOrder: { ...WO(42, 'Pantalone Strada'), startedAt: at(27, 7) }, material: { itemId: MATERIALS.lining.id, itemColourId: COLOURS.grey.id, label: 'DEMO-FOD-02 GRY', uom: 'M' }, word: 'DELAYED', short: '14.5000', neededBy: '2026-11-18', expected: { date: '2026-11-25', purchaseOrderNumber: 'PO-2026-0005' }, fixes: [{ kind: 'EXPEDITE', requirementId: null, purchaseOrder: { id: uid('5801', 5), number: 'PO-2026-0005', lineId: uid('5803', 2), dueDate: '2026-11-25' } }] },
    { workOrder: WO(44, 'Gilet Tour'), material: { itemId: MATERIALS.leather.id, itemColourId: COLOURS.red.id, label: 'DEMO-LEA-01 RED', uom: 'FT2' }, word: 'DELAYED', short: '202.1600', neededBy: '2026-11-10', expected: null, fixes: [{ kind: 'MOVE_FIRM', requirementId: FIRM_LINE.id, purchaseOrder: null }] },
  ],
}

const SEND_CARDS: SendCard[] = [
  { id: uid('5801', 8), number: 'PO-2026-0008', partyId: SUPPLIERS.tannery.id, status: 'DRAFT', version: 3, ready: true, checks: [{ code: 'LATE_FOR_LEAD_TIME', severity: 'WARNING', path: 'lines/0', message: '' }], recipient: { contactId: uid('6767', 1), name: 'Ufficio ordini Demo', email: 'ordini@conceria.example.com' }, confirmBy: at(31, 9), refused: null },
  { id: uid('5801', 9), number: 'PO-2026-0009', partyId: SUPPLIERS.fabric.id, status: 'DRAFT', version: 1, ready: false, checks: [{ code: 'NO_CONTACT_EMAIL', severity: 'BLOCKS', path: 'contact', message: '' }, { code: 'LINE_NOT_PRICED', severity: 'BLOCKS', path: 'lines/0', message: '' }], recipient: null, confirmBy: null, refused: null },
]

export interface PlanCase {
  role: Role
  model: PlanModel
}

function planCase(role: Role, over: Partial<PlanModel> = {}): PlanCase {
  const can = canOf(role)
  const noCost = !can.cost
  const value = plan({ lines: noCost ? LINES.map(({ unitCost: _unit, expectedAmount: _amount, ...rest }) => rest as PlanLine) : LINES })
  return {
    role,
    model: {
      prefix: PREFIX,
      can,
      sites: { status: 'ready', value: [SITE] },
      siteId: SITE.id,
      plan: { status: 'ready', value },
      view: 'open',
      q: '',
      held: HELD,
      live: 'live',
      updates: 0,
      running: false,
      drafting: [],
      notice: null,
      dialog: null,
      why: null,
      shortages: { status: 'ready', value: SHORTAGES },
      today: '2026-10-29',
      canFirm: role !== 'readOnly' && role !== 'sales',
      timeZone: TIME_ZONE,
      ...over,
    },
  }
}

function PlanDesign({ model }: { model: PlanCase }) {
  return inShell('/planning/mrp', createElement(PlanView, { model: model.model }), model.role)
}

const draftDialog = (lineIds: string[], over: Record<string, unknown> = {}): PlanModel['dialog'] => ({
  kind: 'draft',
  draft: { lines: LINES.filter((entry) => lineIds.includes(entry.id)), drafts: DRAFTS, draftsProblem: null, into: {}, suppliers: {}, supplierQuery: '', supplierOptions: SUPPLIER_LIST, busy: false, problem: null, result: null, ...over },
})
const OPEN_BUY = [LINES[0]!.id, LINES[1]!.id, LINES[3]!.id]

export const designScreen = defineDesignScreen<PlanCase>({
  screen: 'SCR-055',
  title: 'What to buy & make',
  view: PlanDesign,
  cases: [
    { id: 'plan', label: 'The plan: open lines, the netting in words, order-by dates, ≈ hides, the expected value (buyer)', model: planCase('buyer'), note: 'Lines are sorted by supplier, then order-by day. The red leather is past its order-by day.' },
    { id: 'all-lines', label: 'Rows ▾ All lines: in a draft PO, ordered (sent), set aside, to make', model: planCase('buyer', { view: 'all' }) },
    { id: 'tile-late', label: 'Tile pressed: order-by date passed', model: planCase('buyer', { view: 'late' }) },
    { id: 'held', label: 'Short although stock exists: the notice and the view', model: planCase('buyer', { view: 'held' }), note: 'The lot on hold waits for its chromium VI result; it may still become usable.' },
    { id: 'in-draft', label: 'Tile pressed: in a draft PO (the decision links to the PO)', model: planCase('buyer', { view: 'inDraft' }) },
    { id: 'set-aside-view', label: 'Tile pressed: set aside, with the reason', model: planCase('buyer', { view: 'setAside' }) },
    { id: 'search-empty', label: 'A search that matches nothing', model: planCase('buyer', { q: 'zzz' }) },
    { id: 'selection', label: 'Selection: Draft POs (reach in lines and suppliers), Set aside, Export', model: planCase('buyer', { selected: OPEN_BUY }) },
    { id: 'selection-mixed', label: 'Selection with a set-aside line: Put back appears', model: planCase('buyer', { view: 'all', selected: [LINES[0]!.id, LINES[6]!.id] }) },
    { id: 'why', label: 'Why this number: sentences, ladder, orders per size, today’s lots, purchase lines', model: planCase('buyer', { why: { lineId: LINES[0]!.id, explain: { status: 'ready', value: EXPLAIN } } }) },
    {
      id: 'why-changed',
      label: 'Why: today’s numbers differ from the run (Run the plan again)',
      model: planCase('buyer', { why: { lineId: LINES[0]!.id, explain: { status: 'ready', value: { ...EXPLAIN, now: { ...EXPLAIN.now, usableStock: '180.0000', netQuantity: '140.0000', changedSinceRun: true } } } } }),
    },
    { id: 'why-loading', label: 'Why: reading', model: planCase('buyer', { why: { lineId: LINES[1]!.id, explain: { status: 'loading' } } }) },
    { id: 'draft-dialog', label: 'Draft purchase orders: a card per supplier, its open draft or a new one, a line with no supplier', model: planCase('buyer', { dialog: draftDialog(OPEN_BUY) }) },
    { id: 'draft-new', label: 'Draft purchase orders: a new draft for the tannery, a supplier picked for the zip', model: planCase('buyer', { dialog: draftDialog(OPEN_BUY, { into: { [SUPPLIERS.tannery.id]: null }, suppliers: { [LINES[3]!.id]: SUPPLIERS.fabric } }) }) },
    {
      id: 'draft-refused',
      label: 'Draft purchase orders refused: a newer plan replaced this one',
      model: planCase('buyer', { dialog: draftDialog(OPEN_BUY.slice(0, 2), { problem: { key: 'plan.notice.planChanged' } }) }),
    },
    {
      id: 'draft-done',
      label: 'Drafts made: each PO with its lines (nothing sent)',
      model: planCase('buyer', {
        dialog: draftDialog(OPEN_BUY, {
          result: {
            orders: [
              { id: uid('5801', 8), number: 'PO-2026-0008', created: false, lineIds: [uid('5803', 11), uid('5803', 12)], lineCount: 3 },
              { id: uid('5801', 9), number: 'PO-2026-0009', created: true, lineIds: [uid('5803', 13)], lineCount: 1 },
            ],
            lines: [
              { requirementId: LINES[0]!.id, purchaseOrderId: uid('5801', 8), purchaseOrderLineId: uid('5803', 11) },
              { requirementId: LINES[1]!.id, purchaseOrderId: uid('5801', 8), purchaseOrderLineId: uid('5803', 12) },
              { requirementId: LINES[3]!.id, purchaseOrderId: uid('5801', 9), purchaseOrderLineId: uid('5803', 13) },
            ],
          },
        }),
      }),
    },
    {
      id: 'drafted-notice',
      label: 'One click Draft PO: the notice says where it went, with Open and Undo',
      model: planCase('buyer', { notice: { tone: 'success', words: { key: 'plan.notice.draftedInto', params: { number: 'PO-2026-0008', count: 2 } }, open: { href: `${PREFIX}/purchasing/orders/${uid('5801', 8)}`, label: 'PO-2026-0008' }, undo: { kind: 'draft', purchaseOrderLineIds: [uid('5803', 11)], cancelOrderIds: [] } } }),
    },
    { id: 'drafting', label: 'A Draft PO on its way (the row says so)', model: planCase('buyer', { drafting: [LINES[0]!.id] }) },
    { id: 'set-aside', label: 'Set aside 2 lines: a reason and a note', model: planCase('buyer', { dialog: { kind: 'setAside', lineIds: [LINES[0]!.id, LINES[3]!.id], reason: 'OTHER', note: '', busy: false, problem: null } }) },
    { id: 'history', label: 'Run history', model: planCase('buyer', { dialog: { kind: 'history', runs: [run(), run({ id: uid('5501', 13), status: 'FAILED', startedAt: at(28, 18, 40), finishedAt: at(28, 18, 41), requirements: 0, short: 0 }), run({ id: uid('5501', 12), status: 'SUPERSEDED', startedAt: at(28, 6, 2), finishedAt: at(28, 6, 3), trigger: 'ORDER' })], problem: null } }) },
    { id: 'explainer', label: 'What the plan counts', model: planCase('buyer', { dialog: { kind: 'explainer' } }) },
    { id: 'keys', label: 'Keyboard shortcuts', model: planCase('buyer', { dialog: { kind: 'keys' } }) },
    { id: 'keyboard', label: 'Keyboard: j / k on the rows (the keys sit in the footer icon)', model: planCase('buyer', { focusRow: 1, keysOpen: true }) },
    { id: 'live-update', label: 'A newer run finished: 1 update · Show', model: planCase('buyer', { updates: 1 }) },
    { id: 'running', label: 'A newer run is going: Run plan now held, the plan shown stays', model: planCase('buyer', { plan: { status: 'ready', value: plan({ latestAttempt: run({ id: uid('5501', 15), status: 'RUNNING', startedAt: at(29, 9, 41), finishedAt: null }) }) } }) },
    { id: 'failed', label: 'The last run failed: you still see the 07:02 plan', model: planCase('buyer', { plan: { status: 'ready', value: plan({ latestAttempt: run({ id: uid('5501', 15), status: 'FAILED', startedAt: at(29, 9, 41), finishedAt: at(29, 9, 41) }) }) } }) },
    {
      id: 'warnings',
      label: 'The run’s warnings (an order line it could not plan)',
      model: planCase('buyer', { plan: { status: 'ready', value: plan({ run: run({ warnings: [{ code: 'NO_RELEASED_BOM', orderId: ORDERS[2]!.id }, { code: 'SEVERAL_SUPPLIERS', itemId: MATERIALS.zip.id }, { code: 'SEVERAL_SUPPLIERS', itemId: MATERIALS.lining.id }] }) }) } }),
    },
    { id: 'no-plan', label: 'First day: no plan for this site yet', model: planCase('buyer', { plan: { status: 'ready', value: { run: null, latestAttempt: null, summary: { toBuy: 0, orderByPassed: 0, toMake: 0, inDraftPurchaseOrder: 0, ordered: 0, setAside: 0, shortWithHeldStock: 0 }, lines: [] } }, held: [] }) },
    { id: 'covered', label: 'Nothing to buy or make', model: planCase('buyer', { plan: { status: 'ready', value: plan({ summary: { toBuy: 0, orderByPassed: 0, toMake: 0, inDraftPurchaseOrder: 0, ordered: 0, setAside: 0, shortWithHeldStock: 0 }, lines: LINES.slice(2, 3).map((entry) => ({ ...entry, netQuantity: '0.0000', decision: 'OPEN', purchaseOrder: null })) }) }, held: [] }) },
    { id: 'two-sites', label: 'Two sites: the site is picked in the band', model: planCase('buyer', { sites: { status: 'ready', value: [SITE, SITE_SOUTH] } }) },
    { id: 'loading', label: 'Loading', model: planCase('buyer', { plan: { status: 'loading' }, live: 'connecting' }) },
    { id: 'error', label: "The plan couldn't be read", model: planCase('buyer', { plan: { status: 'error', problem: 'problem.offline' }, live: 'offline' }) },
    { id: 'short-wo', label: 'W2a Short on open work orders: the fix beside each (Buy · Expedite PO · Move the firm order)', model: planCase('buyer', { view: 'shortWo', plan: { status: 'ready', value: plan({ lines: WITH_FIRM }) } }), note: 'Computed now from the live plan. Buy drafts the plan’s line in one click; Expedite opens the PO (Remind chases the supplier); Move asks a day for the firm order. Swap is a later wave.' },
    { id: 'short-wo-selection', label: 'W2a Short on open work orders: selection drafts the Buy lines', model: planCase('buyer', { view: 'shortWo', selected: [`${uid('9191', 41)}:${MATERIALS.leather.id}:${COLOURS.black.id}`, `${uid('9191', 42)}:${MATERIALS.lining.id}:${COLOURS.grey.id}`] }) },
    { id: 'short-wo-planner', label: 'W2a Short on open work orders as a planner: Buy held (buyers make POs; the line waits in Requests to buy)', model: planCase('planner', { view: 'shortWo' }) },
    { id: 'short-wo-empty', label: 'W2a No work order is waiting for material', model: planCase('buyer', { view: 'shortWo', shortages: { status: 'ready', value: { ...SHORTAGES, rows: [] } } }) },
    { id: 'short-wo-error', label: 'W2a Short on open work orders could not be read', model: planCase('buyer', { view: 'shortWo', shortages: { status: 'error', problem: 'problem.offline' } }) },
    { id: 'move-firm', label: 'W2a Move the firm planned order earlier', model: planCase('buyer', { view: 'shortWo', plan: { status: 'ready', value: plan({ lines: WITH_FIRM }) }, dialog: { kind: 'moveFirm', requirementId: FIRM_LINE.id, date: '2026-11-09', busy: false, problem: null } }) },
    { id: 'why-firm', label: 'W2a Why: a firm planned order carried from an earlier plan', model: planCase('buyer', { plan: { status: 'ready', value: plan({ lines: WITH_FIRM }) }, why: { lineId: FIRM_LINE.id, explain: { status: 'ready', value: { ...EXPLAIN, line: { ...FIRM_LINE, sources: [] }, pegging: [] } } } }) },
    {
      id: 'send',
      label: 'W2a Drafts made → Review and send: one card per order, ready or what blocks it',
      model: planCase('buyer', {
        dialog: draftDialog(OPEN_BUY, {
          result: { orders: [{ id: uid('5801', 8), number: 'PO-2026-0008', created: false, lineIds: [uid('5803', 11), uid('5803', 12)], lineCount: 3 }, { id: uid('5801', 9), number: 'PO-2026-0009', created: true, lineIds: [uid('5803', 13)], lineCount: 1 }], lines: [] },
          send: { cards: SEND_CARDS, problem: null, busy: false, outcomes: null },
        }),
      }),
    },
    {
      id: 'send-done',
      label: 'W2a Send n done: what went, what was refused',
      model: planCase('buyer', {
        dialog: draftDialog(OPEN_BUY, {
          result: { orders: [{ id: uid('5801', 8), number: 'PO-2026-0008', created: false, lineIds: [uid('5803', 11)], lineCount: 3 }], lines: [] },
          send: { cards: SEND_CARDS, problem: null, busy: false, outcomes: [{ id: uid('5801', 8), number: 'PO-2026-0008', outcome: 'SENT', refused: null }] },
        }),
      }),
    },
    { id: 'owner', label: 'Owner: everything', model: planCase('owner') },
    { id: 'planner', label: 'Planner: no money (no value column); Draft PO held — buyers make POs', model: planCase('planner') },
    { id: 'read-only', label: 'Read-only: sees the plan; Run, Draft PO and Set aside held with their reasons', model: planCase('readOnly', { selected: OPEN_BUY }) },
    { id: 'sales', label: 'Sales: no planning.view — the page says so (the row is hidden in the navigation)', model: planCase('sales') },
  ],
})
