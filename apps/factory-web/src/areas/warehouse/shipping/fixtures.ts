import { createElement, type ReactNode } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { permissionCheck } from '../../../lib/session/session'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER, OWNER_PERMISSIONS } from '../../../shell/design-data'
import { officeNavFor } from '../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../shell/office/view/OfficeShellView'
import type { CarrierAccount, Printer, ShippingSettings, SiteSettings } from './api'
import { abilitiesOf, formOf, type SettingsForm } from './model'
import { ShippingSettingsView, type ShippingSettingsViewModel } from './view/ShippingSettingsView'

/**
 * SCR-068 — Carriers & shipping (design warehouse.shipping) with made-up data only: an invented company ("Officina
 * Demo S.r.l."), sites ("Stabilimento Demo Nord", "Magazzino Demo Sud"), made-up addresses, printers and carrier
 * accounts. Every state of the page (loading, error, no permission, no sites, a site not set up yet, unsaved changes,
 * field problems, saved, conflict) and the roles: Owner (sees the carrier accounts: a FAKE one makes the TEST pill),
 * Warehouse (changes the settings, sees no carrier account list), Sales and Finance (read only). Typing, the site
 * picker, Discard, ⌘S and Esc work for real (nothing is sent).
 */

const PREFIX = '/w/DEMO'
const COMPANY = DEMO_COMPANIES[0].id
const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const at = (day: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 9, day, hour, minute)).toISOString()

const COMMON = ['home.view', 'threads.read', 'files.read']
const ROLES = {
  owner: [...OWNER_PERMISSIONS, ...COMMON, 'shipping.view', 'shipping.manage', 'shipping.settings.view', 'shipping.settings.manage', 'print.view', 'print.manage'],
  warehouse: [...COMMON, 'shipping.view', 'shipping.manage', 'shipping.pack', 'shipping.settings.view', 'shipping.settings.manage', 'print.view', 'print.labels', 'print.documents'],
  sales: [...COMMON, 'orders.view', 'shipping.view', 'shipping.settings.view'],
  finance: [...COMMON, 'invoices.view', 'shipping.view', 'shipping.settings.view'],
} as const
type Role = keyof typeof ROLES

function inShell(page: ReactNode, role: Role): ReactNode {
  const path = '/warehouse/shipping'
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

// ---- made-up data ----------------------------------------------------------------------------------------------------------

const NORTH = { id: uid('5e5e', 1), companyId: COMPANY, code: 'NORD', name: 'Stabilimento Demo Nord' }
const SOUTH = { id: uid('5e5e', 2), companyId: COMPANY, code: 'SUD', name: 'Magazzino Demo Sud' }

const ACCOUNT_FAKE: CarrierAccount = {
  id: uid('acc0', 1),
  companyId: COMPANY,
  provider: 'SENDCLOUD',
  code: 'sendcloud-demo',
  label: 'Sendcloud Demo (test)',
  mode: 'FAKE',
  status: 'ACTIVE',
  credentials: { saved: true, savedAt: at(20, 9) },
  lastOkAt: at(29, 15, 12),
  lastErrorAt: null,
}
const ACCOUNT_LIVE: CarrierAccount = { ...ACCOUNT_FAKE, id: uid('acc0', 2), code: 'sendcloud-live', label: 'Sendcloud Demo', mode: 'LIVE', lastOkAt: at(29, 16, 40), lastErrorAt: at(27, 11, 5) }
const ACCOUNT_PAUSED: CarrierAccount = { ...ACCOUNT_LIVE, status: 'PAUSED' }
/** Another company's account: never offered here. */
const ACCOUNT_OTHER: CarrierAccount = { ...ACCOUNT_LIVE, id: uid('acc0', 3), companyId: DEMO_COMPANIES[1].id, label: 'Sendcloud Esempio' }

const printer = (n: number, code: string, name: string, kind: Printer['kind'], status: Printer['status'] = 'ACTIVE'): Printer => ({ id: uid('9919', n), companyId: COMPANY, siteId: NORTH.id, code, name, kind, status })
const PRINTERS: Printer[] = [printer(1, 'LBL-PACK', 'Etichette banco imballo', 'LABEL_ZPL'), printer(2, 'A4-PACK', 'A4 banco imballo', 'A4_PDF'), printer(3, 'LBL-QC', 'Etichette collaudo', 'LABEL_ZPL', 'PAUSED'), printer(4, 'A4-OLD', 'A4 dismessa', 'A4_PDF', 'ARCHIVED')]

const SETTINGS: ShippingSettings = {
  id: NORTH.id,
  siteId: NORTH.id,
  companyId: COMPANY,
  senderAddress: { name: 'Officina Demo S.r.l.', line1: 'Via dell’Esempio 12', line2: 'Capannone B', postalCode: '40100', city: 'Bologna', province: 'BO', country: 'IT', phone: '+39 051 000 0000', email: 'spedizioni@officina-demo.example.com' },
  returnAddress: null,
  integrationAccountId: ACCOUNT_FAKE.id,
  defaultCarrierCode: 'brt',
  defaultServiceCode: 'brt:express',
  defaultTransportBy: 'CARRIER',
  defaultGoodsAppearance: 'Scatole di cartone',
  labelPrinterId: PRINTERS[0]!.id,
  documentPrinterId: PRINTERS[1]!.id,
  cutOffTime: '17:00',
  version: 4,
  updatedAt: at(28, 10, 42),
}

const NORTH_SET: SiteSettings = { site: NORTH, settings: SETTINGS }
const SOUTH_EMPTY: SiteSettings = { site: SOUTH, settings: null }

const base = (role: Role, over: Partial<ShippingSettingsViewModel> = {}): { role: Role; model: ShippingSettingsViewModel } => {
  const can = abilitiesOf(ROLES[role])
  return {
    role,
    model: {
      prefix: PREFIX,
      can,
      sites: { status: 'ready', items: [NORTH_SET] },
      siteId: NORTH.id,
      accounts: can.accounts ? { value: [ACCOUNT_FAKE, ACCOUNT_LIVE, ACCOUNT_OTHER], problem: null } : null,
      printers: can.printers ? { value: PRINTERS, problem: null } : null,
      formKey: '0',
      busy: false,
      savedAt: null,
      notice: null,
      conflict: false,
      serverProblems: {},
      ...over,
    },
  }
}

const typed = (change: (form: SettingsForm) => SettingsForm, settings: ShippingSettings | null = SETTINGS): SettingsForm => change(formOf(settings))

function ShippingDesign({ model }: { model: { role: Role; model: ShippingSettingsViewModel } }) {
  return inShell(createElement(ShippingSettingsView, { model: model.model }), model.role)
}

export const designScreen = defineDesignScreen<{ role: Role; model: ShippingSettingsViewModel }>({
  screen: 'SCR-068',
  title: 'Carriers & shipping (Warehouse › Settings)',
  view: ShippingDesign,
  cases: [
    { id: 'owner', label: 'Owner: the site set up, a FAKE Sendcloud account (TEST pill), both printers', model: base('owner'), note: 'Type in a field: the save bar counts the changes; ⌘S saves, Esc asks before discarding.' },
    { id: 'owner-live', label: 'Owner: a live account (Connected), its last calls', model: base('owner', { sites: { status: 'ready', items: [{ site: NORTH, settings: { ...SETTINGS, integrationAccountId: ACCOUNT_LIVE.id } }] } }) },
    { id: 'warehouse', label: 'Warehouse: changes the settings; the carrier account only as “set” (no integrations.view)', model: base('warehouse') },
    { id: 'sales-read-only', label: 'Sales: read only (shipping.settings.view): fields as text', model: base('sales') },
    { id: 'finance-read-only', label: 'Finance: read only, no printers listed (no print.view)', model: base('finance') },
    { id: 'two-sites', label: 'Two sites: the site picker; the second is not set up yet', model: base('warehouse', { sites: { status: 'ready', items: [NORTH_SET, SOUTH_EMPTY] } }) },
    { id: 'new-site', label: 'A site with no settings yet: “Add the address labels are sent from”', model: base('warehouse', { sites: { status: 'ready', items: [NORTH_SET, SOUTH_EMPTY] }, siteId: SOUTH.id, printers: { value: [], problem: null } }) },
    {
      id: 'unsaved',
      label: 'Unsaved changes: the cut-off moved and returns go elsewhere (save bar)',
      model: base('owner', {
        draft: typed((form) => ({ ...form, cutOffTime: '16:30', returnDifferent: true, returns: { ...form.sender, name: 'Officina Demo S.r.l. – Resi', line1: 'Via del Ritorno 3', line2: '' } })),
      }),
    },
    {
      id: 'field-problems',
      label: 'Field problems shown beside each field after Save was pressed',
      model: base('warehouse', {
        tried: true,
        draft: typed((form) => ({ ...form, sender: { ...form.sender, city: '', country: 'Italia', email: 'spedizioni@' }, defaultCarrierCode: 'BRT Express', defaultServiceCode: 'express', cutOffTime: '5pm' })),
      }),
    },
    {
      id: 'refused',
      label: 'The server refused a printer and the account (in the page’s words)',
      model: base('owner', { notice: { tone: 'danger', key: 'save.problem.invalid' }, serverProblems: { labelPrinterId: 'problem.labelPrinter', integrationAccountId: 'problem.account' } }),
    },
    { id: 'saved', label: 'Saved: “All changes saved · 10:42”', model: base('owner', { savedAt: at(29, 9, 42) }) },
    { id: 'saving', label: 'Saving (the save bar is busy)', model: base('owner', { busy: true, draft: typed((form) => ({ ...form, cutOffTime: '16:00' })) }) },
    { id: 'conflict', label: 'Changed by someone else meanwhile: the typing stays, Reload', model: base('warehouse', { conflict: true, draft: typed((form) => ({ ...form, defaultGoodsAppearance: 'Scatole di cartone su bancale' })) }) },
    { id: 'discard', label: 'Esc with unsaved changes: Discard asks first', model: base('warehouse', { discardOpen: true, draft: typed((form) => ({ ...form, cutOffTime: '18:00' })) }) },
    { id: 'no-printers', label: 'No printer at the site yet (labels print as PDFs from the browser)', model: base('owner', { printers: { value: [], problem: null } }) },
    { id: 'no-account', label: 'The company has no Sendcloud account: connect it in Admin › Connections & API', model: base('owner', { accounts: { value: [ACCOUNT_OTHER], problem: null }, sites: { status: 'ready', items: [{ site: NORTH, settings: { ...SETTINGS, integrationAccountId: null } }] } }) },
    { id: 'paused-account', label: 'The site’s account is paused: no label can be bought', model: base('owner', { accounts: { value: [ACCOUNT_PAUSED], problem: null }, sites: { status: 'ready', items: [{ site: NORTH, settings: { ...SETTINGS, integrationAccountId: ACCOUNT_PAUSED.id } }] } }) },
    { id: 'accounts-failed', label: 'The carrier accounts could not be read (Try again)', model: base('owner', { accounts: { value: null, problem: 'read.problem.unavailable' } }) },
    { id: 'loading', label: 'Loading', model: base('owner', { sites: { status: 'loading' } }) },
    { id: 'error', label: 'The read failed: in words, with Try again (never drawn as empty)', model: base('owner', { sites: { status: 'error', problem: 'read.problem.unavailable' } }) },
    { id: 'no-permission', label: 'No permission: shipping.settings.view is missing', model: base('sales', { sites: { status: 'error', problem: 'read.problem.forbidden' } }) },
    { id: 'no-sites', label: 'No site within the person’s access', model: base('warehouse', { sites: { status: 'ready', items: [] } }) },
  ],
})
