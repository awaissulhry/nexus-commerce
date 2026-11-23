import { createElement, useMemo, useRef, useState, type ReactNode } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import type { UnreadMap } from '../../../lib/last-message-cell/model'
import { ListToolsContext } from '../../../list-frame/tools/transport'
import type { TaskDraft } from '../../../record-panels/tasks/model'
import { TaskNewDialog } from '../../../record-panels/tasks/view/TaskNewDialog'
import { memoryStore, memoryTransport, type MemoryToolsModel } from '../../_shared/list-tools/memory'
import type { PartyRow } from '../../parties/_shared/api'
import { at, CUSTOMERS, inShell, listModel, NOW, rowOf, SUPPLIERS, useDesignList } from '../../parties/_shared/fixtures'
import { blankNewParty, failed, loaded, loading, SIDES, type PartiesListModel } from '../../parties/_shared/model'
import { demoCustomersImport, importButton } from './_demo/fixtures'
import type { CustomersImportModel } from './import/view/CustomersImportView'
import { namesOtherCustomer, type CustomerRights } from './list/model'
import type { SupervisorManyModel } from './list/supervisor/model'
import { SupervisorManyDialog } from './list/supervisor/view/SupervisorManyDialog'
import { bandOf, BUSY_ROWS, BUSY_UNREAD, busyId, DEMO_TODAY, LIMITED_CODES, ROLE_RIGHTS, SUPERVISOR_PEOPLE, supervisorWindow, workModel } from './list/_demo/fixtures'
import type { CustomersViewWork } from './view/CustomersView'
import type { OverdueListModel } from './money/columns'
import { MONEY_CAN, overdueList } from './money/_demo/fixtures'
import { CustomersView } from './view/CustomersView'

/**
 * SCR-032 Customers — made-up customers only ("Demo", "Esempio", "Beispiel" names, example.com mail, VAT numbers of
 * zeros and ones). Each case is one state the Owner reviews: the list with its tiles, each tile pressed, search,
 * nothing yet, nothing matching, loading, a failed read, no access, read-only rights (held actions with their reason),
 * a selection with its reach, live updates waiting, offline, more pages, and every dialog.
 */

const rows = CUSTOMERS.map(rowOf)
const list = (over: Partial<PartiesListModel> = {}) => listModel('customers', over)
const pick = (...codes: string[]) => rows.filter((row) => codes.includes(row.code)).map((row) => row.id)

/** F-CL-102: the reader's own new messages per customer (made up): two customers with something new. */
const UNREAD: UnreadMap = {
  [CUSTOMERS.find((item) => item.code === 'MODA-DEMO')!.id]: { newCount: 2, lastAt: NOW },
  [CUSTOMERS.find((item) => item.code === 'DE-BEISPIEL')!.id]: { newCount: 1, lastAt: at(28, 16, 5) },
}

/**
 * A case: the list, (B-W2a-49) the band's Import with its wizard when open, (B-W2a-81) the Overdue column's read and (F-CL-102) the
 * New messages read (null: a reader without threads.read — no column).
 */
type CustomersCase = PartiesListModel & {
  importer?: CustomersImportModel
  overdue?: OverdueListModel
  unread?: UnreadMap | null
  rights?: CustomerRights
  // ---- T.1 (customers list): where the work stands, Views ▾ / Export ▾ / Customise in memory, and the windows of the bar
  workView?: CustomersViewWork | null
  tools?: MemoryToolsModel
  windows?: { readonly task?: { readonly ticked: readonly PartyRow[]; readonly initial?: Partial<TaskDraft> }; readonly supervisor?: SupervisorManyModel }
}

/** F-CL-104: the Owner's own rights on the list (the bar's Add task and Set supervisor, the row's doors); a role that only views: none. */
const OWNER_RIGHTS: CustomerRights = { threads: true, orders: true, tasks: true, supervisor: true }
const VIEW_RIGHTS: CustomerRights = { threads: false, orders: false, tasks: false, supervisor: false }

function CustomersDesign({ model }: { model: CustomersCase }) {
  const { importer, overdue, unread, rights, workView, tools, windows, ...list } = model
  const view = createElement(CustomersView, { ...useDesignList(list), headActions: importButton(importer ?? { held: null, sheet: null }), overdue, unread: unread === undefined ? UNREAD : unread, rights: rights ?? (list.can.manage ? OWNER_RIGHTS : VIEW_RIGHTS), work: workView ?? null })
  const page = createElement('div', null, tools ? createElement(MemoryTools, { tools }, view) : view, windows ? createElement(Windows, { windows }) : null)
  return inShell('/sales/customers', page)
}

/** T.1: Views ▾ (the side's views, saved ones), Export ▾ and Customise in memory — the Office's list tools, made up. */
function MemoryTools({ tools, children }: { tools: MemoryToolsModel; children?: ReactNode }) {
  const [query, setQuery] = useState('')
  const store = useRef(memoryStore(tools))
  const transport = useMemo(() => memoryTransport(tools, store.current, query, setQuery), [tools, query])
  return createElement(ListToolsContext.Provider, { value: transport }, children)
}

/** T.1: the bar's windows at a step (nothing is sent from the gallery). */
function Windows({ windows }: { windows: NonNullable<CustomersCase['windows']> }) {
  const task = windows.task
  return createElement(
    'div',
    null,
    task
      ? createElement(TaskNewDialog, {
          recordLabel: null,
          people: { status: 'ready', data: SUPERVISOR_PEOPLE },
          me: SUPERVISOR_PEOPLE[1]!.id,
          onClose: () => undefined,
          ...(task.initial ? { initial: task.initial } : {}),
          batch: {
            records: task.ticked.map((row) => ({ type: 'Party', id: row.id, label: row.tradeName ?? row.legalName, supervisor: null })),
            today: DEMO_TODAY,
            onSend: async () => null,
            words: { ns: 'customers-list', prefix: 'task' },
            namesOther: (text: string) => namesOtherCustomer(text, task.ticked),
            hrefOf: (record: { readonly id: string }) => `/w/DEMO/sales/customers/${record.id}?thread=open`,
            about: true, // F-CL-301 (walk W-5)
          },
        })
      : null,
    windows.supervisor ? createElement(SupervisorManyDialog, { model: windows.supervisor, actions: SUPERVISOR_ACTIONS, hrefOf: (id: string) => `/w/DEMO/sales/customers/${id}?thread=open` }) : null,
  )
}
const SUPERVISOR_ACTIONS = { onPick: () => undefined, onGo: () => undefined, onStop: () => undefined, onRunRest: () => undefined, onClose: () => undefined }

// ---- T.1: the busy list (14 customers in every state), its band and work, each role, each window step ----
const TOOLS: MemoryToolsModel = { pageKey: 'sales.customers', locale: 'en', answer: { views: [], roleDefaultId: null, personalDefaultId: null, roles: [], allRoles: [], can: { save: true, manage: false, export: true }, exports: { formats: ['XLSX', 'CSV'] } }, jobs: [] }
const SORT = { choices: ['needs', 'code', 'name'] as const, value: 'needs' as const, sortedBy: 'needs' as const }
const busyWork = (codes?: readonly string[], limited = false): CustomersViewWork => {
  const facts = workModel(codes, { limited })
  return { facts, band: { band: bandOf(facts, limited), problem: null }, today: DEMO_TODAY, wide: false }
}
const busy = (over: Partial<CustomersCase> = {}): CustomersCase => ({
  ...list({ rows: loaded(BUSY_ROWS), total: BUSY_ROWS.length, sort: SORT }),
  unread: BUSY_UNREAD,
  rights: OWNER_RIGHTS,
  workView: busyWork(),
  tools: TOOLS,
  ...over,
})
const busyRows = (...codes: string[]) => BUSY_ROWS.filter((row) => codes.includes(row.code))
const SIX = ['SEED-C1', 'SEED-C3', 'SEED-C5', 'SEED-C8', 'SEED-C13', 'SEED-C9']
const asRole = (role: keyof typeof ROLE_RIGHTS, over: Partial<CustomersCase> = {}): CustomersCase =>
  busy({ rights: ROLE_RIGHTS[role].rights, can: ROLE_RIGHTS[role].can, selected: busyRows(...SIX).map((row) => row.id), ...over })
const notSentCodes = BUSY_ROWS.filter((row) => (workModel().byParty?.get(row.id)?.phases.find((entry) => entry.phase === 'NOT_SENT')?.count ?? 0) > 0).map((row) => row.code)

const importCase = (importer: CustomersImportModel): CustomersCase => ({ ...list(), importer })

const euDraft = () => {
  const draft = blankNewParty(SIDES.customers)
  return {
    ...draft,
    party: { ...draft.party, country: 'DE', language: 'de', legalName: 'Beispiel Neu GmbH', code: 'BEISPIEL-NEU' },
    identity: { ...draft.identity, country: 'DE', taxMode: 'EU_B2B' as const, vatNumber: 'DE222222222' },
    codeTouched: false,
  }
}

export const designScreen = defineDesignScreen<CustomersCase>({
  screen: 'SCR-032',
  title: 'Customers',
  view: CustomersDesign,
  cases: [
    { id: 'list', label: 'The list: the Customer cell, Views ▾ (the five tiles went: their filters are views)', model: list(), note: 'The identity columns are in Customise; a view is the Views ▾ label, never a chip.' },
    // B-W2a-81: the Overdue column (price grain, receivables.view). B-CP-011: Finance holds the grain; Sales sees no amount.
    { id: 'w2a-overdue', label: 'Overdue (W2a): what each customer owes late, per currency, with how late', model: { ...list(), overdue: overdueList(MONEY_CAN.finance) }, note: 'Moda Demo 4,270.00 (38 days late); Beispiel 1,220.00 · CHF 300.00; the others "none".' }, // B-CP-011
    { id: 'w2a-overdue-reading', label: 'Overdue (W2a) still reading: "—", never 0', model: { ...list(), overdue: overdueList(MONEY_CAN.finance, { byParty: null }) } },
    { id: 'w2a-overdue-failed', label: "Overdue (W2a) couldn't be read: \"—\" with the reason on hover", model: { ...list(), overdue: overdueList(MONEY_CAN.finance, { byParty: null, problem: 'problem.unavailable' }) } },
    { id: 'w2a-overdue-no-price', label: 'Overdue (W2a) seen as Sales (no price grain, B-CP-011): the column is not drawn', model: { ...list(), overdue: overdueList(MONEY_CAN.sales) } },
    // ---- T.1 (customers list): the busy list and its states ----
    { id: 'busy', label: 'The busy list: 14 customers in every state — the band, Needs us, Work, Next promise, New messages (Owner, 1440)', model: busy(), note: 'Most urgent first; Seed Customer Eleven is a customer your orders.view does not reach: "—".' },
    { id: 'busy-wide', label: 'The busy list at 1920: + Last order and Overdue (the wide room)', model: busy({ workView: { ...busyWork(), wide: true }, overdue: overdueList(MONEY_CAN.finance) }) },
    { id: 'band-pressed', label: 'A band door pressed: Not sent to the factory (its chip with its why, the rows it counts)', model: busy({ work: 'NOT_SENT', rows: loaded(busyRows(...notSentCodes)), total: notSentCodes.length }) },
    { id: 'band-pressed-empty', label: 'A band door with nobody in it now: its own words and one Clear', model: busy({ query: 'Seed Customer Six', work: 'NEEDS_US', rows: loaded([]), total: 0, workView: busyWork(['SEED-C6']) }) },
    { id: 'view-zero', label: 'A view with 0 rows: “No blocked customers.” and one Clear', model: busy({ view: 'blocked', rows: loaded([]), total: 0, workView: { ...busyWork(), band: { band: bandOf(workModel([])), problem: null } } }) },
    { id: 'search-none', label: 'A search with no match: the band follows the search (zeros), its own words and Clear search', model: busy({ query: 'Seed Zeta', rows: loaded([]), total: 0, workView: { ...busyWork(), band: { band: bandOf(workModel([])), problem: null } } }) },
    { id: 'limited', label: 'The limited reader (Sales over two customers): “Your customers”, their band only', model: busy({ rows: loaded(busyRows(...LIMITED_CODES)), total: LIMITED_CODES.length, rights: ROLE_RIGHTS.sales.rights, can: ROLE_RIGHTS.sales.can, workView: busyWork(LIMITED_CODES, true), unread: { [busyId('SEED-C1')]: { newCount: 1, lastAt: '2026-11-24T08:12:00.000Z' } } }) },
    { id: 'band-failed', label: 'The band and the work couldn’t be read: words, never 0', model: busy({ workView: { facts: workModel([], { byParty: null, problem: 'problem.unavailable' }), band: { band: null, problem: 'problem.unavailable' }, today: DEMO_TODAY } }) },
    { id: 'sort-code', label: 'Sort ▾ Code (today’s order)', model: busy({ sort: { ...SORT, value: 'code', sortedBy: 'code' } }) },
    { id: 'sort-capped', label: 'Most urgent first over the cap: shown by code, said above the rows', model: busy({ sort: { ...SORT, sortedBy: 'code' } }) },
    { id: 'customise', label: 'Customise columns: the list’s own columns, the identity columns unticked', model: busy({ tools: { ...TOOLS, design: { dialog: 'customise' } } }) },
    // ---- T.1: the bar per role (6 ticked) ----
    { id: 'bar-owner', label: 'Bar, Owner: Add task to 6 customers… · Set production supervisor for 6… · Export 6 · More ▾ (VIES · Block · Archive)', model: asRole('owner') },
    { id: 'bar-sales', label: 'Bar, Sales: Add task · Check VIES · Export · More ▾ (Archive)', model: asRole('sales') },
    { id: 'bar-finance', label: 'Bar, Finance: Add task · Check VIES · Export · More ▾ (Block · Archive)', model: asRole('finance') },
    { id: 'bar-pm', label: 'Bar, Production manager: Add task · Set production supervisor · Export', model: asRole('productionManager') },
    { id: 'bar-warehouse', label: 'Bar, Warehouse: Add task · Export', model: asRole('warehouse') },
    { id: 'bar-readonly', label: 'Bar, Read-only: no act, said in words', model: asRole('readOnly') },
    // ---- T.1: each window step ----
    { id: 'task', label: 'Add task to 3 customers… (each customer’s production supervisor by default)', model: busy({ selected: busyRows('SEED-C1', 'SEED-C3', 'SEED-C10').map((row) => row.id), windows: { task: { ticked: busyRows('SEED-C1', 'SEED-C3', 'SEED-C10') } } }) },
    { id: 'task-r47', label: 'Add task: the text names another customer — Make waits for “This text names no other customer”', model: busy({ selected: busyRows('SEED-C1', 'SEED-C3', 'SEED-C10').map((row) => row.id), windows: { task: { ticked: busyRows('SEED-C1', 'SEED-C3', 'SEED-C10'), initial: { title: 'Send Seed Moto Club the new size chart' } } } }) },
    { id: 'task-one', label: 'Row ⋯ Add task…: the same window on one customer', model: busy({ windows: { task: { ticked: busyRows('SEED-C7') } } }) },
    { id: 'sup-read', label: 'Set production supervisor for 3…: reading the customers', model: busy({ windows: { supervisor: supervisorWindow('read') } }) },
    { id: 'sup-pick', label: 'Set production supervisor for 6…: Runs on 3 · Not on 3 with why, one pick, who gets the notices', model: busy({ windows: { supervisor: supervisorWindow('pick') } }) },
    { id: 'sup-running', label: 'Set production supervisor: running, one customer at a time (Stop after this one)', model: busy({ windows: { supervisor: supervisorWindow('running') } }) },
    { id: 'sup-done', label: 'Set production supervisor: the receipt — Done / Already so / Not done / Not run, Run the rest again', model: busy({ windows: { supervisor: supervisorWindow('done') } }) },
    { id: 'block-noton', label: 'Block 2…: Runs on 2 · Not on 2 with why (a prospect, already blocked)', model: busy({ selected: busyRows('SEED-C1', 'SEED-C3', 'SEED-C13', 'SEED-C8').map((row) => row.id), dialog: { kind: 'block', partyIds: busyRows('SEED-C1', 'SEED-C3').map((row) => row.id), notOn: busyRows('SEED-C13', 'SEED-C8').map((row) => row.id) } }) },
    { id: 'archive-noton', label: 'Archive 2…: Not on 1 with why (unblock it first)', model: busy({ selected: busyRows('SEED-C1', 'SEED-C13', 'SEED-C8').map((row) => row.id), dialog: { kind: 'archive', partyIds: busyRows('SEED-C1', 'SEED-C13').map((row) => row.id), notOn: busyRows('SEED-C8').map((row) => row.id) } }) },
    {
      id: 'bulk-receipt',
      label: 'A receipt: each name a door to its customer with the thread open, Run the rest again (1)',
      model: busy({
        dialog: { kind: 'bulk' },
        bulk: {
          kind: 'archive',
          total: 2,
          done: true,
          notOn: [busyId('SEED-C8')],
          results: [
            { id: busyId('SEED-C1'), code: 'SEED-C1', name: 'Seed Racing', outcome: 'bulk.archived', tone: 'success' },
            { id: busyId('SEED-C13'), code: 'SEED-C13', name: 'Seed Customer Three GmbH', outcome: 'problem.conflict', tone: 'danger', failed: true },
          ],
        },
      }),
    },
    {
      id: 'view-vies',
      label: 'Views ▾ VIES problems: EU businesses without a valid VIES check',
      model: list({ view: 'vies', rows: loaded(rows.filter((row) => row.attention.includes('VIES_NOT_PROVEN'))), total: 3 }),
    },
    { id: 'view-invoice', label: 'Views ▾ Missing tax data: can’t be invoiced yet', model: list({ view: 'invoice', rows: loaded(rows.filter((row) => row.invoiceBlocked)), total: 2 }) },
    {
      id: 'view-brands',
      label: 'Views ▾ Brands, with a kind filter',
      model: list({ view: 'brands', filters: { kind: 'ORGANISATION' }, rows: loaded(rows.filter((row) => row.roles.includes('BRAND'))), total: 2 }),
    },
    // B-W2b-324: Views ▾ Riders (people): the customers that are people (a team's riders and private riders).
    {
      id: 'w2b-324-riders',
      label: 'W2b Views ▾ Riders (people): the customers that are people',
      model: list({ view: 'riders', rows: loaded(rows.filter((row) => row.kind === 'PERSON')), total: rows.filter((row) => row.kind === 'PERSON').length }),
      note: 'A rider opens on its record: its team, its measurement profiles. Personal data stays inside the record (never a total).',
    },
    { id: 'w2b-324-riders-empty', label: 'W2b Views ▾ Riders: none yet', model: list({ view: 'riders', rows: loaded([]), total: 0 }) },
    { id: 'search', label: 'Search by name or VAT number', model: list({ query: 'demo', rows: loaded(rows.filter((row) => /demo/i.test(`${row.code} ${row.legalName}`))), total: 6 }) },
    { id: 'filtered-empty', label: 'A search with no match: its own words and Clear search', model: list({ query: 'zzz', rows: loaded([]), total: 0 }) },
    { id: 'empty', label: 'First day: no customer yet', model: list({ rows: loaded([]), total: 0, tiles: { active: 0, prospects: 0, vies: 0, invoice: 0, blocked: 0 } }) },
    { id: 'loading', label: 'Loading', model: list({ rows: loading(), total: null, tiles: {}, asOf: null, live: 'connecting' }) },
    {
      id: 'error',
      label: "The API didn't answer",
      model: list({ rows: failed('problem.unavailable'), total: null, tiles: { active: null, prospects: null, vies: null, invoice: null, blocked: null }, asOf: null, live: 'offline' }),
      note: 'Never drawn as an empty list; the tiles say they could not count.',
    },
    { id: 'no-access', label: 'No permission: what is needed and who has it', model: list({ can: { view: false, manage: false, block: false, vies: false } }) },
    {
      id: 'read-only',
      label: 'Read-only rights: no act without its right',
      model: list({ can: { view: true, manage: false, block: false, vies: false }, selected: pick('DE-BEISPIEL', 'MODA-DEMO') }),
      note: 'No New customer, no Import, no identity act on a row or in ⋯ (each act reads its own right).',
    },
    {
      id: 'selection',
      label: 'Selection: reach said before the click',
      model: list({ selected: pick('DE-BEISPIEL', 'FR-EXEMPLE', 'AT-MUSTER', 'MODA-DEMO', 'BLOCCATO-DEMO') }),
      note: '5 selected: VIES reaches the 3 EU businesses; Archive the 4 not blocked.',
    },
    { id: 'selection-held', label: 'Selection: nothing VIES can check (held)', model: list({ selected: pick('MODA-DEMO', 'PILOTA-DEMO') }) },
    { id: 'live-updates', label: 'Live: 3 updates waiting behind Show', model: list({ updates: 3 }), note: 'Rows never move under the cursor.' },
    { id: 'offline', label: 'Offline: rows stay readable with their time', model: list({ live: 'offline' }) },
    { id: 'more', label: 'More than one page (Show more)', model: list({ more: true, total: 132 }) },
    { id: 'notice', label: 'A receipt after blocking', model: list({ notice: { key: 'done.block', tone: 'success', params: { name: 'Bloccato Demo S.p.A.' } } }) },
    { id: 'keyboard', label: 'Keyboard: j / k on the rows, x selects, the keys in the footer icon', model: list({ focusRow: 2, selected: pick('FR-EXEMPLE') }) },
    { id: 'new', label: 'New customer (VAT number first)', model: list({ dialog: { kind: 'new' } }), note: '⌘↵ creates; the code follows the name until it is typed.' },
    { id: 'new-eu', label: 'New customer: an EU business (VIES asked on create)', model: list({ dialog: { kind: 'new' }, newDraft: euDraft() }) },
    {
      id: 'new-duplicate',
      label: 'New customer: the VAT number already belongs to a party',
      model: list({ dialog: { kind: 'new' }, dialogProblem: 'new.conflictNumber', duplicates: [rowOf(SUPPLIERS.find((item) => item.code === 'PELLETTERIA-DOPPIA')!)] }),
      note: 'One record per business partner: open it and give it the Customer role.',
    },
    { id: 'new-refused', label: 'New customer: a value refused by the API', model: list({ dialog: { kind: 'new' }, newDraft: euDraft(), dialogProblem: 'problem.invalid', refused: ['vatNumber'] }) },
    {
      id: 'new-companies',
      label: 'New customer: a person working in two companies chooses where it belongs',
      model: list({
        dialog: { kind: 'new' },
        companies: [
          { id: 'c1', name: 'Officina Demo S.r.l.' },
          { id: 'c2', name: 'Pelletteria Esempio S.p.A.' },
        ],
      }),
    },
    { id: 'block', label: 'Block a customer (reason required)', model: list({ dialog: { kind: 'block', partyIds: pick('MODA-DEMO') } }) },
    {
      id: 'block-many',
      label: 'Block 3 customers with one reason',
      model: list({ selected: pick('MODA-DEMO', 'MARCHIO-ESEMPIO', 'DE-BEISPIEL', 'NUOVO-PROVA'), dialog: { kind: 'block', partyIds: pick('MODA-DEMO', 'MARCHIO-ESEMPIO', 'DE-BEISPIEL') } }),
      note: 'Block N reaches the active ones only (the prospect is left out).',
    },
    { id: 'archive', label: 'Archive a customer', model: list({ dialog: { kind: 'archive', partyIds: pick('NUOVO-PROVA') } }) },
    {
      id: 'archive-many',
      label: 'Archive 3 customers',
      model: list({ selected: pick('NUOVO-PROVA', 'ES-PRUEBA', 'CH-DEMO', 'BLOCCATO-DEMO'), dialog: { kind: 'archive', partyIds: pick('NUOVO-PROVA', 'ES-PRUEBA', 'CH-DEMO') } }),
    },
    {
      id: 'bulk-running',
      label: 'Check VIES for 3: running',
      model: list({
        dialog: { kind: 'bulk' },
        bulk: { kind: 'vies', total: 3, done: false, results: [{ id: 'a', code: 'DE-BEISPIEL', name: 'Beispiel Motorrad GmbH', outcome: 'vies.result.VALID', tone: 'success' }] },
      }),
    },
    {
      id: 'bulk-done',
      label: 'Check VIES for 3: done, one with no answer',
      model: list({
        dialog: { kind: 'bulk' },
        bulk: {
          kind: 'vies',
          total: 3,
          done: true,
          results: [
            { id: 'a', code: 'DE-BEISPIEL', name: 'Beispiel Motorrad GmbH', outcome: 'vies.result.VALID', tone: 'success' },
            { id: 'b', code: 'FR-EXEMPLE', name: 'Exemple Moto SARL', outcome: 'vies.result.INVALID', tone: 'danger' },
            { id: 'c', code: 'AT-MUSTER', name: 'Muster Leder GmbH', outcome: 'vies.result.ERROR', tone: 'warning' },
          ],
        },
      }),
    },
    // B-W2a-49 (design pop:customers.import, band "Import (W2a)"): the customers and suppliers importer.
    { id: 'import-upload', label: 'W2a: Import — the sheet (every company by default)', model: importCase({ held: null, sheet: demoCustomersImport('upload') }), note: 'Rows by code: new customers, changed ones; nothing is written before Apply.' },
    { id: 'import-check', label: 'W2a: Import — the dry run (2 new, 1 changed, 1 refused)', model: importCase({ held: null, sheet: demoCustomersImport('planned') }), note: 'The columns read and ignored; the refused row says why; Apply 3.' },
    { id: 'import-result', label: 'W2a: Import — applied', model: importCase({ held: null, sheet: demoCustomersImport('applied') }), note: 'Closing reads the list and its tiles again.' },
    { id: 'import-no-apply', label: 'W2a: Import without the apply right (Apply held)', model: importCase({ held: null, sheet: demoCustomersImport('planned', { run: true, apply: false }) }) },
    { id: 'import-held', label: 'W2a: Import hidden (no import right)', model: importCase({ held: 'import.held.run', sheet: null }), note: 'Without the right the button is not drawn.' },
    { id: 'import-held-manage', label: 'W2a: Import hidden (a role that only views customers)', model: { ...list({ can: { view: true, manage: false, block: false, vies: false } }), importer: { held: 'import.held.manage', sheet: null } } },
  ],
})
