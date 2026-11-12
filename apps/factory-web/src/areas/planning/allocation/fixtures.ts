import { createElement, type ReactNode } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { permissionCheck } from '../../../lib/session/session'
import { officeNavFor } from '../../../shell/nav/office-nav'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER, rolePermissions } from '../../../shell/design-data'
import { OfficeShellView, type OfficeShellViewModel } from '../../../shell/office/view/OfficeShellView'
import { SITES } from '../board/fixtures'
import type { Allocation, AllocationCard } from './api'
import type { AllocationWorkshops, DepthOperation, FromAllocation, KitTiming, WorkOrderWorkshops } from './depth/api'
import type { AllocationViewModel, CardOperations } from './view-model'
import { AllocationView } from './view/AllocationView'

/**
 * SCR-126 Lines & subcontractors with made-up data: an invented site, lines, a workshop ("Laboratorio Beta") and work
 * orders. Nothing here is a real company, supplier, person or number. Design-only. Drawn inside the Office shell (the
 * planner's navigation): unlike the board, this page is an Office page.
 */

const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const NOW = new Date(Date.UTC(2026, 10, 16, 8, 42)).toISOString()
const SITE = { ...SITES[0]! }
const LINE1 = { kind: 'LINE' as const, id: uid('4444', 1) }
const LINE2 = { kind: 'LINE' as const, id: uid('4444', 2) }
const BETA = { kind: 'WORKSHOP' as const, id: uid('5555', 1) }
const GAMMA = { kind: 'WORKSHOP' as const, id: uid('5555', 2) }

const style = (n: number, name: string) => ({ id: uid('6666', n), code: `MOD-${String(n).padStart(3, '0')}`, name })
const workOrder = (n: number, name: string, garments: number, due: string | null, extra: Partial<AllocationCard['workOrder']> = {}): AllocationCard['workOrder'] => ({
  id: uid('9999', n),
  number: `WO-0${n}`,
  status: 'RELEASED',
  version: 3,
  dueDate: due,
  style: style(n - 100, name),
  garments,
  holdReason: null,
  ...extra,
})

const W101 = workOrder(101, 'Giacca Aero', 120, '2026-11-27')
const W102 = workOrder(102, 'Pantalone Strada', 80, '2026-11-20')
const W103 = workOrder(103, 'Gilet Pista', 40, '2026-11-24', { status: 'IN_PROGRESS', version: 7 })
const W104 = workOrder(104, 'Giacca Touring', 60, '2026-12-04', { status: 'DRAFT', version: 1 })
const W105 = workOrder(105, 'Tuta Corsa', 30, '2026-11-19')
const W106 = workOrder(106, 'Giubbino Città', 50, null)

const card = (id: string, wo: AllocationCard['workOrder'], lane: AllocationCard['lane'], pieces: number, minutes: number, status: AllocationCard['schedule']['status'], slot: AllocationCard['slot'] = null): AllocationCard => ({
  id,
  workOrder: wo,
  lane,
  pieces,
  minutes: minutes.toFixed(1),
  slot,
  schedule: { status, latestSafeStart: null },
})

export const ALLOCATION: Allocation = {
  site: SITE,
  asOf: NOW,
  today: '2026-11-16',
  plan: { id: uid('abcd', 1), version: 12 },
  mayChange: true,
  lanes: [
    { ...LINE1, code: 'L1', name: 'Linea 1', load: { availableMinutes: '61200.0', bookedMinutes: '48540.0', loadPct: '79.3', overMinutes: '0.0' }, piecesBooked: 160, location: null, subcontractOrders: null },
    { ...LINE2, code: 'L2', name: 'Linea 2', load: { availableMinutes: '41040.0', bookedMinutes: '44280.0', loadPct: '107.9', overMinutes: '3240.0' }, piecesBooked: 100, location: null, subcontractOrders: null },
    { ...BETA, code: 'LAB-B', name: 'Laboratorio Beta', load: null, piecesBooked: 30, location: { id: uid('7171', 1), code: 'SUB-BETA' }, subcontractOrders: 1 },
    { ...GAMMA, code: 'LAB-G', name: 'Laboratorio Gamma', load: null, piecesBooked: 0, location: { id: uid('7171', 2), code: 'SUB-GAMMA' }, subcontractOrders: 0 },
  ],
  cards: [
    card(`${W101.id}:LINE`, W101, LINE1, 120, 4680, 'ON_TIME'),
    card(`${W103.id}:LINE`, W103, LINE1, 40, 1600, 'AT_RISK'),
    card(`${W102.id}:LINE`, W102, LINE2, 60, 1500, 'LATE'),
    card(`${W102.id}:${uid('8888', 9)}`, W102, BETA, 20, 500, 'LATE', { id: uid('8888', 9), version: 1 }),
    card(`${W105.id}:LINE`, W105, LINE2, 20, 700, 'LATE'),
    card(`${W105.id}:${uid('8888', 6)}`, W105, BETA, 10, 350, 'LATE', { id: uid('8888', 6), version: 2 }),
    card(`${W104.id}:LINE`, W104, null, 60, 2340, 'ON_TIME'),
    card(`${W106.id}:LINE`, W106, null, 50, 1900, 'NO_DUE_DATE'),
  ],
}

// ---- B-W2b-338: which workshops take each work order's outside work (made-up) ----

const op = (wo: number, seq: number, name: string, kind: string, extra: Partial<DepthOperation> = {}): DepthOperation => ({ id: uid('7373', wo * 100 + seq), seq, code: `OP-${seq}`, name, workCentreKind: kind, outsourced: false, subcontractOrderId: null, outsideStep: false, version: 2, ...extra })
const SEW = (wo: number, extra: Partial<DepthOperation> = {}) => op(wo, 20, 'Cucitura corpo', 'SEWING', extra)
const POCKETS = (wo: number) => op(wo, 30, 'Tasche paraschiena', 'SEWING')
const FINISH = (wo: number) => op(wo, 40, 'Finitura', 'FINISHING')
const BETA_PARTY = BETA.id
const GAMMA_PARTY = GAMMA.id
const offered = (partyId: string, warnings: AllocationWorkshops['workOrders'][number]['workshops'][number]['warnings'] = []) => ({ partyId, offered: true, held: [], warnings })
const gammaHeld = { partyId: GAMMA_PARTY, offered: false, held: [{ code: 'NO_VALID_DURC' as const, words: 'No valid DURC: it expired on 2026-11-05.' }], warnings: [] }

export const WORKSHOPS: AllocationWorkshops = {
  site: SITE,
  today: '2026-11-16',
  asOf: NOW,
  window: { from: '2026-11-16', to: '2026-12-13' },
  workshops: [
    {
      id: BETA_PARTY,
      code: 'LAB-B',
      name: 'Laboratorio Beta',
      location: { id: uid('7171', 1), code: 'SUB-BETA' },
      active: true,
      supplierProblem: null,
      durc: { checked: true, state: 'MET', expiresOn: '2027-06-30' },
      capacity: [
        { workCentreKind: 'SEWING', unit: 'MINUTES', available: '9600.0', booked: '1350.0', proposed: '800.0', loadPct: '14.1', over: false },
        { workCentreKind: null, unit: 'PIECES', available: '240.0', booked: '30.0', proposed: '0.0', loadPct: '12.5', over: false },
      ],
      qualifications: [
        { workCentreKind: 'SEWING', qualified: true, standing: 'QUALIFIED', words: 'Qualified until 30 June 2027.' },
        { workCentreKind: 'FINISHING', qualified: true, standing: 'CONDITIONAL', words: 'Qualified with conditions: second check on seams' },
        { workCentreKind: 'CUTTING', qualified: false, standing: 'NONE', words: 'Not qualified for this work: no qualification covers it.' },
      ],
    },
    {
      id: GAMMA_PARTY,
      code: 'LAB-G',
      name: 'Laboratorio Gamma',
      location: { id: uid('7171', 2), code: 'SUB-GAMMA' },
      active: true,
      supplierProblem: null,
      durc: { checked: true, state: 'EXPIRED', expiresOn: '2026-11-05' },
      capacity: [{ workCentreKind: null, unit: null, available: null, booked: '0.0', proposed: '0.0', loadPct: null, over: false }],
      qualifications: [{ workCentreKind: 'SEWING', qualified: true, standing: 'QUALIFIED', words: 'Qualified.' }],
    },
  ],
  workOrders: [
    { workOrder: { id: W101.id, number: W101.number, status: W101.status, version: W101.version }, operations: [SEW(101), FINISH(101)], workshops: [offered(BETA_PARTY, [{ code: 'CONDITIONAL', words: 'Approved for finishing (Op 40 Finitura) with conditions: second check on seams' }]), gammaHeld] },
    { workOrder: { id: W102.id, number: W102.number, status: W102.status, version: W102.version }, operations: [SEW(102, { outsourced: true, version: 4 })], workshops: [offered(BETA_PARTY), gammaHeld] },
    { workOrder: { id: W103.id, number: W103.number, status: W103.status, version: W103.version }, operations: [SEW(103)], workshops: [offered(BETA_PARTY, [{ code: 'OVER_CAPACITY', words: 'Laboratorio Beta would be at 112.0% of its capacity while the work is there.' }]), gammaHeld] },
    {
      workOrder: { id: W104.id, number: W104.number, status: W104.status, version: W104.version },
      operations: [SEW(104), POCKETS(104)],
      workshops: [{ partyId: BETA_PARTY, offered: false, held: [{ code: 'NOT_QUALIFIED', words: 'Not approved for sewing (Op 30 Tasche paraschiena): being reviewed: not qualified yet.' }], warnings: [] }, gammaHeld],
    },
    { workOrder: { id: W105.id, number: W105.number, status: W105.status, version: W105.version }, operations: [SEW(105, { outsourced: true, subcontractOrderId: uid('5151', 1), version: 5 })], workshops: [offered(BETA_PARTY), gammaHeld] },
    { workOrder: { id: W106.id, number: W106.number, status: W106.status, version: W106.version }, operations: [SEW(106)], workshops: [offered(BETA_PARTY, [{ code: 'DURC_EXPIRING', words: 'Its DURC expires on 2026-12-01.' }]), gammaHeld] },
  ],
}

const KIT: KitTiming = {
  workOrder: { id: W101.id, number: W101.number, status: W101.status, garments: 120 },
  workshop: { id: BETA_PARTY, code: 'LAB-B', name: 'Laboratorio Beta' },
  operations: [{ id: SEW(101).id, seq: 20, code: 'OP-20', name: 'Cucitura corpo', workCentreKind: 'SEWING' }, { id: FINISH(101).id, seq: 40, code: 'OP-40', name: 'Finitura', workCentreKind: 'FINISHING' }],
  pieces: 120,
  start: '2026-11-23',
  startSource: 'SCHEDULE',
  transportDays: 2,
  transportSource: 'DEFAULT',
  kitShipOn: '2026-11-19',
  kitDueAt: '2026-11-19T07:00:00.000Z',
  late: false,
  workDays: 4,
  workDaysSource: 'CAPACITY',
  backOn: '2026-12-01',
  closedDaysSkipped: 0,
  kit: {
    note: null,
    lines: [
      { item: { id: uid('3131', 1), code: 'PEL-CAP-NERO', name: 'Pelle bovina 1,2 mm nero' }, colour: { id: uid('3232', 1), code: 'NERO' }, quantity: '86.400', uom: 'DM2' },
      { item: { id: uid('3131', 2), code: 'FOD-MESH', name: 'Fodera rete traspirante' }, colour: null, quantity: '13.230', uom: 'M' },
      { item: { id: uid('3131', 3), code: 'PRT-SPALLA', name: 'Protezione spalla livello 2' }, colour: null, quantity: '240', uom: 'PCS' },
    ],
  },
  laterOperations: [
    { id: uid('7373', 10150), seq: 50, name: 'Controllo finale', earliestStart: '2026-12-01', latestStart: '2026-12-04', finishesLate: false },
    { id: uid('7373', 10160), seq: 60, name: 'Imballaggio', earliestStart: '2026-12-02', latestStart: '2026-12-07', finishesLate: false },
  ],
  finishesLate: false,
}

const KIT_LATE: KitTiming = {
  ...KIT,
  workOrder: { id: W103.id, number: W103.number, status: W103.status, garments: 40 },
  pieces: 40,
  start: '2026-11-17',
  startSource: 'TODAY',
  transportDays: 3,
  transportSource: 'WORKSHOP',
  kitShipOn: '2026-11-12',
  kitDueAt: '2026-11-12T07:00:00.000Z',
  late: true,
  workDays: 2,
  workDaysSource: 'ROUTING',
  backOn: '2026-11-24',
  closedDaysSkipped: 1,
  laterOperations: [{ id: uid('7373', 10350), seq: 50, name: 'Controllo finale', earliestStart: '2026-11-24', latestStart: '2026-11-21', finishesLate: true }],
  finishesLate: true,
}

const OPERATIONS: CardOperations = {
  mayOutsource: true,
  operations: [
    { ...op(102, 10, 'Taglio pannelli', 'CUTTING'), remaining: 0, workshopName: null },
    { ...SEW(102, { outsourced: true, version: 4 }), remaining: 20, workshopName: 'Laboratorio Beta' },
    { ...op(102, 40, 'Finitura', 'FINISHING'), remaining: 80, workshopName: null },
    { ...op(102, 50, 'Imballaggio', 'PACKING'), remaining: 80, workshopName: null },
  ],
}

const workshopView = (base: AllocationWorkshops['workshops'][number]) => ({ id: base.id, code: base.code, name: base.name, location: base.location, active: base.active, supplierProblem: base.supplierProblem, durc: base.durc, capacity: base.capacity })
const SWITCH: WorkOrderWorkshops = {
  workOrder: { id: W101.id, number: W101.number, status: W101.status, version: W101.version, garments: 120, style: 'MOD-001' },
  asOf: NOW,
  operations: [FINISH(101)],
  mayOutsource: true,
  workshops: [
    { ...workshopView(WORKSHOPS.workshops[0]!), routing: true, offered: true, held: [], warnings: [{ code: 'CONDITIONAL', words: 'Approved for finishing (Op 40 Finitura) with conditions: second check on seams' }], operations: [{ operationId: FINISH(101).id, qualified: true, standing: 'CONDITIONAL', words: 'Qualified with conditions: second check on seams' }] },
    { ...workshopView(WORKSHOPS.workshops[1]!), routing: false, offered: false, held: [{ code: 'NO_VALID_DURC', words: 'No valid DURC: it expired on 2026-11-05.' }, { code: 'NOT_QUALIFIED', words: 'Not approved for finishing (Op 40 Finitura): suspended: seams opened on the last lot.' }], warnings: [{ code: 'NO_CAPACITY_SET', words: 'Laboratorio Gamma has no weekly capacity set: its load is not known.' }], operations: [{ operationId: FINISH(101).id, qualified: false, standing: 'SUSPENDED', words: 'Suspended: seams opened on the last lot.' }] },
  ],
}
const SWITCH_IN: WorkOrderWorkshops = { ...SWITCH, workOrder: { ...SWITCH.workOrder, id: W102.id, number: W102.number, garments: 80 }, operations: [SEW(102, { outsourced: true, version: 4 })] }

const PARTS = [`${W102.id}:${uid('8888', 9)}`, `${W105.id}:${uid('8888', 6)}`]
const PREVIEW: FromAllocation = {
  preview: true,
  made: 0,
  held: 1,
  asOf: NOW,
  results: [
    { slotId: uid('8888', 9), ok: true, workOrder: { id: W102.id, number: W102.number }, workshop: { id: BETA_PARTY, code: 'LAB-B', name: 'Laboratorio Beta' }, operations: [{ id: SEW(102).id, seq: 20, name: 'Cucitura corpo' }], pieces: 20, order: null, kitShipOn: '2026-11-18', backOn: '2026-11-27', problems: [], warnings: [] },
    { slotId: uid('8888', 6), ok: false, workOrder: { id: W105.id, number: W105.number }, workshop: { id: BETA_PARTY, code: 'LAB-B', name: 'Laboratorio Beta' }, operations: [{ id: SEW(105).id, seq: 20, name: 'Cucitura corpo' }], pieces: 0, order: null, kitShipOn: null, backOn: null, problems: ["WO-0105's garments at this workshop are on a subcontract order already."], warnings: [] },
  ],
}
const DONE: FromAllocation = { ...PREVIEW, preview: false, made: 1, held: 0, results: [{ ...PREVIEW.results[0]!, order: { id: uid('5151', 2), number: 'SC-2026-0007', status: 'DRAFT', kitDueAt: '2026-11-18T07:00:00.000Z' } }] }

const PLANNER = rolePermissions('planner')
const BUYER_PLANNER = [...new Set([...rolePermissions('planner'), ...rolePermissions('buyer')])]

function inShell(page: ReactNode, permissions: readonly string[] = PLANNER): ReactNode {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck(permissions)),
    path: '/planning/allocation',
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: [], site: null, path: '/planning/allocation' },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}

interface AllocationCase {
  view: AllocationViewModel
  permissions?: readonly string[]
}

function AllocationDesign({ model }: { model: AllocationCase }) {
  return inShell(createElement(AllocationView, { model: model.view }), model.permissions)
}

const base = (over: Partial<AllocationViewModel> = {}): AllocationViewModel => ({
  prefix: '/w/DEMO',
  sites: SITES,
  controls: { site: SITE.id, card: null },
  read: { status: 'ready', value: ALLOCATION },
  workshops: { status: 'ready', value: WORKSHOPS },
  may: { outsource: true, order: true },
  offline: false,
  save: { state: 'idle' },
  dialog: null,
  notice: null,
  ...over,
})

const one = (view: AllocationViewModel, permissions?: readonly string[]): AllocationCase => ({ view, ...(permissions ? { permissions } : {}) })

export const designScreen = defineDesignScreen<AllocationCase>({
  screen: 'SCR-126',
  title: 'Lines & subcontractors',
  view: AllocationDesign,
  cases: [
    { id: 'board', label: 'Allocation board (buyer-planner): workshops as columns with their reasons', model: one(base(), BUYER_PLANNER), note: 'One load tile per line and workshop (a workshop: its fullest capacity line, in minutes or garments), then Not allocated · Line 1 · Line 2 · the workshops. Laboratorio Beta says what it is approved for and its DURC; Laboratorio Gamma is a held drop zone (no valid DURC). Dragging WO-0104 onto Beta is held: not approved for Op 30 Tasche paraschiena. Cards with an operation outside carry the chip. Create subcontract orders (1): the part of WO-0102 at Beta.' },
    { id: 'part', label: 'Move part of an order; the card’s operations', model: one(base({ dialog: { kind: 'card', cardId: `${W101.id}:LINE`, operations: { status: 'ready', value: OPERATIONS } } })), note: 'The card detail: how many garments go to which line or workshop; the rest stays. Below, every operation in-house or outside with Send outside… / Bring in-house… (board#4).' },
    { id: 'operations-loading', label: 'The card’s operations: reading', model: one(base({ dialog: { kind: 'card', cardId: `${W101.id}:LINE`, operations: { status: 'loading' } } })) },
    { id: 'operations-error', label: 'The card’s operations could not be read', model: one(base({ dialog: { kind: 'card', cardId: `${W101.id}:LINE`, operations: { status: 'error', problem: 'offline' } } })) },
    { id: 'kit', label: 'Drop on a workshop: Send to Laboratorio Beta (kit timing)', model: one(base({ dialog: { kind: 'kit', cardId: `${W101.id}:LINE`, laneKey: `WORKSHOP:${BETA_PARTY}`, pieces: 120, timing: { status: 'ready', value: KIT } } }), BUYER_PLANNER), note: 'Kit ship-out = start − 2 transport days, the kit list from the bill of materials, the return date and the later operations it drives; the condition on finishing is said, never held. Allocate books the workshop on the board.' },
    { id: 'kit-late', label: 'Kit timing: the kit is late and the order would finish late', model: one(base({ dialog: { kind: 'kit', cardId: `${W103.id}:LINE`, laneKey: `WORKSHOP:${BETA_PARTY}`, pieces: 40, timing: { status: 'ready', value: KIT_LATE } } })), note: 'The kit should have left on Thu 12 Nov; one closed day of the workshop skipped; Op 50 can start only after its latest start; Beta would be over its capacity (said, not held).' },
    { id: 'kit-loading', label: 'Kit timing: reading', model: one(base({ dialog: { kind: 'kit', cardId: `${W101.id}:LINE`, laneKey: `WORKSHOP:${BETA_PARTY}`, pieces: 120, timing: { status: 'loading' } } })) },
    { id: 'kit-error', label: 'Kit timing could not be read', model: one(base({ dialog: { kind: 'kit', cardId: `${W101.id}:LINE`, laneKey: `WORKSHOP:${BETA_PARTY}`, pieces: 120, timing: { status: 'error', problem: 'failed' } } })) },
    { id: 'kit-no-work', label: 'Kit timing: nothing left to send out', model: one(base({ dialog: { kind: 'kit', cardId: `${W101.id}:LINE`, laneKey: `WORKSHOP:${BETA_PARTY}`, pieces: 120, timing: { status: 'error', problem: 'noWork' } } })), note: 'Nothing the work order makes is left (no outside work): Allocate is held with that; the drag onto a workshop is held the same way.' },
    { id: 'kit-refused', label: 'Kit timing: Allocate refused', model: one(base({ dialog: { kind: 'kit', cardId: `${W101.id}:LINE`, laneKey: `WORKSHOP:${BETA_PARTY}`, pieces: 120, timing: { status: 'ready', value: KIT }, error: 'The work order changed since it was read: the board was read again.' } })) },
    { id: 'switch-outside', label: 'Send Op 40 Finitura outside: approved and held workshops', model: one(base({ dialog: { kind: 'switch', cardId: `${W101.id}:LINE`, operationId: FINISH(101).id, mode: 'outside', workshops: { status: 'ready', value: SWITCH }, partyId: BETA_PARTY } }), BUYER_PLANNER), note: 'Beta is approved with a condition (said); Gamma cannot be picked and says why: no valid DURC, finishing suspended.' },
    { id: 'switch-planner', label: 'Send outside as a planner: the buyer makes the order', model: one(base({ may: { outsource: true, order: false }, dialog: { kind: 'switch', cardId: `${W101.id}:LINE`, operationId: FINISH(101).id, mode: 'outside', workshops: { status: 'ready', value: SWITCH } } })), note: 'No workshop picked yet: Send outside is held and says why. Without the subcontracting permission no order is made.' },
    { id: 'switch-in-house', label: 'Bring Op 20 back in-house: the reason', model: one(base({ dialog: { kind: 'switch', cardId: `${W102.id}:LINE`, operationId: SEW(102).id, mode: 'in-house', workshops: { status: 'ready', value: SWITCH_IN }, reason: 'Linea 2 ha capacità libera' } }), BUYER_PLANNER) },
    { id: 'switch-refused', label: 'A refused switch: the kit is at the workshop', model: one(base({ dialog: { kind: 'switch', cardId: `${W102.id}:LINE`, operationId: SEW(102).id, mode: 'in-house', workshops: { status: 'ready', value: SWITCH_IN }, reason: 'Linea 2 ha capacità libera', error: 'The kit or pieces are at the workshop: take them back on the subcontract order first.' } }), BUYER_PLANNER) },
    { id: 'orders', label: 'Create subcontract orders: the review', model: one(base({ dialog: { kind: 'orders', slotIds: PARTS, preview: { status: 'ready', value: PREVIEW }, phase: 'ready' } }), BUYER_PLANNER), note: 'One part becomes a draft order with its kit dates; the other is left out with why (already on an order).' },
    { id: 'orders-done', label: 'Create subcontract orders: made', model: one(base({ dialog: { kind: 'orders', slotIds: PARTS, preview: { status: 'ready', value: PREVIEW }, phase: 'done', result: DONE } }), BUYER_PLANNER) },
    { id: 'orders-held', label: 'Create subcontract orders held: a planner without the subcontracting permission', model: one(base({ may: { outsource: true, order: false } })), note: 'The primary stays focusable and says why: the buyer makes the orders.' },
    { id: 'workshops-error', label: 'The workshops’ check could not be read: every workshop column is held', model: one(base({ workshops: { status: 'error', problem: 'offline' } })), note: 'Fail closed: an unchecked workshop never takes a drop.' },
    { id: 'refused', label: 'A refused move', model: one(base({ save: { state: 'failed', refusal: 'UNALLOCATED_PART' }, dialog: { kind: 'card', cardId: `${W105.id}:${uid('8888', 6)}` } })), note: 'A part card; a refusal is said in words in the dialog and the status line.' },
    { id: 'read-only', label: 'Read-only (production manager)', model: one(base({ read: { status: 'ready', value: { ...ALLOCATION, mayChange: false } } }), rolePermissions('production_manager')), note: 'Cards cannot be moved: the reason shows at rest and on the first attempt.' },
    { id: 'offline', label: 'Offline', model: one(base({ offline: true })) },
    { id: 'empty', label: 'Nothing to allocate', model: one(base({ read: { status: 'ready', value: { ...ALLOCATION, cards: [] } } })) },
    { id: 'keys', label: 'Keyboard shortcuts', model: one(base({ dialog: { kind: 'keys' } })) },
    { id: 'loading', label: 'Loading', model: one(base({ read: { status: 'loading' } })) },
    { id: 'error', label: 'Could not load', model: one(base({ read: { status: 'error', problem: 'failed' } })), note: 'A failed read is never drawn as an empty board.' },
    { id: 'no-permission', label: 'No permission', model: one(base({ read: { status: 'error', problem: 'forbidden' } })) },
  ],
})
