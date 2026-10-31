import { defineDesignScreen, type DesignCase } from '../../lib/design/design-screen'
import { permissionCheck } from '../../lib/session/session'
import { DEMO_COMPANIES, DEMO_LABELS, DEMO_SITES, DEMO_TAG, DEMO_USER, rolePermissions } from '../design-data'
import { firstOfficePage, OFFICE_NAV, officeNavFor } from '../nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from './view/OfficeShellView'

/**
 * SCR-003 — the Office frame with the navigation of W1 (B-W1-08) and W2a (B-W2a-83): the Owner's full rail (12 areas in
 * the approved tree's order, Plant right above Admin at the foot), each area's Pages overlay open on its first page, and
 * two roles' smaller maps. People are the system role templates as the build ships them (made-up names; nothing real).
 */

const navOf = (role: Parameters<typeof rolePermissions>[0]) => officeNavFor(permissionCheck(rolePermissions(role)))
const switcher = { companies: DEMO_COMPANIES, company: 'DEMO', sites: DEMO_SITES, site: null, path: '/home/today' }
const at = (model: OfficeShellViewModel, path: string): OfficeShellViewModel => ({ ...model, path, switcher: { ...model.switcher, path } })

const owner: OfficeShellViewModel = {
  nav: navOf('owner'),
  path: '/home/today',
  switcher,
  user: DEMO_USER,
  tenantTag: DEMO_TAG,
  banners: [],
}

/** One case per area: the Owner on the area's first page, its Pages overlay open (Admin on Users: a page inside a group). */
const areaCases: DesignCase<OfficeShellViewModel>[] = OFFICE_NAV.areas.map((area) => {
  const path = area.id === 'admin' ? '/admin/users' : firstOfficePage(owner.nav, { areaId: area.id })
  const name = `${area.id.charAt(0).toUpperCase()}${area.id.slice(1)}`
  return {
    id: `area-${area.id}`,
    label: `Owner: ${name} pages open`,
    model: { ...at(owner, path), areaNavOpen: true },
    note: `${name}'s overlay in the tree's groups and order; exactly one row is current (${path}). Esc closes it and the focus goes back to the button.`,
  }
})

const warehouse = navOf('warehouse')
const sales = navOf('sales')

export const designScreen = defineDesignScreen<OfficeShellViewModel>({
  screen: 'SCR-003',
  title: 'Office shell',
  view: OfficeShellView,
  holdsPage: true,
  cases: [
    {
      id: 'owner',
      label: 'Owner on Home › Today (pages closed)',
      model: owner,
      note: 'The full rail: Home, Sales, Products, Planning, Purchasing, Warehouse, Production, Quality, Compliance, Finance, Plant, Admin at the foot. Rail: hover or Tab. Search: ⌘K. Phone: bottom bar.',
    },
    ...areaCases,
    {
      id: 'record',
      label: 'A record under a page',
      model: at(owner, '/sales/orders/0190f0e2-3333-7000-8000-000000000002'),
      note: 'A deep link to a record (PLT-161): Orders stays the current page; the record page draws its own header below.',
    },
    {
      id: 'warehouse',
      label: 'Warehouse role: its pages open',
      model: { ...at({ ...owner, nav: warehouse }, firstOfficePage(warehouse, { areaId: 'warehouse' })), areaNavOpen: true },
      note: 'Only the rows the warehouse role may open, in the same order: of Finance only Finance reports (quantities), of Admin only Import & export.',
    },
    {
      id: 'sales',
      label: 'Sales role: its pages open',
      model: { ...at({ ...owner, nav: sales }, firstOfficePage(sales, { areaId: 'sales' })), areaNavOpen: true },
      note: 'A sales person: Home, Sales and the areas it reads; nothing of Admin.',
    },
    {
      id: 'bell',
      label: 'The bell: 4 unread (B-W2a-40)',
      model: { ...owner, bell: { status: 'ready', unread: 4, complete: true } },
      note: 'Mentions, assignments, approvals and alerts: "Notifications: 4 unread" in words; it opens Home › Notifications. One light read, then live.',
    },
    {
      id: 'bell-none',
      label: 'The bell: nothing unread',
      model: { ...owner, bell: { status: 'ready', unread: 0, complete: true } },
      note: 'No badge; its words say "nothing unread".',
    },
    {
      id: 'bell-many',
      label: 'The bell: more than 1000 unread',
      model: { ...owner, bell: { status: 'ready', unread: 1000, complete: false } },
      note: 'The badge says 99+, the words "more than 1000 unread".',
    },
    {
      id: 'bell-unknown',
      label: 'The bell: count not available',
      model: { ...owner, bell: { status: 'error' } },
      note: 'An unknown count shows no badge, never 0; the words say the count is not available now.',
    },
    {
      id: 'test-mode',
      label: 'TEST MODE banner',
      model: { ...owner, banners: [{ id: 'test-mode', kind: 'test-mode', connections: ['Email (fake)', 'Files (fake)', 'Printing (fake)'] }] },
      note: 'Shown while any connection is fake or in a sandbox.',
    },
    {
      id: 'no-areas',
      label: 'No area yet',
      model: { ...owner, nav: officeNavFor(permissionCheck([])), path: '/me', switcher: { ...switcher, companies: DEMO_COMPANIES.slice(0, 1), sites: [], path: '/me' } },
      note: 'A person with no role: no rail rows, no bottom bar; the profile page still opens.',
    },
    {
      id: 'palette-pages',
      label: 'Search open: every page',
      model: { ...owner, paletteOpen: true, paletteQuery: '' },
      note: 'Every page the Owner may open, by area, then My profile (the top bar).',
    },
    {
      id: 'palette',
      label: 'Search open with a scanned label',
      model: { ...owner, paletteOpen: true, paletteQuery: DEMO_LABELS.hide },
    },
  ],
})
