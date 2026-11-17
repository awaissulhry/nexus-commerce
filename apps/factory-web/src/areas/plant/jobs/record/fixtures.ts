import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { at, canAs, CARDS, card, inShell, JOBS, MACHINES, NOW, PEOPLE, PREFIX, REQUESTS, TECHNICIANS, type PlantRole } from '../../_shared/fixtures'
// ---- B-TH-265: the job's docked thread in the design cases (notes only: a maintenance job has no party) ----
import { designDockedThread } from '../../../_shared/record-frame/fixtures'
import { STEP_UP_CLOSED } from '../../_shared/parts'
import type { DeepJobRecord } from '../../requests/depth/api'
import { DEEP, DEEP_JOBS, deepJob, media, viewsOf } from '../../requests/depth/fixtures'
import { closeDraftOf } from '../../requests/depth/model'
import type { JobRecordModel, JobTab } from '../view-model'
import { JobRecordView } from './view/JobRecordView'

/**
 * SCR-149-record — a maintenance job (Plant › Maintenance jobs › a job) with made-up data only: the Problem tab (the
 * requests behind it, the machine's card, the side panel and its explicit edit), a machine locked as unsafe (B-W2b-140:
 * the Unsafe lock panel with Sign safe and its fresh code), the Photos tab (before / after, voice notes, the requests'
 * photos; the camera, sending, a failed upload with Try again, no right), the Hand-back tab (the one-screen close with
 * the action and failure-code tiles, the API's minutes, the machine after — running held while locked), the Hand back
 * dialog, a handed-back job with the Line lead confirms panel, the docked thread beside both tabs (B-TH-265: notes only — a job has no
 * party; Activity went, its tools in the thread's "⋯"; Problem and Photos are one tab), Cancel, and the states.
 */

interface JobCase {
  role: PlantRole
  record: JobRecordModel
  /** B-TH-265: no thread here (without threads.read): no dock, no Thread button. */
  noThread?: boolean
}

const base = { canManage: true, canWork: true, lock: null, files: [], requestFiles: [], close: { minutesSoFar: null, runningHeld: false, canHandBack: false }, canConfirm: false }

const SAFETY: DeepJobRecord = {
  ...base,
  job: { ...DEEP_JOBS.safety, assignee: { kind: 'WORKER', id: TECHNICIANS[2]!.id, name: 'Luca Demo' } },
  card: CARDS.sew2,
  requests: [DEEP.unsafe],
  lock: { request: DEEP.unsafe, since: at(30, 9, 12), canSignSafe: true },
  files: [media(11, 'PHOTO', 'BEFORE_WORK', 31), media(12, 'AUDIO', null, 33)],
  requestFiles: [{ ...media(1, 'PHOTO'), requestId: REQUESTS.unsafe.id }, { ...media(2, 'AUDIO', null, 16), requestId: REQUESTS.unsafe.id }],
  close: { minutesSoFar: 12, runningHeld: true, canHandBack: true },
}
const THREAD: DeepJobRecord = { ...base, job: DEEP_JOBS.thread, card: card(MACHINES.sew4, { openJob: { id: JOBS.thread.id, number: JOBS.thread.number, status: JOBS.thread.status }, requestsIn30Days: 3, repeatFailure: true }), requests: [] }
const IN_PROGRESS: DeepJobRecord = { ...THREAD, job: deepJob({ ...JOBS.thread, status: 'IN_PROGRESS', overdue: false }), close: { minutesSoFar: 42, runningHeld: false, canHandBack: true } }
const HANDED: DeepJobRecord = {
  ...base,
  job: DEEP_JOBS.handedBack,
  card: card(MACHINES.cutTable),
  requests: [{ ...DEEP.noise, status: 'JOB_MADE', job: { id: JOBS.handedBack.id, number: JOBS.handedBack.number, status: 'HANDED_BACK' }, progress: { ...DEEP.noise.progress, step: 'FIXED', fixedAt: at(29, 11), canConfirm: true } }],
  files: [media(21, 'PHOTO', 'BEFORE_WORK', 2), media(22, 'PHOTO', 'AFTER_WORK', 58)],
  canConfirm: true,
}
const CONFIRMED: DeepJobRecord = { ...HANDED, job: { ...HANDED.job, leadConfirmed: { at: at(29, 11, 40), by: PEOPLE.anna } }, canConfirm: false }

function record(role: PlantRole, tab: JobTab, value: DeepJobRecord | null, over: Partial<JobRecordModel> = {}): JobCase {
  return {
    role,
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
      handBack: closeDraftOf(value?.close ?? null),
      busy: false,
      dialog: null,
      notice: null,
      media: value ? viewsOf([...value.files, ...value.requestFiles]) : [],
      lightbox: null,
      capture: null,
      stepUp: STEP_UP_CLOSED,
      ...over,
    },
  }
}

function JobDesign({ model }: { model: JobCase }) {
  const loaded = model.record.loaded
  const id = loaded.status === 'ready' ? loaded.value.job.id : 'x'
  // B-TH-265: the job's thread (notes only) beside both tabs; none without threads.read.
  const thread = loaded.status === 'ready' && !model.noThread ? designDockedThread({ recordType: 'MaintenanceJob', record: loaded.value.job.number, party: null }) : null
  return inShell(`/plant/jobs/${id}`, createElement(JobRecordView, { model: model.record, thread }), model.role)
}

const closing = { action: 'REPLACED_PART' as const, failure: 'WORN_PART', words: 'Crochet sostituito, tensione regolata.', after: 'RUNNING' as const }

export const designScreen = defineDesignScreen<JobCase>({
  screen: 'SCR-149-record',
  title: 'Maintenance job (Problem & photos, Hand-back, the docked thread)',
  view: JobDesign,
  cases: [
    { id: 'problem-locked', label: 'Problem: the Unsafe lock panel — locked since, by whom, why; Sign safe here', model: record('maintenance', 'problem', SAFETY), note: 'The floor technician is named here, inside the one record (Owner W1).' },
    { id: 'problem-repeat', label: 'Problem: waiting parts, overdue, the third-failure hint', model: record('maintenance', 'problem', THREAD) },
    { id: 'edit', label: 'Side panel: the explicit edit (priority, technician, due, problem)', model: record('maintenance', 'problem', THREAD, { edit: { type: 'CORRECTIVE', problem: JOBS.thread.problem, priority: 'P1', assignee: `USER:${TECHNICIANS[1]!.id}`, due: '2026-10-30T16:00' } }) },
    { id: 'sign-safe', label: 'Sign safe from the lock panel: what was checked, the state after (H1)', model: record('maintenance', 'problem', SAFETY, { dialog: { kind: 'signSafe', draft: { note: 'Carter rimontato e fissato; prova a vuoto ok.', machineAfter: null }, busy: false, problem: null } }) },
    { id: 'sign-safe-code', label: 'Sign safe: the fresh two-factor code', model: record('maintenance', 'problem', SAFETY, { dialog: { kind: 'signSafe', draft: { note: 'Carter rimontato.', machineAfter: 'RUNNING' }, busy: true, problem: null }, stepUp: { open: true, busy: false, sentence: 'stepUp.sentence.signSafe', problem: null } }) },
    { id: 'photos', label: 'Problem & photos: before / after and voice notes, and the requests’ photos, under the problem', model: record('maintenance', 'problem', SAFETY), note: 'A thumbnail opens the Lightbox; the voice notes play here.' },
    { id: 'photos-lightbox', label: 'Photos: one full size (Lightbox)', model: record('maintenance', 'problem', SAFETY, { lightbox: 0 }) },
    { id: 'photos-empty', label: 'Photos: none yet', model: record('maintenance', 'problem', IN_PROGRESS) },
    { id: 'photos-camera', label: 'Photos: the camera for a photo before the work (arrows and circles, faces kept out)', model: record('maintenance', 'problem', IN_PROGRESS, { capture: { state: 'camera', category: 'BEFORE_WORK' } }) },
    { id: 'photos-sending', label: 'Photos: a voice note going up', model: record('maintenance', 'problem', SAFETY, { capture: { state: 'sending', kind: 'AUDIO' } }) },
    { id: 'photos-failed', label: 'Photos: an upload refused in words, Try again', model: record('maintenance', 'problem', SAFETY, { capture: { state: 'failed', kind: 'PHOTO', words: { key: 'problem.unavailable' } } }) },
    { id: 'photos-no-right', label: 'Photos as the production manager: adding held (no plant.jobs.work), files unread without files.read', model: record('production', 'problem', SAFETY, { can: { ...canAs('production'), readFiles: false }, media: viewsOf([...SAFETY.files, ...SAFETY.requestFiles], false) }) },
    { id: 'handback', label: 'Hand-back: the tiles (replaced a part · worn part), the minutes, Running', model: record('maintenance', 'handback', IN_PROGRESS, { handBack: closing }) },
    { id: 'handback-other', label: 'Hand-back: Other needs words (Hand back held, said why)', model: record('maintenance', 'handback', IN_PROGRESS, { handBack: { action: 'OTHER', failure: 'OTHER', words: '', after: 'RUNNING' } }) },
    { id: 'handback-locked', label: 'Hand-back while locked: "Running" held until it is signed safe', model: record('maintenance', 'handback', SAFETY, { handBack: { action: 'ADJUSTED', failure: 'LOOSE_PART', words: 'Carter rimontato.', after: 'DO_NOT_USE' } }) },
    { id: 'handback-not-started', label: 'Hand-back before the work started: Start first', model: record('maintenance', 'handback', THREAD) },
    { id: 'handback-dialog', label: 'Hand back dialog (the record’s primary, h): three taps', model: record('maintenance', 'problem', IN_PROGRESS, { handBack: closing, dialog: { kind: 'handBack', busy: false, problem: null } }) },
    { id: 'handback-refused', label: 'Hand back refused in words (the job changed)', model: record('maintenance', 'problem', IN_PROGRESS, { handBack: closing, dialog: { kind: 'handBack', busy: false, problem: { key: 'refusal.MOVE_NOT_ALLOWED' } } }) },
    { id: 'handed-back', label: 'Handed back: the failure code, the minutes; Line lead confirms (stitch settings: first-piece check later)', model: record('maintenance', 'handback', HANDED) },
    { id: 'lead-confirmed', label: 'Line lead confirmed: by whom and when', model: record('maintenance', 'handback', CONFIRMED) },
    { id: 'lead-refused', label: 'Line lead confirm refused in words (confirmed already)', model: record('maintenance', 'handback', HANDED, { notice: { tone: 'danger', words: { key: 'done.leadRefused', params: { number: JOBS.handedBack.number } }, detail: { key: 'depthRefusal.LEAD_CONFIRMED' } } }) },
    // ---- B-TH-265: the docked thread (the rule of picture 38) ----
    {
      id: 'thread-docked',
      label: 'B-TH-265 · The job’s thread docked beside Problem & photos (40 %, notes only)',
      model: record('maintenance', 'problem', SAFETY),
      note: 'The band sits in the shell’s band row with ONE state pill; the thread is docked, sticky, ⌘J hides it. A job has no party: Office notes only, no “Reply to”. Its “⋯” holds Activity’s tools (Add task, Ask a partner to approve, Share with a partner, Followers, Follow, Mute, Remind me). An old ?tab=photos opens Problem & photos; ?tab=activity too, with the thread.',
    },
    { id: 'thread-handback', label: 'B-TH-265 · The thread beside Hand-back', model: record('maintenance', 'handback', IN_PROGRESS, { handBack: closing }) },
    { id: 'thread-no-right', label: 'B-TH-265 · Without threads.read: no thread beside the tabs (no Thread button)', model: { ...record('readOnly', 'problem', THREAD), noThread: true } },
    { id: 'cancel', label: 'Cancel with its reason', model: record('maintenance', 'problem', THREAD, { dialog: { kind: 'cancel', reason: '', busy: false, problem: null } }) },
    { id: 'refused', label: 'A move refused in words (locked as unsafe)', model: record('maintenance', 'problem', SAFETY, { notice: { tone: 'danger', words: { key: 'done.moveRefused', params: { number: JOBS.safety.number } }, detail: { key: 'refusal.LOCKED_UNSAFE' } } }) },
    { id: 'production', label: 'Production manager: plans and closes; works no job (Start held), signs nothing safe', model: record('production', 'problem', { ...SAFETY, job: { ...DEEP_JOBS.planned, machine: SAFETY.job.machine }, canWork: false, lock: { ...SAFETY.lock!, canSignSafe: false } }) },
    { id: 'read-only', label: 'Read-only: every move held with its reason; Line lead confirm held', model: record('readOnly', 'handback', { ...HANDED, canManage: false, canWork: false, canConfirm: false }) },
    { id: 'loading', label: 'Loading', model: record('maintenance', 'problem', null) },
    { id: 'not-found', label: 'Not found', model: record('maintenance', 'problem', null, { loaded: { status: 'notFound' } }) },
    { id: 'error', label: "Couldn't be read", model: record('maintenance', 'problem', null, { loaded: { status: 'error', problem: 'problem.unavailable' } }) },
    { id: 'sales', label: 'Sales: no plant.view', model: record('sales', 'problem', null, { loaded: { status: 'forbidden' } }) },
  ],
})
