import { createElement, type ReactNode } from 'react'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { permissionCheck } from '../../../../lib/session/session'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER } from '../../../../shell/design-data'
import { officeNavFor } from '../../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../../shell/office/view/OfficeShellView'
import { at, COLOURS, ITEMS, LOCATIONS, LOTS, NOW, PREFIX, ROLE_PERMISSIONS, SITE, SITE_SOUTH, TIME_ZONE, uid } from '../../../_shared/stock/fixtures'
import type { CreateResult, PickRow, PickSheet, PickTiles, ReadinessMaterial, SheetLine } from '../api'
import { addressOf, createChoices, pickingCan, type PickingCan } from '../model'
import type { CreateModel, PickingListModel, PrintModel, SheetModel } from '../view-model'

/**
 * Made-up data for Warehouse › Picking & kits' design cases (SCR-237, SCR-237-print): the invented company and site of the
 * stock screens ("Officina Demo", "STAB-N"), its places, materials and lots, work orders "WO-D-0031" …, styles
 * "GIACCA-DEMO-…", purchase orders "PO-D-0102" …, the cutting team "Taglio". Nothing here is a real company, person,
 * work order or number. Design-only.
 */

export { NOW, PREFIX, TIME_ZONE }

// ---- roles -----------------------------------------------------------------------------------------------------------------

const template = (key: string): string[] => [...(templateOf(key)?.permissions ?? []), 'home.view']

/**
 * The role cases: the owner (everything), the warehouse (sees, creates pick lists), the planner (sees and reserves, opens
 * What to buy & make), read-only (sees; Create pick lists held), sales (no inventory.stock.view: the page names it).
 */
export const PICK_ROLES = {
  owner: [...ROLE_PERMISSIONS.owner, 'inventory.reserve', 'workorders.view', 'purchasing.view', 'planning.view'],
  warehouse: template('warehouse'),
  planner: template('planner'),
  readOnly: [...(templateOf('read_only')?.permissions ?? []), 'home.view'],
  sales: template('sales'),
} as const
export type PickRole = keyof typeof PICK_ROLES
export const canAs = (role: PickRole): PickingCan => pickingCan(PICK_ROLES[role])

export function inShell(path: string, page: ReactNode, role: PickRole): ReactNode {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck([...PICK_ROLES[role]])),
    path,
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: [], site: null, path },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}

export const SITES = [SITE, SITE_SOUTH].map((site) => ({ id: site.id, code: site.code, name: site.name }))
const STYLES = {
  jacket: { id: uid('7474', 1), code: 'GIACCA-DEMO-01', name: 'Giacca moto Demo in pelle' },
  trousers: { id: uid('7474', 2), code: 'PANT-DEMO-02', name: 'Pantalone moto Demo' },
}
const PO = { late: { id: uid('7575', 1), number: 'PO-D-0102', status: 'CONFIRMED', dueDate: '2026-10-28' }, soon: { id: uid('7575', 2), number: 'PO-D-0107', status: 'SENT', dueDate: '2026-11-03' } }

// ---- readiness -----------------------------------------------------------------------------------------------------------------

const material = (over: Partial<ReadinessMaterial> & Pick<ReadinessMaterial, 'itemId' | 'label' | 'word'>): ReadinessMaterial => ({
  itemColourId: null,
  uom: 'FT2',
  date: null,
  needed: '48.0000',
  issued: '0.0000',
  reserved: '0.0000',
  inStock: '0.0000',
  onOrder: '0.0000',
  short: '0.0000',
  purchaseOrders: [],
  ...over,
})
const leather = (over: Partial<ReadinessMaterial>) => material({ itemId: ITEMS.leather.id, itemColourId: COLOURS.black.id, label: `${ITEMS.leather.code} ${COLOURS.black.code}`, word: 'RECEIVED', ...over })
const lining = (over: Partial<ReadinessMaterial>) => material({ itemId: ITEMS.lining.id, itemColourId: COLOURS.grey.id, label: `${ITEMS.lining.code} ${COLOURS.grey.code}`, uom: 'M', needed: '3.2000', word: 'RECEIVED', ...over })
const protector = (over: Partial<ReadinessMaterial>) => material({ itemId: ITEMS.protector.id, label: ITEMS.protector.code, uom: 'PCS', needed: '4.0000', word: 'RECEIVED', ...over })

// ---- rows ------------------------------------------------------------------------------------------------------------------

export function pickRow(n: number, over: Partial<PickRow> & { word?: PickRow['readiness']['word']; materials?: ReadinessMaterial[] } = {}): PickRow {
  const { word, materials, ...rest } = over
  return {
    workOrder: {
      id: uid('9191', n),
      number: `WO-D-${String(30 + n).padStart(4, '0')}`,
      status: 'RELEASED',
      kind: 'STANDARD',
      companyId: SITE.companyId,
      siteId: SITE.id,
      dueDate: '2026-11-20',
      priority: 0,
      pieces: 12,
      style: STYLES.jacket,
      onHold: null,
    },
    cutDate: '2026-10-30',
    readiness: { word: word ?? 'RECEIVED', date: null, materials: materials ?? [leather({ reserved: '48.0000' }), lining({ reserved: '3.2000' }), protector({ reserved: '4.0000' })] },
    lines: { all: 3, picked: 0, short: 3 },
    kit: { status: 'OPEN', location: null, checkedAt: null, version: 0 },
    pickList: { created: true, reservations: 4, createdAt: at(29, 16) },
    pickedBy: [],
    startedAt: null,
    finishedAt: null,
    ...rest,
  }
}

export const PICK_ROWS: PickRow[] = [
  pickRow(1, { lines: { all: 9, picked: 6, short: 3 }, kit: { status: 'PARTLY', location: { id: LOCATIONS.cutting.id, code: LOCATIONS.cutting.code, name: LOCATIONS.cutting.name }, checkedAt: null, version: 1 }, pickedBy: [{ kind: 'TEAM', name: 'Taglio' }], startedAt: at(30, 7, 12) }),
  pickRow(2, {
    word: 'DELAYED',
    materials: [leather({ word: 'DELAYED', date: '2026-11-05', short: '48.0000', onOrder: '48.0000', purchaseOrders: [PO.late] }), lining({ reserved: '3.2000' }), protector({ word: 'NOT_BOOKED', inStock: '4.0000' })],
    pickList: { created: false, reservations: 0, createdAt: null },
  }),
  pickRow(3, { word: 'EXPECTED', cutDate: '2026-11-04', materials: [leather({ word: 'EXPECTED', date: '2026-11-03', onOrder: '48.0000', purchaseOrders: [PO.soon] }), lining({ reserved: '3.2000' })], pickList: { created: false, reservations: 0, createdAt: null } }),
  pickRow(4, {
    word: 'NOT_ENOUGH',
    cutDate: '2026-10-31',
    workOrder: { ...pickRow(4).workOrder, style: STYLES.trousers, pieces: 8 },
    materials: [material({ itemId: ITEMS.suede.id, label: ITEMS.suede.code, uom: 'M2', needed: '9.6000', short: '9.6000', word: 'NOT_ENOUGH' }), lining({ word: 'NOT_BOOKED', inStock: '3.2000' })],
    pickList: { created: false, reservations: 0, createdAt: null },
  }),
  pickRow(5, { lines: { all: 3, picked: 3, short: 0 }, kit: { status: 'COMPLETE', location: { id: LOCATIONS.cutting.id, code: LOCATIONS.cutting.code, name: LOCATIONS.cutting.name }, checkedAt: at(29, 15, 52), version: 3 }, pickedBy: [{ kind: 'TEAM', name: 'Taglio' }, { kind: 'OFFICE', name: null }], startedAt: at(29, 14, 5), finishedAt: at(29, 15, 40), cutDate: '2026-10-29' }),
  pickRow(6, {
    workOrder: { ...pickRow(6).workOrder, status: 'ON_HOLD', onHold: { reason: 'Controllo qualità: differenza di tonalità', from: 'RELEASED' } },
    word: 'NOT_BOOKED',
    materials: [leather({ word: 'NOT_BOOKED', inStock: '48.0000' })],
    pickList: { created: false, reservations: 0, createdAt: null },
    cutDate: null,
  }),
]

export const PICK_TILES: PickTiles = { today: 2, waiting: 3, complete: 1, toCreate: 3, all: PICK_ROWS.length }

// ---- one pick list ------------------------------------------------------------------------------------------------------------

const place = (location: (typeof LOCATIONS)[keyof typeof LOCATIONS], onHand: string) => ({ locationId: location.id, locationCode: location.code, onHand })

function sheetLine(over: Partial<SheetLine> & Pick<SheetLine, 'itemId' | 'itemCode' | 'itemName' | 'tracking' | 'baseUom'>): SheetLine {
  return {
    itemColourId: null,
    colourCode: null,
    colourName: null,
    planned: '0.0000',
    issued: '0.0000',
    toIssue: '0.0000',
    over: '0.0000',
    covered: false,
    held: [],
    atWorkOrder: [],
    pick: { reserved: '0.0000', short: '0.0000', proposed: [], reservations: [] },
    ...over,
  }
}

export const SHEET_LINES: SheetLine[] = [
  sheetLine({
    itemId: ITEMS.leather.id,
    itemCode: ITEMS.leather.code,
    itemName: ITEMS.leather.name,
    tracking: 'HIDE',
    baseUom: 'FT2',
    itemColourId: COLOURS.black.id,
    colourCode: COLOURS.black.code,
    colourName: COLOURS.black.name,
    planned: '576.0000',
    issued: '384.0000',
    toIssue: '192.0000',
    atWorkOrder: [
      { lotId: LOTS.nappa.id, lotCode: LOTS.nappa.code, hideId: uid('8282', 1), hideCode: 'H-D-0007', quantity: '52.4000' },
      { lotId: LOTS.nappa.id, lotCode: LOTS.nappa.code, hideId: uid('8282', 2), hideCode: 'H-D-0008', quantity: '49.8000' },
    ],
    held: [
      { reason: 'QUALITY_HOLD', lotId: LOTS.nappa.id, lotCode: LOTS.nappa.code, onHand: '51.0000', hides: 1, hideId: uid('8282', 9), hideCode: 'H-D-0012', hold: { id: uid('8383', 1), subjectType: 'Hide', reasonCode: 'QUALITY_CHECK', reasonIt: 'Controllo qualità', reasonEn: 'Quality check', placedAt: at(29, 10) } },
      { reason: 'CR_VI_PENDING', lotId: LOTS.nappaQuarantine.id, lotCode: LOTS.nappaQuarantine.code, onHand: '210.0000', hides: 4 },
    ],
    pick: {
      reserved: '192.0000',
      short: '0.0000',
      proposed: [],
      reservations: [
        { id: uid('8484', 1), status: 'ACTIVE', lotId: LOTS.nappa.id, lotCode: LOTS.nappa.code, hideId: uid('8282', 3), hideCode: 'H-D-0009', quantity: '50.2000', issued: '0.0000', locations: [place(LOCATIONS.binA1, '50.2000')] },
        { id: uid('8484', 2), status: 'ACTIVE', lotId: LOTS.nappa.id, lotCode: LOTS.nappa.code, hideId: uid('8282', 4), hideCode: 'H-D-0010', quantity: '48.6000', issued: '0.0000', locations: [place(LOCATIONS.binA1, '48.6000')] },
        { id: uid('8484', 3), status: 'ACTIVE', lotId: LOTS.nappa.id, lotCode: LOTS.nappa.code, hideId: uid('8282', 5), hideCode: 'H-D-0011', quantity: '53.1000', issued: '0.0000', locations: [place(LOCATIONS.binA2, '53.1000')] },
      ],
    },
  }),
  sheetLine({
    itemId: ITEMS.lining.id,
    itemCode: ITEMS.lining.code,
    itemName: ITEMS.lining.name,
    tracking: 'LOT',
    baseUom: 'M',
    itemColourId: COLOURS.grey.id,
    colourCode: COLOURS.grey.code,
    colourName: COLOURS.grey.name,
    planned: '38.4000',
    issued: '38.4000',
    toIssue: '0.0000',
    covered: true,
    atWorkOrder: [{ lotId: LOTS.lining.id, lotCode: LOTS.lining.code, hideId: null, hideCode: null, quantity: '38.4000' }],
  }),
  sheetLine({
    itemId: ITEMS.protector.id,
    itemCode: ITEMS.protector.code,
    itemName: ITEMS.protector.name,
    tracking: 'LOT',
    baseUom: 'PCS',
    planned: '48.0000',
    issued: '24.0000',
    toIssue: '24.0000',
    atWorkOrder: [{ lotId: LOTS.protector.id, lotCode: LOTS.protector.code, hideId: null, hideCode: null, quantity: '24.0000' }],
    pick: { reserved: '0.0000', short: '0.0000', proposed: [{ kind: 'LOT', lotId: LOTS.protector.id, lotCode: LOTS.protector.code, hideId: null, hideCode: null, quantity: '24.0000', locations: [place(LOCATIONS.rackA, '120.0000')] }], reservations: [] },
  }),
]

export function pickSheet(row: PickRow, over: Partial<PickSheet> = {}): PickSheet {
  return {
    workOrder: { ...row.workOrder, batchNumber: `BT-${row.workOrder.number.slice(3)}`, version: 3, issuable: row.workOrder.status === 'RELEASED' || row.workOrder.status === 'IN_PROGRESS' },
    cutDate: row.cutDate,
    readiness: row.readiness,
    kit: { ...row.kit, all: row.lines.all, picked: row.lines.picked, short: row.lines.short },
    pickList: row.pickList,
    pickedBy: row.pickedBy,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    lines: SHEET_LINES,
    ...over,
  }
}

const covered = (line: SheetLine): SheetLine => ({ ...line, issued: line.planned, toIssue: '0.0000', covered: true, held: [], pick: { ...line.pick, proposed: [], reservations: line.pick.reservations.map((row) => ({ ...row, status: 'ISSUED' as const, issued: row.quantity })) } })
/** B-W2b-15: every line picked, staged at the cutting rack, not checked yet: "Mark kit complete" may be pressed. */
export const COMPLETE_SHEET = pickSheet(PICK_ROWS[4]!, { lines: SHEET_LINES.map(covered), kit: { ...pickSheet(PICK_ROWS[4]!).kit, checkedAt: null, version: 2 } })
/** The same kit checked complete (when, never who): "Open again" offered. */
export const CHECKED_SHEET = pickSheet(PICK_ROWS[4]!, { lines: SHEET_LINES.map(covered) })

/** The places a kit may wait at (the site's in use, never a workshop's): the design's store, its shelves and the cutting rack. */
export const STAGING_PLACES = [LOCATIONS.store, LOCATIONS.rackA, LOCATIONS.binA1, LOCATIONS.binA2, LOCATIONS.receiving, LOCATIONS.quarantine, LOCATIONS.cutting].map((location) => ({ id: location.id, code: location.code, name: location.name, depth: location.depth }))

export function sheetModel(over: Partial<SheetModel> = {}): SheetModel {
  return { id: PICK_ROWS[0]!.workOrder.id, ids: PICK_ROWS.map((row) => row.workOrder.id), sheet: pickSheet(PICK_ROWS[0]!), problem: null, places: { items: STAGING_PLACES, problem: null }, kitBusy: false, kitProblem: null, reopen: null, ...over }
}

// ---- Create pick lists ------------------------------------------------------------------------------------------------------------

export const CREATE_RESULTS: CreateResult[] = [
  { workOrderId: PICK_ROWS[1]!.workOrder.id, number: PICK_ROWS[1]!.workOrder.number, outcome: 'CREATED', reserved: [{ itemCode: ITEMS.lining.code, colourCode: 'GRY', kind: 'LOT', lotCode: LOTS.lining.code, hideCode: null, quantity: '3.2000', baseUom: 'M' }, { itemCode: ITEMS.protector.code, colourCode: null, kind: 'LOT', lotCode: LOTS.protector.code, hideCode: null, quantity: '4.0000', baseUom: 'PCS' }], short: [{ itemCode: ITEMS.leather.code, colourCode: 'BLK', quantity: '48.0000', baseUom: 'FT2' }], refusal: null },
  { workOrderId: PICK_ROWS[2]!.workOrder.id, number: PICK_ROWS[2]!.workOrder.number, outcome: 'CREATED', reserved: [{ itemCode: ITEMS.lining.code, colourCode: 'GRY', kind: 'LOT', lotCode: LOTS.lining.code, hideCode: null, quantity: '3.2000', baseUom: 'M' }], short: [], refusal: null },
  { workOrderId: PICK_ROWS[3]!.workOrder.id, number: PICK_ROWS[3]!.workOrder.number, outcome: 'REFUSED', reserved: [], short: [], refusal: { code: 'HIDE_RESERVED', message: 'made up' } },
]

export function createModel(over: Partial<CreateModel> = {}): CreateModel {
  return { siteId: SITE.id, sites: [SITES[0]!], choices: { items: createChoices(PICK_ROWS), problem: null }, picked: [], busy: false, results: null, problem: null, ...over }
}

// ---- the page -----------------------------------------------------------------------------------------------------------------------

export function listModel(role: PickRole, over: Partial<PickingListModel> = {}): PickingListModel {
  return {
    prefix: PREFIX,
    can: canAs(role),
    address: addressOf(new URLSearchParams()),
    sites: [SITES[0]!],
    rows: { items: PICK_ROWS, more: false, total: PICK_ROWS.length, problem: null },
    tiles: PICK_TILES,
    asOf: NOW,
    live: 'live',
    updates: 0,
    timeZone: TIME_ZONE,
    sheet: null,
    create: null,
    notice: null,
    ...over,
  }
}

export function printModel(over: Partial<PrintModel> = {}): PrintModel {
  const sheets = [pickSheet(PICK_ROWS[0]!), pickSheet(PICK_ROWS[1]!, { lines: SHEET_LINES.slice(0, 1) })]
  return { company: DEMO_COMPANIES[0].name, ids: sheets.map((sheet) => sheet.workOrder.id), sheets: { value: sheets, problem: null }, readAt: NOW, timeZone: TIME_ZONE, allowed: true, ...over }
}
