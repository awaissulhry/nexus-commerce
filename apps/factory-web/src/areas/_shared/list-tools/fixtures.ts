import { createElement, type ReactNode } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { permissionCheck } from '../../../lib/session/session'
import type { ExportJob, SavedView, ViewsAnswer } from '../../../list-frame/tools/transport'
import type { BulkRowFacts } from '@nexus/factory-domain/views/bulk/rules'
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
  priority: index % 4,
  owner: index % 2 === 0 ? 'me' : 'u-demo-bianchi',
  version: 1,
}))

/** B-W2b-13: the made-up orders as the bulk target reads them (shipped ones keep their promised day and priority). */
export const DEMO_BULK: BulkRowFacts[] = DEMO_ORDERS.map((row) => {
  const held = row.status === 'SHIPPED' ? { code: 'held' as const, status: row.status } : null
  return { id: row.id, label: row.number, version: row.version, values: { promised: row.promised, priority: row.priority }, held: { promised: held, priority: held } }
})

const view = (over: Partial<SavedView> & Pick<SavedView, 'id' | 'name'>): SavedView => ({
  listKey: 'sales.orders',
  ownerId: 'me',
  ownerName: 'Demo Owner',
  mine: true,
  audience: 'ONLY_ME',
  roleId: null,
  roleName: null,
  roleDefault: false,
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
  roles: [ROLE_SALES],
  allRoles: [ROLE_FINANCE, ROLE_SALES],
  can: { save: true, manage: true, export: true },
  exports: { formats: ['CSV', 'XLSX'] },
  ...over,
})
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
/** B-W2b-13: the W2b frame on (modes, cards, edit, quick filters, Export N of the selection), the bulk rows in memory. */
const w2b = (over: Partial<ListToolsModel> = {}, toolsOver: Partial<MemoryToolsModel> = {}): ListToolsModel => page({ w2b: true, ...over }, { bulk: DEMO_BULK, ...toolsOver })
const PICKED = DEMO_ORDERS.filter((row) => row.status !== 'SHIPPED').slice(0, 4).map((row) => row.id)
const PICKED_WITH_SHIPPED = DEMO_ORDERS.slice(0, 6).map((row) => row.id)

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
    { id: 'shared-view', label: 'A view shared by someone else: Copy link only (its owner changes it)', model: page({ query: 'rows=all' }, { layout: { viewId: EVERYTHING.id }, design: { menu: 'columns' } }) },
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
    // B-W2b-13 — the W2b list frame.
    { id: 'w2b-table', label: 'W2b · Table: mode switch, quick filters, editable Promised and Priority cells (F2 or type; saves by itself)', model: w2b(), note: 'Edit a Promised day or a Priority: ↻ while saving, then green; a shipped order says why it keeps them. Paste a column from a sheet with ⌘V.' },
    { id: 'w2b-board', label: 'W2b · Board by status: drag or Move to… where no review is needed; Shipped held with the reason', model: w2b({ query: 'mode=board' }), note: 'Space picks a card up, ← → choose the lane, Enter drops. Ready from Confirmed and every move to Shipped are held with their reason.' },
    { id: 'w2b-calendar', label: 'W2b · Calendar by the promised day: rows per day, the chosen day’s orders, Move to another day', model: w2b({ query: 'mode=calendar&rows=all', design: { day: '2026-11-11' } }), note: 'Arrows move between days, Enter opens a day. Moving a day goes through the same save as the cell (version-checked).' },
    { id: 'w2b-cards', label: 'W2b · Cards (on a phone the table is these cards by itself): same columns, filters, Select mode', model: w2b({ query: 'mode=cards' }) },
    { id: 'w2b-quick', label: 'W2b · Quick filters on: “Followed by me” and “Promised: This week” as chips with ✕', model: w2b({ query: 'owner=me&promised=this-week&rows=all' }), note: 'The words stay in the address (owner=me, promised=this-week): a saved view keeps meaning the same week and the person who opens it.' },
    { id: 'w2b-quick-none', label: 'W2b · A quick filter that matches nothing: the list says so, the chips stay', model: w2b({ query: 'promised=today' }) },
    { id: 'w2b-selected', label: 'W2b · Rows selected: Edit N and Export N beside the list’s own actions', model: w2b({ selected: PICKED }) },
    { id: 'w2b-bulk-form', label: 'W2b · Edit 4 orders: choose the fields and the new values', model: w2b({ selected: PICKED, design: { bulk: { values: { promised: '2026-11-20' } } } }) },
    { id: 'w2b-bulk-held', label: 'W2b · Edit with shipped orders selected: the fields they keep are held with how many and why', model: w2b({ selected: PICKED_WITH_SHIPPED, design: { bulk: {} } }) },
    { id: 'w2b-bulk-review', label: 'W2b · Review: old → new per order, the ones already so, the ones refused; Save, then Done with Undo', model: w2b({ selected: PICKED_WITH_SHIPPED, design: { bulk: { values: { priority: 2 }, review: true } } }), note: 'Change → the Done screen counts what was saved; Undo puts back what changed (a row changed again since is refused, never overwritten).' },
    { id: 'w2b-bulk-failed', label: 'W2b · Save refused for every row: each says why, nothing written', model: w2b({ selected: PICKED, design: { bulk: { values: { priority: 3 }, review: true } } }, { bulkFails: true }) },
    { id: 'w2b-bulk-offline', label: 'W2b · The review cannot read the rows: Save held, Try again', model: w2b({ selected: PICKED, design: { bulk: { values: { priority: 3 }, review: true } } }, { bulk: undefined }) },
    { id: 'w2b-edit-held', label: 'W2b · No right to change orders: cells read only, Edit N held with the reason', model: w2b({ editHeld: true, selected: PICKED }) },
    { id: 'w2b-export-selected', label: 'W2b · Export N of the selected orders went through the shared engine: the job says “only the 4 selected rows”', model: w2b({}, { design: { dialog: 'job', job: job({ id: 'j-selected', status: 'RUNNING', rowsDone: 2, rowCount: 4, selected: 4 }) } }), note: 'Select rows, then Export N › CSV or Excel: the same job dialog follows the export of the selection.' },
    { id: 'w2b-no-price', label: 'W2b · No price grain: Columns ▾ lists Net as “Hidden: needs price rights”', model: w2b({ price: false }, { answer: SALES, design: { menu: 'columns' } }) },
    { id: 'w2b-loading', label: 'W2b · Board while the rows are read', model: w2b({ query: 'mode=board', loading: true }) },
  ],
})
