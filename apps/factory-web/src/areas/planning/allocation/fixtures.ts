import { createElement, type ReactNode } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { permissionCheck } from '../../../lib/session/session'
import { officeNavFor } from '../../../shell/nav/office-nav'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER, rolePermissions } from '../../../shell/design-data'
import { OfficeShellView, type OfficeShellViewModel } from '../../../shell/office/view/OfficeShellView'
import { SITES } from '../board/fixtures'
import type { Allocation, AllocationCard } from './api'
import type { AllocationViewModel } from './view-model'
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

const PLANNER = rolePermissions('planner')

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
    { id: 'board', label: 'Allocation board (planner)', model: one(base()), note: 'One load tile per line and workshop (next 4 weeks; a workshop has no load in standard minutes: —), then Not allocated · Line 1 · Line 2 · the workshops. A drop moves all the garments; moves work in this view only.' },
    { id: 'part', label: 'Move part of an order', model: one(base({ dialog: { kind: 'card', cardId: `${W101.id}:LINE` } })), note: 'The card detail: how many garments go to which line or workshop; the rest stays.' },
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
