import { createElement, type ReactNode } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { permissionCheck } from '../../../lib/session/session'
import type { ExportJob, SavedView, ViewsAnswer } from '../../../list-frame/tools/transport'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER, OWNER_PERMISSIONS } from '../../../shell/design-data'
import { officeNavFor } from '../../../shell/nav/office-nav'
import { OfficeShellView } from '../../../shell/office/view/OfficeShellView'
import type { MemoryToolsModel } from './memory'
import { ListToolsView, type DemoOrder, type ListToolsModel } from './view/ListToolsView'

/**
 * SCR-232 — List tools (design shell.lists; B-W2a-23): the toolbar's Columns ▾ and Export ▾ with their pop-ups
 * (Customise columns, Save view, Exporting N rows) over a made-up list of sales orders ("Demo …" customers, invented
 * numbers), in the Office shell. The tools run in memory: in the browser every menu and dialog works (save, update,
 * share, remove, export with its progress). Each case is a starting state; light and dark, 1440 and 390, English and
 * Italian are the gallery's own switches.
 */

const ROLE_SALES = { id: 'r-demo-sales', name: 'Demo sales' }
const ROLE_FINANCE = { id: 'r-demo-finance', name: 'Demo finance' }
const CUSTOMERS = ['Demo Alfa S.r.l.', 'Demo Beta S.p.A.', 'Demo Gamma S.r.l.', 'Demo Rossi Moto S.r.l.', 'Demo Delta Racing', 'Demo Epsilon S.a.s.']
const STATUSES: DemoOrder['status'][] = ['CONFIRMED', 'IN_PRODUCTION', 'READY', 'IN_PRODUCTION', 'SHIPPED', 'CONFIRMED']
export const DEMO_ORDERS: DemoOrder[] = Array.from({ length: 18 }, (_, index) => ({
  id: `0190f0e2-cdcd-7000-8000-${String(index + 1).padStart(12, '0')}`,
  number: `OV-DEMO-${String(index + 101).padStart(4, '0')}`,
  customer: CUSTOMERS[index % CUSTOMERS.length]!,
  status: STATUSES[index % STATUSES.length]!,
  promised: `2026-${index % 3 === 0 ? '10' : '11'}-${String(10 + (index % 18)).padStart(2, '0')}`,
  late: index % 3 === 0 && STATUSES[index % STATUSES.length] !== 'SHIPPED',
  net: 125_000 + index * 13_750,
}))

const view = (over: Partial<SavedView> & Pick<SavedView, 'id' | 'name'>): SavedView => ({
  listKey: 'sales.orders',
  ownerId: 'me',
  ownerName: 'Demo Owner',
  mine: true,
  audience: 'ONLY_ME',
  roleId: null,
  roleName: null,
  roleDefault: false,
  personalDefault: false,
  state: { query: '' },
  changeHeld: null,
  version: 1,
  ...over,
})

const LATE = view({ id: 'v-late', name: 'Late, my customers', state: { query: 'late=true', columns: { order: [], hidden: ['net'], pinned: ['number'] } } })
const ROSSI = view({ id: 'v-rossi', name: 'Demo Rossi orders', audience: 'ROLE', roleId: ROLE_SALES.id, roleName: ROLE_SALES.name, state: { query: 'q=rossi&rows=all', density: 'compact' } })
const EVERYTHING = view({ id: 'v-all', name: 'Every order', mine: false, ownerId: 'u-bianchi', ownerName: 'Demo Bianchi', audience: 'EVERYONE', state: { query: 'rows=all' }, changeHeld: 'Only its owner changes this view (views.manage changes the views others shared).' })
const START = view({
  id: 'v-start',
  name: 'Sales start',
  mine: false,
  ownerId: 'u-admin',
  ownerName: 'Demo Admin',
  audience: 'ROLE',
  roleId: ROLE_SALES.id,
  roleName: ROLE_SALES.name,
  roleDefault: true,
  state: { query: 'late=true', columns: { order: ['customer', 'number'], hidden: [], pinned: [] }, density: 'compact' },
  changeHeld: 'Only its owner changes this view (views.manage changes the views others shared).',
})
const VIEWS = [LATE, ROSSI, EVERYTHING, START]

const answer = (over: Partial<ViewsAnswer> = {}): ViewsAnswer => ({
  views: VIEWS,
  roleDefaultId: START.id,
  personalDefaultId: null,
  roles: [ROLE_SALES],
  allRoles: [ROLE_FINANCE, ROLE_SALES],
  can: { save: true, manage: true, export: true },
  exports: { formats: ['CSV', 'XLSX'] },
  ...over,
})
// B-W2b-24: Late is my own default view of the list: the list opens on it before the role's default.
const MY_DEFAULT = answer({ views: [view({ ...LATE, personalDefault: true }), ROSSI, EVERYTHING, START], personalDefaultId: LATE.id })
// A sales person: saves and shares with their role, exports; no views.manage (everyone and role defaults held).
const SALES = answer({ allRoles: [], can: { save: true, manage: false, export: true } })
// Read-only: uses the views shared with it; saves none, exports nothing.
const READ_ONLY = answer({ views: [EVERYTHING, START], roles: [], allRoles: [], can: { save: false, manage: false, export: false }, exports: null })

const job = (over: Partial<ExportJob> & Pick<ExportJob, 'id' | 'status'>): ExportJob => ({
  listKey: 'sales.orders',
  format: 'CSV',
  title: 'Sales orders (made-up)',
  viewName: null,
  columns: [
    { key: 'number', label: 'Number' },
    { key: 'customer', label: 'Customer' },
    { key: 'status', label: 'Status' },
    { key: 'promised', label: 'Promised' },
  ],
  omitted: [],
  rowsDone: 0,
  rowCount: null,
  failureReason: null,
  file: null,
  createdAt: '2026-10-30T09:12:00.000Z',
  startedAt: '2026-10-30T09:12:01.000Z',
  finishedAt: null,
  expiresAt: null,
  ...over,
})
const DONE = job({ id: 'j-done', status: 'DONE', rowsDone: 1240, rowCount: 1240, file: { id: 'f-1', name: 'sales-orders-made-up-2026-10-30.csv', sizeBytes: 106_640 }, finishedAt: '2026-10-30T09:12:09.000Z', expiresAt: '2026-11-06T09:12:09.000Z' })
const RUNNING = job({ id: 'j-running', status: 'RUNNING', format: 'XLSX', rowsDone: 3_400, createdAt: '2026-10-30T09:40:00.000Z', startedAt: '2026-10-30T09:40:01.000Z', omitted: [{ key: 'net', label: 'Net' }], viewName: 'Late, my customers' })
const QUEUED = job({ id: 'j-queued', status: 'QUEUED', startedAt: null, createdAt: '2026-10-30T09:41:00.000Z' })
const FAILED = job({ id: 'j-failed', status: 'FAILED', finishedAt: '2026-10-29T16:02:00.000Z', createdAt: '2026-10-29T16:01:00.000Z', failureReason: 'This view has more than 50,000 rows: narrow it with a filter and export it again.' })
const EXPIRED = job({ id: 'j-expired', status: 'EXPIRED', format: 'XLSX', rowsDone: 420, rowCount: 420, createdAt: '2026-10-20T08:00:00.000Z', finishedAt: '2026-10-20T08:00:05.000Z', expiresAt: '2026-10-27T08:00:05.000Z' })
const JOBS = [RUNNING, DONE, FAILED, EXPIRED]

const tools = (over: Partial<MemoryToolsModel> = {}): MemoryToolsModel => ({ pageKey: 'sales.orders', locale: 'en', answer: answer(), jobs: JOBS, layout: { viewId: null }, ...over })
const page = (over: Partial<ListToolsModel> = {}, toolsOver: Partial<MemoryToolsModel> = {}): ListToolsModel => ({ tools: tools(toolsOver), rows: DEMO_ORDERS, query: '', price: true, ...over })

/** The Office shell around the list, at Sales › Orders (the owner's navigation). */
function inShell(content: ReactNode): ReactNode {
  const path = '/sales/orders'
  return createElement(
    OfficeShellView,
    {
      model: {
        nav: officeNavFor(permissionCheck(OWNER_PERMISSIONS)),
        path,
        switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: [], site: null, path },
        user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
        tenantTag: DEMO_TAG,
        banners: [],
      },
    },
    content,
  )
}

function ListToolsDesign({ model }: { model: ListToolsModel }) {
  return inShell(createElement(ListToolsView, { model }))
}

export const designScreen = defineDesignScreen<ListToolsModel>({
  screen: 'SCR-232',
  title: 'List tools: saved views, Customise, export (every Office list)',
  view: ListToolsDesign,
  cases: [
    { id: 'toolbar', label: 'The toolbar: Search · Rows ▾ · Columns ▾ · Export ▾', model: page(), note: 'Open Columns ▾ or Export ▾: every item works in memory. The keys stay in the footer icon.' },
    { id: 'columns-menu', label: 'Columns ▾: my views, the shared ones, the verbs, Customise', model: page({}, { design: { menu: 'columns' } }) },
    { id: 'view-open', label: 'A view of mine is on screen: its name on the trigger, its filter and columns applied', model: page({ query: 'late=true' }, { layout: { columns: LATE.state.columns, viewId: LATE.id } }) },
    { id: 'view-changed', label: 'The screen differs from the view: “· changed”, Update offered', model: page({ query: 'late=true&q=beta' }, { layout: { columns: LATE.state.columns, viewId: LATE.id }, design: { menu: 'columns' } }) },
    { id: 'role-default', label: "The list opens on the role's default view (Sales start)", model: page({}, { layout: null }), note: 'A clean address and no working layout: the default of the first role held.' },
    { id: 'my-default', label: 'The list opens on my default view (Late, my customers), before the role’s default', model: page({}, { answer: MY_DEFAULT, layout: null }), note: 'A clean address and no working layout: my own default first (B-W2b-24); the role default only for those without one.' },
    { id: 'my-default-menu', label: 'Columns ▾ on my default: marked “my default”, Stop using it as my default', model: page({ query: 'late=true' }, { answer: MY_DEFAULT, layout: { columns: LATE.state.columns, viewId: LATE.id }, design: { menu: 'columns' } }) },
    { id: 'make-default', label: 'Columns ▾ on a view of mine: Make it my default', model: page({ query: 'q=rossi&rows=all' }, { layout: { density: 'compact', viewId: ROSSI.id }, design: { menu: 'columns' } }), note: 'Only a view of my own can be my default; a shared view says so (held with the reason) and is saved as my own first.' },
    { id: 'shared-view', label: 'A view shared by someone else: Copy link only (its owner changes it); my default held with the reason', model: page({ query: 'rows=all' }, { layout: { viewId: EVERYTHING.id }, design: { menu: 'columns' } }) },
    { id: 'customise', label: 'Customise columns: order, show, freeze; the rows’ density', model: page({}, { design: { dialog: 'customise' } }) },
    { id: 'save-view', label: 'Save view: name, who sees it, what it keeps', model: page({ query: 'late=true' }, { design: { dialog: 'save' } }) },
    { id: 'save-view-sales', label: 'Save view without views.manage: everyone and a role default held with the reason', model: page({ query: 'late=true' }, { answer: SALES, design: { dialog: 'save' } }) },
    { id: 'edit-view', label: 'Rename or share a view, with its link to copy', model: page({ query: 'q=rossi&rows=all' }, { layout: { density: 'compact', viewId: ROSSI.id }, design: { dialog: 'edit', activeViewId: ROSSI.id } }) },
    { id: 'remove-view', label: 'Remove a shared view: its reach said first', model: page({ query: 'q=rossi&rows=all' }, { layout: { density: 'compact', viewId: ROSSI.id }, design: { dialog: 'remove', activeViewId: ROSSI.id } }) },
    { id: 'export-menu', label: 'Export ▾: this view as CSV or Excel, then my recent exports', model: page({}, { design: { menu: 'export' } }) },
    { id: 'export-running', label: 'Exporting: progress, you can close the window, the columns left out by rights', model: page({}, { design: { dialog: 'job', job: RUNNING } }) },
    { id: 'export-queued', label: 'Exporting: waiting for the worker', model: page({}, { design: { dialog: 'job', job: QUEUED } }) },
    { id: 'export-done', label: 'The export is ready: the file, its rows and size, until when it is kept, Download', model: page({}, { design: { dialog: 'job', job: DONE } }) },
    { id: 'export-failed', label: 'The export failed: why, in words; Export again', model: page({}, { design: { dialog: 'job', job: FAILED } }) },
    { id: 'export-expired', label: 'The file was deleted after 7 days: Export again', model: page({}, { design: { dialog: 'job', job: EXPIRED } }) },
    { id: 'no-price', label: 'No price grain: the Net column is absent (and never in a file)', model: page({ price: false }, { answer: SALES }) },
    { id: 'read-only', label: 'Read-only: shared views to use, Save held with the reason, no Export ▾', model: page({ price: false }, { answer: READ_ONLY, design: { menu: 'columns' } }) },
    { id: 'no-export', label: 'A list without an export: no Export ▾ (its own Export N of the selected rows stays)', model: page({}, { answer: answer({ exports: null }) }) },
    { id: 'views-loading', label: 'The saved views are still being read', model: page({}, { answer: 'loading', design: { menu: 'columns' } }) },
    { id: 'views-failed', label: "The saved views couldn't be read: Try again in the menu, the list works", model: page({}, { answer: 'failed', design: { menu: 'columns' } }) },
    { id: 'link-not-shared', label: 'A link to a view not shared with me: the list opens as it is, said in a notice', model: page({}, { linked: { view: 'v-not-shared', export: null } }) },
    { id: 'empty', label: 'No rows yet: the toolbar stays', model: page({ rows: [] }) },
  ],
})
