import { createElement, type ReactNode } from 'react'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { permissionCheck } from '../../../../lib/session/session'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER, OWNER_PERMISSIONS } from '../../../../shell/design-data'
import { officeNavFor } from '../../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../../shell/office/view/OfficeShellView'
import type { StockList, TransferList, TransferView } from '../api'
import { transfersCan, type LineView, type OptionSite, type TransferRow, type TransfersCan } from '../model'

/**
 * Design-only made-up data of Warehouse › Transfers (SCR-360 and the transfer's record SCR-361): "Demo" plants, materials,
 * lots and hides, example numbers (TRF-DEMO-…, DDT DEMO-…). Nothing here is a real company, site, person or document.
 */

export const PREFIX = '/w/DEMO'
export const TODAY = '2026-11-12'
export const NOW = '2026-11-12T09:42:00.000Z'

export const uid = (family: string, n: number): string => `0190f0e2-${family.padStart(4, '0').slice(-4)}-7000-8000-${String(n).padStart(12, '0')}`

const template = (key: string): string[] => [...(templateOf(key)?.permissions ?? []), 'home.view']

/** The role cases: the owner, the warehouse (ships and receives), a buyer (reads the stock: sees transfers, changes none), the sales office (no stock: no page). */
export const ROLE_PERMISSIONS = {
  owner: [...OWNER_PERMISSIONS, 'inventory.stock.view', 'inventory.transfers.manage'],
  warehouse: template('warehouse'),
  buyer: template('buyer'),
  sales: template('sales'),
} as const
export type RoleCase = keyof typeof ROLE_PERMISSIONS

export const canFor = (role: RoleCase): TransfersCan => transfersCan(ROLE_PERMISSIONS[role])

/** The Office shell around a page (the role's navigation, this page's place). */
export function inShell(path: string, page: ReactNode, role: RoleCase = 'owner'): ReactNode {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck([...ROLE_PERMISSIONS[role]])),
    path,
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: [], site: null, path },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}

// ---- sites and places -----------------------------------------------------------------------------------------------------

const COMPANY_A = { id: uid('6101', 1), name: 'Demo Pelletteria' }
const COMPANY_B = { id: uid('6101', 2), name: 'Demo Laboratorio' }
const place = (n: number, code: string, name: string) => ({ id: uid('6301', n), code, name })
export const PLACES = {
  a1Store: place(1, 'A1-STORE', 'Main store'),
  a1Bin: place(2, 'A1-BIN-04', 'Lining rack 4'),
  a1Hides: place(3, 'A1-HID-01', 'Hide rack 1'),
  a1Transit: place(4, 'A1-TRANSIT-B1', 'In transit to plant B1'),
  b1Store: place(5, 'B1-STORE', 'Store'),
  b1Cut: place(6, 'B1-CUT', 'Cutting room'),
  a2Store: place(7, 'A2-STORE', 'Store'),
  a1TransitA2: place(8, 'A1-TRANSIT-A2', 'In transit to plant A2'),
}
const site = (n: number, code: string, name: string, company: { id: string; name: string }) => ({ id: uid('6201', n), code, name, companyId: company.id, companyName: company.name })
export const A1 = site(1, 'A1', 'Demo plant North', COMPANY_A)
export const A2 = site(2, 'A2', 'Demo plant South', COMPANY_A)
export const B1 = site(3, 'B1', 'Demo workshop', COMPANY_B)

export const SITES: OptionSite[] = [
  { ...A1, active: true, send: true, receive: true, transitPlaces: [PLACES.a1Transit, PLACES.a1TransitA2], places: [PLACES.a1Store, PLACES.a1Bin, PLACES.a1Hides] },
  { ...A2, active: true, send: true, receive: true, transitPlaces: [], places: [PLACES.a2Store] },
  { ...B1, active: true, send: false, receive: true, transitPlaces: [], places: [PLACES.b1Store, PLACES.b1Cut] },
]

// ---- the list ------------------------------------------------------------------------------------------------------------------

const row = (n: number, over: Partial<TransferRow>): TransferRow => ({
  id: uid('6401', n),
  number: `TRF-DEMO-${String(n).padStart(4, '0')}`,
  status: 'DRAFT',
  from: A1,
  to: B1,
  interCompany: true,
  lines: 2,
  shipOn: null,
  expectedOn: null,
  ddtNumber: null,
  ddtDate: null,
  differences: 0,
  late: false,
  version: 1,
  createdAt: `2026-11-${String(Math.max(1, 12 - n)).padStart(2, '0')}T08:00:00.000Z`,
  ...over,
})

export const ROWS: TransferRow[] = [
  row(7, { status: 'DRAFT', shipOn: '2026-11-13', expectedOn: '2026-11-14' }),
  row(6, { status: 'SHIPPED', shipOn: '2026-11-11', expectedOn: '2026-11-12', ddtNumber: 'DEMO-144', ddtDate: '2026-11-11', lines: 3 }),
  row(5, { status: 'SHIPPED', to: A2, interCompany: false, shipOn: '2026-11-08', expectedOn: '2026-11-10', ddtNumber: 'DEMO-141', ddtDate: '2026-11-08', late: true, lines: 1 }),
  row(4, { status: 'PARTLY_RECEIVED', shipOn: '2026-11-06', expectedOn: '2026-11-07', ddtNumber: 'DEMO-139', ddtDate: '2026-11-06', lines: 4 }),
  row(3, { status: 'RECEIVED', shipOn: '2026-11-03', expectedOn: '2026-11-04', ddtNumber: 'DEMO-133', ddtDate: '2026-11-03', differences: 1 }),
  row(2, { status: 'RECEIVED', to: A2, interCompany: false, shipOn: '2026-10-28', expectedOn: '2026-10-29', ddtNumber: 'DEMO-128', ddtDate: '2026-10-28' }),
  row(1, { status: 'CANCELLED', lines: 1 }),
]

export function listOf(rows: readonly TransferRow[] = ROWS, complete = true): TransferList {
  const inTransit = ROWS.filter((one) => one.status === 'SHIPPED' || one.status === 'PARTLY_RECEIVED')
  return {
    rows: [...rows],
    counts: { IN_TRANSIT: inTransit.length, ARRIVING_TODAY: inTransit.filter((one) => one.expectedOn === TODAY).length, WITH_DIFFERENCES: ROWS.filter((one) => one.differences > 0).length, ALL: ROWS.length },
    complete,
    today: TODAY,
  }
}

// ---- one transfer ----------------------------------------------------------------------------------------------------------------

const LINING = { id: uid('6501', 1), code: 'DEMO-LIN-GRY', name: 'Demo mesh lining', baseUom: 'M' as const, tracking: 'LOT' as const }
const LEATHER = { id: uid('6501', 2), code: 'DEMO-COW-1.2', name: 'Demo cowhide 1.2 mm', baseUom: 'FT2' as const, tracking: 'HIDE' as const }
const PROTECTOR = { id: uid('6501', 3), code: 'DEMO-PRO-ELB', name: 'Demo elbow protector', baseUom: 'PCS' as const, tracking: 'NONE' as const }
const GREY = { id: uid('6601', 1), code: 'GRY', name: 'Grey' }
const BLACK = { id: uid('6601', 2), code: 'BLK', name: 'Black' }

const line = (n: number, over: Partial<LineView>): LineView => ({
  id: uid('6701', n),
  seq: n * 10,
  item: LINING,
  colour: GREY,
  lot: { id: uid('6801', n), code: `L-DEMO-${String(40 + n)}`, qualityStatus: 'RELEASED' },
  hide: null,
  fromLocation: PLACES.a1Bin,
  quantity: '30',
  uom: 'M',
  available: null,
  shippedQuantity: '30',
  receivedQuantity: '0',
  inTransit: '30',
  difference: '30',
  state: 'IN_TRANSIT',
  toLocation: null,
  toLot: null,
  toHide: null,
  differenceReasonCode: null,
  differenceNote: null,
  differenceResolution: null,
  resolvedAt: null,
  note: null,
  version: 1,
  ...over,
})

const ALLOWED = { allowed: true, refusal: null }
const held = (refusal: TransferView['actions']['ship']['refusal']) => ({ allowed: false, refusal })
export const REASONS = [
  { code: 'SHORT', labelIt: 'Quantità mancante', labelEn: 'Short' },
  { code: 'DAMAGED', labelIt: 'Danneggiato', labelEn: 'Damaged' },
  { code: 'WRONG_ITEM', labelIt: 'Articolo errato', labelEn: 'Wrong item' },
]

const base = (over: Partial<TransferView>): TransferView => ({
  id: uid('6401', 6),
  number: 'TRF-DEMO-0006',
  status: 'SHIPPED',
  from: A1,
  to: B1,
  interCompany: true,
  fromLocation: PLACES.a1Store,
  toLocation: PLACES.b1Store,
  transit: PLACES.a1Transit,
  shipOn: '2026-11-11',
  expectedOn: '2026-11-12',
  late: false,
  ddt: null,
  trackingRef: null,
  trackingUrl: null,
  shippedAt: null,
  receivedAt: null,
  cancelledAt: null,
  cancelReason: null,
  note: 'Lining and leather for the workshop’s next jackets (demo).',
  version: 4,
  createdAt: '2026-11-10T08:00:00.000Z',
  lines: [],
  totals: { lines: 0, inTransitLines: 0, openDifferences: 0, settled: 0 },
  actions: { edit: ALLOWED, lines: ALLOWED, ship: ALLOWED, cancel: ALLOWED, receive: ALLOWED, settle: held('NOTHING_TO_SETTLE'), track: ALLOWED, printDdt: ALLOWED },
  reasons: REASONS,
  ...over,
})

const totals = (lines: readonly LineView[]) => ({
  lines: lines.length,
  inTransitLines: lines.filter((one) => one.inTransit !== '0').length,
  openDifferences: lines.filter((one) => one.state === 'SHORT').length,
  settled: lines.filter((one) => one.state === 'SETTLED').length,
})

const DRAFT_LINES: LineView[] = [
  line(1, { shippedQuantity: null, inTransit: '0', difference: '0', state: 'DRAFT', quantity: '30', available: '42.5' }),
  line(2, { item: LEATHER, colour: BLACK, lot: { id: uid('6801', 9), code: 'L-DEMO-77', qualityStatus: 'RELEASED' }, hide: { id: uid('6901', 1), code: 'HD-DEMO-0101' }, fromLocation: PLACES.a1Hides, quantity: '52.6', uom: 'FT2', shippedQuantity: null, inTransit: '0', difference: '0', state: 'DRAFT', available: '52.6' }),
  line(3, { item: PROTECTOR, colour: null, lot: null, fromLocation: PLACES.a1Store, quantity: '24', uom: 'PCS', shippedQuantity: null, inTransit: '0', difference: '0', state: 'DRAFT', available: '18' }),
]

export const DRAFT: TransferView = base({
  id: uid('6401', 7),
  number: 'TRF-DEMO-0007',
  status: 'DRAFT',
  shipOn: '2026-11-13',
  expectedOn: '2026-11-14',
  version: 5,
  lines: DRAFT_LINES,
  totals: totals(DRAFT_LINES),
  actions: { edit: ALLOWED, lines: ALLOWED, ship: held('NOT_ENOUGH_STOCK'), cancel: ALLOWED, receive: held('NOT_SHIPPED'), settle: held('NOTHING_TO_SETTLE'), track: ALLOWED, printDdt: held('NO_DDT') },
  reasons: [],
})

export const DRAFT_READY: TransferView = (() => {
  const lines = DRAFT_LINES.map((one) => (one.seq === 30 ? { ...one, quantity: '18' } : one))
  return { ...DRAFT, lines, actions: { ...DRAFT.actions, ship: ALLOWED } }
})()

export const DRAFT_EMPTY: TransferView = { ...DRAFT, lines: [], totals: totals([]), actions: { ...DRAFT.actions, ship: held('NO_LINES') } }

const DDT = { number: 'DEMO-144', date: '2026-11-11', reason: 'TRANSFER' as const, reasonText: null, transportBy: 'SENDER' as const, carrier: null, packages: 3, grossWeightKg: '48.5', appearance: 'colli', fileId: uid('7001', 1) }

const SHIPPED_LINES: LineView[] = [
  line(1, { toLocation: null }),
  line(2, { item: LEATHER, colour: BLACK, lot: { id: uid('6801', 9), code: 'L-DEMO-77', qualityStatus: 'RELEASED' }, hide: { id: uid('6901', 1), code: 'HD-DEMO-0101' }, fromLocation: PLACES.a1Hides, quantity: '52.6', uom: 'FT2', shippedQuantity: '52.6', inTransit: '52.6', difference: '52.6' }),
  line(3, { item: PROTECTOR, colour: null, lot: null, fromLocation: PLACES.a1Store, quantity: '18', uom: 'PCS', shippedQuantity: '18', inTransit: '18', difference: '18' }),
]

export const SHIPPED: TransferView = base({
  status: 'SHIPPED',
  ddt: DDT,
  trackingRef: 'VAN-DEMO-07',
  shippedAt: '2026-11-11T07:30:00.000Z',
  lines: SHIPPED_LINES,
  totals: totals(SHIPPED_LINES),
  actions: { edit: held('NOT_DRAFT'), lines: held('NOT_DRAFT'), ship: held('NOT_DRAFT'), cancel: held('NOT_DRAFT'), receive: ALLOWED, settle: held('NOTHING_TO_SETTLE'), track: ALLOWED, printDdt: ALLOWED },
})

export const SHIPPED_SENDER: TransferView = { ...SHIPPED, actions: { ...SHIPPED.actions, receive: held('NO_RIGHT_TO'), settle: held('NO_RIGHT_TO') } }

const RECEIVED_LINES: LineView[] = [
  line(1, { receivedQuantity: '28', inTransit: '2', difference: '2', state: 'SHORT', differenceReasonCode: 'SHORT', differenceNote: 'Two metres missing from the roll (demo).', toLocation: PLACES.b1Store, toLot: { id: uid('6802', 1), code: 'L-DEMO-B-0012' } }),
  line(2, { item: LEATHER, colour: BLACK, lot: { id: uid('6801', 9), code: 'L-DEMO-77', qualityStatus: 'RELEASED' }, hide: { id: uid('6901', 1), code: 'HD-DEMO-0101' }, fromLocation: PLACES.a1Hides, quantity: '52.6', uom: 'FT2', shippedQuantity: '52.6', receivedQuantity: '52.6', inTransit: '0', difference: '0', state: 'RECEIVED', toLocation: PLACES.b1Cut, toLot: { id: uid('6802', 2), code: 'L-DEMO-B-0013' }, toHide: { id: uid('6902', 1), code: 'HD-DEMO-0409' } }),
  line(3, { item: PROTECTOR, colour: null, lot: null, fromLocation: PLACES.a1Store, quantity: '18', uom: 'PCS', shippedQuantity: '18', receivedQuantity: '18', inTransit: '0', difference: '0', state: 'RECEIVED', toLocation: PLACES.b1Store }),
]

export const RECEIVED: TransferView = base({
  id: uid('6401', 3),
  number: 'TRF-DEMO-0003',
  status: 'RECEIVED',
  ddt: { ...DDT, number: 'DEMO-133', date: '2026-11-03' },
  shipOn: '2026-11-03',
  expectedOn: '2026-11-04',
  shippedAt: '2026-11-03T07:30:00.000Z',
  receivedAt: '2026-11-04T10:10:00.000Z',
  lines: RECEIVED_LINES,
  totals: totals(RECEIVED_LINES),
  actions: { edit: held('NOT_DRAFT'), lines: held('NOT_DRAFT'), ship: held('NOT_DRAFT'), cancel: held('NOT_DRAFT'), receive: held('NOT_IN_TRANSIT'), settle: ALLOWED, track: held('NOT_IN_TRANSIT'), printDdt: ALLOWED },
})

export const CLOSED: TransferView = (() => {
  const lines = RECEIVED_LINES.map((one) => (one.seq === 10 ? { ...one, state: 'SETTLED' as const, inTransit: '0', differenceResolution: 'ADJUSTMENT' as const, resolvedAt: '2026-11-05T09:00:00.000Z' } : one))
  return { ...RECEIVED, lines, totals: totals(lines), actions: { ...RECEIVED.actions, settle: held('NOTHING_TO_SETTLE') } }
})()

export const PARTLY: TransferView = (() => {
  const lines = SHIPPED_LINES.map((one) => (one.seq === 30 ? { ...one, receivedQuantity: '18', inTransit: '0', difference: '0', state: 'RECEIVED' as const, toLocation: PLACES.b1Store } : one))
  return { ...SHIPPED, id: uid('6401', 4), number: 'TRF-DEMO-0004', status: 'PARTLY_RECEIVED', lines, totals: totals(lines) }
})()

export const CANCELLED: TransferView = { ...DRAFT, id: uid('6401', 1), number: 'TRF-DEMO-0001', status: 'CANCELLED', cancelledAt: '2026-11-09T12:00:00.000Z', cancelReason: 'Made twice by mistake (demo).', actions: { ...DRAFT.actions, edit: held('NOT_DRAFT'), lines: held('NOT_DRAFT'), ship: held('NOT_DRAFT'), cancel: held('NOT_DRAFT'), track: held('NOT_IN_TRANSIT') } }

export const LATE: TransferView = { ...SHIPPED, late: true, expectedOn: '2026-11-10', trackingUrl: 'https://tracking.example.test/DEMO-07' }

export const PDF_MISSING: TransferView = { ...SHIPPED, ddt: { ...DDT, fileId: null } }

export const CARRIER: TransferView = { ...SHIPPED, ddt: { ...DDT, transportBy: 'CARRIER', carrier: { name: 'Demo Corriere', vatNumber: null } } }

// ---- the stock picker ------------------------------------------------------------------------------------------------------------

export const STOCK: StockList = {
  rows: [
    { location: PLACES.a1Bin, item: LINING, colour: GREY, lot: { id: uid('6801', 1), code: 'L-DEMO-41', qualityStatus: 'RELEASED' }, hide: null, onHand: '42.5', onLines: '30', available: '12.5', refusal: null },
    { location: PLACES.a1Bin, item: LINING, colour: GREY, lot: { id: uid('6801', 5), code: 'L-DEMO-45', qualityStatus: 'BLOCKED' }, hide: null, onHand: '15', onLines: '0', available: '15', refusal: 'LOT_NOT_SENT' },
    { location: PLACES.a1Hides, item: LEATHER, colour: BLACK, lot: { id: uid('6801', 9), code: 'L-DEMO-77', qualityStatus: 'RELEASED' }, hide: { id: uid('6901', 2), code: 'HD-DEMO-0102' }, onHand: '49.8', onLines: '0', available: '49.8', refusal: null },
    { location: PLACES.a1Hides, item: LEATHER, colour: BLACK, lot: { id: uid('6801', 9), code: 'L-DEMO-77', qualityStatus: 'RELEASED' }, hide: { id: uid('6901', 1), code: 'HD-DEMO-0101' }, onHand: '52.6', onLines: '52.6', available: '0', refusal: null },
    { location: PLACES.a1Store, item: PROTECTOR, colour: null, lot: null, hide: null, onHand: '18', onLines: '24', available: '0', refusal: null },
  ],
  truncated: false,
}
