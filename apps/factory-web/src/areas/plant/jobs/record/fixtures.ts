import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { designScreen as panelsScreen } from '../../../../record-panels/fixtures'
import type { RecordPanelsViewModel } from '../../../../record-panels/view/RecordPanelsView'
import type { JobRecord } from '../../_shared/api'
import { canAs, CARDS, card, COMPANY, inShell, JOBS, MACHINES, NOW, PREFIX, REQUESTS, SITE, TECHNICIANS, type PlantRole } from '../../_shared/fixtures'
import type { JobRecordModel, JobTab } from '../view-model'
import { JobRecordView } from './view/JobRecordView'

/**
 * SCR-149-record — a maintenance job (Plant › Maintenance jobs › a job) with made-up data only: the Problem tab (the
 * requests behind it, the machine's card, the side panel and its explicit edit), a machine locked as unsafe (where it is
 * signed safe), the Hand-back tab (the one-screen close: what was done, the time, the machine after — running held while
 * locked) and a handed-back job to close, Activity (the record panels), Cancel with its reason, and the page's states.
 */

interface JobCase {
  role: PlantRole
  record: JobRecordModel
  panels: RecordPanelsViewModel | null
}

const conversation = panelsScreen.cases.find((item) => item.id === 'conversation')!.model as RecordPanelsViewModel

const SAFETY: JobRecord = { job: { ...JOBS.safety, assignee: { kind: 'WORKER', id: TECHNICIANS[2]!.id, name: 'Luca Demo' } }, card: CARDS.sew2, requests: [REQUESTS.unsafe], canManage: true, canWork: true }
const THREAD: JobRecord = { job: JOBS.thread, card: card(MACHINES.sew4, { openJob: { id: JOBS.thread.id, number: JOBS.thread.number, status: JOBS.thread.status }, requestsIn30Days: 3, repeatFailure: true }), requests: [], canManage: true, canWork: true }
const HANDED: JobRecord = { job: JOBS.handedBack, card: card(MACHINES.cutTable), requests: [], canManage: true, canWork: true }
const IN_PROGRESS: JobRecord = { job: { ...JOBS.thread, status: 'IN_PROGRESS', overdue: false }, card: THREAD.card, requests: [], canManage: true, canWork: true }

function record(role: PlantRole, tab: JobTab, value: JobRecord | null, over: Partial<JobRecordModel> = {}): JobCase {
  return {
    role,
    panels: tab === 'activity' && value ? { ...conversation, record: { type: 'MaintenanceJob', id: value.job.id, companyId: COMPANY, siteId: SITE.id }, title: `${value.job.number} · ${value.job.machine.assetNumber}`, party: null } : null,
    record: {
      prefix: PREFIX,
      can: canAs(role),
      tab,
      loaded: value ? { status: 'ready', value } : { status: 'loading' },
      timeZone: 'Europe/Rome',
      now: NOW,
      live: 'live',
      asOf: NOW,
      technicians: { technicians: TECHNICIANS, floorListed: true, problem: null },
      edit: null,
      editBusy: false,
      handBack: { workDone: '', machineAfter: null },
      busy: false,
      dialog: null,
      notice: null,
      ...over,
    },
  }
}

function JobDesign({ model }: { model: JobCase }) {
  const id = model.record.loaded.status === 'ready' ? model.record.loaded.value.job.id : 'x'
  return inShell(`/plant/jobs/${id}`, createElement(JobRecordView, { model: model.record, panelsPreview: model.panels ?? undefined }), model.role)
}

export const designScreen = defineDesignScreen<JobCase>({
  screen: 'SCR-149-record',
  title: 'Maintenance job (Problem, Hand-back, Activity)',
  view: JobDesign,
  cases: [
    { id: 'problem-locked', label: 'Problem: a safety job on a machine locked as unsafe (where to sign it safe)', model: record('maintenance', 'problem', SAFETY), note: 'The floor technician is named here, inside the one record (Owner W1).' },
    { id: 'problem-repeat', label: 'Problem: waiting parts, overdue, the third-failure hint', model: record('maintenance', 'problem', THREAD) },
    { id: 'edit', label: 'Side panel: the explicit edit (priority, technician, due, problem)', model: record('maintenance', 'problem', THREAD, { edit: { type: 'CORRECTIVE', problem: JOBS.thread.problem, priority: 'P1', assignee: `USER:${TECHNICIANS[1]!.id}`, due: '2026-10-30T16:00' } }) },
    { id: 'handback', label: 'Hand-back: what was done, the machine after', model: record('maintenance', 'handback', IN_PROGRESS, { handBack: { workDone: 'Crochet sostituito, tensione regolata.', machineAfter: 'RUNNING' } }) },
    { id: 'handback-locked', label: 'Hand-back while locked: "Running" held until it is signed safe', model: record('maintenance', 'handback', SAFETY, { handBack: { workDone: 'Carter rimontato.', machineAfter: 'DO_NOT_USE' } }) },
    { id: 'handback-not-started', label: 'Hand-back before the work started: Start first', model: record('maintenance', 'handback', THREAD) },
    { id: 'handed-back', label: 'Handed back: the office closes it, the technician may reopen it', model: record('maintenance', 'handback', HANDED) },
    { id: 'activity', label: 'Activity: the record panels (thread, files, history)', model: record('maintenance', 'activity', SAFETY) },
    { id: 'cancel', label: 'Cancel with its reason', model: record('maintenance', 'problem', THREAD, { dialog: { kind: 'cancel', reason: '', busy: false, problem: null } }) },
    { id: 'refused', label: 'A move refused in words (locked as unsafe)', model: record('maintenance', 'problem', SAFETY, { notice: { tone: 'danger', words: { key: 'done.moveRefused', params: { number: JOBS.safety.number } }, detail: { key: 'refusal.LOCKED_UNSAFE' } } }) },
    { id: 'production', label: 'Production manager: plans and closes; works no job (Start held)', model: record('production', 'problem', { ...THREAD, job: { ...JOBS.planned }, canWork: false }) },
    { id: 'read-only', label: 'Read-only: every move held with its reason', model: record('readOnly', 'problem', { ...THREAD, canManage: false, canWork: false }) },
    { id: 'loading', label: 'Loading', model: record('maintenance', 'problem', null) },
    { id: 'not-found', label: 'Not found', model: record('maintenance', 'problem', null, { loaded: { status: 'notFound' } }) },
    { id: 'error', label: "Couldn't be read", model: record('maintenance', 'problem', null, { loaded: { status: 'error', problem: 'problem.unavailable' } }) },
    { id: 'sales', label: 'Sales: no plant.view', model: record('sales', 'problem', null, { loaded: { status: 'forbidden' } }) },
  ],
})
