import { defineDesignScreen, type DesignCase } from '../../lib/design/design-screen'
import { permissionCheck } from '../../lib/session/session'
import { DEMO_COMPANIES, DEMO_LABELS, DEMO_SITES, DEMO_TAG, DEMO_USER, rolePermissions } from '../design-data'
import { firstOfficePage, OFFICE_NAV, officeNavFor } from '../nav/office-nav'
import { navWithMfaHint } from './mfa-hint'
import { testModeBanner, testModeRights } from './test-mode'
import { OfficeShellView, type OfficeShellViewModel, type SystemBanner } from './view/OfficeShellView'

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
const admin = navOf('admin') // B-W2b-F49

/**
 * B-W2b-437: the banner a role sees with these sites' carriers and the first company's e-invoicing in test mode (made up).
 * B-W2b-F49: what GET /shell/notices answers every office person; the role only holds the links.
 */
function testModeOf(role: Parameters<typeof rolePermissions>[0], on: { carrier: readonly string[]; eInvoicing: boolean; bannerHidden?: boolean }): SystemBanner[] {
  const company = DEMO_COMPANIES[0]
  const banner = testModeBanner({
    notices: {
      carrierSites: DEMO_SITES.filter((site) => on.carrier.includes(site.name)).map((site) => ({ siteId: site.id, name: site.name })),
      eInvoicingCompanies: on.eInvoicing ? [{ companyId: company.id, name: company.name }] : [],
      bannerHidden: on.bannerHidden ?? false,
    },
    rights: testModeRights(permissionCheck(rolePermissions(role))),
  })
  return banner ? [banner] : []
}

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
    // B-W2b-437: the TEST MODE banner from the two W2b-6 test modes, through the shell's own rule (test-mode.ts) per role.
    {
      id: 'test-mode',
      label: 'TEST MODE banner: the carrier and e-invoicing',
      model: { ...owner, banners: testModeOf('owner', { carrier: [DEMO_SITES[0].name, DEMO_SITES[1].name], eInvoicing: true }) },
      note: 'Shown on every page while a site\'s carrier or the company\'s e-invoicing is in test mode; each line opens where it is switched (Warehouse › Carriers & shipping, Finance › Finance settings).',
    },
    {
      id: 'test-mode-carrier',
      label: 'TEST MODE banner: a warehouse person, one site\'s carrier',
      model: { ...at({ ...owner, nav: warehouse }, '/warehouse/shipments'), banners: testModeOf('warehouse', { carrier: [DEMO_SITES[1].name], eInvoicing: false }) },
      note: 'One site\'s carrier in test mode, e-invoicing live: one line, with its page (Carriers & shipping).',
    },
    {
      id: 'test-mode-reader',
      label: 'TEST MODE banner: a sales person, no settings page to open',
      model: { ...at({ ...owner, nav: sales }, '/sales/orders'), banners: testModeOf('sales', { carrier: [DEMO_SITES[0].name], eInvoicing: true }) },
      note: 'Sales reads both test modes but may not open Carriers & shipping (shipping.settings.view): that line has no link.',
    },
    // B-W2b-F49: every office person sees the band, not only who reads shipping or invoices.
    {
      id: 'test-mode-admin',
      label: 'TEST MODE banner: an admin, who reads neither test mode',
      model: { ...at({ ...owner, nav: admin }, '/admin/users'), banners: testModeOf('admin', { carrier: [DEMO_SITES[0].name], eInvoicing: true }) },
      note: 'The admin role holds neither shipping.view nor invoices.view and still sees both lines (GET /shell/notices, for every office person); it may open Carriers & shipping (shipping.settings.view), not Finance settings (invoices.view): that line has no link.',
    },
    {
      id: 'test-mode-off',
      label: 'TEST MODE banner: everything live',
      model: { ...owner, banners: testModeOf('owner', { carrier: [], eInvoicing: false }) },
      note: 'No band at all (no empty strip) once every site\'s carrier and the company\'s e-invoicing are live.',
    },
    {
      id: 'test-mode-hidden-local',
      label: 'TEST MODE bar hidden on the local test server',
      model: { ...owner, banners: testModeOf('owner', { carrier: [DEMO_SITES[0].name], eInvoicing: true, bannerHidden: true }), localMailbox: true },
      note: 'B-W2b-F58 (Owner answer A, 11-15): FACTORY_HIDE_TEST_MODE_BANNER=1, honoured only on FACTORY_ENV=local: both test modes stay on, no top bar; every other TEST word stays. The person menu offers the Local mailbox (local only).',
    },
    {
      id: 'no-areas',
      label: 'No area yet',
      model: { ...owner, nav: officeNavFor(permissionCheck([])), path: '/me', switcher: { ...switcher, companies: DEMO_COMPANIES.slice(0, 1), sites: [], path: '/me' } },
      note: 'A person with no role: no rail rows, no bottom bar; the profile page still opens.',
    },
    {
      id: 'authenticator-first',
      label: 'Two-factor first: one row in words',
      model: {
        ...owner,
        nav: navWithMfaHint(officeNavFor(permissionCheck([])), { enabled: false, required: true, satisfied: false }),
        path: '/me',
        switcher: { ...switcher, companies: DEMO_COMPANIES.slice(0, 1), sites: [], path: '/me' },
      },
      note: 'B-W2b-F58: a role that asks for two-factor gives nothing until the code is proved on this session: the rail (and the phone bar) hold ONE row, "Set up your authenticator app to see your work", that opens Me › Authenticator.',
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
    // ── B-W2b-05 ─────────────────────────────────────────────────────────────────────────────────────────────────────
    {
      id: 'live',
      label: 'The band: live, and Print this view',
      model: { ...at(owner, '/sales/orders'), live: 'live', printKind: 'view', query: 'late=true' },
      note: 'COL-077: one live connection per tab, said in the band. Print opens this view (its filters) for paper in a new tab.',
    },
    {
      id: 'live-offline',
      label: 'The band: not live',
      model: { ...at(owner, '/sales/orders'), live: 'offline', printKind: 'view' },
      note: 'While the stream is down the tab keeps ONE fallback read every 30 s and says so; it comes back by itself.',
    },
    {
      id: 'print-record',
      label: 'The band on a record: Print view of the record',
      model: { ...at(owner, '/sales/orders/0190f0e2-3333-7000-8000-000000000002'), live: 'live', printKind: 'record' },
      note: 'PLT-171: the record for paper in a new tab (its band and every panel), with the company, site and page numbers.',
    },
    {
      id: 'phone-owner',
      label: 'Phone: the Owner\'s 4 tabs and More',
      model: { ...owner, live: 'live' },
      note: 'PLT-162 — at phone width: Home, Sales, Warehouse, Production, then More (every other area, in rail order: tap it). Esc or the close button closes the sheet.',
    },
    {
      id: 'phone-warehouse',
      label: 'Phone: a warehouse person\'s tabs',
      model: { ...at({ ...owner, nav: warehouse }, firstOfficePage(warehouse, { areaId: 'warehouse' })), live: 'live' },
      note: 'The areas their role opens the most of (Home, Products, Purchasing, Warehouse), in rail order; the rest under More.',
    },
    {
      id: 'phone-sales',
      label: 'Phone: a sales person\'s tabs',
      model: { ...at({ ...owner, nav: sales }, firstOfficePage(sales, { areaId: 'sales' })), live: 'live' },
    },
    {
      id: 'phone-last-page',
      label: 'Phone: tabs open the page used last',
      model: { ...owner, lastPages: { sales: '/sales/orders', warehouse: '/warehouse/stock' } },
      note: 'Sales opens Orders, Warehouse opens Stock (the pages used last on this device); the others their first page.',
    },
    {
      id: 'window',
      label: 'A window page: the planning board',
      model: { ...at(owner, '/planning/board'), frame: 'window', live: 'live' },
      note: 'Z15:01 — no rail, no Pages, no bottom bar: Back to Office, the page\'s name, company and site, the live state, Close (when the window opened from a row). Its navigation row opens it in a new tab.',
    },
    {
      id: 'window-offline',
      label: 'A window page, not live',
      model: { ...at(owner, '/planning/board'), frame: 'window', live: 'offline', switcher: { ...switcher, site: DEMO_SITES[0].id, path: '/planning/board' } },
    },
  ],
})
