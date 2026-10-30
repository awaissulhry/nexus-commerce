import { createElement, type ReactNode } from 'react'
import { permissionCheck } from '../../../lib/session/session'
import { designScreen as panelsScreen } from '../../../record-panels/fixtures'
import type { RecordPanelsViewModel } from '../../../record-panels/model'
import { RecordPanelsView } from '../../../record-panels/view/RecordPanelsView'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER, OWNER_PERMISSIONS } from '../../../shell/design-data'
import { officeNavFor } from '../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../shell/office/view/OfficeShellView'
import type { SiteOption, SupplierOption } from './api'
import { buyingCan, type BuyingCan } from './model'

/**
 * Made-up data for the buying screens' design cases (SCR-055, SCR-058/059, SCR-061 … 063): an invented company
 * ("Officina Demo"), a site ("STAB-N"), suppliers ("Conceria Demo S.r.l.", "Tessitura Esempio S.p.A.", "Protezioni Prova
 * S.r.l."), materials ("DEMO-LEA-01" …), people and numbers. Nothing here is a real company, person, order or number.
 * Design-only (a fixtures file: only fixtures and tests import it); it exports no `designScreen`.
 */

export const PREFIX = '/w/DEMO'
export const TIME_ZONE = 'Europe/Rome'
export const at = (day: number, hour: number, minute = 0, month = 10) => new Date(Date.UTC(2026, month - 1, day, hour, minute)).toISOString()
export const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
export const COMPANY = DEMO_COMPANIES[0].id
export const SITE: SiteOption = { id: uid('2222', 1), companyId: COMPANY, code: 'STAB-N', name: 'Stabilimento Demo Nord', locations: [{ id: uid('2323', 1), code: 'N-RCV', name: 'Banchina ricevimento', kind: 'RECEIVING', status: 'ACTIVE' }] }
export const SITE_SOUTH: SiteOption = { id: uid('2222', 2), companyId: COMPANY, code: 'MAG-S', name: 'Magazzino Demo Sud', locations: [] }

export const SUPPLIERS = {
  tannery: { id: uid('6060', 1), companyId: null, code: 'CONCERIA-DEMO', legalName: 'Conceria Demo S.r.l.', tradeName: null, roles: ['SUPPLIER'], status: 'ACTIVE', country: 'IT', currency: 'EUR' },
  fabric: { id: uid('6060', 2), companyId: null, code: 'TESSITURA-ESEMPIO', legalName: 'Tessitura Esempio S.p.A.', tradeName: null, roles: ['SUPPLIER'], status: 'ACTIVE', country: 'IT', currency: 'EUR' },
  protector: { id: uid('6060', 3), companyId: null, code: 'PROTEZIONI-PROVA', legalName: 'Protezioni Prova S.r.l.', tradeName: null, roles: ['SUPPLIER'], status: 'ACTIVE', country: 'IT', currency: 'EUR' },
  prospect: { id: uid('6060', 4), companyId: null, code: 'COUROS-EXEMPLO', legalName: 'Couros Exemplo Lda', tradeName: null, roles: ['SUPPLIER'], status: 'PROSPECT', country: 'PT', currency: 'EUR' },
  blocked: { id: uid('6060', 5), companyId: null, code: 'FORN-BLOCCATO', legalName: 'Fornitore Bloccato S.r.l.', tradeName: null, roles: ['SUPPLIER'], status: 'BLOCKED', country: 'IT', currency: 'EUR' },
} satisfies Record<string, SupplierOption>
export const SUPPLIER_LIST: SupplierOption[] = Object.values(SUPPLIERS)

export const MATERIALS = {
  leather: { id: uid('7171', 1), code: 'DEMO-LEA-01', name: 'Nappa bovina 1,2 mm', kind: 'LEATHER', baseUom: 'FT2' as const, purchaseUom: 'FT2' as const },
  lining: { id: uid('7171', 2), code: 'DEMO-FOD-02', name: 'Fodera rete traspirante', kind: 'LINING', baseUom: 'M' as const, purchaseUom: 'M' as const },
  protector: { id: uid('7171', 3), code: 'DEMO-PRT-03', name: 'Protezione spalla livello 2', kind: 'PROTECTOR', baseUom: 'PCS' as const, purchaseUom: 'PCS' as const },
  zip: { id: uid('7171', 4), code: 'DEMO-ZIP-04', name: 'Zip divisibile 60 cm', kind: 'TRIM', baseUom: 'PCS' as const, purchaseUom: 'PCS' as const },
}
export const COLOURS = {
  black: { id: uid('7272', 1), code: 'BLK', name: 'Nero' },
  red: { id: uid('7272', 2), code: 'RED', name: 'Rosso' },
  grey: { id: uid('7272', 3), code: 'GRY', name: 'Grigio' },
}

// ---- roles -------------------------------------------------------------------------------------------------------------------

const BASE = ['home.view', 'threads.read', 'threads.post', 'files.read', 'files.upload']
const PLAN = ['planning.view', 'planning.run', 'planning.decide']
const BUY = ['purchasing.view', 'purchasing.manage', 'purchasing.send']
export const ROLES = {
  owner: [...OWNER_PERMISSIONS, ...BASE, ...PLAN, ...BUY, 'inventory.stock.view', 'inventory.locations.view', 'inventory.receive', 'inventory.reverse', 'product.materials.view', 'quality.lots.view', 'parties.manage', 'money.cost', 'money.price', 'money.margin'],
  buyer: [...BASE, ...PLAN, ...BUY, 'parties.view', 'parties.manage', 'product.materials.view', 'inventory.stock.view', 'inventory.locations.view', 'quality.lots.view', 'money.cost'],
  planner: [...BASE, ...PLAN, 'purchasing.view', 'product.materials.view', 'inventory.stock.view', 'inventory.locations.view', 'workorders.view'],
  warehouse: [...BASE, 'inventory.stock.view', 'inventory.locations.view', 'inventory.receive', 'inventory.reverse', 'purchasing.view', 'parties.view', 'product.materials.view', 'quality.lots.view'],
  /** The real sales template holds none of these screens' permissions: their rows are hidden and an address says so. */
  sales: [...BASE, 'quotes.view', 'quotes.manage', 'orders.view', 'parties.view', 'money.price', 'money.margin'],
  /** Read-only: every view, nothing written, no money. */
  readOnly: ['home.view', 'threads.read', 'files.read', 'planning.view', 'purchasing.view', 'inventory.stock.view', 'inventory.locations.view', 'parties.view', 'product.materials.view', 'quality.lots.view'],
} as const
export type Role = keyof typeof ROLES
export const canOf = (role: Role): BuyingCan => buyingCan(ROLES[role])

/** The Office shell around a page at this address (the role's navigation). */
export function inShell(path: string, page: ReactNode, role: Role = 'buyer'): ReactNode {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck(ROLES[role])),
    path,
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: [], site: null, path },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}

const conversation = panelsScreen.cases.find((item) => item.id === 'conversation')!.model as RecordPanelsViewModel

export function panelsModel(type: string, id: string, title: string): RecordPanelsViewModel {
  return { ...conversation, record: { type, id, companyId: COMPANY, siteId: SITE.id }, title, party: null }
}

export function panels(type: string, id: string, title: string): ReactNode {
  return createElement(RecordPanelsView, { model: panelsModel(type, id, title) })
}
