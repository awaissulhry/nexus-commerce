import { createElement, useEffect, useState, type ReactNode } from 'react'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { permissionCheck } from '../../../lib/session/session'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER } from '../../../shell/design-data'
import { officeNavFor } from '../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../shell/office/view/OfficeShellView'
import type { ProjectRow, ShortProject } from './api'
import type { PartyOption, SeasonOption } from './list-api'
import { emptyNewDraft, HOME_ADDRESS, type ListAddress } from './list-model'
import { projectsCan } from './model'
import type { BulkColleagueModel } from './view/BulkColleagueDialog'
import type { NewProjectModel } from './view/NewProjectDialog'
import { ProjectsView, type ProjectsListModel } from './view/ProjectsView'

/**
 * SCR-700 — Products › Development › Projects, the list and New project (B-TH-248; design PROJ.list, PROJ.new; pictures 31 and 32
 * were never drawn: built to the design kit). Made-up data only: "Demo" projects for two made-up customers (Brand Alpha, Brand
 * Beta), a made-up tannery supplier and office-only ones; made-up people on example.com. The office sees every customer's projects
 * (the factory sees all; a person limited to one customer would list only theirs — the API's filter).
 */

type RoleCase = 'owner' | 'reader' | 'nobody'

interface DesignModel {
  readonly role: RoleCase
  readonly model: ProjectsListModel
}

const PREFIX = '/w/DEMO'
const COMPANY_ID = DEMO_COMPANIES[0].id
const ME = DEMO_USER.id
const TODAY = '2026-11-17'
const NOW = '2026-11-17T09:42:00.000Z'
const uid = (family: string, n: number): string => `0190f0e2-${family.padStart(4, '0').slice(-4)}-7000-8000-${String(n).padStart(12, '0')}`
const at = (day: number, hour = 9, minute = 0): string => new Date(Date.UTC(2026, 10, day, hour, minute)).toISOString()

const PERMISSIONS: Readonly<Record<RoleCase, readonly string[]>> = {
  owner: [...(templateOf('owner')?.permissions ?? [])],
  reader: [...(templateOf('read_only')?.permissions ?? [])],
  nobody: ['home.view'],
}

const ALPHA = { id: uid('5101', 1), code: 'BRAND-ALPHA', name: 'Brand Alpha' }
const BETA = { id: uid('5101', 2), code: 'BRAND-BETA', name: 'Brand Beta' }
const TANNERY = { id: uid('5101', 3), code: 'PELLI-DEMO', name: 'Pelli Demo S.r.l.' }
const MARA = { id: uid('3333', 7), name: 'Mara Demo' }
const LUCA = { id: uid('3333', 8), name: 'Luca Esempio' }
const LEAD_ME = { id: ME, name: DEMO_USER.displayName }

function row(n: number, over: Partial<ProjectRow>): ProjectRow {
  return {
    id: uid('7001', n),
    number: `PRJ-26-${String(n).padStart(3, '0')}`,
    name: 'Demo project',
    companyId: COMPANY_ID,
    party: null,
    lead: LEAD_ME,
    status: 'ACTIVE',
    targetDate: '2026-12-18',
    target: { state: 'LATER', days: 31 },
    seasonCode: null,
    lastMessageAt: at(16, 15, 20),
    newForMe: 0,
    muted: false,
    mine: true,
    linked: 0,
    version: 1,
    ...over,
  }
}

const ROWS: readonly ProjectRow[] = [
  row(12, { name: 'FW27 airbag jacket line', party: ALPHA, seasonCode: 'FW27', targetDate: '2026-11-14', target: { state: 'OVERDUE', days: -3 }, newForMe: 3, linked: 6, lastMessageAt: at(17, 8, 55) }),
  row(13, { name: 'Leather change on the touring range', party: BETA, lead: MARA, targetDate: '2026-11-21', target: { state: 'SOON', days: 4 }, newForMe: 1, linked: 4 }),
  row(14, { name: 'Find a second tannery for nappa', party: TANNERY, lead: LUCA, targetDate: '2027-01-29', target: { state: 'LATER', days: 73 }, linked: 2, muted: true, lastMessageAt: at(12, 10, 5) }),
  row(15, { name: 'Made-to-measure race suit programme', party: ALPHA, seasonCode: 'SS27', targetDate: '2026-11-17', target: { state: 'SOON', days: 0 }, linked: 3 }),
  row(16, { name: 'New stitching process trial', lead: MARA, targetDate: '2026-12-04', target: { state: 'LATER', days: 17 }, lastMessageAt: null, mine: false }),
  row(17, { name: 'Glove sizing review', party: BETA, status: 'ON_HOLD', targetDate: '2026-12-11', target: { state: 'LATER', days: 24 }, linked: 1 }),
]
const CLOSED: readonly ProjectRow[] = [
  row(9, { name: 'SS26 rain cover line', party: ALPHA, status: 'CLOSED', targetDate: '2026-09-30', target: { state: 'CLOSED', days: -48 }, linked: 5, lastMessageAt: at(2, 11, 40) }),
  row(10, { name: 'Supplier audit for buckles', status: 'CLOSED', lead: LUCA, targetDate: '2026-10-15', target: { state: 'CLOSED', days: -33 }, lastMessageAt: at(5, 16, 0) }),
]

const PARTIES: readonly PartyOption[] = [
  { id: ALPHA.id, code: ALPHA.code, legalName: 'Brand Alpha S.r.l.', tradeName: 'Brand Alpha', roles: ['CUSTOMER'] },
  { id: BETA.id, code: BETA.code, legalName: 'Brand Beta S.p.A.', tradeName: 'Brand Beta', roles: ['BRAND', 'CUSTOMER'] },
  { id: TANNERY.id, code: TANNERY.code, legalName: TANNERY.name, tradeName: null, roles: ['SUPPLIER'] },
]
const SEASONS: readonly SeasonOption[] = [
  { id: uid('5201', 1), code: 'SS27', name: 'Spring–Summer 2027' },
  { id: uid('5201', 2), code: 'FW27', name: 'Fall–Winter 2027' },
]

function shell(page: ReactNode, role: RoleCase): ReactNode {
  const path = '/products/projects'
  const model: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck([...PERMISSIONS[role]])),
    path,
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: [], site: null, path },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model }, page)
}

function page(over: Partial<ProjectsListModel> = {}, role: RoleCase = 'owner'): DesignModel {
  const rows = over.rows === undefined ? ROWS : over.rows
  return {
    role,
    model: {
      prefix: PREFIX,
      me: ME,
      today: TODAY,
      can: projectsCan(PERMISSIONS[role]),
      address: HOME_ADDRESS,
      rows,
      count: rows ? rows.length : null,
      complete: true,
      hasMore: false,
      moreBusy: false,
      problem: null,
      parties: PARTIES,
      seasons: SEASONS,
      asOf: NOW,
      live: 'live',
      updates: 0,
      notice: null,
      bulkBusy: false,
      newProject: null,
      colleague: null,
      ...over,
    },
  }
}

const addr = (over: Partial<ListAddress>): ListAddress => ({ ...HOME_ADDRESS, ...over })

const NEW_BASE: NewProjectModel = {
  draft: emptyNewDraft(),
  can: projectsCan(PERMISSIONS.owner),
  prefix: PREFIX,
  companyId: COMPANY_ID,
  lead: { id: ME, name: DEMO_USER.displayName },
  parties: { items: [...PARTIES], problem: null },
  seasons: { items: [...SEASONS], problem: null },
  similar: [],
  link: null,
  busy: false,
  notice: null,
  lines: [],
  offline: false,
}
const SIMILAR: readonly ShortProject[] = [{ id: ROWS[0]!.id, number: ROWS[0]!.number, name: ROWS[0]!.name, status: 'ACTIVE' }]

const COLLEAGUE: BulkColleagueModel = {
  count: 2,
  choices: { items: [{ userId: MARA.id, name: MARA.name }, { userId: LUCA.id, name: LUCA.name }], problem: null },
  q: '',
  picked: LUCA.id,
  busy: false,
  notice: null,
}

function ListDesign({ model }: { model: DesignModel }) {
  const [state, setState] = useState(model.model)
  useEffect(() => setState(model.model), [model])
  const view = createElement(ProjectsView, {
    model: state,
    actions: {
      onAddress: (patch) => setState((now) => ({ ...now, address: { ...now.address, ...patch } })),
      onClearFilters: () => setState((now) => ({ ...now, address: { ...HOME_ADDRESS, view: now.address.view } })),
      onNew: () => setState((now) => ({ ...now, newProject: NEW_BASE })),
      newProject: {
        onDraft: (patch) => setState((now) => (now.newProject ? { ...now, newProject: { ...now.newProject, draft: { ...now.newProject.draft, ...patch } } } : now)),
        onSubmit: () => setState((now) => ({ ...now, newProject: null })),
        onClose: () => setState((now) => ({ ...now, newProject: null })),
      },
      onBulkColleague: (ids) => setState((now) => ({ ...now, colleague: { ...COLLEAGUE, count: ids.length, picked: null } })),
      colleague: {
        onPick: (userId) => setState((now) => (now.colleague ? { ...now, colleague: { ...now.colleague, picked: userId } } : now)),
        onSubmit: () => setState((now) => ({ ...now, colleague: null })),
        onClose: () => setState((now) => ({ ...now, colleague: null })),
      },
      onDismissNotice: () => setState((now) => ({ ...now, notice: null })),
    },
  })
  return shell(view, model.role)
}

const byParty = [...ROWS].filter((one) => one.status === 'ACTIVE').sort((a, b) => (a.party?.name ?? '￿').localeCompare(b.party?.name ?? '￿') || a.targetDate.localeCompare(b.targetDate))
const many = Array.from({ length: 50 }, (_, index) => row(100 + index, { name: `Demo collection study ${index + 1}`, party: index % 3 === 0 ? ALPHA : index % 3 === 1 ? BETA : null, targetDate: '2027-02-26', target: { state: 'LATER', days: 101 }, newForMe: index % 7 === 0 ? 2 : 0 }))

export const designScreen = defineDesignScreen<DesignModel>({
  screen: 'SCR-700',
  title: 'Projects — list and New project',
  view: ListDesign,
  holdsPage: true,
  cases: [
    { id: 'mine', label: 'My projects (the default): every cell a door, an overdue and a near target with words, my own new marks, a muted row', model: page(), note: 'Number and Name open the project; Outside company its record; Lead, Status and Target date filter the list; Last message and New for me open the thread at what is new; Linked the Linked block.' },
    { id: 'active', label: 'Active: every active project the reader may open', model: page({ address: addr({ view: 'active' }), rows: ROWS.filter((one) => one.status === 'ACTIVE') }) },
    { id: 'by-party', label: 'By outside company: the active projects in the order of their outside company, office-only last', model: page({ address: addr({ view: 'party' }), rows: byParty }) },
    { id: 'on-hold', label: 'On hold', model: page({ address: addr({ view: 'onHold' }), rows: ROWS.filter((one) => one.status === 'ON_HOLD') }) },
    { id: 'closed', label: 'Closed: a closed project leaves My projects but stays findable', model: page({ address: addr({ view: 'closed' }), rows: CLOSED }) },
    { id: 'filtered', label: 'Filtered: Brand Alpha, overdue (the chips; the filters in the address)', model: page({ address: addr({ view: 'active', party: ALPHA.id, target: 'OVERDUE' }), rows: [ROWS[0]!] }) },
    { id: 'by-lead', label: 'Filtered by a lead (the Lead cell’s door): the chip with its clear', model: page({ address: addr({ view: 'active', lead: MARA.id }), rows: ROWS.filter((one) => one.lead.id === MARA.id) }) },
    { id: 'selected', label: 'Two rows selected: Put on hold, Resume, Add a colleague, Export 2; Close held with why', model: page({ selected: [ROWS[0]!.id, ROWS[1]!.id] }) },
    { id: 'bulk-done', label: 'After Put on hold for three: one moved, one already, one closed skipped (the receipt in words)', model: page({ notice: { tone: 'warning', lines: [{ key: 'bulk.done.hold', params: { count: 1 } }, { key: 'bulk.already.hold', params: { count: 1 } }, { key: 'bulk.skippedClosed', params: { count: 1 } }] } }) },
    { id: 'colleague', label: 'Add a colleague to two projects (the first project’s colleagues offered; the person is told)', model: page({ selected: [ROWS[0]!.id, ROWS[1]!.id], colleague: COLLEAGUE }) },
    { id: 'paged', label: 'Fifty of 87 read (Show more)', model: page({ rows: many, count: 87, hasMore: true }) },
    { id: 'over-1000', label: 'More than 1,000 match: the first 1,000 (narrow the filters)', model: page({ rows: many, count: 1000, complete: false, hasMore: true }) },
    { id: 'updates', label: 'Three changes waiting (Show)', model: page({ updates: 3 }) },
    { id: 'no-match', label: 'A search with no rows: says which filters hide them, Clear filters', model: page({ address: addr({ view: 'active', q: 'zzz', season: 'FW27' }), rows: [] }) },
    { id: 'view-empty', label: 'A view with no rows (On hold): says the view', model: page({ address: addr({ view: 'onHold' }), rows: [] }) },
    { id: 'empty', label: 'No projects yet (the rule in one sentence, New project)', model: page({ rows: [] }) },
    { id: 'loading', label: 'Loading', model: page({ rows: null, asOf: null, live: 'connecting' }) },
    { id: 'failed', label: "The projects didn't load (Retry)", model: page({ rows: [], problem: 'problem.unavailable' }) },
    { id: 'offline', label: 'Offline: the rows as last read, every write held', model: page({ live: 'offline' }) },
    { id: 'keys', label: 'The keys in the footer icon (N new project)', model: page({ keysOpen: true }) },
    { id: 'reader', label: 'A reader (read only): reads every project; New project and the bulk writes held with the right in words', model: page({}, 'reader') },
    { id: 'no-access', label: 'No right to read threads: the page says so', model: page({ rows: [] }, 'nobody') },
    { id: 'new-empty', label: 'New project: the rule at the top, held until name and target date', model: page({ newProject: NEW_BASE }) },
    { id: 'new-office', label: 'New project, office only: the set-once line says no outside company can be added later', model: page({ newProject: { ...NEW_BASE, draft: { ...emptyNewDraft(), name: 'New stitching process trial', targetDate: '2026-12-04', goal: 'Try the twin-needle seam on two jackets before the SS27 samples.' } } }) },
    { id: 'new-customer', label: 'New project for Brand Alpha: "Only Brand Alpha and our team will be in this project. This cannot be changed later."', model: page({ newProject: { ...NEW_BASE, draft: { ...emptyNewDraft(ALPHA.id), name: 'SS27 rain cover line', targetDate: '2027-03-12', seasonCode: 'SS27' } } }) },
    { id: 'new-similar', label: 'New project: the duplicate warning while typing (an active project with a similar name for Brand Alpha, Open)', model: page({ newProject: { ...NEW_BASE, draft: { ...emptyNewDraft(ALPHA.id), name: 'FW27 airbag jackets', targetDate: '2027-02-12' }, similar: SIMILAR } }) },
    { id: 'new-from-record', label: 'New project started from a style: "Will link: JK-210"', model: page({ newProject: { ...NEW_BASE, draft: { ...emptyNewDraft(BETA.id), name: 'Touring jacket family', targetDate: '2027-01-15' }, link: { type: 'Style', id: uid('6101', 1), label: 'JK-210' } } }) },
    { id: 'new-refused', label: 'New project refused in words (a season of another company; the field named), every typed field kept', model: page({ newProject: { ...NEW_BASE, draft: { ...emptyNewDraft(), name: 'Buckle supplier audit', targetDate: '2026-12-20', seasonCode: 'FW27' }, notice: { key: 'refusal.SEASON', tone: 'danger' }, lines: [{ key: 'field.seasonCode' }] } }) },
    { id: 'new-no-parties', label: 'New project without the right to list customers and suppliers: office only, said in words', model: page({ newProject: { ...NEW_BASE, parties: null } }) },
  ],
})
