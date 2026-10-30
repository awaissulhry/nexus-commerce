import { createElement, type ReactNode } from 'react'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { permissionCheck } from '../../../../lib/session/session'
import { designScreen as panelsScreen } from '../../../../record-panels/fixtures'
import type { RecordPanelsViewModel } from '../../../../record-panels/model'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER, OWNER_PERMISSIONS } from '../../../../shell/design-data'
import { officeNavFor } from '../../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../../shell/office/view/OfficeShellView'
import type { BundleOption, KitLine, Operation, OrderRow, OrderStatus, OutsideOperations, Receipt, SubcontractOrder, TileCounts, WorkOrderChoice, WorkshopOption, WorkshopStock } from '../api'
import { subcontractCan, type SubcontractCan } from '../model'

/**
 * Made-up data for Purchasing › Subcontract orders' design cases (SCR-128 the list and the record, SCR-129 the stock at
 * the workshops): an invented company ("Officina Demo"), its site ("STAB-N"), workshops ("Laboratorio Cuciture Demo",
 * "Ricami Esempio", "Finiture Prova"), work orders, styles, lots, bundles and numbers. Nothing here is a real company,
 * person, order or number. Design-only (fixtures and tests import it); it exports no `designScreen`.
 */

export const PREFIX = '/w/DEMO'
export const TIME_ZONE = 'Europe/Rome'
export const TODAY = '2026-11-18'
export const NOW = '2026-11-18T09:30:00.000Z'
export const at = (day: number, hour: number, minute = 0, month = 11) => new Date(Date.UTC(2026, month - 1, day, hour, minute)).toISOString()
export const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
export const COMPANY = DEMO_COMPANIES[0].id
export const SITE = { id: uid('2222', 1), code: 'STAB-N' }

export const WORKSHOPS = {
  sewing: { id: uid('6262', 1), code: 'LAB-CUC-DEMO', name: 'Laboratorio Cuciture Demo' },
  embroidery: { id: uid('6262', 2), code: 'RIC-ESEMPIO', name: 'Ricami Esempio S.n.c.' },
  finishing: { id: uid('6262', 3), code: 'FIN-PROVA', name: 'Finiture Prova S.r.l.' },
}
export const LOCATIONS = {
  sewing: { id: uid('2424', 1), code: 'N-TERZ-CUC', name: 'Presso Laboratorio Cuciture Demo' },
  embroidery: { id: uid('2424', 2), code: 'N-TERZ-RIC', name: 'Presso Ricami Esempio' },
  finishing: { id: uid('2424', 3), code: 'N-TERZ-FIN', name: 'Presso Finiture Prova' },
}
export const STYLE = { id: uid('4141', 1), code: 'DEMO-GIA-01', name: 'Giacca demo touring' }
export const STYLE_PANTS = { id: uid('4141', 2), code: 'DEMO-PAN-02', name: 'Pantalone demo estivo' }
export const WORK_ORDERS = {
  jacket: { id: uid('5151', 1), number: 'WO-DEMO-0101', status: 'IN_PROGRESS', style: STYLE },
  pants: { id: uid('5151', 2), number: 'WO-DEMO-0102', status: 'RELEASED', style: STYLE_PANTS },
  held: { id: uid('5151', 3), number: 'WO-DEMO-0103', status: 'ON_HOLD', style: STYLE },
}
export const SERVICES = {
  sewing: { seq: 30, code: 'CUC', name: 'Cucitura completa (CMT)' },
  embroidery: { seq: 40, code: 'RIC', name: 'Ricamo logo schiena' },
  pockets: { seq: 50, code: 'TAS', name: 'Tasche per protezioni' },
  finishing: { seq: 60, code: 'FIN', name: 'Finitura e stiro' },
}
export const CELLS = [
  { workOrderSizeId: uid('5252', 1), colourway: 'BLK', size: '48', quantity: 4 },
  { workOrderSizeId: uid('5252', 2), colourway: 'BLK', size: '50', quantity: 8 },
  { workOrderSizeId: uid('5252', 3), colourway: 'BLK', size: '52', quantity: 8 },
  { workOrderSizeId: uid('5252', 4), colourway: 'RED', size: '50', quantity: 6 },
  { workOrderSizeId: uid('5252', 5), colourway: 'RED', size: '52', quantity: 4 },
]
const GARMENTS = CELLS.reduce((sum, cell) => sum + cell.quantity, 0)
export const ALL_SIZES = CELLS.map((cell) => ({ workOrderSizeId: cell.workOrderSizeId, colourway: cell.colourway, size: cell.size, pieces: cell.quantity }))

// ---- the list -----------------------------------------------------------------------------------------------------------------

const counts = (ordered: number, sent = 0, good = 0, defective = 0, scrapped = 0) => ({ ordered, sent, backGood: good, backDefective: defective, scrapped, atWorkshop: sent - good - defective - scrapped })

interface RowSpec {
  n: number
  status: OrderStatus
  workshop: keyof typeof WORKSHOPS
  workOrder: keyof typeof WORK_ORDERS
  services: (keyof typeof SERVICES)[]
  back: string | null
  late?: boolean
  pieces: ReturnType<typeof counts>
  kit: SubcontractOrder['kit']
  amount: number
}

const ROW_SPECS: RowSpec[] = [
  { n: 7, status: 'DRAFT', workshop: 'finishing', workOrder: 'pants', services: ['finishing'], back: '2026-11-27', pieces: counts(24), kit: { state: 'NONE', planned: 0, sent: 0, cancelled: 0 }, amount: 2880 },
  { n: 6, status: 'ISSUED', workshop: 'sewing', workOrder: 'pants', services: ['sewing'], back: '2026-11-25', pieces: counts(24), kit: { state: 'TO_SEND', planned: 3, sent: 0, cancelled: 0 }, amount: 12600 },
  { n: 5, status: 'AT_WORKSHOP', workshop: 'sewing', workOrder: 'jacket', services: ['sewing', 'pockets'], back: '2026-11-20', pieces: counts(30, 30), kit: { state: 'SENT', planned: 0, sent: 3, cancelled: 0 }, amount: 21000 },
  { n: 4, status: 'PARTLY_RECEIVED', workshop: 'embroidery', workOrder: 'jacket', services: ['embroidery'], back: '2026-11-14', late: true, pieces: counts(30, 30, 18, 1, 0), kit: { state: 'PARTLY_SENT', planned: 1, sent: 1, cancelled: 0 }, amount: 5400 },
  { n: 3, status: 'RECEIVED', workshop: 'finishing', workOrder: 'jacket', services: ['finishing'], back: '2026-11-12', pieces: counts(30, 30, 29, 0, 1), kit: { state: 'NONE', planned: 0, sent: 0, cancelled: 0 }, amount: 3600 },
  { n: 2, status: 'CLOSED', workshop: 'sewing', workOrder: 'jacket', services: ['sewing'], back: '2026-11-06', pieces: counts(12, 12, 12), kit: { state: 'SENT', planned: 0, sent: 2, cancelled: 0 }, amount: 6300 },
  { n: 1, status: 'CANCELLED', workshop: 'embroidery', workOrder: 'held', services: ['embroidery'], back: null, pieces: counts(10), kit: { state: 'NONE', planned: 0, sent: 0, cancelled: 2 }, amount: 0 },
]

export const orderNumber = (n: number) => `SC-2026-${String(n).padStart(4, '0')}`

function rowOf(spec: RowSpec): OrderRow {
  return {
    id: uid('8181', spec.n),
    number: orderNumber(spec.n),
    status: spec.status,
    companyId: COMPANY,
    site: SITE,
    workshop: WORKSHOPS[spec.workshop],
    location: LOCATIONS[spec.workshop],
    workOrder: WORK_ORDERS[spec.workOrder],
    orderDate: '2026-11-05',
    expectedBackDate: spec.back,
    late: !!spec.late,
    services: spec.services.map((key) => SERVICES[key]),
    pieces: spec.pieces,
    kit: spec.kit,
    currency: 'EUR',
    netAmount: spec.amount * 100,
    version: 3,
    createdAt: at(5, 9),
    updatedAt: at(17, 15),
  }
}

export const ORDER_ROWS: OrderRow[] = ROW_SPECS.map(rowOf)
export const OPEN_ROWS = ORDER_ROWS.filter((row) => row.status !== 'CLOSED' && row.status !== 'CANCELLED')
export const TILE_COUNTS: TileCounts = { kitToSend: 2, atWorkshops: 2, dueBackThisWeek: 2, late: 1 }
export const ZERO_COUNTS: TileCounts = { kitToSend: 0, atWorkshops: 0, dueBackThisWeek: 0, late: 0 }

/** A row as a role without the cost grain receives it (the API drops the fee). */
export const withoutFee = <T extends { netAmount?: number }>(row: T): T => {
  const { netAmount: _amount, ...rest } = row
  return rest as T
}

// ---- New subcontract order ----------------------------------------------------------------------------------------------------

export const WORK_ORDER_CHOICES: WorkOrderChoice[] = [
  { ...WORK_ORDERS.jacket, companyId: COMPANY, site: SITE, garments: GARMENTS, outsideSteps: 2, liveOrders: 3 },
  { ...WORK_ORDERS.pants, companyId: COMPANY, site: SITE, garments: 24, outsideSteps: 1, liveOrders: 2 },
  { id: uid('5151', 4), number: 'WO-DEMO-0104', status: 'RELEASED', style: STYLE, companyId: COMPANY, site: SITE, garments: 16, outsideSteps: 0, liveOrders: 0 },
]

export const OUTSIDE: OutsideOperations = {
  workOrder: { ...WORK_ORDERS.jacket, companyId: COMPANY, siteId: SITE.id },
  cells: CELLS,
  operations: [
    { id: uid('5353', 10), seq: 10, code: 'TAG', name: 'Taglio pelle', outside: null, ordered: 0 },
    { id: uid('5353', 20), seq: 20, code: 'PRE', name: 'Preparazione', outside: null, ordered: 0 },
    { id: uid('5353', 30), seq: 30, code: SERVICES.sewing.code, name: SERVICES.sewing.name, outside: { workshop: WORKSHOPS.sewing, pricePerPiece: '7.000000', transitDays: 7 }, ordered: 12 },
    { id: uid('5353', 40), seq: 40, code: SERVICES.embroidery.code, name: SERVICES.embroidery.name, outside: { workshop: WORKSHOPS.embroidery, pricePerPiece: '1.800000', transitDays: 4 }, ordered: 30 },
    { id: uid('5353', 50), seq: 50, code: SERVICES.pockets.code, name: SERVICES.pockets.name, outside: null, ordered: 0 },
  ],
  workshops: [
    { ...WORKSHOPS.sewing, locations: [LOCATIONS.sewing] },
    { ...WORKSHOPS.embroidery, locations: [LOCATIONS.embroidery] },
  ],
  orders: [
    { id: uid('8181', 5), number: orderNumber(5), status: 'AT_WORKSHOP' },
    { id: uid('8181', 4), number: orderNumber(4), status: 'PARTLY_RECEIVED' },
  ],
}

export const OTHER_WORKSHOPS: WorkshopOption[] = [
  { id: WORKSHOPS.finishing.id, code: WORKSHOPS.finishing.code, legalName: WORKSHOPS.finishing.name, tradeName: null, roles: ['SUBCONTRACTOR'], status: 'ACTIVE', companyId: null },
  { id: uid('6262', 4), code: 'TERZ-NUOVO', legalName: 'Terzista Nuovo Demo', tradeName: null, roles: ['SUBCONTRACTOR'], status: 'ACTIVE', companyId: null },
]

// ---- the record ----------------------------------------------------------------------------------------------------------------

export const MATERIALS = {
  lining: { id: uid('7171', 2), code: 'DEMO-FOD-02', name: 'Fodera rete traspirante', baseUom: 'M', tracking: 'LOT' as const },
  protector: { id: uid('7171', 3), code: 'DEMO-PRT-03', name: 'Protezione spalla livello 2', baseUom: 'PCS', tracking: 'NONE' as const },
  thread: { id: uid('7171', 5), code: 'DEMO-FIL-05', name: 'Filo poliestere 40', baseUom: 'PCS', tracking: 'NONE' as const },
}
export const LOTS = { lining: { id: uid('7373', 1), code: 'LT-DEMO-FOD-11', qualityStatus: 'RELEASED' } }
export const BUNDLES: BundleOption[] = CELLS.map((cell, index) => ({ id: uid('5454', index + 1), code: `BN-DEMO-${String(index + 1).padStart(4, '0')}`, workOrderSizeId: cell.workOrderSizeId, colourwayCode: cell.colourway, size: cell.size, part: null, quantity: cell.quantity, status: 'ACTIVE' }))

export function operation(seq: 30 | 50, over: Partial<Operation> = {}): Operation {
  const service = seq === 30 ? SERVICES.sewing : SERVICES.pockets
  return {
    id: uid('8282', seq),
    seq: seq === 30 ? 10 : 20,
    workOrderOperation: { id: uid('5353', seq), seq, code: service.code, name: service.name },
    pieces: GARMENTS,
    sizes: ALL_SIZES,
    pricePerPiece: seq === 30 ? '7.000000' : '0.000000',
    netAmount: seq === 30 ? GARMENTS * 700 : 0,
    expectedBackDate: '2026-11-20',
    piecesSent: 0,
    piecesBackGood: 0,
    piecesBackDefective: 0,
    piecesScrapped: 0,
    atWorkshop: 0,
    note: null,
    version: 1,
    ...over,
  }
}

export function kitLine(n: number, over: Partial<KitLine> = {}): KitLine {
  const lines: Omit<KitLine, 'status' | 'sentAt' | 'moveId' | 'ddt' | 'version' | 'note'>[] = [
    { id: uid('8383', 1), seq: 10, item: MATERIALS.lining, colour: { id: uid('7272', 1), code: 'BLK', name: 'Nero' }, lot: LOTS.lining, hide: null, quantity: '42.6000', uom: 'M', baseQuantity: '42.6000' },
    { id: uid('8383', 2), seq: 20, item: MATERIALS.protector, colour: null, lot: null, hide: null, quantity: '60.0000', uom: 'PCS', baseQuantity: '60.0000' },
    { id: uid('8383', 3), seq: 30, item: MATERIALS.thread, colour: { id: uid('7272', 1), code: 'BLK', name: 'Nero' }, lot: null, hide: null, quantity: '6.0000', uom: 'PCS', baseQuantity: '6.0000' },
  ]
  return { ...lines[n - 1]!, status: 'PLANNED', sentAt: null, moveId: null, ddt: null, note: null, version: 1, ...over }
}

export const DDT_LIVE = { id: uid('8484', 1), number: '212/2026', documentDate: '2026-11-10', cancelled: false }
export const DDT_ANNULLED = { id: uid('8484', 2), number: '209/2026', documentDate: '2026-11-09', cancelled: true }

export const RECEIPT: Receipt = {
  id: uid('8585', 1),
  receivedAt: at(16, 10, 15),
  recordedAt: at(16, 10, 20),
  byId: uid('9191', 1),
  lines: [
    { operationId: uid('8282', 30), seq: 10, code: SERVICES.sewing.code, bundle: { id: BUNDLES[1]!.id, code: BUNDLES[1]!.code, workOrderSizeId: CELLS[1]!.workOrderSizeId, colourway: 'BLK', size: '50' }, good: 7, defective: 1, scrapped: 0, reason: 'Cucitura manica storta' },
    { operationId: uid('8282', 30), seq: 10, code: SERVICES.sewing.code, bundle: { id: BUNDLES[2]!.id, code: BUNDLES[2]!.code, workOrderSizeId: CELLS[2]!.workOrderSizeId, colourway: 'BLK', size: '52' }, good: 8, defective: 0, scrapped: 0, reason: null },
  ],
  returns: [{ moveId: uid('8686', 1), item: { id: MATERIALS.lining.id, code: MATERIALS.lining.code, name: MATERIALS.lining.name }, colour: { id: uid('7272', 1), code: 'BLK', name: 'Nero' }, lot: { id: LOTS.lining.id, code: LOTS.lining.code, name: LOTS.lining.code }, hide: null, quantity: '3.4000', uom: 'M', toLocation: { id: uid('2323', 2), code: 'N-STORE-01', name: 'Scaffale materiali 01' } }],
  supplierDdt: { number: 'LCD-88/26', date: '2026-11-16' },
  note: null,
}

const ACTIONS_NONE = { issue: null, reopen: null, cancel: null, close: null, send: null, receive: null }

/** A record in a given state (made-up, consistent: counts, kit lines and DDTs follow the state). */
export function order(status: OrderStatus, over: Partial<SubcontractOrder> = {}): SubcontractOrder {
  const row = ORDER_ROWS.find((entry) => entry.number === orderNumber(5))!
  const ops = [operation(30), operation(50, { pricePerPiece: '1.200000', netAmount: GARMENTS * 120 })]
  const base: SubcontractOrder = {
    ...row,
    id: uid('8181', 50),
    number: orderNumber(8),
    status,
    note: 'Cuciture a doppio ago sulle spalle, come da campione.',
    internalNote: null,
    issuedAt: null,
    issuedById: null,
    closedAt: null,
    cancelledAt: null,
    cancelReason: null,
    operations: ops,
    kitLines: [kitLine(1), kitLine(2), kitLine(3)],
    receipts: [],
    ddts: [],
    actions: { ...ACTIONS_NONE },
    pieces: counts(GARMENTS * 2),
    kit: { state: 'TO_SEND', planned: 3, sent: 0, cancelled: 0 },
    netAmount: GARMENTS * 820,
    late: false,
  }
  const sentLines = [kitLine(1, { status: 'SENT', sentAt: at(10, 8), moveId: uid('8787', 1), ddt: { id: DDT_LIVE.id, number: DDT_LIVE.number, cancelled: false } }), kitLine(2, { status: 'SENT', sentAt: at(10, 8), moveId: uid('8787', 2), ddt: { id: DDT_LIVE.id, number: DDT_LIVE.number, cancelled: false } })]
  const sentOps = ops.map((entry) => ({ ...entry, piecesSent: GARMENTS, atWorkshop: GARMENTS }))
  const held = (words: string) => words
  switch (status) {
    case 'DRAFT':
      Object.assign(base, { actions: { ...ACTIONS_NONE, reopen: held('The order is a draft.'), close: held('closed once every piece is back'), send: held('the kit goes out once the order is issued'), receive: held('pieces come back only once something went out') } })
      break
    case 'ISSUED':
      Object.assign(base, { issuedAt: at(9, 11), issuedById: uid('9191', 1), actions: { ...ACTIONS_NONE, issue: held('only a draft is issued'), close: held('closed once every piece is back'), receive: held('pieces come back only once something went out') } })
      break
    case 'AT_WORKSHOP':
      Object.assign(base, {
        issuedAt: at(9, 11),
        operations: sentOps,
        kitLines: [...sentLines, kitLine(3)],
        ddts: [{ ...DDT_LIVE, kitLineIds: sentLines.map((line) => line.id) }],
        pieces: counts(GARMENTS * 2, GARMENTS * 2),
        kit: { state: 'PARTLY_SENT', planned: 1, sent: 2, cancelled: 0 },
        actions: { ...ACTIONS_NONE, issue: held('only a draft'), reopen: held('Part of the kit or the pieces are out already'), cancel: held('Part of the kit or the pieces are out already'), close: held('closed once every piece is back') },
      })
      break
    case 'PARTLY_RECEIVED': {
      const back = sentOps.map((entry, index) => (index === 0 ? { ...entry, piecesBackGood: 15, piecesBackDefective: 1, atWorkshop: GARMENTS - 16 } : entry))
      Object.assign(base, {
        issuedAt: at(9, 11),
        operations: back,
        kitLines: [...sentLines, kitLine(3, { status: 'CANCELLED' })],
        ddts: [{ ...DDT_LIVE, kitLineIds: sentLines.map((line) => line.id) }, { ...DDT_ANNULLED, kitLineIds: [] }],
        receipts: [RECEIPT],
        pieces: counts(GARMENTS * 2, GARMENTS * 2, 15, 1, 0),
        kit: { state: 'SENT', planned: 0, sent: 2, cancelled: 1 },
        late: true,
        expectedBackDate: '2026-11-14',
        actions: { ...ACTIONS_NONE, issue: held('only a draft'), reopen: held('out already'), cancel: held('out already'), close: held('closed once every piece is back') },
      })
      break
    }
    case 'RECEIVED':
    case 'CLOSED': {
      const back = sentOps.map((entry) => ({ ...entry, piecesBackGood: GARMENTS, atWorkshop: 0 }))
      Object.assign(base, {
        issuedAt: at(9, 11),
        closedAt: status === 'CLOSED' ? at(18, 9) : null,
        operations: back,
        kitLines: sentLines,
        ddts: [{ ...DDT_LIVE, kitLineIds: sentLines.map((line) => line.id) }],
        receipts: [RECEIPT, { ...RECEIPT, id: uid('8585', 2), receivedAt: at(17, 15), recordedAt: at(17, 15, 5), returns: [], supplierDdt: { number: 'LCD-91/26', date: '2026-11-17' }, lines: [{ ...RECEIPT.lines[0]!, good: 45, defective: 0, reason: null, bundle: null }] }],
        pieces: counts(GARMENTS * 2, GARMENTS * 2, GARMENTS * 2),
        kit: { state: 'SENT', planned: 0, sent: 2, cancelled: 0 },
        actions: { ...ACTIONS_NONE, issue: held('only a draft'), reopen: held('out'), cancel: held('out'), send: held('until every piece is back'), receive: status === 'CLOSED' ? held('closed') : held('every piece is back'), close: status === 'CLOSED' ? held('closed') : null },
      })
      break
    }
    case 'CANCELLED':
      Object.assign(base, {
        cancelledAt: at(8, 16),
        cancelReason: 'Il cliente ha rinviato il ricamo: lo facciamo in casa.',
        kitLines: [kitLine(1, { status: 'CANCELLED' }), kitLine(2, { status: 'CANCELLED' })],
        kit: { state: 'NONE', planned: 0, sent: 0, cancelled: 2 },
        actions: { issue: held('cancelled'), reopen: held('cancelled'), cancel: held('cancelled'), close: held('cancelled'), send: held('cancelled'), receive: held('cancelled') },
      })
      break
  }
  return { ...base, ...over }
}

/** The order as a role without the cost grain receives it (no fee, no amount anywhere). */
export function withoutFees(value: SubcontractOrder): SubcontractOrder {
  const { netAmount: _amount, ...rest } = value
  return { ...rest, operations: value.operations.map(({ pricePerPiece: _price, netAmount: _net, ...entry }) => entry) } as SubcontractOrder
}

// ---- stock at the workshops (SCR-129) ------------------------------------------------------------------------------------------

export const STOCK: WorkshopStock = {
  rows: [
    { site: SITE, workshop: WORKSHOPS.sewing, location: LOCATIONS.sewing, item: { id: MATERIALS.lining.id, code: MATERIALS.lining.code, name: MATERIALS.lining.name, baseUom: 'M' }, colour: { id: uid('7272', 1), code: 'BLK', name: 'Nero' }, lot: LOTS.lining, hide: null, onHand: '39.2000', lastSentAt: at(10, 8), unitCost: '4.150000', value: 16268, currency: 'EUR' },
    { site: SITE, workshop: WORKSHOPS.sewing, location: LOCATIONS.sewing, item: { id: MATERIALS.protector.id, code: MATERIALS.protector.code, name: MATERIALS.protector.name, baseUom: 'PCS' }, colour: null, lot: null, hide: null, onHand: '60.0000', lastSentAt: at(10, 8), unitCost: '2.900000', value: 17400, currency: 'EUR' },
    { site: SITE, workshop: WORKSHOPS.embroidery, location: LOCATIONS.embroidery, item: { id: MATERIALS.thread.id, code: MATERIALS.thread.code, name: MATERIALS.thread.name, baseUom: 'PCS' }, colour: { id: uid('7272', 2), code: 'RED', name: 'Rosso' }, lot: null, hide: null, onHand: '4.0000', lastSentAt: at(3, 14), unitCost: null, value: null, currency: 'EUR' },
  ],
  workshops: [
    { workshop: WORKSHOPS.sewing, location: LOCATIONS.sewing, site: SITE, lines: 2, value: 33668 },
    { workshop: WORKSHOPS.embroidery, location: LOCATIONS.embroidery, site: SITE, lines: 1, value: null },
  ],
  truncated: false,
}

export function stockWithoutValues(stock: WorkshopStock): WorkshopStock {
  return { ...stock, rows: stock.rows.map(({ unitCost: _cost, value: _value, ...row }) => row), workshops: stock.workshops.map(({ value: _value, ...entry }) => entry) }
}

// ---- roles ------------------------------------------------------------------------------------------------------------------------

/** The office permissions of a role template (factory-domain), plus Home: what that role's person holds. */
const templatePermissions = (key: string): string[] => [...(templateOf(key)?.permissions ?? []), 'home.view']

/**
 * The role cases the design names: the owner (everything, with costs), the buyer (makes and issues orders, with costs),
 * the warehouse (sends the kit, receives back, issues the DDT; no money), the planner (reads, no money), read-only, and
 * sales (no purchasing.view: the page says so).
 */
export const ROLE_PERMISSIONS = {
  owner: [...OWNER_PERMISSIONS, ...(templateOf('owner')?.permissions ?? []), 'money.cost', 'money.price', 'money.margin'],
  buyer: [...templatePermissions('buyer'), 'money.cost'],
  warehouse: templatePermissions('warehouse'),
  planner: templatePermissions('planner'),
  readOnly: [...(templateOf('read_only')?.permissions ?? []), 'home.view'],
  sales: templatePermissions('sales'),
} as const
export type RoleCase = keyof typeof ROLE_PERMISSIONS
export const canFor = (role: RoleCase): SubcontractCan => subcontractCan(ROLE_PERMISSIONS[role])

/** The Office shell around a page (the role's navigation, this page's place), as the page sees it. */
export function inShell(path: string, page: ReactNode, role: RoleCase = 'buyer'): ReactNode {
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

const conversation = panelsScreen.cases.find((item) => item.id === 'conversation')!.model as RecordPanelsViewModel

/** The record's Activity (the shared record panels) with a made-up conversation. */
export function panelsModel(id: string, title: string): RecordPanelsViewModel {
  return { ...conversation, record: { type: 'SubcontractOrder', id, companyId: COMPANY, siteId: SITE.id }, title, party: null }
}
