import { createElement, type ReactNode } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { BRAND_ALPHA } from '../../../../lib/testing/two-brands'
import type { ApiFile } from '../../../../record-panels/api'
import type { TaskItem } from '../../../../record-panels/tasks/model'
import { designDockedThread } from '../../../_shared/record-frame/fixtures'
import type { ProjectPage, ProjectView } from '../api'
import { projectsCan } from '../model'
import { LINKED_DEMO } from './linked/fixtures'
import { LinkedBlock } from './linked/view/LinkedBlock'
import { emptyCloseDraft, editDraftOf } from './model'
import { PEOPLE_DEMO } from './people/fixtures'
import { PeopleBlock } from './people/view/PeopleBlock'
import type { ProjectRecordModel } from './view-model'
import { LinkedNewsCard, type LinkedNewsModel } from './news/view/LinkedNewsCard'
import { ProjectRecordView } from './view/ProjectRecordView'

/**
 * SCR-701 — the project page (B-TH-249; design PROJ.record, PROJ.thread, PROJ.linked-F08; picture 33 never drawn: built to the
 * design kit and the record-frame pattern). Made-up data only: one project shared with Brand Alpha (the two-brands fixture), one
 * office-only project. The People and Linked sections are their own steps' views (B-TH-250, B-TH-251) with their demo models; the
 * thread is the made-up docked thread of the project's own record (its party's words only, or notes only).
 */

const PREFIX = '/w/DEMO'
const COMPANY = 'c0c0c0c0-0000-4000-8000-000000000001'
const ALPHA_ID = 'a1a1a1a1-0000-4000-8000-000000000001'
const PROJECT_ID = 'd7d7d7d7-0000-4000-8000-000000000701'
const OFFICE_ID = 'd7d7d7d7-0000-4000-8000-000000000702'
const MARCO = { id: 'e1e1e1e1-0000-4000-8000-000000000001', name: 'Marco Demo' }
const GIULIA = { id: 'e1e1e1e1-0000-4000-8000-000000000002', name: 'Giulia Prova' }

const customerProject: ProjectView = {
  id: PROJECT_ID,
  number: 'PRJ-26-012',
  name: 'FW27 airbag line',
  goal: 'Six jackets with the new airbag vest: tech packs, protos and fit rounds before the salesman samples in March.',
  companyId: COMPANY,
  company: { id: COMPANY, code: 'DEMO' },
  party: { id: ALPHA_ID, code: BRAND_ALPHA.code, name: BRAND_ALPHA.tradeName, roles: ['CUSTOMER'] },
  lead: MARCO,
  seasonCode: 'FW27',
  targetDate: '2027-03-15',
  target: { state: 'LATER', days: 118 },
  status: 'ACTIVE',
  outcome: null,
  outcomeNote: null,
  closedAt: null,
  closedBy: null,
  createdAt: '2026-10-02T08:30:00.000Z',
  createdBy: MARCO,
  lastMessageAt: '2026-11-16T15:12:00.000Z',
  threadStatus: 'OPEN',
  version: 4,
  officeOnly: false,
  may: { manage: true, post: true, moves: ['HOLD', 'CLOSE'] },
}

const officeProject: ProjectView = {
  ...customerProject,
  id: OFFICE_ID,
  number: 'PRJ-26-015',
  name: 'Find a second leather supplier',
  goal: 'Two offers for cowhide 1.2 mm by the end of January; one test hide cut on the floor.',
  party: null,
  officeOnly: true,
  lead: GIULIA,
  createdBy: GIULIA,
  seasonCode: null,
  targetDate: '2027-01-31',
  target: { state: 'LATER', days: 75 },
}

const pageOf = (project: ProjectView, people: 'customer' | 'officeOnly' = project.party ? 'customer' : 'officeOnly'): ProjectPage => ({
  project,
  people: {
    office: {
      count: 2,
      people: [
        { userId: MARCO.id, name: MARCO.name, lead: project.lead.id === MARCO.id, me: true, reason: 'CREATOR', addedBy: null, muted: false, since: '2026-10-02T08:30:00.000Z' },
        { userId: GIULIA.id, name: GIULIA.name, lead: project.lead.id === GIULIA.id, me: false, reason: 'ADDED', addedBy: MARCO, muted: false, since: '2026-10-03T09:00:00.000Z' },
      ],
    },
    outside: people === 'customer' ? { count: 1, people: [{ userId: 'f1f1f1f1-0000-4000-8000-000000000001', name: BRAND_ALPHA.portalPerson.name, reason: 'ADDED', addedBy: MARCO, since: '2026-10-04T10:00:00.000Z' }] } : { count: 0, people: [] },
    invited: { count: 0, people: [] },
  },
  links: { count: 0, records: [] },
  tasks: { open: 2, overdue: 1 },
  files: { count: 3 },
  me: { following: true, muted: false, reason: 'CREATOR' },
})

const task = (id: string, title: string, due: TaskItem['due'], assignee: { id: string; name: string } | null): TaskItem => ({
  id,
  title,
  description: null,
  record: { type: 'Project', id: PROJECT_ID, label: 'PRJ-26-012' },
  companyId: COMPANY,
  siteId: null,
  partyId: null,
  assignee: assignee ? { id: assignee.id, name: assignee.name, me: assignee.id === MARCO.id } : null,
  assignedBy: null,
  assignedAt: null,
  dueDate: due?.date ?? null,
  dueTime: null,
  due,
  checklist: [],
  progress: null,
  status: 'OPEN',
  tile: null,
  closedAt: null,
  closedBy: null,
  snoozedUntil: null,
  snoozed: false,
  createdBy: { id: MARCO.id, name: MARCO.name, me: true },
  createdAt: '2026-11-01T09:00:00.000Z',
  updatedAt: '2026-11-01T09:00:00.000Z',
  version: 1,
  relation: 'RECORD',
  canChange: true,
})

const TASKS: TaskItem[] = [
  task('t1t1t1t1-0000-4000-8000-000000000001', 'Tech pack AX-310 to the pattern room', { date: '2026-11-14', days: -3, word: 'OVERDUE' }, GIULIA),
  task('t1t1t1t1-0000-4000-8000-000000000002', 'Book the fit session for proto 2', { date: '2026-11-20', days: 3, word: 'SOON' }, MARCO),
]

const file = (id: string, name: string, createdAt: string, visibility: ApiFile['visibility']): ApiFile => ({
  id,
  companyId: COMPANY,
  recordType: 'Project',
  recordId: PROJECT_ID,
  kind: 'DOCUMENT',
  originalName: name,
  contentType: 'application/pdf',
  sizeBytes: 182_000,
  status: 'AVAILABLE',
  visibility,
  retainUntil: null,
  quarantineReason: null,
  availableAt: createdAt,
  createdAt,
  version: 1,
})

const FILES: ApiFile[] = [
  file('f2f2f2f2-0000-4000-8000-000000000001', 'Airbag vest placement v3.pdf', '2026-11-12T10:00:00.000Z', ['OFFICE', 'PARTNER']),
  file('f2f2f2f2-0000-4000-8000-000000000002', 'Costing notes FW27.pdf', '2026-11-10T10:00:00.000Z', ['OFFICE']),
  file('f2f2f2f2-0000-4000-8000-000000000003', 'Collar sketch.pdf', '2026-11-03T10:00:00.000Z', ['OFFICE', 'PARTNER']),
]

const base = (page: ProjectRecordModel['page'], extra: Partial<ProjectRecordModel> = {}): ProjectRecordModel => ({
  prefix: PREFIX,
  me: MARCO.id,
  can: projectsCan(['threads.read', 'threads.post', 'projects.manage', 'parties.view', 'home.view', 'files.read', 'tasks.manage']),
  page,
  offline: false,
  busy: false,
  notice: null,
  tasks: { status: 'ready', data: TASKS },
  addTaskHeld: null,
  files: { status: 'ready', data: FILES },
  dialog: null,
  ...extra,
})

const NEWS_CLOSED: LinkedNewsModel = { asked: false, status: 'idle', lines: [], more: false, moreBusy: false, problem: null }
const NEWS_OPEN: LinkedNewsModel = {
  asked: true,
  status: 'ready',
  more: true,
  moreBusy: false,
  problem: null,
  lines: [
    { id: 'n1', at: '2026-11-16T14:00:00.000Z', recordType: 'SampleRound', recordId: 'r1', label: 'SR-2026-0042', from: 'SENT', to: 'RECEIVED', actor: GIULIA.name, more: 2, href: `${PREFIX}/products/samples/r1` },
    { id: 'n2', at: '2026-11-15T09:30:00.000Z', recordType: 'Quote', recordId: 'q1', label: 'Q-2026-0101', from: 'DRAFT', to: 'SENT', actor: MARCO.name, more: 0, href: `${PREFIX}/sales/quotes/q1` },
    { id: 'n3', at: '2026-11-14T11:00:00.000Z', recordType: 'Style', recordId: 's1', label: 'AX-310', from: null, to: null, actor: null, more: 0, href: `${PREFIX}/products/styles/s1` },
  ],
}

/** A case of the page: its model and which demo sections fill the slots. */
interface ProjectCase {
  readonly record: ProjectRecordModel
  readonly news?: LinkedNewsModel
}

/** The design view: the page with the made-up thread, People, Linked and news in its slots (the page itself mounts the live ones). */
function ProjectDesign({ model }: { model: ProjectCase }) {
  const page = model.record.page
  const project = page.status === 'ready' ? page.data.project : null
  const which = project?.party ? 'customer' : 'officeOnly'
  const slots: { thread: ReactNode; people: ReactNode; linked: ReactNode; news: ReactNode } = project
    ? {
        thread: designDockedThread({ recordType: 'Project', record: project.number, party: project.party ? { name: project.party.name, role: 'customer' } : null }),
        people: createElement(PeopleBlock, { model: PEOPLE_DEMO[which] }),
        linked: createElement(LinkedBlock, { model: LINKED_DEMO[which] }),
        news: createElement(LinkedNewsCard, { model: model.news ?? NEWS_CLOSED }),
      }
    : { thread: null, people: null, linked: null, news: null }
  return createElement(ProjectRecordView, { model: model.record, ...slots })
}

const ready = (project: ProjectView, extra: Partial<ProjectRecordModel> = {}, news?: LinkedNewsModel): ProjectCase => ({ record: base({ status: 'ready', data: pageOf(project) }, extra), ...(news ? { news } : {}) })

const closedProject: ProjectView = {
  ...customerProject,
  status: 'CLOSED',
  target: { state: 'CLOSED', days: -2 },
  outcome: 'DONE',
  outcomeNote: 'FW27 airbag line approved: six styles to production in March.',
  closedAt: '2026-11-12T16:40:00.000Z',
  closedBy: MARCO,
  threadStatus: 'CLOSED',
  may: { manage: true, post: true, moves: ['REOPEN'] },
}

export const designScreen = defineDesignScreen<ProjectCase>({
  screen: 'SCR-701',
  title: 'Project page',
  view: ProjectDesign,
  cases: [
    { id: 'customer', label: 'With a customer', model: ready(customerProject), note: 'Brand Alpha is the one outside company: the thread offers "Reply to Brand Alpha" only; People shows its portal person.' },
    { id: 'office-only', label: 'Office only', model: ready(officeProject), note: 'No outside company: office notes only, no "Reply to", no waiting pill; Details says nobody outside reads it.' },
    { id: 'on-hold', label: 'On hold', model: ready({ ...customerProject, status: 'ON_HOLD', may: { manage: true, post: true, moves: ['RESUME', 'CLOSE'] } }), note: 'Amber pill; ⋯ offers Resume.' },
    { id: 'overdue', label: 'Past its target date', model: ready({ ...customerProject, targetDate: '2026-11-10', target: { state: 'OVERDUE', days: -7 } }), note: 'The target date in red with "Overdue 7 d" (never colour alone).' },
    { id: 'closed', label: 'Closed with its outcome', model: ready(closedProject), note: 'The closed banner above the thread with Reopen; the band\'s primary is Reopen; ⋯ has no Close.' },
    { id: 'closed-read-only', label: 'Closed, read only', model: ready({ ...closedProject, may: { manage: false, post: true, moves: [] } }), note: 'No projects.manage: no Reopen button, the banner says who can reopen it.' },
    { id: 'read-only', label: 'Read only (no projects.manage)', model: ready({ ...customerProject, may: { manage: false, post: true, moves: [] } }), note: '⋯ lines held with the right in words.' },
    { id: 'offline', label: 'Offline', model: ready(customerProject, { offline: true }), note: 'Every change held: "You are offline".' },
    { id: 'news', label: 'News of linked records', model: ready(customerProject, {}, NEWS_OPEN), note: 'Asked only: moves and decisions of the linked records, one line per record per day, "+2 more that day".' },
    { id: 'details-open', label: 'Details view (below 1280 px)', model: ready(customerProject, { detailsOpen: true }), note: 'Below 1280 px the side column opens from the band\'s "Details" (an "i" on a phone) and replaces the thread until Back.' },
    {
      id: 'close-dialog',
      label: 'Close with outcome',
      model: ready(customerProject, { dialog: { kind: 'close', draft: { ...emptyCloseDraft(), outcome: 'DONE' }, busy: false, problem: null } }),
      note: 'Done picked, the outcome line still empty: Close held with words; the tick posts the outcome to Brand Alpha too.',
    },
    {
      id: 'edit-dialog',
      label: 'Edit details',
      model: ready(customerProject, { dialog: { kind: 'edit', draft: editDraftOf(customerProject), leads: { status: 'ready', data: [MARCO, GIULIA] }, busy: false, problem: null, stale: false, fields: [] } }),
      note: 'The outside company read only, with why.',
    },
    {
      id: 'edit-stale',
      label: 'Edit details: changed by someone else',
      model: ready(customerProject, { dialog: { kind: 'edit', draft: { ...editDraftOf(customerProject), name: 'FW27 airbag line (jackets)' }, leads: { status: 'ready', data: [MARCO, GIULIA] }, busy: false, problem: null, stale: true, fields: [] } }),
      note: 'Someone saved first: Reload reads it again.',
    },
    { id: 'no-tasks-files', label: 'No tasks, no files to read', model: ready(officeProject, { tasks: null, files: null, addTaskHeld: 'tasks.held.noManage' }), note: 'Without home.view the tasks are counted only; without files.read the files are in the thread.' },
    { id: 'loading', label: 'Reading', model: { record: base({ status: 'loading' }) } },
    { id: 'not-found', label: 'Not found (or not mine to read)', model: { record: base({ status: 'error', problem: 'problem.notFound' }) }, note: 'One sentence, never "you may not" (W38).' },
    { id: 'failed', label: 'Read failed', model: { record: base({ status: 'error', problem: 'problem.unavailable' }) } },
  ],
})
