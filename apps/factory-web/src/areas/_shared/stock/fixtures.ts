import { createElement, type ReactNode } from 'react'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { permissionCheck } from '../../../lib/session/session'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER, OWNER_PERMISSIONS } from '../../../shell/design-data'
import { officeNavFor } from '../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../shell/office/view/OfficeShellView'
import type { HideRow, ItemRef, LedgerRow, LocationView, LotRow, Named, StockRow } from './api'
import { stockCan, type StockCan } from './model'

/**
 * Made-up data for the warehouse stock screens' design cases (SCR-060, SCR-064, SCR-065, SCR-200, SCR-201): an invented
 * company ("Officina Demo"), a site ("STAB-N"), a tannery ("Conceria Demo S.r.l."), materials ("DEMO-LEA-01" …), places,
 * lots ("LOT-D-000101" …), hide tags ("HD-DEMO-0001" …), work orders and people. Nothing here is a real company, person,
 * order or number. Design-only (only fixtures and tests import it); it exports no `designScreen`.
 */

export const PREFIX = '/w/DEMO'
export const TIME_ZONE = 'Europe/Rome'
export const COMPANY = DEMO_COMPANIES[0].id
export const uid = (block: string, n: number) => `0190f0e2-${block.padStart(4, '0').slice(-4)}-7000-8000-${String(n).padStart(12, '0')}`
export const at = (day: number, hour = 9, minute = 0, month = 10) => new Date(Date.UTC(2026, month - 1, day, hour, minute)).toISOString()
export const NOW = at(30, 9, 42)

export const SITE = { id: uid('2222', 1), companyId: COMPANY, code: 'STAB-N', name: 'Stabilimento Demo Nord' }
export const SITE_SOUTH = { id: uid('2222', 2), companyId: COMPANY, code: 'MAG-S', name: 'Magazzino Demo Sud' }

export const ITEMS = {
  leather: { id: uid('7171', 1), code: 'DEMO-LEA-01', name: 'Nappa bovina 1,2 mm', baseUom: 'FT2', tracking: 'HIDE' },
  suede: { id: uid('7171', 5), code: 'DEMO-LEA-05', name: 'Scamosciato 1,0 mm', baseUom: 'M2', tracking: 'HIDE' },
  lining: { id: uid('7171', 2), code: 'DEMO-FOD-02', name: 'Fodera rete traspirante', baseUom: 'M', tracking: 'LOT' },
  protector: { id: uid('7171', 3), code: 'DEMO-PRT-03', name: 'Protezione spalla livello 2', baseUom: 'PCS', tracking: 'LOT' },
  zip: { id: uid('7171', 4), code: 'DEMO-ZIP-04', name: 'Zip divisibile 60 cm', baseUom: 'PCS', tracking: 'NONE' },
} satisfies Record<string, ItemRef>

export const COLOURS = {
  black: { id: uid('7272', 1), code: 'BLK', name: 'Nero' },
  red: { id: uid('7272', 2), code: 'RED', name: 'Rosso' },
  grey: { id: uid('7272', 3), code: 'GRY', name: 'Grigio' },
} satisfies Record<string, Named>

export const SUPPLIERS = {
  tannery: { id: uid('6060', 1), code: 'CONCERIA-DEMO', name: 'Conceria Demo S.r.l.' },
  fabric: { id: uid('6060', 2), code: 'TESSITURA-ESEMPIO', name: 'Tessitura Esempio S.p.A.' },
  protector: { id: uid('6060', 3), code: 'PROTEZIONI-PROVA', name: 'Protezioni Prova S.r.l.' },
} satisfies Record<string, Named>

const place = (n: number, parent: number | null, code: string, name: string, kind: LocationView['kind'], depth: number, path: string[], status: LocationView['status'] = 'ACTIVE'): LocationView => ({
  id: uid('2323', n),
  companyId: COMPANY,
  siteId: SITE.id,
  parentId: parent === null ? null : uid('2323', parent),
  code,
  name,
  kind,
  status,
  depth,
  path,
  version: 1,
  createdAt: at(1, 8),
  updatedAt: at(1, 8),
})
export const LOCATIONS = {
  store: place(1, null, 'N-MAG', 'Magazzino pelli', 'WAREHOUSE', 0, ['N-MAG']),
  rackA: place(2, 1, 'N-MAG-A', 'Scaffale A', 'ZONE', 1, ['N-MAG', 'N-MAG-A']),
  binA1: place(3, 2, 'N-MAG-A-01', 'Ripiano A1', 'BIN', 2, ['N-MAG', 'N-MAG-A', 'N-MAG-A-01']),
  binA2: place(4, 2, 'N-MAG-A-02', 'Ripiano A2', 'BIN', 2, ['N-MAG', 'N-MAG-A', 'N-MAG-A-02']),
  receiving: place(5, null, 'N-RCV', 'Banchina ricevimento', 'RECEIVING', 0, ['N-RCV']),
  quarantine: place(6, null, 'N-QUA', 'Scaffale quarantena', 'QUARANTINE', 0, ['N-QUA']),
  cutting: place(7, null, 'N-TAG', 'Reparto taglio · rastrelliera', 'PRODUCTION', 0, ['N-TAG']),
  old: place(8, 1, 'N-MAG-Z', 'Vecchio soppalco', 'ZONE', 1, ['N-MAG', 'N-MAG-Z'], 'ARCHIVED'),
}
export const named = (location: LocationView): Named => ({ id: location.id, code: location.code, name: location.name })

export const LOTS = {
  nappa: { id: uid('8181', 1), code: 'LOT-D-000101' },
  nappaQuarantine: { id: uid('8181', 2), code: 'LOT-D-000102' },
  suedeFail: { id: uid('8181', 3), code: 'LOT-D-000103' },
  lining: { id: uid('8181', 4), code: 'LOT-D-000104' },
  protector: { id: uid('8181', 5), code: 'LOT-D-000105' },
}

export const WORK_ORDERS = {
  a: { id: uid('9191', 1), number: 'WO-D-0031', batchNumber: 'BT-D-0031' },
  b: { id: uid('9191', 2), number: 'WO-D-0032', batchNumber: 'BT-D-0032' },
}
export const RECEIPTS = { a: { id: uid('9292', 1), number: 'GR-D-0012' }, b: { id: uid('9292', 2), number: 'GR-D-0013' } }
export const DEVICES = { cut: { id: uid('9393', 1), name: 'Tablet taglio 1' }, store: { id: uid('9393', 2), name: 'Tablet magazzino' } }
export const PEOPLE = { anna: 'Anna Esempio', marco: 'Marco Prova' }

// ---- rows the pages share ---------------------------------------------------------------------------------------------------

export function hideRow(n: number, over: Partial<HideRow> = {}): HideRow {
  return {
    id: uid('8282', n),
    code: `HD-DEMO-${String(n).padStart(4, '0')}`,
    supplierCode: `T-${4400 + n}`,
    siteId: SITE.id,
    companyId: COMPANY,
    item: ITEMS.leather,
    colour: COLOURS.black,
    lot: { id: LOTS.nappa.id, code: LOTS.nappa.code, qualityStatus: 'RELEASED', crViStatus: 'PASS', dyeBatch: 'TB-7731', shade: 'A' },
    grade: n % 3 === 0 ? 'B' : 'A',
    shade: 'A',
    thicknessMm: '1.20',
    defects: n % 4 === 0 ? 'Piccola cicatrice sulla spalla sinistra' : null,
    area: (48 + (n % 7) * 1.3).toFixed(4),
    areaUom: 'FT2',
    baseArea: (48 + (n % 7) * 1.3).toFixed(4),
    onHand: (48 + (n % 7) * 1.3).toFixed(4),
    left: (48 + (n % 7) * 1.3).toFixed(4),
    state: 'FULL',
    location: named(LOCATIONS.binA1),
    receivedAt: at(14, 10),
    createdAt: at(14, 10, n),
    ...over,
  }
}

export function lotRow(over: Partial<LotRow> & Pick<LotRow, 'id' | 'code'>): LotRow {
  return {
    companyId: COMPANY,
    siteId: SITE.id,
    siteCode: SITE.code,
    item: ITEMS.leather,
    colour: COLOURS.black,
    supplier: SUPPLIERS.tannery,
    supplierLotRef: 'CD-26-0412',
    dyeBatch: 'TB-7731',
    shade: 'A',
    receivedAt: at(14, 10),
    receipt: RECEIPTS.a,
    opening: false,
    qualityStatus: 'RELEASED',
    qualityNote: null,
    qualityDecidedAt: at(15, 11),
    crVi: { required: true, status: 'PASS', valueMgKg: '1.200', limitMgKg: '3.000', evidence: 'LOT_REPORT', testedOn: '2026-10-15' },
    documents: 2,
    onHand: '412.5000',
    hides: 8,
    issuedTo: 2,
    ...over,
  }
}

export function stockRow(over: Partial<StockRow> & Pick<StockRow, 'item' | 'location'>): StockRow {
  return { siteId: SITE.id, siteCode: SITE.code, colour: null, lot: null, hide: null, onHand: '0.0000', held: '0.0000', available: '0.0000', ...over }
}

export function ledgerRow(n: number, over: Partial<LedgerRow> & Pick<LedgerRow, 'reason'>): LedgerRow {
  return {
    id: uid('8383', n),
    companyId: COMPANY,
    siteId: SITE.id,
    siteCode: SITE.code,
    occurredAt: at(29, 8, n),
    createdAt: at(29, 8, n),
    item: ITEMS.leather,
    colour: COLOURS.black,
    lot: LOTS.nappa,
    hide: null,
    from: { kind: 'LOCATION', location: named(LOCATIONS.binA1) },
    to: { kind: 'LOCATION', location: named(LOCATIONS.cutting) },
    quantity: '48.0000',
    uom: 'FT2',
    baseQuantity: '48.0000',
    delta: '0.0000',
    document: null,
    reference: null,
    note: null,
    reversalOfId: null,
    reversedById: null,
    postedBy: { audience: 'OFFICE', name: PEOPLE.anna, device: null },
    ...over,
  }
}

// ---- roles ------------------------------------------------------------------------------------------------------------------

/** The office permissions of a role template (factory-domain), plus Home: what that role's person holds. */
const templatePermissions = (key: string): string[] => [...(templateOf(key)?.permissions ?? []), 'home.view']

/**
 * The role cases of the review: the owner (everything, with costs), the warehouse (stock and moves, no money), quality
 * (sees stock, decides lots), the administrator (no stock pages but Admin) and sales (none of these pages); read-only
 * sees and changes nothing.
 */
export const ROLE_PERMISSIONS = {
  owner: [...OWNER_PERMISSIONS, ...templatePermissions('warehouse'), ...templatePermissions('quality_inspector'), 'production.settings.view', 'production.settings.manage', 'money.cost', 'money.price', 'money.margin'],
  warehouse: templatePermissions('warehouse'),
  quality: templatePermissions('quality_inspector'),
  admin: templatePermissions('admin'),
  sales: templatePermissions('sales'),
  readOnly: [...(templateOf('read_only')?.permissions ?? []), 'home.view'],
} as const
export type RoleCase = keyof typeof ROLE_PERMISSIONS
export const canFor = (role: RoleCase): StockCan => stockCan(ROLE_PERMISSIONS[role])

/** The Office shell around a page (the role's navigation, this page's place), as the page sees it. */
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
